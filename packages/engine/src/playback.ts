import {
  DMX_UNIVERSE_SIZE,
  blockFadeGain,
  envelopeValue,
  profileMap,
  type PlaybackState,
  type Project,
  type Sequence,
  type Show,
  type ShowTransportState,
} from '@fountain-studio/shared';

/** Скомпилированная сцена: universeId → 512 целевых уровней (не занятые сценой каналы = 0). */
type CompiledScene = Map<number, Uint8Array>;

interface RunningSeq {
  sequence: Sequence;
  stepIndex: number;
  paused: boolean;
  /** Момент входа в текущий шаг по часам движка, мс. */
  stepStartMs: number;
  /** Накопленное время внутри шага на момент паузы. */
  pausedElapsedMs: number;
  /** Уровни, с которых идёт фейд текущего шага (снимок на входе в шаг). */
  fadeFrom: Map<number, Float32Array>;
  /** Текущие уровни секвенсора (его вклад в слой воспроизведения). */
  levels: Map<number, Float32Array>;
}

interface ShowRuntime {
  show: Show;
  playing: boolean;
  /** Позиция на момент якоря, мс смонтированного таймлайна. */
  posAtAnchorMs: number;
  /** Якорь по часам движка (nowMs). */
  anchorMs: number;
}

/** Адрес устройства для огибающих: вселенная + первый адрес + число каналов. */
interface DeviceSlot {
  universe: number;
  address: number;
  channels: number;
}

/**
 * Слой воспроизведения: активная статическая сцена + запущенные секвенсоры + шоу.
 * Все источники сливаются по HTP (максимум по каждому каналу). Результат каждой
 * вселенной движок затем сливает по HTP с ручным слоем консоли.
 */
export class Playback {
  private project: Project | null = null;
  private compiled = new Map<string, CompiledScene>();
  private deviceSlots = new Map<string, DeviceSlot>();
  private activeSceneId: string | null = null;
  private running: RunningSeq[] = [];
  private showRt: ShowRuntime | null = null;
  private readonly merged = new Map<number, Uint8Array>();
  /** Растёт при любом изменении состояния (транспорт, автопереход шага) — сигнал серверу разослать состояние. */
  version = 0;

  constructor(private readonly universeIds: number[]) {
    for (const id of universeIds) this.merged.set(id, new Uint8Array(DMX_UNIVERSE_SIZE));
  }

  setProject(project: Project): void {
    this.project = project;
    this.compiled.clear();
    for (const scene of project.scenes) {
      const compiledScene: CompiledScene = new Map();
      const profiles = profileMap(project);
      for (const [deviceId, values] of Object.entries(scene.values)) {
        const device = project.devices.find((d) => d.id === deviceId);
        if (!device) continue;
        const profile = profiles.get(device.profileId);
        if (!profile || !this.merged.has(device.universe)) continue;
        let buf = compiledScene.get(device.universe);
        if (!buf) {
          buf = new Uint8Array(DMX_UNIVERSE_SIZE);
          compiledScene.set(device.universe, buf);
        }
        for (let k = 0; k < profile.channels.length; k++) {
          const addr = device.address - 1 + k;
          if (addr < 0 || addr >= DMX_UNIVERSE_SIZE) continue;
          buf[addr] = Math.max(buf[addr]!, values[k] ?? 0);
        }
      }
      this.compiled.set(scene.id, compiledScene);
    }
    this.deviceSlots.clear();
    {
      const profiles = profileMap(project);
      for (const d of project.devices) {
        const profile = profiles.get(d.profileId);
        if (!profile || !this.merged.has(d.universe)) continue;
        this.deviceSlots.set(d.id, { universe: d.universe, address: d.address, channels: profile.channels.length });
      }
    }
    // Проект изменился: сцена, секвенсор или шоу могли исчезнуть или сократиться.
    if (this.activeSceneId !== null && !this.compiled.has(this.activeSceneId)) {
      this.activeSceneId = null;
      this.version++;
    }
    if (this.showRt !== null) {
      const fresh = project.shows.find((s) => s.id === this.showRt!.show.id);
      if (!fresh) {
        this.showRt = null;
        this.version++;
      } else {
        this.showRt.show = fresh;
      }
    }
    const before = this.running.length;
    this.running = this.running.filter((r) => {
      const fresh = project.sequences.find((q) => q.id === r.sequence.id);
      if (!fresh || fresh.steps.length === 0) return false;
      r.sequence = fresh;
      if (r.stepIndex >= fresh.steps.length) r.stepIndex = 0;
      return true;
    });
    if (this.running.length !== before) this.version++;
  }

  setScene(sceneId: string | null, nowMs: number): void {
    void nowMs;
    this.activeSceneId = sceneId !== null && this.compiled.has(sceneId) ? sceneId : null;
    this.version++;
  }

  start(sequenceId: string, nowMs: number): void {
    const sequence = this.project?.sequences.find((q) => q.id === sequenceId);
    if (!sequence || sequence.steps.length === 0) return;
    this.stop(sequenceId);
    this.running.push({
      sequence,
      stepIndex: 0,
      paused: false,
      stepStartMs: nowMs,
      pausedElapsedMs: 0,
      fadeFrom: new Map(),
      levels: new Map(),
    });
    this.version++;
  }

