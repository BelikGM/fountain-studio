import {
  DMX_UNIVERSE_SIZE,
  clampDmx,
  computeWindLimitPercent,
  defaultUtilityLightConfig,
  defaultWindLimitConfig,
  isUtilityLightOn,
  profileMap,
  type ChannelTrim,
  type EngineStats,
  type ModbusState,
  type PlaybackState,
  type Project,
  type TestPatternMode,
  type UniverseInfo,
  type UtilityLightConfig,
  type WindLimitConfig,
} from '@fountain-studio/shared';
import { Ticker } from './clock';
import { eventLog } from './eventlog';
import type { EngineConfig, OutputConfig } from './config';
import { ArtNetOutput } from './drivers/artnet';
import { SacnOutput } from './drivers/sacn';
import { UsbDmxOutput } from './drivers/usb-dmx';
import type { UniverseOutput } from './drivers/output';
import { Playback } from './playback';
import { PumpModbusManager } from './pumpmodbus';

interface UniverseState {
  id: number;
  label: string;
  /** Ручные уровни (слой live-управления из UI). */
  manual: Uint8Array;
  /** Итоговый кадр, уходящий в выходы и визуализацию. */
  out: Uint8Array;
  outputs: UniverseOutput[];
}

/**
 * Движок реального времени. Каждый тик собирает итоговый кадр каждой вселенной
 * и отправляет его во все настроенные выходы. Кадры шлются каждый тик даже без
 * изменений — это keep-alive для нод и гарантия равномерного потока.
 */
export class Engine {
  readonly universes: UniverseState[] = [];
  readonly playback: Playback;
  /** Насосы с прямым управлением по Modbus (§12 п.9) — читают то же u.out, что уходит в DMX. */
  readonly pumps = new PumpModbusManager();
  private ticker: Ticker;
  private pattern: TestPatternMode = 'off';
  private framesSent = 0;
  /** Часы движка: время последнего тика (n * tickMs), мс. */
  private nowMs = 0;
  /**
   * Пауза всего (§27 доработки, УХ п.1): в отличие от blackout не гасит каналы,
   * а замораживает картину и таймеры. Реализация — не продвигать nowMs, пока
   * пауза активна: playback.tick(nowMs) с неизменным nowMs не меняет позиции
   * шагов/огибающих, HTP-слияние и тест-паттерн (тоже от nowMs) замирают сами,
   * без отдельной логики заморозки внутри Playback. pauseOffsetMs накапливает
   * «упущенное» время тикера, чтобы после resumeAll часы продолжили с того же
   * места, а не скачком вперёд на длительность паузы.
   */
  private paused = false;
  private pauseOffsetMs = 0;
  /** Калибровка каналов из патча: universeId → (адрес-1 → min/max). */
  private trims = new Map<number, Map<number, ChannelTrim>>();
  /** Устройства с modbus-конфигом: индекс вселенной в this.universes + адрес-1. */
  private modbusPumps: { universeIndex: number; addressIdx: number; deviceId: string }[] = [];
  /**
   * Безопасное снижение струй по ветру (§27 доработки, §4 п.1): только каналы
   * intensity устройств-насосов (kind='pump') — свет не трогаем. universeId →
   * набор индексов адресов (адрес-1).
   */
  private pumpChannels = new Map<number, Set<number>>();
  /**
   * Клапан следует за насосом (§27 доработки, «Influence: Valve by Pump») —
   * universeId → пары индексов адресов (адрес-1) клапан/насос из форсунок с
   * layout.nozzles[].valveFollowsPump=true. Применяется последним шагом на
   * тике, переопределяя любое другое значение клапана.
   */
  private valveFollowsPump = new Map<number, { valveIdx: number; pumpIdx: number }[]>();
  /**
   * Служебное освещение по времени суток (§27 доработки, «Switches») —
   * universeId → индексы адресов (адрес-1) ВСЕХ каналов выбранных приборов.
   * Форсирует 255 в окне on-off (или всегда, если always) и 0 вне его —
   * независимо от сцен/шоу, последний шаг тика.
   */
  private utilityChannels = new Map<number, Set<number>>();
  private utilityLightConfig: UtilityLightConfig = defaultUtilityLightConfig();
  private windLimitConfig: WindLimitConfig = defaultWindLimitConfig();
  /** Текущее показание скорости ветра, м/с — null, пока никто не ввёл/не прислал. */
  private windSpeed: number | null = null;

