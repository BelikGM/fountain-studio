"use strict";

// ../engine/src/playbackworker.ts
var import_node_worker_threads = require("node:worker_threads");

// ../shared/src/dmx.ts
var DMX_UNIVERSE_SIZE = 512;

// ../shared/src/show.ts
function envelopeValue(points, tMs) {
  if (points.length === 0) return 0;
  const first = points[0];
  const last = points[points.length - 1];
  if (tMs < first.tMs || tMs > last.tMs) return 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (tMs <= b.tMs) {
      if (b.tMs === a.tMs) return b.value;
      const t = (tMs - a.tMs) / (b.tMs - a.tMs);
      return a.value + (b.value - a.value) * t;
    }
  }
  return last.value;
}
function blockFadeGain(block, localMs) {
  let gain = 1;
  if (block.fadeInMs > 0 && localMs < block.fadeInMs) gain = Math.min(gain, localMs / block.fadeInMs);
  const tail = block.durationMs - localMs;
  if (block.fadeOutMs > 0 && tail < block.fadeOutMs) gain = Math.min(gain, Math.max(0, tail / block.fadeOutMs));
  return Math.max(0, Math.min(1, gain));
}

// ../shared/src/project.ts
var BUILTIN_PROFILES = [
  {
    id: "pump",
    name: "\u041D\u0430\u0441\u043E\u0441 (\u0430\u043D\u0430\u043B\u043E\u0433 0\u2013255)",
    kind: "pump",
    // «Скорость», а не «Мощность»: канал задаёт уставку оборотов (через ПЧ —
    // частоту), а не потребляемую мощность в киловаттах. Мощность насос
    // потребляет сам, в зависимости от режима, и в DMX её не задают. Тем же
    // словом оперирует телеметрия Modbus (speedRpm), так что название сходится
    // с тем, что видно на вкладке насоса.
    channels: [{ name: "\u0421\u043A\u043E\u0440\u043E\u0441\u0442\u044C", role: "intensity" }],
    builtin: true
  },
  {
    id: "valve",
    name: "\u041A\u043B\u0430\u043F\u0430\u043D (\u043E\u0442\u043A\u0440/\u0437\u0430\u043A\u0440)",
    kind: "valve",
    // «Положение» — имя КАНАЛА, а его значения уже «Открыт»/«Закрыт». Раньше
    // канал назывался «Открыт», и в подписях выходило «Клапан 1 · Открыт» —
    // читается как состояние прибора, хотя это столбец управления. С
    // «Положением» строка становится «Клапан 1 · Положение», а открыт он или
    // закрыт — показывает само значение.
    channels: [{ name: "\u041F\u043E\u043B\u043E\u0436\u0435\u043D\u0438\u0435", role: "open" }],
    twoState: true,
    builtin: true
  },
  {
    id: "dimmer",
    name: "\u041E\u0434\u043D\u043E\u043A\u0430\u043D\u0430\u043B\u044C\u043D\u044B\u0439 \u0441\u0432\u0435\u0442",
    kind: "lamp",
    channels: [{ name: "\u042F\u0440\u043A\u043E\u0441\u0442\u044C", role: "intensity" }],
    builtin: true
  },
  {
    id: "rgb",
    name: "\u0421\u0432\u0435\u0442\u0438\u043B\u044C\u043D\u0438\u043A RGB",
    kind: "lamp",
    channels: [
      { name: "R", role: "red" },
      { name: "G", role: "green" },
      { name: "B", role: "blue" }
    ],
    builtin: true
  },
  {
    id: "rgbw",
    name: "\u0421\u0432\u0435\u0442\u0438\u043B\u044C\u043D\u0438\u043A RGBW",
    kind: "lamp",
    channels: [
      { name: "R", role: "red" },
      { name: "G", role: "green" },
      { name: "B", role: "blue" },
      { name: "W", role: "white" }
    ],
    builtin: true
  }
];
function allProfiles(project) {
  const custom = new Map(project.profiles.map((p) => [p.id, p]));
  return [...BUILTIN_PROFILES.filter((p) => !custom.has(p.id)), ...project.profiles];
}
function profileMap(project) {
  return new Map(allProfiles(project).map((p) => [p.id, p]));
}