  pause(sequenceId: string, nowMs: number): void {
    const r = this.running.find((x) => x.sequence.id === sequenceId);
    if (!r || r.paused) return;
    r.pausedElapsedMs = nowMs - r.stepStartMs;
    r.paused = true;
    this.version++;
  }

  resume(sequenceId: string, nowMs: number): void {
    const r = this.running.find((x) => x.sequence.id === sequenceId);
    if (!r || !r.paused) return;
    r.stepStartMs = nowMs - r.pausedElapsedMs;
    r.paused = false;
    this.version++;
  }

  stop(sequenceId: string): void {
    const before = this.running.length;
    this.running = this.running.filter((x) => x.sequence.id !== sequenceId);
    if (this.running.length !== before) this.version++;
  }

  stopAll(): void {
    if (this.running.length === 0 && this.activeSceneId === null && this.showRt === null) return;
    this.running = [];
    this.activeSceneId = null;
    this.showRt = null;
    this.version++;
  }

  // ── Транспорт шоу ──────────────────────────────────────────────────────────

  private showPosition(nowMs: number): number {
    const rt = this.showRt;
    if (!rt) return 0;
    return rt.playing ? rt.posAtAnchorMs + (nowMs - rt.anchorMs) : rt.posAtAnchorMs;
  }

  playShow(showId: string, positionMs: number, nowMs: number): void {
    const show = this.project?.shows.find((s) => s.id === showId);
    if (!show) return;
    this.showRt = { show, playing: true, posAtAnchorMs: Math.max(0, positionMs), anchorMs: nowMs };
    this.version++;
  }

  pauseShow(nowMs: number): void {
    const rt = this.showRt;
    if (!rt || !rt.playing) return;
    rt.posAtAnchorMs = this.showPosition(nowMs);
    rt.playing = false;
    this.version++;
  }

  seekShow(positionMs: number, nowMs: number): void {
    const rt = this.showRt;
    if (!rt) return;
    rt.posAtAnchorMs = Math.max(0, positionMs);
    rt.anchorMs = nowMs;
    this.version++;
  }

  /** Коррекция по аудио-часам редактора: якорь переставляется без остановки. */
  syncShow(positionMs: number, nowMs: number): void {
    const rt = this.showRt;
    if (!rt || !rt.playing) return;
    rt.posAtAnchorMs = Math.max(0, positionMs);
    rt.anchorMs = nowMs;
  }

  stopShow(): void {
    if (this.showRt === null) return;
    this.showRt = null;
    this.version++;
  }

  showState(nowMs: number): ShowTransportState | null {
    const rt = this.showRt;
    if (!rt) return null;
    return { showId: rt.show.id, positionMs: Math.round(this.showPosition(nowMs)), playing: rt.playing };
  }

  state(nowMs: number): PlaybackState {
    return {
      activeSceneId: this.activeSceneId,
      running: this.running.map((r) => ({
        sequenceId: r.sequence.id,
        stepIndex: r.stepIndex,
        paused: r.paused,
      })),
      show: this.showState(nowMs),
    };
  }

  /** Пересчитывает слой воспроизведения на момент nowMs. */
  tick(nowMs: number): void {
    for (const buf of this.merged.values()) buf.fill(0);

    if (this.activeSceneId !== null) {
      const scene = this.compiled.get(this.activeSceneId);
      if (scene) {
        for (const [universe, target] of scene) {
          const out = this.merged.get(universe)!;
          for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
            if (target[i]! > out[i]!) out[i] = target[i]!;
          }
        }
      }
    }

