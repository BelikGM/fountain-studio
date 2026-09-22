import {
  DMX_UNIVERSE_SIZE,
  activeEffectAt,
  blockFadeGain,
  envelopeValue,
  profileMap,
  smoothStep,
  SMOOTHNESS_DEFAULT,
  type PlaybackState,
  type Playlist,
  type PlaylistTransportState,
  type Project,
  type Sequence,
  type SequenceGroup,
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
  /**
   * Эффект плавности секвенсора (§27 доработки, УХ п.16): сглаженная версия
   * levels, которую реально видит выход — отдельно от levels (та остаётся
   * «сырой» целью для fadeFrom следующего шага). null — ещё не тикали ни разу.
   */
  smoothed: Map<number, Float32Array>;
  lastTickMs: number | null;
}

interface ShowRuntime {
  show: Show;
  playing: boolean;
  /** Позиция на момент якоря, мс смонтированного таймлайна. */
  posAtAnchorMs: number;
  /** Якорь по часам движка (nowMs). */
  anchorMs: number;
}

interface PlaylistRuntime {
  playlist: Playlist;
  itemIndex: number;
  /** Конец паузы между шоу по часам движка; null — сейчас играет шоу. */
  gapUntilMs: number | null;
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
  private playlistRt: PlaylistRuntime | null = null;
  /**
   * Поведение старта плейлиста «resume» (§27 доработки) — playlistId →
   * последний itemIndex, на котором плейлист был остановлен. Только в
   * памяти движка (как и остальное состояние воспроизведения) — после
   * перезапуска движка плейлист снова начнёт сначала.
   */
  private lastPlaylistIndex = new Map<string, number>();
  private readonly merged = new Map<number, Uint8Array>();
  /**
   * Эффект плавности треков шоу (§27 доработки, УХ п.16): состояние фильтра на
   * трек, ключ — id дорожки. lastTt — таймлайн-время (не часы движка) прошлого
   * тика: скраб/перемотка обычно дают скачок tt — обнаруживаем это по разнице
   * и сбрасываем фильтр (сразу честное значение), а не тянем плавность через
   * разрыв (тот самый принцип «стейтлес-рендер» для перемотки, см. renderShow).
   */
  private trackSmoothed = new Map<string, { lastTt: number; levels: Map<number, Float32Array> }>();
  /** Растёт при любом изменении состояния (транспорт, автопереход шага) — сигнал серверу разослать состояние. */
  version = 0;
  /**
   * Автономное воспроизведение сменило шоу: движку пора запустить (show) или
   * остановить (null) системный аудиоплеер. Назначает точка входа движка.
   */
  onShowAudio: ((show: Show | null) => void) | null = null;

  constructor(private universeIds: number[]) {
    for (const id of universeIds) this.merged.set(id, new Uint8Array(DMX_UNIVERSE_SIZE));
  }

  /**
   * Расчёт идёт здесь же, в главном потоке, поэтому ломаться отдельно от
   * процесса нечему — см. PlaybackSource.healthy.
   */
  readonly healthy = true;

  /**
   * Пауза всего живёт в часах движка: он просто не продвигает nowMs. Здесь
   * делать нечего — метод есть ради общего интерфейса с расчётом в отдельном
   * потоке, где часы свои и про паузу надо сообщать.
   */
  setPausedAll(_paused: boolean): void {
    // намеренно пусто
  }

  /** Закрывать нечего: ни потока, ни файлов. Метод — ради общего интерфейса. */
  dispose(): void {
    // намеренно пусто
  }

  /**
   * Подхватывать нечего: здесь кадр считается в том же такте, что и
   * отправляется, и первый же tick() даёт настоящие значения. Замер это
   * подтверждает: при переходе на расчёт одним потоком провала нет.
   */
  seed(_levels: ReadonlyMap<number, Uint8Array>, _state: PlaybackState): void {
    // намеренно пусто
  }