  constructor(readonly config: EngineConfig) {
    for (const u of config.universes) {
      this.universes.push({
        id: u.id,
        label: u.label ?? `Вселенная ${u.id}`,
        manual: new Uint8Array(DMX_UNIVERSE_SIZE),
        out: new Uint8Array(DMX_UNIVERSE_SIZE),
        outputs: u.outputs.map(createOutput),
      });
    }
    this.playback = new Playback(this.universes.map((u) => u.id));
    this.ticker = new Ticker(config.timing.tickMs, config.timing.spinMs, (n) => this.tick(n));
  }

  start(): void {
    for (const u of this.universes) {
      for (const o of u.outputs) console.log(`[engine] ${u.label}: ${o.describe()}`);
    }
    this.ticker.start();
    console.log(
      `[engine] тик ${this.config.timing.tickMs} мс (${Math.round(1000 / this.config.timing.tickMs)} Гц), вселенных: ${this.universes.length}`,
    );
  }

  stop(): void {
    this.ticker.stop();
    for (const u of this.universes) for (const o of u.outputs) o.close();
    this.pumps.stop();
  }

  /**
   * Применение новой конфигурации вселенных/тика на лету (вкладка «Настройки»):
   * воспроизведение останавливается, выходы пересоздаются, тикер перезапускается
   * с новым шагом. После вызова нужно повторить setProject (калибровка и Modbus-
   * насосы индексируются по вселенным) — это делает server.ts.
   * Мониторинг сети (ArtPoll/захват) подхватит новые адреса после перезапуска движка.
   */
  applyConfig(universes: EngineConfig['universes'], tickMs: number): void {
    this.playback.stopAll();
    this.ticker.stop();
    for (const u of this.universes) for (const o of u.outputs) o.close();
    this.universes.length = 0;
    for (const u of universes) {
      this.universes.push({
        id: u.id,
        label: u.label ?? `Вселенная ${u.id}`,
        manual: new Uint8Array(DMX_UNIVERSE_SIZE),
        out: new Uint8Array(DMX_UNIVERSE_SIZE),
        outputs: u.outputs.map(createOutput),
      });
    }
    this.config.universes = universes;
    this.config.timing.tickMs = tickMs;
    this.playback.setUniverses(this.universes.map((u) => u.id));
    this.pattern = 'off';
    this.nowMs = 0;
    this.paused = false;
    this.pauseOffsetMs = 0;
    this.ticker = new Ticker(tickMs, this.config.timing.spinMs, (n) => this.tick(n));
    this.ticker.start();
    console.log(
      `[engine] конфигурация применена: тик ${tickMs} мс, вселенных: ${this.universes.length}`,
    );
  }