    const finished: string[] = [];
    for (const r of this.running) {
      this.advance(r, nowMs, finished);
      const step = r.sequence.steps[r.stepIndex]!;
      const target = this.compiled.get(step.sceneId);
      const elapsed = r.paused ? r.pausedElapsedMs : nowMs - r.stepStartMs;
      const t = step.fadeMs > 0 ? Math.min(1, Math.max(0, elapsed / step.fadeMs)) : 1;
      for (const universe of this.universeIds) {
        const levels = getOrCreate(r.levels, universe);
        const from = r.fadeFrom.get(universe);
        const targetBuf = target?.get(universe);
        for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
          const a = from?.[i] ?? 0;
          const b = targetBuf?.[i] ?? 0;
          levels[i] = a + (b - a) * t;
        }
        const out = this.merged.get(universe)!;
        for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
          const v = levels[i]!;
          if (v > out[i]!) out[i] = Math.round(v);
        }
      }
    }
    if (finished.length > 0) {
      this.running = this.running.filter((r) => !finished.includes(r.sequence.id));
      this.version++;
    }

    this.renderShow(nowMs);
  }

  /**
   * Слой шоу: позиция таймлайна однозначно определяет картинку (стейтлес) —
   * скраб/перемотка сразу показывают верное состояние. Рисуем и на паузе.
   */
  private renderShow(nowMs: number): void {
    const rt = this.showRt;
    if (!rt || !this.project) return;
    let pos = this.showPosition(nowMs);
    if (rt.playing && rt.show.durationMs > 0 && pos >= rt.show.durationMs) {
      // Конец таймлайна — пауза на последней позиции.
      rt.posAtAnchorMs = rt.show.durationMs;
      rt.playing = false;
      pos = rt.show.durationMs;
      this.version++;
    }
    for (const track of rt.show.tracks) {
      if (track.muted) continue;
      // Опережение: дорожка читается на offsetMs впереди таймлайна.
      const tt = pos + track.offsetMs;
      if (track.kind === 'envelope') {
        const v = Math.round(envelopeValue(track.points, tt));
        if (v <= 0) continue;
        const slot = this.deviceSlots.get(track.deviceId);
        if (!slot || track.channel >= slot.channels) continue;
        const out = this.merged.get(slot.universe);
        const addr = slot.address - 1 + track.channel;
        if (!out || addr < 0 || addr >= DMX_UNIVERSE_SIZE) continue;
        if (v > out[addr]!) out[addr] = v;
      } else {
        for (const block of track.blocks) {
          const local = tt - block.startMs;
          if (local < 0 || local >= block.durationMs) continue;
          const gain = blockFadeGain(block, local);
          if (gain <= 0) continue;
          if (block.type === 'scene') {
            const scene = this.compiled.get(block.refId);
            if (scene) this.mergeScaled(scene, gain);
          } else {
            const seq = this.project.sequences.find((q) => q.id === block.refId);
            if (seq && seq.steps.length > 0) this.mergeSequenceAt(seq, local, gain);
          }
        }
      }
    }
  }

  private mergeScaled(scene: CompiledScene, gain: number): void {
    for (const [universe, buf] of scene) {
      const out = this.merged.get(universe);
      if (!out) continue;
      for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
        const v = Math.round(buf[i]! * gain);
        if (v > out[i]!) out[i] = v;
      }
    }
  }

  /** Секвенсор внутри блока шоу: elapsedMs однозначно даёт шаг и фазу фейда. */
  private mergeSequenceAt(seq: Sequence, elapsedMs: number, gain: number): void {
    const total = seq.steps.reduce((s, st) => s + st.holdMs, 0);
    if (total <= 0) return;
    let e: number;
    let firstPass: boolean;
    if (seq.mode === 'loop') {
      firstPass = elapsedMs < total;
      e = elapsedMs % total;
    } else {
      firstPass = true;
      e = Math.min(elapsedMs, total - 1);
    }
    let idx = 0;
    let acc = 0;
    for (let i = 0; i < seq.steps.length; i++) {
      if (e < acc + seq.steps[i]!.holdMs) {
        idx = i;
        break;
      }
      acc += seq.steps[i]!.holdMs;
    }
    const step = seq.steps[idx]!;
    const stepElapsed = e - acc;
    const t = step.fadeMs > 0 ? Math.min(1, stepElapsed / step.fadeMs) : 1;
    const cur = this.compiled.get(step.sceneId);
    // Фейд идёт от предыдущего шага; на самом первом проходе первого шага — от нуля.
    const prevIdx = idx > 0 ? idx - 1 : firstPass ? -1 : seq.steps.length - 1;
    const prev = prevIdx >= 0 ? this.compiled.get(seq.steps[prevIdx]!.sceneId) : undefined;
    for (const universe of this.universeIds) {
      const out = this.merged.get(universe)!;
      const a = prev?.get(universe);
      const b = cur?.get(universe);
      if (!a && !b) continue;
      for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
        const av = a ? a[i]! : 0;
        const bv = b ? b[i]! : 0;
        const v = Math.round((av + (bv - av) * t) * gain);
        if (v > out[i]!) out[i] = v;
      }
    }
  }

  /** Переходы шагов: возможно, прошло несколько шагов за один тик. */
  private advance(r: RunningSeq, nowMs: number, finished: string[]): void {
    if (r.paused) return;
    for (;;) {
      const step = r.sequence.steps[r.stepIndex]!;
      const elapsed = nowMs - r.stepStartMs;
      if (elapsed < step.holdMs) return;
      const isLast = r.stepIndex === r.sequence.steps.length - 1;
      if (isLast && r.sequence.mode === 'once') {
        finished.push(r.sequence.id);
        return;
      }
      // Снимок текущих уровней — с них пойдёт фейд следующего шага.
      for (const universe of this.universeIds) {
        const snap = getOrCreate(r.fadeFrom, universe);
        snap.set(getOrCreate(r.levels, universe));
      }
      r.stepIndex = isLast ? 0 : r.stepIndex + 1;
      r.stepStartMs += step.holdMs;
      this.version++;
    }
  }

  /** Итоговый слой воспроизведения вселенной (512 байт). */
  levels(universeId: number): Uint8Array | undefined {
    return this.merged.get(universeId);
  }
}

function getOrCreate(map: Map<number, Float32Array>, universe: number): Float32Array {
  let arr = map.get(universe);
  if (!arr) {
    arr = new Float32Array(DMX_UNIVERSE_SIZE);
    map.set(universe, arr);
  }
  return arr;
}