// ../shared/src/smoothing.ts
function smoothStep(prev, target, mode, strength, dtMs) {
  if (mode === "quick") return target;
  if (mode === "decay" && target >= prev) return target;
  if (dtMs <= 0) return prev;
  const s = Math.max(1, Math.min(100, strength));
  const tauMs = 2e3 / s;
  const k = 1 - Math.exp(-dtMs / tauMs);
  return prev + (target - prev) * k;
}
function activeEffectAt(effects, tMs) {
  for (const e of effects) {
    if (tMs >= e.startMs && tMs < e.endMs) return e;
  }
  return null;
}

// ../engine/src/clock.ts
function emaStep(prev, sample, alpha) {
  return prev < 0 ? sample : prev + alpha * (sample - prev);
}
var Ticker = class _Ticker {
  constructor(intervalMs, spinMs, onTick) {
    this.intervalMs = intervalMs;
    this.spinMs = spinMs;
    this.onTick = onTick;
  }
  running = false;
  n = 0;
  startNs = 0n;
  timer;
  /**
   * avg — EMA, не «сумма/n» за всё время жизни движка: headless-эксплуатация
   * (§9, §18) держит процесс сутками, и один-единственный сбой (сон Windows,
   * зависшая антивирусная проверка, что угодно, остановившее event loop на
   * время) даёт джиттер тика в порядки больше нормы; при кумулятивном среднем
   * такой выброс отравляет «avg» на буквально годы вперёд (при миллионах уже
   * накопленных тиков разбавить его обратно нечем) — показание становится
   * бесполезным навсегда, хотя реальная работа давно в норме. EMA отражает
   * недавнее поведение и отходит от выброса за секунды. max остаётся
   * пожизненным — это осознанно другой вопрос («был ли когда-нибудь сбой»).
   */
  static EMA_ALPHA = 0.01;
  jitterEma = -1;
  jitterMax = 0;
  jitterLast = 0;
  start() {
    if (this.running) return;
    this.running = true;
    this.n = 0;
    this.startNs = process.hrtime.bigint();
    this.jitterEma = -1;
    this.jitterMax = 0;
    this.arm();
  }
  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
  targetNs() {
    return this.startNs + BigInt(this.n + 1) * BigInt(Math.round(this.intervalMs * 1e6));
  }
  arm() {
    const target = this.targetNs();
    const remainingMs = Number(target - process.hrtime.bigint()) / 1e6;
    const sleepMs = remainingMs - this.spinMs;
    if (sleepMs > 1) {
      this.timer = setTimeout(() => this.finish(target), Math.floor(sleepMs));
    } else {
      setImmediate(() => this.finish(target));
    }
  }
  finish(target) {
    if (!this.running) return;
    if (process.hrtime.bigint() < target) {
      setImmediate(() => this.finish(target));
      return;
    }
    this.n++;
    const jitterMs = Number(process.hrtime.bigint() - target) / 1e6;
    this.jitterLast = jitterMs;
    this.jitterEma = emaStep(this.jitterEma, jitterMs, _Ticker.EMA_ALPHA);
    if (jitterMs > this.jitterMax) this.jitterMax = jitterMs;
    try {
      this.onTick(this.n);
    } catch (err) {
      console.error("[ticker] \u043E\u0448\u0438\u0431\u043A\u0430 \u0432 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0447\u0438\u043A\u0435 \u0442\u0438\u043A\u0430:", err);
    }
    this.arm();
  }
  stats() {
    return {
      ticks: this.n,
      intervalMs: this.intervalMs,
      lastJitterMs: round2(this.jitterLast),
      avgJitterMs: this.jitterEma < 0 ? 0 : round2(this.jitterEma),
      maxJitterMs: round2(this.jitterMax)
    };
  }
};
function round2(v) {
  return Math.round(v * 100) / 100;
}