  private tick(n: number): void {
    if (this.paused) this.pauseOffsetMs += this.config.timing.tickMs;
    this.nowMs = n * this.config.timing.tickMs - this.pauseOffsetMs;
    const tSec = this.nowMs / 1000;
    this.playback.tick(this.nowMs);
    for (let i = 0; i < this.universes.length; i++) {
      const u = this.universes[i]!;
      if (this.pattern === 'off') {
        // Слияние слоёв по HTP: воспроизведение (сцены/секвенсоры) и ручная консоль.
        const pb = this.playback.levels(u.id);
        for (let ch = 0; ch < DMX_UNIVERSE_SIZE; ch++) {
          const p = pb ? pb[ch]! : 0;
          const m = u.manual[ch]!;
          u.out[ch] = p > m ? p : m;
        }
        // Калибровка приборов: 0 остаётся 0 (выключено), 1–255 растягиваются в min–max.
        const trims = this.trims.get(u.id);
        if (trims) {
          for (const [idx, t] of trims) {
            const v = u.out[idx]!;
            if (v > 0) u.out[idx] = Math.round(t.min + (v * (t.max - t.min)) / 255);
          }
        }
        // Безопасное снижение струй по ветру (§27 доработки, §4 п.1) — после
        // калибровки, только каналы intensity насосов; свет не трогаем.
        const windPercent = this.windLimitPercent();
        if (windPercent < 100) {
          const pumpIdx = this.pumpChannels.get(u.id);
          if (pumpIdx) {
            for (const idx of pumpIdx) {
              const v = u.out[idx]!;
              if (v > 0) u.out[idx] = Math.round((v * windPercent) / 100);
            }
          }
        }
        // Клапан следует за насосом (§27 доработки) — последний шаг, после
        // калибровки и ветра, читает уже итоговое значение канала насоса.
        const follows = this.valveFollowsPump.get(u.id);
        if (follows) {
          for (const f of follows) u.out[f.valveIdx] = u.out[f.pumpIdx]! > 0 ? 255 : 0;
        }
        // Служебное освещение по времени (§27 доработки, «Switches») —
        // безусловный оверрайд поверх сцен/шоу, не зависит от воспроизведения.
        if (this.utilityLightConfig.enabled) {
          const idx = this.utilityChannels.get(u.id);
          if (idx) {
            const on = isUtilityLightOn(this.utilityLightConfig, new Date());
            for (const i of idx) u.out[i] = on ? 255 : 0;
          }
        }
      } else {
        fillTestPattern(this.pattern, tSec, i, u.out);
      }
      for (const o of u.outputs) {
        o.send(u.out);
        this.framesSent++;
      }
    }
    // Насосы на Modbus: тот же посчитанный кадр (включая тест-паттерны — пусконаладка),
    // что уходит в DMX-выходы, идёт и на прямое управление ПЧ.
    for (const p of this.modbusPumps) {
      const u = this.universes[p.universeIndex];
      if (u) this.pumps.update(p.deviceId, u.out[p.addressIdx]!);
    }
  }

  setChannel(universeId: number, channel: number, value: number): void {
    const u = this.universes.find((x) => x.id === universeId);
    if (!u || channel < 1 || channel > DMX_UNIVERSE_SIZE) return;
    u.manual[channel - 1] = clampDmx(value);
  }

  setChannels(universeId: number, start: number, values: number[]): void {
    const u = this.universes.find((x) => x.id === universeId);
    if (!u || start < 1) return;
    for (let i = 0; i < values.length && start - 1 + i < DMX_UNIVERSE_SIZE; i++) {
      u.manual[start - 1 + i] = clampDmx(values[i] ?? 0);
    }
  }

  blackout(): void {
    this.pattern = 'off';
    this.paused = false;
    this.playback.stopAll();
    for (const u of this.universes) u.manual.fill(0);
  }

  pauseAll(): void {
    this.paused = true;
  }

  resumeAll(): void {
    this.paused = false;
  }

  // ── Проект и транспорт воспроизведения ────────────────────────────────────