  /** Смена набора вселенных на лету (вкладка «Настройки»). Буферы пересоздаются. */
  setUniverses(ids: number[]): void {
    this.universeIds = [...ids];
    this.merged.clear();
    for (const id of ids) this.merged.set(id, new Uint8Array(DMX_UNIVERSE_SIZE));
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
    {
      const playlistIds = new Set(project.playlists.map((p) => p.id));
      for (const id of this.lastPlaylistIndex.keys()) {
        if (!playlistIds.has(id)) this.lastPlaylistIndex.delete(id);
      }
    }
    if (this.playlistRt !== null) {
      const fresh = project.playlists.find((p) => p.id === this.playlistRt!.playlist.id);
      if (!fresh || fresh.items.length === 0) {
        this.playlistRt = null;
        this.version++;
      } else {
        this.playlistRt.playlist = fresh;
        if (this.playlistRt.itemIndex >= fresh.items.length) this.playlistRt.itemIndex = 0;
        // Текущее шоу удалили из проекта — переходим к следующему элементу на ближайшем тике.
        if (this.showRt === null && this.playlistRt.gapUntilMs === null) this.playlistRt.gapUntilMs = 0;
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
    this.startAt(sequenceId, 0, false, nowMs);
  }

  /**
   * Запустить секвенсор С ЗАДАННОГО ШАГА. Обычный `start` — это `startAt` с
   * нулевого.
   *
   * Нужно для переноса состояния при смене места расчёта (главный поток ↔
   * отдельный): секвенсор, идущий на седьмом шаге, обязан продолжить с
   * седьмого, а не прыгнуть на первый. Внутри шага позиция не переносится — шаг
   * начинается заново; это заметно только на очень длинных шагах и несравнимо
   * лучше, чем остановка всего воспроизведения.
   */
  startAt(sequenceId: string, stepIndex: number, paused: boolean, nowMs: number): void {
    const sequence = this.project?.sequences.find((q) => q.id === sequenceId);
    if (!sequence || sequence.steps.length === 0) return;
    this.stop(sequenceId);
    const step = Math.max(0, Math.min(sequence.steps.length - 1, Math.round(stepIndex)));
    this.running.push({
      sequence,
      stepIndex: step,
      paused,
      stepStartMs: nowMs,
      pausedElapsedMs: 0,
      fadeFrom: new Map(),
      levels: new Map(),
      smoothed: new Map(),
      lastTickMs: null,
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

  // ── Группы секвенсоров (§27 доработки) ──────────────────────────────────────
  // «Сделать правильно» синхронный/параллельный запуск: просто вызываем
  // start/stop/pause/resume на каждом участнике В ОДНОМ вызове (один и тот же
  // nowMs). Наши секвенсоры считают elapsed от абсолютного nowMs, не копят
  // дельты тик-к-тику — участники, стартовавшие в общий момент, физически не
  // могут разойтись по времени. Никакой отдельной машины синхронизации не
  // нужно, и разойтись они уже не смогут даже за часы работы.

  private findGroup(groupId: string): SequenceGroup | null {
    return this.project?.sequenceGroups.find((g) => g.id === groupId) ?? null;
  }

  startGroup(groupId: string, nowMs: number): void {
    const group = this.findGroup(groupId);
    if (!group) return;
    for (const id of group.sequenceIds) this.start(id, nowMs);
  }

  stopGroup(groupId: string): void {
    const group = this.findGroup(groupId);
    if (!group) return;
    for (const id of group.sequenceIds) this.stop(id);
  }

  pauseGroup(groupId: string, nowMs: number): void {
    const group = this.findGroup(groupId);
    if (!group) return;
    for (const id of group.sequenceIds) this.pause(id, nowMs);
  }

  resumeGroup(groupId: string, nowMs: number): void {
    const group = this.findGroup(groupId);
    if (!group) return;
    for (const id of group.sequenceIds) this.resume(id, nowMs);
  }

  stopAll(): void {
    if (this.running.length === 0 && this.activeSceneId === null && this.showRt === null && this.playlistRt === null)
      return;
    this.running = [];
    this.activeSceneId = null;
    this.showRt = null;
    if (this.playlistRt !== null) {
      this.lastPlaylistIndex.set(this.playlistRt.playlist.id, this.playlistRt.itemIndex);
      this.onShowAudio?.(null);
    }
    this.playlistRt = null;
    this.version++;
  }

  // ── Транспорт плейлиста (движок — мастер-часы, аудио — системный плеер) ────

  playPlaylist(playlistId: string, itemIndex: number | undefined, nowMs: number): void {
    const playlist = this.project?.playlists.find((p) => p.id === playlistId);
    if (!playlist || playlist.items.length === 0) return;
    // «resume» — продолжить с места прошлой остановки, если явный itemIndex не задан.
    const fallback = playlist.onStart === 'resume' ? (this.lastPlaylistIndex.get(playlistId) ?? 0) : 0;
    const idx = Math.min(Math.max(0, itemIndex ?? fallback), playlist.items.length - 1);
    this.playlistRt = { playlist, itemIndex: idx, gapUntilMs: null };
    this.startPlaylistItem(nowMs);
  }

  skipPlaylist(dir: 1 | -1, nowMs: number): void {
    const rt = this.playlistRt;
    if (!rt) return;
    const n = rt.playlist.items.length;
    rt.itemIndex = (rt.itemIndex + dir + n) % n;
    this.startPlaylistItem(nowMs);
  }

  stopPlaylist(): void {
    if (this.playlistRt === null) return;
    this.lastPlaylistIndex.set(this.playlistRt.playlist.id, this.playlistRt.itemIndex);
    this.playlistRt = null;
    this.showRt = null;
    this.version++;
    this.onShowAudio?.(null);
  }

  /** Запускает текущий элемент плейлиста; битые элементы пропускает (максимум один круг). */
  private startPlaylistItem(nowMs: number): void {
    const rt = this.playlistRt;
    if (!rt || !this.project) return;
    for (let tries = 0; tries < rt.playlist.items.length; tries++) {
      const item = rt.playlist.items[rt.itemIndex]!;
      const show = this.project.shows.find((s) => s.id === item.showId);
      if (show && show.durationMs > 0) {
        rt.gapUntilMs = null;
        this.showRt = { show, playing: true, posAtAnchorMs: 0, anchorMs: nowMs };
        this.version++;
        this.onShowAudio?.(show);
        return;
      }
      if (rt.itemIndex + 1 >= rt.playlist.items.length && rt.playlist.mode !== 'loop') break;
      rt.itemIndex = (rt.itemIndex + 1) % rt.playlist.items.length;
    }
    this.stopPlaylist();
  }

  /** Конец паузы между шоу — переход к следующему элементу или завершение. */
  private advancePlaylistIfDue(nowMs: number): void {
    const rt = this.playlistRt;
    if (!rt || rt.gapUntilMs === null || nowMs < rt.gapUntilMs) return;
    const last = rt.itemIndex + 1 >= rt.playlist.items.length;
    if (last && rt.playlist.mode !== 'loop') {
      // Плейлист доигран целиком (не прерван) — «resume» в следующий раз
      // должен начинать сначала, а не намертво повторять последний пункт.
      const playlistId = rt.playlist.id;
      this.stopPlaylist();
      this.lastPlaylistIndex.set(playlistId, 0);
    } else {
      rt.itemIndex = (rt.itemIndex + 1) % rt.playlist.items.length;
      this.startPlaylistItem(nowMs);
    }
  }

  /** Ручное управление шоу из редактора перехватывает воспроизведение у плейлиста. */
  private releasePlaylist(): void {
    if (this.playlistRt === null) return;
    this.lastPlaylistIndex.set(this.playlistRt.playlist.id, this.playlistRt.itemIndex);
    this.playlistRt = null;
    this.version++;
    this.onShowAudio?.(null);
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
    this.releasePlaylist();
    this.showRt = { show, playing: true, posAtAnchorMs: Math.max(0, positionMs), anchorMs: nowMs };
    this.version++;
  }

  pauseShow(nowMs: number): void {
    const rt = this.showRt;
    if (!rt || !rt.playing) return;
    this.releasePlaylist();
    rt.posAtAnchorMs = this.showPosition(nowMs);
    rt.playing = false;
    this.version++;
  }

  seekShow(positionMs: number, nowMs: number): void {
    const rt = this.showRt;
    if (!rt) return;
    this.releasePlaylist();
    rt.posAtAnchorMs = Math.max(0, positionMs);
    rt.anchorMs = nowMs;
    this.version++;
  }

  /** Коррекция по аудио-часам редактора: якорь переставляется без остановки. */
  syncShow(positionMs: number, nowMs: number): void {
    const rt = this.showRt;
    // При активном плейлисте мастер-часы — движок, коррекция редактора не применяется.
    if (!rt || !rt.playing || this.playlistRt !== null) return;
    rt.posAtAnchorMs = Math.max(0, positionMs);
    rt.anchorMs = nowMs;
  }

  stopShow(): void {
    this.releasePlaylist();
    if (this.showRt === null) return;
    this.showRt = null;
    this.version++;
  }

  showState(nowMs: number): ShowTransportState | null {
    const rt = this.showRt;
    if (!rt) return null;
    return { showId: rt.show.id, positionMs: Math.round(this.showPosition(nowMs)), playing: rt.playing };
  }

  playlistState(): PlaylistTransportState | null {
    const rt = this.playlistRt;
    if (!rt) return null;
    return { playlistId: rt.playlist.id, itemIndex: rt.itemIndex, inGap: rt.gapUntilMs !== null };
  }

  state(nowMs: number, pausedAll: boolean): PlaybackState {
    return {
      activeSceneId: this.activeSceneId,
      running: this.running.map((r) => ({
        sequenceId: r.sequence.id,
        stepIndex: r.stepIndex,
        paused: r.paused,
      })),
      show: this.showState(nowMs),
      playlist: this.playlistState(),
      pausedAll,
      playlistPositions: Object.fromEntries(this.lastPlaylistIndex),
    };
  }

  /** Пересчитывает слой воспроизведения на момент nowMs. */
  tick(nowMs: number): void {
    this.advancePlaylistIfDue(nowMs);
    for (const buf of this.merged.values()) buf.fill(0);

    // Холостая сцена (§27 доработки, по примеру прежнего приложения —
    // «Color Form») — только когда действительно ничего не запущено; пауза
    // между элементами плейлиста — намеренное затемнение, туда не подставляем.
    if (
      this.activeSceneId === null &&
      this.running.length === 0 &&
      this.showRt === null &&
      this.playlistRt === null &&
      this.project?.idleSceneId
    ) {
      const idle = this.compiled.get(this.project.idleSceneId);
      if (idle) {
        for (const [universe, target] of idle) {
          this.merged.get(universe)?.set(target);
        }
      }
    }

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
      // Эффект плавности секвенсора (§27 доработки, УХ п.16): sequence.effect
      // сглаживает то, что реально идёт на выход, отдельно от «сырого» levels
      // (тот остаётся честным fadeFrom-снимком для следующего шага).
      const mode = r.sequence.effect?.mode ?? 'quick';
      const smoothness = r.sequence.effect?.smoothness ?? SMOOTHNESS_DEFAULT;
      const dtMs = r.lastTickMs === null ? 0 : nowMs - r.lastTickMs;
      r.lastTickMs = nowMs;
      for (const universe of this.universeIds) {
        const levels = getOrCreate(r.levels, universe);
        const from = r.fadeFrom.get(universe);
        const targetBuf = target?.get(universe);
        for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
          const a = from?.[i] ?? 0;
          const b = targetBuf?.[i] ?? 0;
          levels[i] = a + (b - a) * t;
        }
        const smoothed = getOrCreate(r.smoothed, universe);
        const out = this.merged.get(universe)!;
        for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
          const raw = levels[i]!;
          const v = mode === 'quick' || dtMs === 0 ? raw : smoothStep(smoothed[i]!, raw, mode, smoothness, dtMs);
          smoothed[i] = v;
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
      const prt = this.playlistRt;
      if (prt && prt.gapUntilMs === null) {
        // Шоу в плейлисте закончилось — пауза между элементами, затем следующий.
        const item = prt.playlist.items[prt.itemIndex];
        prt.gapUntilMs = nowMs + (item?.gapMs ?? 0);
        this.showRt = null;
        this.version++;
        this.onShowAudio?.(null);
        return;
      }
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
        const zone = activeEffectAt(track.effects, tt);
        if (!zone) {
          // Как обычно — прямой мердж по HTP в общий буфер, без сглаживания.
          for (const block of track.blocks) {
            const local = tt - block.startMs;
            if (local < 0 || local >= block.durationMs) continue;
            const gain = blockFadeGain(block, local);
            if (gain <= 0) continue;
            if (block.type === 'scene') {
              const scene = this.compiled.get(block.refId);
              if (scene) this.mergeScaled(scene, gain, this.merged);
            } else {
              const seq = this.project.sequences.find((q) => q.id === block.refId);
              if (seq && seq.steps.length > 0) this.mergeSequenceAt(seq, local, gain, this.merged);
            }
          }
        } else {
          // В зоне эффекта: вклад ЭТОЙ дорожки считаем отдельно (свой scratch,
          // HTP внутри дорожки, если блоки перекрылись), сглаживаем, и только
          // потом мерджим сглаженный результат в общий буфер.
          const scratch = new Map<number, Uint8Array>();
          for (const id of this.universeIds) scratch.set(id, new Uint8Array(DMX_UNIVERSE_SIZE));
          for (const block of track.blocks) {
            const local = tt - block.startMs;
            if (local < 0 || local >= block.durationMs) continue;
            const gain = blockFadeGain(block, local);
            if (gain <= 0) continue;
            if (block.type === 'scene') {
              const scene = this.compiled.get(block.refId);
              if (scene) this.mergeScaled(scene, gain, scratch);
            } else {
              const seq = this.project.sequences.find((q) => q.id === block.refId);
              if (seq && seq.steps.length > 0) this.mergeSequenceAt(seq, local, gain, scratch);
            }
          }
          let st = this.trackSmoothed.get(track.id);
          const jump = !st || Math.abs(tt - st.lastTt) > 250;
          if (!st) {
            st = { lastTt: tt, levels: new Map() };
            this.trackSmoothed.set(track.id, st);
          }
          const dtMs = jump ? 0 : tt - st.lastTt;
          st.lastTt = tt;
          for (const universe of this.universeIds) {
            const raw = scratch.get(universe)!;
            const levels = getOrCreate(st.levels, universe);
            const out = this.merged.get(universe)!;
            for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
              const v = jump || dtMs === 0 ? raw[i]! : smoothStep(levels[i]!, raw[i]!, zone.mode, zone.smoothness, dtMs);
              levels[i] = v;
              if (v > out[i]!) out[i] = Math.round(v);
            }
          }
        }
      }
    }
  }

  private mergeScaled(scene: CompiledScene, gain: number, target: Map<number, Uint8Array>): void {
    for (const [universe, buf] of scene) {
      const out = target.get(universe);
      if (!out) continue;
      for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
        const v = Math.round(buf[i]! * gain);
        if (v > out[i]!) out[i] = v;
      }
    }
  }

  /** Секвенсор внутри блока шоу: elapsedMs однозначно даёт шаг и фазу фейда. */
  private mergeSequenceAt(seq: Sequence, elapsedMs: number, gain: number, target: Map<number, Uint8Array>): void {
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
      const out = target.get(universe)!;
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