// ../engine/src/playback.ts
var Playback = class {
  constructor(universeIds2) {
    this.universeIds = universeIds2;
    for (const id of universeIds2) this.merged.set(id, new Uint8Array(DMX_UNIVERSE_SIZE));
  }
  project = null;
  compiled = /* @__PURE__ */ new Map();
  deviceSlots = /* @__PURE__ */ new Map();
  activeSceneId = null;
  running = [];
  showRt = null;
  playlistRt = null;
  /**
   * Поведение старта плейлиста «resume» (§27 доработки) — playlistId →
   * последний itemIndex, на котором плейлист был остановлен. Только в
   * памяти движка (как и остальное состояние воспроизведения) — после
   * перезапуска движка плейлист снова начнёт сначала.
   */
  lastPlaylistIndex = /* @__PURE__ */ new Map();
  merged = /* @__PURE__ */ new Map();
  /**
   * Эффект плавности треков шоу (§27 доработки, УХ п.16): состояние фильтра на
   * трек, ключ — id дорожки. lastTt — таймлайн-время (не часы движка) прошлого
   * тика: скраб/перемотка обычно дают скачок tt — обнаруживаем это по разнице
   * и сбрасываем фильтр (сразу честное значение), а не тянем плавность через
   * разрыв (тот самый принцип «стейтлес-рендер» для перемотки, см. renderShow).
   */
  trackSmoothed = /* @__PURE__ */ new Map();
  /** Растёт при любом изменении состояния (транспорт, автопереход шага) — сигнал серверу разослать состояние. */
  version = 0;
  /**
   * Автономное воспроизведение сменило шоу: движку пора запустить (show) или
   * остановить (null) системный аудиоплеер. Назначает точка входа движка.
   */
  onShowAudio = null;
  /**
   * Расчёт идёт здесь же, в главном потоке, поэтому ломаться отдельно от
   * процесса нечему — см. PlaybackSource.healthy.
   */
  healthy = true;
  /**
   * Пауза всего живёт в часах движка: он просто не продвигает nowMs. Здесь
   * делать нечего — метод есть ради общего интерфейса с расчётом в отдельном
   * потоке, где часы свои и про паузу надо сообщать.
   */
  setPausedAll(_paused) {
  }
  /** Закрывать нечего: ни потока, ни файлов. Метод — ради общего интерфейса. */
  dispose() {
  }
  /** Смена набора вселенных на лету (вкладка «Настройки»). Буферы пересоздаются. */
  setUniverses(ids) {
    this.universeIds = [...ids];
    this.merged.clear();
    for (const id of ids) this.merged.set(id, new Uint8Array(DMX_UNIVERSE_SIZE));
  }
  setProject(project) {
    this.project = project;
    this.compiled.clear();
    for (const scene of project.scenes) {
      const compiledScene = /* @__PURE__ */ new Map();
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
          buf[addr] = Math.max(buf[addr], values[k] ?? 0);
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
    if (this.activeSceneId !== null && !this.compiled.has(this.activeSceneId)) {
      this.activeSceneId = null;
      this.version++;
    }
    if (this.showRt !== null) {
      const fresh = project.shows.find((s) => s.id === this.showRt.show.id);
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
      const fresh = project.playlists.find((p) => p.id === this.playlistRt.playlist.id);
      if (!fresh || fresh.items.length === 0) {
        this.playlistRt = null;
        this.version++;
      } else {
        this.playlistRt.playlist = fresh;
        if (this.playlistRt.itemIndex >= fresh.items.length) this.playlistRt.itemIndex = 0;
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
  setScene(sceneId, nowMs2) {
    this.activeSceneId = sceneId !== null && this.compiled.has(sceneId) ? sceneId : null;
    this.version++;
  }
  start(sequenceId, nowMs2) {
    const sequence = this.project?.sequences.find((q) => q.id === sequenceId);
    if (!sequence || sequence.steps.length === 0) return;
    this.stop(sequenceId);
    this.running.push({
      sequence,
      stepIndex: 0,
      paused: false,
      stepStartMs: nowMs2,
      pausedElapsedMs: 0,
      fadeFrom: /* @__PURE__ */ new Map(),
      levels: /* @__PURE__ */ new Map(),
      smoothed: /* @__PURE__ */ new Map(),
      lastTickMs: null
    });
    this.version++;
  }
  pause(sequenceId, nowMs2) {
    const r = this.running.find((x) => x.sequence.id === sequenceId);
    if (!r || r.paused) return;
    r.pausedElapsedMs = nowMs2 - r.stepStartMs;
    r.paused = true;
    this.version++;
  }
  resume(sequenceId, nowMs2) {
    const r = this.running.find((x) => x.sequence.id === sequenceId);
    if (!r || !r.paused) return;
    r.stepStartMs = nowMs2 - r.pausedElapsedMs;
    r.paused = false;
    this.version++;
  }
  stop(sequenceId) {
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
  findGroup(groupId) {
    return this.project?.sequenceGroups.find((g) => g.id === groupId) ?? null;
  }
  startGroup(groupId, nowMs2) {
    const group = this.findGroup(groupId);
    if (!group) return;
    for (const id of group.sequenceIds) this.start(id, nowMs2);
  }
  stopGroup(groupId) {
    const group = this.findGroup(groupId);
    if (!group) return;
    for (const id of group.sequenceIds) this.stop(id);
  }
  pauseGroup(groupId, nowMs2) {
    const group = this.findGroup(groupId);
    if (!group) return;
    for (const id of group.sequenceIds) this.pause(id, nowMs2);
  }
  resumeGroup(groupId, nowMs2) {
    const group = this.findGroup(groupId);
    if (!group) return;
    for (const id of group.sequenceIds) this.resume(id, nowMs2);
  }
  stopAll() {
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
  playPlaylist(playlistId, itemIndex, nowMs2) {
    const playlist = this.project?.playlists.find((p) => p.id === playlistId);
    if (!playlist || playlist.items.length === 0) return;
    const fallback = playlist.onStart === "resume" ? this.lastPlaylistIndex.get(playlistId) ?? 0 : 0;
    const idx = Math.min(Math.max(0, itemIndex ?? fallback), playlist.items.length - 1);
    this.playlistRt = { playlist, itemIndex: idx, gapUntilMs: null };
    this.startPlaylistItem(nowMs2);
  }
  skipPlaylist(dir, nowMs2) {
    const rt = this.playlistRt;
    if (!rt) return;
    const n = rt.playlist.items.length;
    rt.itemIndex = (rt.itemIndex + dir + n) % n;
    this.startPlaylistItem(nowMs2);
  }
  stopPlaylist() {
    if (this.playlistRt === null) return;
    this.lastPlaylistIndex.set(this.playlistRt.playlist.id, this.playlistRt.itemIndex);
    this.playlistRt = null;
    this.showRt = null;
    this.version++;
    this.onShowAudio?.(null);
  }
  /** Запускает текущий элемент плейлиста; битые элементы пропускает (максимум один круг). */
  startPlaylistItem(nowMs2) {
    const rt = this.playlistRt;
    if (!rt || !this.project) return;
    for (let tries = 0; tries < rt.playlist.items.length; tries++) {
      const item = rt.playlist.items[rt.itemIndex];
      const show = this.project.shows.find((s) => s.id === item.showId);
      if (show && show.durationMs > 0) {
        rt.gapUntilMs = null;
        this.showRt = { show, playing: true, posAtAnchorMs: 0, anchorMs: nowMs2 };
        this.version++;
        this.onShowAudio?.(show);
        return;
      }
      if (rt.itemIndex + 1 >= rt.playlist.items.length && rt.playlist.mode !== "loop") break;
      rt.itemIndex = (rt.itemIndex + 1) % rt.playlist.items.length;
    }
    this.stopPlaylist();
  }
  /** Конец паузы между шоу — переход к следующему элементу или завершение. */
  advancePlaylistIfDue(nowMs2) {
    const rt = this.playlistRt;
    if (!rt || rt.gapUntilMs === null || nowMs2 < rt.gapUntilMs) return;
    const last = rt.itemIndex + 1 >= rt.playlist.items.length;
    if (last && rt.playlist.mode !== "loop") {
      const playlistId = rt.playlist.id;
      this.stopPlaylist();
      this.lastPlaylistIndex.set(playlistId, 0);
    } else {
      rt.itemIndex = (rt.itemIndex + 1) % rt.playlist.items.length;
      this.startPlaylistItem(nowMs2);
    }
  }
  /** Ручное управление шоу из редактора перехватывает воспроизведение у плейлиста. */
  releasePlaylist() {
    if (this.playlistRt === null) return;
    this.lastPlaylistIndex.set(this.playlistRt.playlist.id, this.playlistRt.itemIndex);
    this.playlistRt = null;
    this.version++;
    this.onShowAudio?.(null);
  }
  // ── Транспорт шоу ──────────────────────────────────────────────────────────
  showPosition(nowMs2) {
    const rt = this.showRt;
    if (!rt) return 0;
    return rt.playing ? rt.posAtAnchorMs + (nowMs2 - rt.anchorMs) : rt.posAtAnchorMs;
  }
  playShow(showId, positionMs, nowMs2) {
    const show = this.project?.shows.find((s) => s.id === showId);
    if (!show) return;
    this.releasePlaylist();
    this.showRt = { show, playing: true, posAtAnchorMs: Math.max(0, positionMs), anchorMs: nowMs2 };
    this.version++;
  }
  pauseShow(nowMs2) {
    const rt = this.showRt;
    if (!rt || !rt.playing) return;
    this.releasePlaylist();
    rt.posAtAnchorMs = this.showPosition(nowMs2);
    rt.playing = false;
    this.version++;
  }
  seekShow(positionMs, nowMs2) {
    const rt = this.showRt;
    if (!rt) return;
    this.releasePlaylist();
    rt.posAtAnchorMs = Math.max(0, positionMs);
    rt.anchorMs = nowMs2;
    this.version++;
  }
  /** Коррекция по аудио-часам редактора: якорь переставляется без остановки. */
  syncShow(positionMs, nowMs2) {
    const rt = this.showRt;
    if (!rt || !rt.playing || this.playlistRt !== null) return;
    rt.posAtAnchorMs = Math.max(0, positionMs);
    rt.anchorMs = nowMs2;
  }
  stopShow() {
    this.releasePlaylist();
    if (this.showRt === null) return;
    this.showRt = null;
    this.version++;
  }
  showState(nowMs2) {
    const rt = this.showRt;
    if (!rt) return null;
    return { showId: rt.show.id, positionMs: Math.round(this.showPosition(nowMs2)), playing: rt.playing };
  }
  playlistState() {
    const rt = this.playlistRt;
    if (!rt) return null;
    return { playlistId: rt.playlist.id, itemIndex: rt.itemIndex, inGap: rt.gapUntilMs !== null };
  }
  state(nowMs2, pausedAll2) {
    return {
      activeSceneId: this.activeSceneId,
      running: this.running.map((r) => ({
        sequenceId: r.sequence.id,
        stepIndex: r.stepIndex,
        paused: r.paused
      })),
      show: this.showState(nowMs2),
      playlist: this.playlistState(),
      pausedAll: pausedAll2
    };
  }
  /** Пересчитывает слой воспроизведения на момент nowMs. */
  tick(nowMs2) {
    this.advancePlaylistIfDue(nowMs2);
    for (const buf of this.merged.values()) buf.fill(0);
    if (this.activeSceneId === null && this.running.length === 0 && this.showRt === null && this.playlistRt === null && this.project?.idleSceneId) {
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
          const out = this.merged.get(universe);
          for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
            if (target[i] > out[i]) out[i] = target[i];
          }
        }
      }
    }
    const finished = [];
    for (const r of this.running) {
      this.advance(r, nowMs2, finished);
      const step = r.sequence.steps[r.stepIndex];
      const target = this.compiled.get(step.sceneId);
      const elapsed = r.paused ? r.pausedElapsedMs : nowMs2 - r.stepStartMs;
      const t = step.fadeMs > 0 ? Math.min(1, Math.max(0, elapsed / step.fadeMs)) : 1;
      const mode = r.sequence.effect?.mode ?? "quick";
      const strength = r.sequence.effect?.strength ?? 50;
      const dtMs = r.lastTickMs === null ? 0 : nowMs2 - r.lastTickMs;
      r.lastTickMs = nowMs2;
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
        const out = this.merged.get(universe);
        for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
          const raw = levels[i];
          const v = mode === "quick" || dtMs === 0 ? raw : smoothStep(smoothed[i], raw, mode, strength, dtMs);
          smoothed[i] = v;
          if (v > out[i]) out[i] = Math.round(v);
        }
      }
    }
    if (finished.length > 0) {
      this.running = this.running.filter((r) => !finished.includes(r.sequence.id));
      this.version++;
    }
    this.renderShow(nowMs2);
  }
  /**
   * Слой шоу: позиция таймлайна однозначно определяет картинку (стейтлес) —
   * скраб/перемотка сразу показывают верное состояние. Рисуем и на паузе.
   */
  renderShow(nowMs2) {
    const rt = this.showRt;
    if (!rt || !this.project) return;
    let pos = this.showPosition(nowMs2);
    if (rt.playing && rt.show.durationMs > 0 && pos >= rt.show.durationMs) {
      const prt = this.playlistRt;
      if (prt && prt.gapUntilMs === null) {
        const item = prt.playlist.items[prt.itemIndex];
        prt.gapUntilMs = nowMs2 + (item?.gapMs ?? 0);
        this.showRt = null;
        this.version++;
        this.onShowAudio?.(null);
        return;
      }
      rt.posAtAnchorMs = rt.show.durationMs;
      rt.playing = false;
      pos = rt.show.durationMs;
      this.version++;
    }
    for (const track of rt.show.tracks) {
      if (track.muted) continue;
      const tt = pos + track.offsetMs;
      if (track.kind === "envelope") {
        const v = Math.round(envelopeValue(track.points, tt));
        if (v <= 0) continue;
        const slot = this.deviceSlots.get(track.deviceId);
        if (!slot || track.channel >= slot.channels) continue;
        const out = this.merged.get(slot.universe);
        const addr = slot.address - 1 + track.channel;
        if (!out || addr < 0 || addr >= DMX_UNIVERSE_SIZE) continue;
        if (v > out[addr]) out[addr] = v;
      } else {
        const zone = activeEffectAt(track.effects, tt);
        if (!zone) {
          for (const block of track.blocks) {
            const local = tt - block.startMs;
            if (local < 0 || local >= block.durationMs) continue;
            const gain = blockFadeGain(block, local);
            if (gain <= 0) continue;
            if (block.type === "scene") {
              const scene = this.compiled.get(block.refId);
              if (scene) this.mergeScaled(scene, gain, this.merged);
            } else {
              const seq = this.project.sequences.find((q) => q.id === block.refId);
              if (seq && seq.steps.length > 0) this.mergeSequenceAt(seq, local, gain, this.merged);
            }
          }
        } else {
          const scratch = /* @__PURE__ */ new Map();
          for (const id of this.universeIds) scratch.set(id, new Uint8Array(DMX_UNIVERSE_SIZE));
          for (const block of track.blocks) {
            const local = tt - block.startMs;
            if (local < 0 || local >= block.durationMs) continue;
            const gain = blockFadeGain(block, local);
            if (gain <= 0) continue;
            if (block.type === "scene") {
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
            st = { lastTt: tt, levels: /* @__PURE__ */ new Map() };
            this.trackSmoothed.set(track.id, st);
          }
          const dtMs = jump ? 0 : tt - st.lastTt;
          st.lastTt = tt;
          for (const universe of this.universeIds) {
            const raw = scratch.get(universe);
            const levels = getOrCreate(st.levels, universe);
            const out = this.merged.get(universe);
            for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
              const v = jump || dtMs === 0 ? raw[i] : smoothStep(levels[i], raw[i], zone.mode, zone.strength, dtMs);
              levels[i] = v;
              if (v > out[i]) out[i] = Math.round(v);
            }
          }
        }
      }
    }
  }
  mergeScaled(scene, gain, target) {
    for (const [universe, buf] of scene) {
      const out = target.get(universe);
      if (!out) continue;
      for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
        const v = Math.round(buf[i] * gain);
        if (v > out[i]) out[i] = v;
      }
    }
  }
  /** Секвенсор внутри блока шоу: elapsedMs однозначно даёт шаг и фазу фейда. */
  mergeSequenceAt(seq, elapsedMs, gain, target) {
    const total = seq.steps.reduce((s, st) => s + st.holdMs, 0);
    if (total <= 0) return;
    let e;
    let firstPass;
    if (seq.mode === "loop") {
      firstPass = elapsedMs < total;
      e = elapsedMs % total;
    } else {
      firstPass = true;
      e = Math.min(elapsedMs, total - 1);
    }
    let idx = 0;
    let acc = 0;
    for (let i = 0; i < seq.steps.length; i++) {
      if (e < acc + seq.steps[i].holdMs) {
        idx = i;
        break;
      }
      acc += seq.steps[i].holdMs;
    }
    const step = seq.steps[idx];
    const stepElapsed = e - acc;
    const t = step.fadeMs > 0 ? Math.min(1, stepElapsed / step.fadeMs) : 1;
    const cur = this.compiled.get(step.sceneId);
    const prevIdx = idx > 0 ? idx - 1 : firstPass ? -1 : seq.steps.length - 1;
    const prev = prevIdx >= 0 ? this.compiled.get(seq.steps[prevIdx].sceneId) : void 0;
    for (const universe of this.universeIds) {
      const out = target.get(universe);
      const a = prev?.get(universe);
      const b = cur?.get(universe);
      if (!a && !b) continue;
      for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
        const av = a ? a[i] : 0;
        const bv = b ? b[i] : 0;
        const v = Math.round((av + (bv - av) * t) * gain);
        if (v > out[i]) out[i] = v;
      }
    }
  }
  /** Переходы шагов: возможно, прошло несколько шагов за один тик. */
  advance(r, nowMs2, finished) {
    if (r.paused) return;
    for (; ; ) {
      const step = r.sequence.steps[r.stepIndex];
      const elapsed = nowMs2 - r.stepStartMs;
      if (elapsed < step.holdMs) return;
      const isLast = r.stepIndex === r.sequence.steps.length - 1;
      if (isLast && r.sequence.mode === "once") {
        finished.push(r.sequence.id);
        return;
      }
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
  levels(universeId) {
    return this.merged.get(universeId);
  }
};
function getOrCreate(map, universe) {
  let arr = map.get(universe);
  if (!arr) {
    arr = new Float32Array(DMX_UNIVERSE_SIZE);
    map.set(universe, arr);
  }
  return arr;
}

// ../engine/src/playbacksource.ts
var WORKER_MAX_UNIVERSES = 64;
var WORKER_FRAMES_OFFSET = 3 /* Size */ * 4;

// ../engine/src/playbackworker.ts
var init = import_node_worker_threads.workerData;
var port = import_node_worker_threads.parentPort;
if (!port) throw new Error("playbackworker: \u0437\u0430\u043F\u0443\u0449\u0435\u043D \u043D\u0435 \u043A\u0430\u043A worker_threads");
var header = new Int32Array(init.buffer, 0, 3 /* Size */);
var frames = new Uint8Array(init.buffer, WORKER_FRAMES_OFFSET, WORKER_MAX_UNIVERSES * DMX_UNIVERSE_SIZE);
var universeIds = [...init.universeIds];
var playback = new Playback(universeIds);
playback.onShowAudio = (show) => post({ e: "showAudio", show });
var pausedAll = false;
var pauseOffsetMs = 0;
var nowMs = 0;
var lastVersion = -1;
var lastStateJson = "";
function post(e) {
  port.postMessage(e);
}
function publish() {
  Atomics.add(header, 0 /* Seq */, 1);
  const count = Math.min(universeIds.length, WORKER_MAX_UNIVERSES);
  for (let i = 0; i < count; i++) {
    const lv = playback.levels(universeIds[i]);
    const at = i * DMX_UNIVERSE_SIZE;
    if (lv) frames.set(lv, at);
    else frames.fill(0, at, at + DMX_UNIVERSE_SIZE);
  }
  Atomics.store(header, 1 /* Count */, count);
  Atomics.add(header, 2 /* Ticks */, 1);
  Atomics.add(header, 0 /* Seq */, 1);
}
function publishState() {
  const state = playback.state(nowMs, pausedAll);
  const json = JSON.stringify(state);
  if (playback.version === lastVersion && json === lastStateJson) return;
  lastVersion = playback.version;
  lastStateJson = json;
  post({ e: "state", state, version: playback.version });
}
var ticker = new Ticker(init.tickMs, init.spinMs, (n) => {
  if (pausedAll) pauseOffsetMs += init.tickMs;
  nowMs = n * init.tickMs - pauseOffsetMs;
  try {
    playback.tick(nowMs);
  } catch (err) {
    post({ e: "warn", text: `\u043E\u0448\u0438\u0431\u043A\u0430 \u0440\u0430\u0441\u0447\u0451\u0442\u0430 \u043A\u0430\u0434\u0440\u0430: ${String(err)}` });
  }
  publish();
  publishState();
});
port.on("message", (msg) => {
  try {
    apply(msg);
  } catch (err) {
    post({ e: "warn", text: `\u043E\u0448\u0438\u0431\u043A\u0430 \u043A\u043E\u043C\u0430\u043D\u0434\u044B ${msg.c}: ${String(err)}` });
  }
});
function apply(msg) {
  switch (msg.c) {
    case "setUniverses":
      universeIds = [...msg.ids];
      playback.setUniverses(msg.ids);
      return;
    case "setProject":
      playback.setProject(msg.project);
      return;
    case "setPausedAll":
      pausedAll = msg.paused;
      return;
    case "setScene":
      playback.setScene(msg.sceneId, nowMs);
      return;
    case "start":
      playback.start(msg.id, nowMs);
      return;
    case "pause":
      playback.pause(msg.id, nowMs);
      return;
    case "resume":
      playback.resume(msg.id, nowMs);
      return;
    case "stop":
      playback.stop(msg.id);
      return;
    case "startGroup":
      playback.startGroup(msg.id, nowMs);
      return;
    case "stopGroup":
      playback.stopGroup(msg.id);
      return;
    case "pauseGroup":
      playback.pauseGroup(msg.id, nowMs);
      return;
    case "resumeGroup":
      playback.resumeGroup(msg.id, nowMs);
      return;
    case "stopAll":
      playback.stopAll();
      return;
    case "playPlaylist":
      playback.playPlaylist(msg.id, msg.itemIndex, nowMs);
      return;
    case "skipPlaylist":
      playback.skipPlaylist(msg.dir, nowMs);
      return;
    case "stopPlaylist":
      playback.stopPlaylist();
      return;
    case "playShow":
      playback.playShow(msg.id, msg.positionMs, nowMs);
      return;
    case "pauseShow":
      playback.pauseShow(nowMs);
      return;
    case "seekShow":
      playback.seekShow(msg.positionMs, nowMs);
      return;
    case "syncShow":
      playback.syncShow(msg.positionMs, nowMs);
      return;
    case "stopShow":
      playback.stopShow();
      return;
    case "shutdown":
      ticker.stop();
      port.close();
      return;
  }
}
ticker.start();
post({ e: "ready" });