  setProject(project: Project): void {
    this.playback.setProject(project);
    this.trims.clear();
    const profiles = profileMap(project);
    for (const d of project.devices) {
      if (!d.trim) continue;
      const profile = profiles.get(d.profileId);
      if (!profile) continue;
      let map = this.trims.get(d.universe);
      if (!map) {
        map = new Map();
        this.trims.set(d.universe, map);
      }
      for (let k = 0; k < profile.channels.length && k < d.trim.length; k++) {
        const t = d.trim[k]!;
        if (t.min === 0 && t.max === 255) continue;
        const idx = d.address - 1 + k;
        if (idx >= 0 && idx < DMX_UNIVERSE_SIZE) map.set(idx, t);
      }
    }
    this.modbusPumps = [];
    for (const d of project.devices) {
      if (!d.modbus) continue;
      const universeIndex = this.universes.findIndex((u) => u.id === d.universe);
      if (universeIndex < 0) continue;
      this.modbusPumps.push({ universeIndex, addressIdx: d.address - 1, deviceId: d.id });
    }
    this.pumps.setDevices(project.devices);

    this.pumpChannels.clear();
    for (const d of project.devices) {
      const profile = profiles.get(d.profileId);
      if (!profile || profile.kind !== 'pump') continue;
      let set = this.pumpChannels.get(d.universe);
      if (!set) {
        set = new Set();
        this.pumpChannels.set(d.universe, set);
      }
      for (let k = 0; k < profile.channels.length; k++) {
        if (profile.channels[k]!.role !== 'intensity') continue;
        const idx = d.address - 1 + k;
        if (idx >= 0 && idx < DMX_UNIVERSE_SIZE) set.add(idx);
      }
    }
    this.windLimitConfig = project.windLimit;

    this.valveFollowsPump.clear();
    const deviceById = new Map(project.devices.map((d) => [d.id, d]));
    for (const n of project.layout.nozzles) {
      if (!n.valveFollowsPump || !n.pumpDeviceId || !n.valveDeviceId) continue;
      const pump = deviceById.get(n.pumpDeviceId);
      const valve = deviceById.get(n.valveDeviceId);
      if (!pump || !valve || pump.universe !== valve.universe) continue;
      const pumpProfile = profiles.get(pump.profileId);
      const valveProfile = profiles.get(valve.profileId);
      if (!pumpProfile || !valveProfile) continue;
      const pumpCh = pumpProfile.channels.findIndex((c) => c.role === 'intensity');
      const valveCh = valveProfile.channels.findIndex((c) => c.role === 'open');
      if (pumpCh < 0 || valveCh < 0) continue;
      const pumpIdx = pump.address - 1 + pumpCh;
      const valveIdx = valve.address - 1 + valveCh;
      if (pumpIdx < 0 || pumpIdx >= DMX_UNIVERSE_SIZE || valveIdx < 0 || valveIdx >= DMX_UNIVERSE_SIZE) continue;
      let list = this.valveFollowsPump.get(pump.universe);
      if (!list) {
        list = [];
        this.valveFollowsPump.set(pump.universe, list);
      }
      list.push({ valveIdx, pumpIdx });
    }

    this.utilityLightConfig = project.utilityLight;
    this.utilityChannels.clear();
    for (const id of project.utilityLight.deviceIds) {
      const d = deviceById.get(id);
      const profile = d && profiles.get(d.profileId);
      if (!d || !profile) continue;
      let set = this.utilityChannels.get(d.universe);
      if (!set) {
        set = new Set();
        this.utilityChannels.set(d.universe, set);
      }
      for (let k = 0; k < profile.channels.length; k++) {
        const idx = d.address - 1 + k;
        if (idx >= 0 && idx < DMX_UNIVERSE_SIZE) set.add(idx);
      }
    }
  }

  /** Ручной ввод (пока нет датчика по Modbus/MQTT — задел под него, см. windlimit.ts) или null — сбросить. */
  setWindSpeed(speedMs: number | null): void {
    const before = this.windLimitPercent();
    this.windSpeed = speedMs;
    const after = this.windLimitPercent();
    if (before !== after) {
      eventLog.log(
        'wind',
        speedMs === null
          ? 'показание ветра сброшено — ограничение снято'
          : `ветер ${speedMs} м/с → высота струй ограничена ${after}%`,
        after < 100 ? 'warn' : 'info',
      );
    }
  }

  private windLimitPercent(): number {
    if (this.windSpeed === null) return 100;
    return computeWindLimitPercent(this.windSpeed, this.windLimitConfig);
  }

  windState(): { speedMs: number | null; limitPercent: number; config: WindLimitConfig } {
    return { speedMs: this.windSpeed, limitPercent: this.windLimitPercent(), config: this.windLimitConfig };
  }

