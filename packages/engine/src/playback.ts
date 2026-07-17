import {
  DMX_UNIVERSE_SIZE,
  profileMap,
  type PlaybackState,
  type Project,
  type Sequence,
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

/**
 * Слой воспроизведения: активная статическая сцена + запущенные секвенсоры.
 * Все источники сливаются по HTP (максимум по каждому каналу). Результат каждой
 * вселенной движок затем сливает по HTP с ручным слоем консоли.
 */
export class Playback {
  private project: Project | null = null;
  private compiled = new Map<string, CompiledScene>();
  private activeSceneId: string | null = null;
  private running: RunningSeq[] = [];
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
    // Проект изменился: сцена или секвенсор могли исчезнуть или сократиться.
    if (this.activeSceneId !== null && !this.compiled.has(this.activeSceneId)) {
      this.activeSceneId = null;
      this.version++;
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
    if (this.running.length === 0 && this.activeSceneId === null) return;
    this.running = [];
    this.activeSceneId = null;
    this.version++;
  }

  state(): PlaybackState {
    return {
      activeSceneId: this.activeSceneId,
      running: this.running.map((r) => ({
        sequenceId: r.sequence.id,
        stepIndex: r.stepIndex,
        paused: r.paused,
      })),
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