  modbusState(): ModbusState {
    return this.pumps.state();
  }

  setScene(sceneId: string | null): void {
    this.playback.setScene(sceneId, this.nowMs);
  }

  startSequence(sequenceId: string): void {
    this.playback.start(sequenceId, this.nowMs);
  }

  pauseSequence(sequenceId: string): void {
    this.playback.pause(sequenceId, this.nowMs);
  }

  resumeSequence(sequenceId: string): void {
    this.playback.resume(sequenceId, this.nowMs);
  }

  stopSequence(sequenceId: string): void {
    this.playback.stop(sequenceId);
  }

  stopAllPlayback(): void {
    this.playback.stopAll();
  }

  playShow(showId: string, positionMs: number): void {
    this.playback.playShow(showId, positionMs, this.nowMs);
  }

  pauseShow(): void {
    this.playback.pauseShow(this.nowMs);
  }

  seekShow(positionMs: number): void {
    this.playback.seekShow(positionMs, this.nowMs);
  }

  syncShow(positionMs: number): void {
    this.playback.syncShow(positionMs, this.nowMs);
  }

  stopShow(): void {
    this.playback.stopShow();
  }

  playPlaylist(playlistId: string, itemIndex: number | undefined): void {
    this.playback.playPlaylist(playlistId, itemIndex, this.nowMs);
  }

  skipPlaylist(dir: 1 | -1): void {
    this.playback.skipPlaylist(dir, this.nowMs);
  }

  stopPlaylist(): void {
    this.playback.stopPlaylist();
  }

  playbackState(): PlaybackState {
    return this.playback.state(this.nowMs, this.paused);
  }

  setTestPattern(mode: TestPatternMode): void {
    this.pattern = mode;
  }

  universeInfos(): UniverseInfo[] {
    return this.universes.map((u) => ({
      id: u.id,
      label: u.label,
      outputs: u.outputs.map((o) => o.describe()),
    }));
  }

  stats(): EngineStats {
    return {
      ...this.ticker.stats(),
      framesSent: this.framesSent,
      pattern: this.pattern,
    };
  }
}

function createOutput(cfg: OutputConfig): UniverseOutput {
  switch (cfg.type) {
    case 'artnet': {
      if (!cfg.host) throw new Error('artnet: не указан host (IP ноды или broadcast-адрес)');
      return new ArtNetOutput({
        host: cfg.host,
        port: cfg.port,
        universe: cfg.universe,
        broadcast: cfg.broadcast,
      });
    }
    case 'sacn':
      return new SacnOutput({
        universe: cfg.universe,
        priority: cfg.priority,
        host: cfg.host,
        port: cfg.port,
      });
    case 'usb-dmx': {
      if (!cfg.path) throw new Error('usb-dmx: не указан path (COM-порт адаптера)');
      return new UsbDmxOutput({ path: cfg.path, baudRate: cfg.baudRate });
    }
    default:
      throw new Error(`Неизвестный тип выхода: ${(cfg as { type: string }).type}`);
  }
}

/**
 * Тестовые генераторы: меняют ВСЕ каналы каждый тик — проверка пропускной
 * способности и наглядная «жизнь» на приборах при пусконаладке.
 */
function fillTestPattern(mode: TestPatternMode, tSec: number, universeIndex: number, out: Uint8Array): void {
  switch (mode) {
    case 'sine': {
      const base = tSec * 2 * Math.PI * 0.2 + universeIndex * 1.3;
      for (let ch = 0; ch < out.length; ch++) {
        out[ch] = Math.round((Math.sin(base + ch * 0.06) + 1) * 127.5);
      }
      break;
    }
    case 'chase': {
      out.fill(0);
      const pos = Math.floor(tSec * 40) % out.length;
      for (let w = 0; w < 8; w++) out[(pos + w) % out.length] = 255 - w * 30;
      break;
    }
    case 'ramp': {
      const v = Math.round(tSec * 100) % 256;
      out.fill(v);
      break;
    }
    case 'off':
      break;
  }
}
