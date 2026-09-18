import {
  applyAddressRemap,
  ANALOG_PATTERNS,
  DEFAULT_PATTERN_SPEED_SEC,
  DMX_UNIVERSE_SIZE,
  clampDmx,
  computeWindLimitPercent,
  initialWindSmoothState,
  stepWindSmoothing,
  type WindSmoothState,
  defaultUtilityLightConfig,
  defaultWindLimitConfig,
  isUtilityLightOn,
  profileMap,
  type ChannelTrim,
  type DeviceKind,
  type EngineStats,
  type ModbusState,
  type PlaybackState,
  type Project,
  type TestPatternMode,
  type TestPatternScope,
  type UniverseInfo,
  type UtilityLightConfig,
  type WindLimitConfig,
  type AddressRemap,
  defaultFailsafeConfig,
  type FailsafeConfig,
  type FailsafeState,
} from '@fountain-studio/shared';
import { Ticker } from './clock';
import { eventLog } from './eventlog';
import type { EngineConfig, OutputConfig } from './config';
/** Высота струи для насоса, не привязанного к схеме, м — считаем его средним. */
const WIND_FALLBACK_HEIGHT_M = 4;
/**
 * Сколько держим безопасные значения после того, как такт выровнялся: если
 * машина дышит рывками, вода не должна мигать туда-сюда каждые полсекунды.
 */
const FAILSAFE_RECOVER_MS = 2000;
import { ArtNetOutput } from './drivers/artnet';
import { SacnOutput } from './drivers/sacn';
import { OpenDmxOutput } from './drivers/open-dmx';
import { UsbDmxOutput } from './drivers/usb-dmx';
import { MusidoraOutput } from './drivers/musidora';
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
  /**
   * Готовый кадр ПОСЛЕ переадресации — именно он уходит в кабель. Лежит
   * отдельно от out, потому что считает его один такт, а отправляет другой
   * (см. комментарий к sender в Engine).
   */
  wire: Uint8Array;
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
  /** Расчётчик: собирает кадр (сцены, шоу, консоль, ветер, переадресация). */
  private ticker: Ticker;
  /**
   * Отправщик — ОТДЕЛЬНЫЙ такт, который только берёт последний готовый кадр
   * и отдаёт его в выходы, ничего не считая.
   *
   * Зачем разделять. Раньше один таймер считал и тут же отправлял. Стоит
   * расчёту задуматься (тяжёлое шоу, сборка мусора, антивирус) — и кадр
   * уходит в линию не через 50 мс, а через 65–70: свет дёргается, заливки
   * идут ступеньками. Теперь задержка расчёта не рвёт поток: отправщик в
   * свой момент отдаёт ПРЕДЫДУЩИЙ кадр. Для DMX это совершенно нормально —
   * протокол состояния, повтор кадра и есть его обычная жизнь, а вот пауза
   * в потоке приёмнику видна.
   *
   * Предрасчёта «на секунду вперёд» здесь сознательно нет: чтобы считать
   * будущее, воспроизведение должно стать чистой функцией времени, а ручная
   * консоль, ветер и служебный свет всё равно обязаны применяться в момент
   * отправки — иначе фейдер оператора начнёт отставать на всю глубину
   * буфера. См. IDEAS.md → «Раздельный такт».
   */
  private sender: Ticker;
  /** Пока расчётчик не собрал первый кадр, слать нечего — нули в линию не гоним. */
  private hasFrame = false;
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
  /** «вселенная:индекс» → высота струи этого насоса, м (для ветрового ограничения). */
  private pumpHeightByChannel = new Map<string, number>();
  /**
   * Служебное освещение по времени суток (§27 доработки, «Switches») —
   * universeId → индексы адресов (адрес-1) ВСЕХ каналов выбранных приборов.
   * Форсирует 255 в окне on-off (или всегда, если always) и 0 вне его —
   * независимо от сцен/шоу, последний шаг тика.
   */
  private utilityChannels = new Map<number, Set<number>>();
  /** Переадресация из проекта: universeId → { выходной адрес: источник }. */
  private addressRemap: AddressRemap = {};
  private patternScope: TestPatternScope = 'all';
  /** universeId → вид прибора → по группе каналов на каждый прибор этого вида. */
  private kindGroups = new Map<number, Map<DeviceKind, number[][]>>();
  /** Ленивый кэш для scope='all': 512 групп по одному адресу, пересоздавать каждый тик незачем. */
  private allChannelGroups: number[][] | null = null;
  /** Момент включения текущего генератора — чтобы он всегда начинался «сначала». */
  private patternStartMs = 0;
  private patternSpeedSec = DEFAULT_PATTERN_SPEED_SEC.off;
  /**
   * Двухпозиционные каналы (клапаны): universeId → индексы адресов (адрес-1).
   * Генератор обязан выдавать по ним только 0 или 255 — промежуточных положений
   * у клапана не бывает, и сцены это уже соблюдают (scenegen.ts, twoState).
   */
  private twoStateChannels = new Map<number, Set<number>>();
  private utilityLightConfig: UtilityLightConfig = defaultUtilityLightConfig();
  private windLimitConfig: WindLimitConfig = defaultWindLimitConfig();
  /**
   * Последнее СЫРОЕ показание датчика (или ручного ввода), м/с — null, пока
   * никто не ввёл/не прислал. Для расчёта ограничения используется не оно, а
   * сглаженное windSpeed: по сырому нельзя, порыв на полсекунды уронил бы
   * воду на глазах у людей (см. stepWindSmoothing в windlimit.ts).
   */
  private windRaw: number | null = null;
  /**
   * Состояние сглаживания: расчётная скорость (по ней режутся насосы) и
   * сколько секунд ветер держится ниже неё — см. stepWindSmoothing.
   */
  private windSmoothing: WindSmoothState = initialWindSmoothState();
  /** Расчётная (сглаженная) скорость ветра — по ней и режутся насосы. */
  private get windCalcSpeed(): number | null {
    return this.windSmoothing.smoothed;
  }
  /** Когда последний раз двигали сглаживание — чтобы считать шаг по стенным часам. */
  private windSmoothedAtMs = 0;
  /** Последний записанный в журнал процент ограничения: не пишем строку на каждый процент. */
  private windLoggedPercent = 100;
  private failsafeConfig: FailsafeConfig = defaultFailsafeConfig();
  /** Время предыдущего тика по стенным часам — по нему видно, что такт вставал. */
  private lastTickWallMs = 0;
  /** С какого момента держится беда (0 — всё в порядке): такт или выходы. */
  private stallSinceMs = 0;
  private linkBadSinceMs = 0;
  private failsafe: FailsafeState = { active: false, reason: '', sinceMs: 0, trips: 0 };
  /** Сообщить наружу, что аварийное отключение включилось или снялось. */
  onFailsafeChange: ((state: FailsafeState) => void) | null = null;

  constructor(readonly config: EngineConfig) {
    for (const u of config.universes) {
      this.universes.push({
        id: u.id,
        label: u.label ?? `Вселенная ${u.id}`,
        manual: new Uint8Array(DMX_UNIVERSE_SIZE),
        out: new Uint8Array(DMX_UNIVERSE_SIZE),
        wire: new Uint8Array(DMX_UNIVERSE_SIZE),
        outputs: u.outputs.map(createOutput),
      });
    }
    this.playback = new Playback(this.universes.map((u) => u.id));
    this.ticker = new Ticker(config.timing.tickMs, config.timing.spinMs, (n) => this.tick(n));
    this.sender = new Ticker(config.timing.tickMs, config.timing.spinMs, () => this.sendFrames());
  }

  start(): void {
    for (const u of this.universes) {
      for (const o of u.outputs) console.log(`[engine] ${u.label}: ${o.describe()}`);
    }
    this.ticker.start();
    this.sender.start();
    console.log(
      `[engine] тик ${this.config.timing.tickMs} мс (${Math.round(1000 / this.config.timing.tickMs)} Гц), вселенных: ${this.universes.length}`,
    );
  }

  stop(): void {
    this.ticker.stop();
    this.sender.stop();
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
    this.sender.stop();
    this.hasFrame = false;
    for (const u of this.universes) for (const o of u.outputs) o.close();
    this.universes.length = 0;
    for (const u of universes) {
      this.universes.push({
        id: u.id,
        label: u.label ?? `Вселенная ${u.id}`,
        manual: new Uint8Array(DMX_UNIVERSE_SIZE),
        out: new Uint8Array(DMX_UNIVERSE_SIZE),
        wire: new Uint8Array(DMX_UNIVERSE_SIZE),
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
    this.sender = new Ticker(tickMs, this.config.timing.spinMs, () => this.sendFrames());
    this.ticker.start();
    this.sender.start();
    console.log(
      `[engine] конфигурация применена: тик ${tickMs} мс, вселенных: ${this.universes.length}`,
    );
  }

  /**
   * Отправка готового кадра в линию — отдельный такт, ничего не считает.
   *
   * Здесь же следим за аварийным отключением: смотреть надо именно за
   * ОТПРАВКОЙ, потому что на линию влияет она. Если расчёт задумался, а
   * отправщик идёт ровно — приборы продолжают получать поток, и это не
   * авария; а вот если встал отправщик, поток прервался по-настоящему.
   */
  private sendFrames(): void {
    this.checkFailsafe();
    if (!this.hasFrame) return;
    for (const u of this.universes) {
      for (const o of u.outputs) {
        o.send(u.wire);
        this.framesSent++;
      }
    }
  }

  private tick(n: number): void {
    if (this.paused) this.pauseOffsetMs += this.config.timing.tickMs;
    this.nowMs = n * this.config.timing.tickMs - this.pauseOffsetMs;
    const tSec = this.nowMs / 1000;
    this.playback.tick(this.nowMs);
    // Ветер двигаем до расчёта кадра: ограничение внизу должно считаться по
    // уже обновлённому сглаженному значению, а не по прошлому тику.
    this.updateWindSmoothing();
    for (let i = 0; i < this.universes.length; i++) {
      const u = this.universes[i]!;
      // Воспроизведение считаем ВСЕГДА, даже когда идёт тест-генератор: при
      // области применения «только насосы»/«только свет» остальные приборы
      // должны продолжать играть сцену, а не гаснуть. Для области «всё»
      // генератор всё равно перезапишет весь кадр ниже — как и раньше.
      {
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
        // Ветровое ограничение считается ДЛЯ КАЖДОГО НАСОСА по высоте его
        // струи: одинаковый процент на весь объект резал бы низкие фонтанчики
        // впустую и не спасал бы высокие.
        if (this.windCalcSpeed !== null && this.windLimitConfig.enabled) {
          const pumpIdx = this.pumpChannels.get(u.id);
          if (pumpIdx) {
            for (const idx of pumpIdx) {
              const v = u.out[idx]!;
              if (v <= 0) continue;
              const h = this.pumpHeightByChannel.get(`${u.id}:${idx}`) ?? WIND_FALLBACK_HEIGHT_M;
              const pct = computeWindLimitPercent(this.windCalcSpeed, this.windLimitConfig, h);
              if (pct < 100) u.out[idx] = Math.round((v * pct) / 100);
            }
          }
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
      }
      if (this.pattern !== 'off') {
        applyTestPattern(
          this.pattern,
          (this.nowMs - this.patternStartMs) / 1000,
          i,
          u.out,
          this.patternGroups(u.id),
          this.twoStateChannels.get(u.id),
          this.patternSpeedSec,
        );
      }
      /**
       * Аварийное отключение — поверх всего, включая тест-генератор: если
       * движок перестал нормально выдавать кадры, вода должна упасть, а не
       * остаться на последней уставке (см. failsafe.ts).
       */
      if (this.failsafe.active) this.applySafeValues(u);
      // Переадресация — САМЫЙ ПОСЛЕДНИЙ шаг, уже над готовым кадром: проект,
      // сцены и тест-генераторы продолжают работать с правильными адресами, а
      // на линию уходит то, что нужно фактическому монтажу.
      // Готовый кадр кладём в u.wire — в линию его отдаст ОТПРАВЩИК своим
      // тактом (см. sendFrames и комментарий к sender).
      u.wire.set(applyAddressRemap(u.out, this.addressRemap[u.id]));
    }
    this.hasFrame = true;
    // Насосы на Modbus: тот же посчитанный кадр (включая тест-паттерны — пусконаладка),
    // что уходит в DMX-выходы, идёт и на прямое управление ПЧ. Переадресация
    // сюда НЕ применяется: она про путаницу в кабелях DMX, а ПЧ адресуется по
    // Modbus и к DMX-адресам отношения не имеет.
    for (const p of this.modbusPumps) {
      const u = this.universes[p.universeIndex];
      if (u) this.pumps.update(p.deviceId, u.out[p.addressIdx]!);
    }
  }

  /**
   * Слежение за тем, выдаём ли мы кадры на линию, и включение/снятие
   * аварийного отключения. Две беды, обе меряются одним таймаутом:
   *
   * 1. ТАКТ ВСТАЛ — между тиками прошло намного больше положенного (event
   *    loop подвис: сон машины, тяжёлая операция, антивирус). Пока он стоял,
   *    в линию ничего не уходило, и приборы держали последнее значение.
   * 2. ВЫХОД НЕ ДОСТАВЛЯЕТ — драйвер сообщает, что связи с железом нет
   *    (выдернули USB, закрылся порт). Art-Net и sACN о доставке ничего не
   *    знают (UDP без подтверждений) — они healthy() не реализуют, и по ним
   *    мы не судим.
   *
   * Снимается само, как только обе беды ушли: движок возвращается к обычной
   * картине и продолжает слать то, что должно идти по сценам и шоу.
   */
  private checkFailsafe(): void {
    const now = Date.now();
    const prev = this.lastTickWallMs;
    this.lastTickWallMs = now;
    if (!this.failsafeConfig.enabled) {
      this.stallSinceMs = 0;
      this.linkBadSinceMs = 0;
      if (this.failsafe.active) this.setFailsafe(false, '');
      return;
    }
    const limitMs = this.failsafeConfig.timeoutSec * 1000;

    // 1. Такт вставал? Разрыв считаем от ожидаемого шага, а не от нуля.
    const gap = prev > 0 ? now - prev : 0;
    if (gap > limitMs + this.config.timing.tickMs) {
      this.stallSinceMs = now;
    } else if (this.stallSinceMs > 0 && now - this.stallSinceMs > FAILSAFE_RECOVER_MS) {
      // После провала держим безопасные значения ещё пару секунд: если
      // машина «дышит» рывками, не мигаем водой туда-сюда.
      this.stallSinceMs = 0;
    }

    // 2. Выходы, которые умеют сказать о доставке.
    let known = 0;
    let bad = 0;
    for (const u of this.universes) {
      for (const o of u.outputs) {
        if (!o.healthy) continue;
        known++;
        if (!o.healthy()) bad++;
      }
    }
    if (known > 0 && bad === known) {
      if (this.linkBadSinceMs === 0) this.linkBadSinceMs = now;
    } else {
      this.linkBadSinceMs = 0;
    }

    const stalled = this.stallSinceMs > 0;
    const linkLost = this.linkBadSinceMs > 0 && now - this.linkBadSinceMs > limitMs;
    const active = stalled || linkLost;
    if (active === this.failsafe.active) return;
    this.setFailsafe(
      active,
      stalled
        ? `такт движка вставал на ${(gap / 1000).toFixed(1)} с`
        : linkLost
          ? `выход на линию не доставляет дольше ${this.failsafeConfig.timeoutSec} с`
          : '',
    );
  }

  private setFailsafe(active: boolean, reason: string): void {
    this.failsafe = {
      active,
      reason: active ? reason : '',
      sinceMs: active ? Date.now() : 0,
      trips: this.failsafe.trips + (active ? 1 : 0),
    };
    if (active) {
      eventLog.log(
        'авария',
        `Аварийное отключение: ${reason}. Насосы и клапаны в 0${this.failsafeConfig.lights ? ', свет погашен' : ''}.`,
        'error',
      );
    } else {
      eventLog.log('авария', 'Аварийное отключение снято — вывод на линию восстановлен.', 'info', 'recovery');
    }
    this.onFailsafeChange?.(this.failsafe);
  }

  /** Безопасные значения в готовый кадр вселенной: вода в 0, свет — по настройке. */
  private applySafeValues(u: { id: number; out: Uint8Array }): void {
    const byKind = this.kindGroups.get(u.id);
    if (!byKind) return;
    const kinds: string[] = ['pump', 'valve'];
    if (this.failsafeConfig.lights) kinds.push('lamp');
    for (const kind of kinds) {
      const groups = byKind.get(kind as never);
      if (!groups) continue;
      for (const g of groups) for (const i of g) u.out[i] = 0;
    }
  }

  failsafeState(): FailsafeState {
    return this.failsafe;
  }

  /** Таблица переадресации вселенной — нужна серверу, чтобы отдать интерфейсу кадр линии. */
  addressRemapFor(universeId: number): Record<number, number> | undefined {
    return this.addressRemap[universeId];
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

    /**
     * Насосные каналы и ВЫСОТА струи, которую каждый из них поднимает.
     *
     * Высота нужна ветровому ограничению: снос растёт линейно с высотой, и
     * пятнадцатиметровую струю надо резать в разы раньше двухметровой. Если
     * один насос кормит несколько форсунок — берём самую высокую из них: по
     * ней и считаем, иначе высокая останется без защиты.
     *
     * Насос без привязки к схеме высоты не имеет — для него ограничение
     * считается по запасному значению (см. WIND_FALLBACK_HEIGHT_M).
     */
    this.pumpChannels.clear();
    this.pumpHeightByChannel.clear();
    const heightByPumpId = new Map<string, number>();
    for (const n of project.layout.nozzles) {
      for (const id of [n.pumpDeviceId, n.pump2DeviceId, ...(n.extraPumpDeviceIds ?? []), ...(n.extraPump2DeviceIds ?? [])]) {
        if (!id) continue;
        heightByPumpId.set(id, Math.max(heightByPumpId.get(id) ?? 0, n.maxHeightM));
      }
    }
    for (const d of project.devices) {
      const profile = profiles.get(d.profileId);
      if (!profile || profile.kind !== 'pump') continue;
      let set = this.pumpChannels.get(d.universe);
      if (!set) {
        set = new Set();
        this.pumpChannels.set(d.universe, set);
      }
      const h = heightByPumpId.get(d.id) ?? WIND_FALLBACK_HEIGHT_M;
      for (let k = 0; k < profile.channels.length; k++) {
        if (profile.channels[k]!.role !== 'intensity') continue;
        const idx = d.address - 1 + k;
        if (idx >= 0 && idx < DMX_UNIVERSE_SIZE) {
          set.add(idx);
          this.pumpHeightByChannel.set(`${d.universe}:${idx}`, h);
        }
      }
    }
    this.windLimitConfig = project.windLimit;
    this.failsafeConfig = project.failsafe;
    this.addressRemap = project.addressRemap ?? {};

    const deviceById = new Map(project.devices.map((d) => [d.id, d]));

    // Группы каналов по видам приборов — для тест-генератора с областью
    // применения (§27 доработки): гонять насосы, не трогая свет, и наоборот.
    this.kindGroups.clear();
    for (const d of project.devices) {
      const profile = profiles.get(d.profileId);
      if (!profile) continue;
      const idx: number[] = [];
      for (let k = 0; k < profile.channels.length; k++) {
        const i = d.address - 1 + k;
        if (i >= 0 && i < DMX_UNIVERSE_SIZE) idx.push(i);
      }
      if (idx.length === 0) continue;
      let byKind = this.kindGroups.get(d.universe);
      if (!byKind) {
        byKind = new Map();
        this.kindGroups.set(d.universe, byKind);
      }
      const list = byKind.get(profile.kind);
      if (list) list.push(idx);
      else byKind.set(profile.kind, [idx]);
    }
    // Порядок групп — по адресу: «бегущая» и «по очереди» должны идти так же,
    // как приборы стоят на линии, иначе обход теряет смысл.
    for (const byKind of this.kindGroups.values()) {
      for (const list of byKind.values()) list.sort((a, b) => a[0]! - b[0]!);
    }

    this.twoStateChannels.clear();
    for (const d of project.devices) {
      const profile = profiles.get(d.profileId);
      if (!profile?.twoState) continue;
      let set = this.twoStateChannels.get(d.universe);
      if (!set) {
        set = new Set();
        this.twoStateChannels.set(d.universe, set);
      }
      for (let k = 0; k < profile.channels.length; k++) {
        const i = d.address - 1 + k;
        if (i >= 0 && i < DMX_UNIVERSE_SIZE) set.add(i);
      }
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

  /**
   * Ручной ввод (пока нет датчика по Modbus/MQTT — задел под него, см.
   * windlimit.ts) или null — сбросить.
   *
   * Показание только ЗАПОМИНАЕТСЯ. Применяется оно через сглаживание в
   * тике: рост ветра догоняем за ~секунду, спад отпускаем заметно медленнее.
   * Сброс (null) — единственное, что действует сразу: это явная команда
   * человека «датчика больше нет», тянуть с ней нечего.
   */
  setWindSpeed(speedMs: number | null): void {
    this.windRaw = speedMs;
    if (speedMs === null) {
      const had = this.windCalcSpeed !== null;
      this.windSmoothing = initialWindSmoothState();
      this.windSmoothedAtMs = 0;
      if (had) {
        eventLog.log('wind', 'показание ветра сброшено — ограничение снято');
        this.windLoggedPercent = 100;
      }
      return;
    }
    // Первое показание берём как есть — иначе ограничение «поедет» с нуля и
    // первые секунды вода будет лететь так, будто ветра нет.
    if (this.windCalcSpeed === null) {
      this.windSmoothing = { smoothed: speedMs, belowSec: 0 };
      this.windSmoothedAtMs = Date.now();
      this.logWindIfChanged();
    }
  }

  /**
   * Двигает сглаженное значение ветра к последнему показанию. Зовётся из
   * тика: шаг считается по стенным часам, чтобы постоянные времени в
   * секундах не зависели от того, какой сейчас шаг тика.
   */
  private updateWindSmoothing(): void {
    if (this.windRaw === null || this.windCalcSpeed === null) return;
    const now = Date.now();
    const dtSec = this.windSmoothedAtMs > 0 ? (now - this.windSmoothedAtMs) / 1000 : 0;
    this.windSmoothedAtMs = now;
    if (dtSec <= 0) return;
    this.windSmoothing = stepWindSmoothing(this.windSmoothing, this.windRaw, dtSec, this.windLimitConfig);
    this.logWindIfChanged();
  }

  /**
   * Пишем в журнал не каждый процент, а заметные ступени: сглаживание меняет
   * значение непрерывно, и построчная запись забила бы журнал за вечер.
   */
  private logWindIfChanged(): void {
    const pct = this.windLimitPercent();
    if (Math.abs(pct - this.windLoggedPercent) < 5 && !(pct === 100 && this.windLoggedPercent !== 100)) return;
    this.windLoggedPercent = pct;
    eventLog.log(
      'wind',
      pct >= 100
        ? `ветер ${this.windCalcSpeed?.toFixed(1)} м/с — ограничение снято`
        : `ветер ${this.windCalcSpeed?.toFixed(1)} м/с → высота струй ограничена ${pct}%`,
      pct < 100 ? 'warn' : 'info',
    );
  }

  /**
   * Показательный процент для статуса в интерфейсе.
   *
   * Насосы режутся каждый по своей высоте, одного числа на объект больше нет —
   * но человеку нужно видеть, насколько серьёзно ветер вмешался. Показываем
   * САМОЕ СИЛЬНОЕ ограничение по объекту: если где-то струя срезана вдвое,
   * именно это и надо знать.
   */
  private windLimitPercent(): number {
    if (this.windCalcSpeed === null || !this.windLimitConfig.enabled) return 100;
    let worst = 100;
    for (const h of this.pumpHeightByChannel.values()) {
      worst = Math.min(worst, computeWindLimitPercent(this.windCalcSpeed, this.windLimitConfig, h));
    }
    if (this.pumpHeightByChannel.size === 0) {
      worst = computeWindLimitPercent(this.windCalcSpeed, this.windLimitConfig, WIND_FALLBACK_HEIGHT_M);
    }
    return worst;
  }

  windState(): { speedMs: number | null; limitPercent: number; config: WindLimitConfig } {
    return { speedMs: this.windCalcSpeed, limitPercent: this.windLimitPercent(), config: this.windLimitConfig };
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

  startSequenceGroup(groupId: string): void {
    this.playback.startGroup(groupId, this.nowMs);
  }

  pauseSequenceGroup(groupId: string): void {
    this.playback.pauseGroup(groupId, this.nowMs);
  }

  resumeSequenceGroup(groupId: string): void {
    this.playback.resumeGroup(groupId, this.nowMs);
  }

  stopSequenceGroup(groupId: string): void {
    this.playback.stopGroup(groupId);
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

  setTestPattern(mode: TestPatternMode, scope: TestPatternScope = 'all', speedSec?: number): void {
    this.pattern = mode;
    this.patternScope = scope;
    this.patternSpeedSec = speedSec && speedSec > 0 ? speedSec : DEFAULT_PATTERN_SPEED_SEC[mode];
    // Отсчёт с нуля при КАЖДОМ переключении: раньше генератор считал от общих
    // часов движка, и «бегущая»/«по очереди» подхватывались с середины круга —
    // включаешь обход приборов, а он стартует с седьмого. Наладчику нужно
    // «сначала», иначе непонятно, какой прибор сейчас горит.
    this.patternStartMs = this.nowMs;
  }

  /**
   * Группы каналов, по которым «шагает» генератор во вселенной. Для 'all' —
   * каждый адрес сам по себе (как было исторически: бегущая волна идёт по
   * адресам). Для вида прибора — по одной группе на прибор, поэтому «бегущая»
   * и «по очереди» перебирают приборы, а не сырые адреса: на пусконаладке
   * нужно именно это.
   */
  private patternGroups(universeId: number): number[][] {
    if (this.patternScope === 'all') {
      if (!this.allChannelGroups) {
        this.allChannelGroups = Array.from({ length: DMX_UNIVERSE_SIZE }, (_, i) => [i]);
      }
      return this.allChannelGroups;
    }
    return this.kindGroups.get(universeId)?.get(this.patternScope) ?? [];
  }

  universeInfos(): UniverseInfo[] {
    return this.universes.map((u) => ({
      id: u.id,
      label: u.label,
      outputs: u.outputs.map((o) => o.describe()),
    }));
  }

  stats(): EngineStats {
    /*
     * Основные цифры — от ОТПРАВЩИКА: именно его ровность видит линия, и
     * именно её имеет смысл показывать как «джиттер» в строке состояния.
     * Джиттер расчётчика отдаём отдельно (calc*): он важен для понимания
     * «успевает ли машина считать», но на поток уже не влияет — задержку
     * расчёта отправщик закрывает повтором предыдущего кадра.
     */
    const calc = this.ticker.stats();
    return {
      ...this.sender.stats(),
      calcAvgJitterMs: calc.avgJitterMs,
      calcMaxJitterMs: calc.maxJitterMs,
      framesSent: this.framesSent,
      pattern: this.pattern,
      patternScope: this.patternScope,
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
    case 'open-dmx': {
      if (!cfg.path) throw new Error('open-dmx: не указан path (COM-порт адаптера)');
      return new OpenDmxOutput({ path: cfg.path, baudRate: cfg.baudRate });
    }
    case 'musidora':
      // Путь не обязателен: пусто — первый свободный интерфейс, как у FontanPlay.
      return new MusidoraOutput({ path: cfg.path, out: cfg.musidoraOut });
    default:
      throw new Error(`Неизвестный тип выхода: ${(cfg as { type: string }).type}`);
  }
}

/**
 * Тестовые генераторы для пусконаладки. Шагают не по сырым адресам, а по
 * ГРУППАМ каналов: при области применения «всё» группа — это один адрес (как
 * было исторически), а при «только насосы»/«клапаны»/«свет» — один прибор.
 * Поэтому «бегущая» и «по очереди» перебирают приборы в порядке адресов, а не
 * произвольные каналы внутри многоканальных светильников.
 *
 * tSec отсчитывается от МОМЕНТА ВКЛЮЧЕНИЯ режима, а не от часов движка —
 * поэтому каждое переключение начинает картину сначала, с первого прибора и с
 * нулевого сдвига.
 *
 * speedSec — темп: для шаговых режимов время одного шага, для циклических
 * длительность полного цикла (см. DEFAULT_PATTERN_SPEED_SEC).
 */
function applyTestPattern(
  mode: TestPatternMode,
  tSec: number,
  universeIndex: number,
  out: Uint8Array,
  groups: number[][],
  twoState: Set<number> | undefined,
  speedSec: number,
): void {
  const n = groups.length;
  if (n === 0) return;
  const step = speedSec > 0 ? speedSec : DEFAULT_PATTERN_SPEED_SEC[mode];
  /**
   * Клапан не имеет промежуточных положений, поэтому в его канал уходит только
   * 0 или 255.
   *
   * В режимах с плавной шкалой (синус, подъём, ступени) клапан держится
   * ОТКРЫТЫМ всё время: насос там идёт через промежуточные значения, и если
   * закрывать клапан ниже половины шкалы, то на всей нижней половине хода
   * струи просто нет — видно только верхнюю, а смотрят как раз на плавность.
   * Порог по половине шкалы остаётся там, где значение и так двоичное
   * (строб, бегущая, по очереди, чёт/нечёт) — клапан честно повторяет его.
   */
  const analog = ANALOG_PATTERNS.includes(mode);
  const snapValve = (v: number): number => (analog ? 255 : v >= 128 ? 255 : 0);
  const put = (gi: number, v: number): void => {
    for (const ch of groups[gi]!) out[ch] = twoState?.has(ch) ? snapValve(v) : v;
  };
  switch (mode) {
    case 'sine': {
      const base = (tSec / step) * 2 * Math.PI + universeIndex * 1.3;
      for (let g = 0; g < n; g++) put(g, Math.round((Math.sin(base + g * 0.06) + 1) * 127.5));
      break;
    }
    case 'chase': {
      for (let g = 0; g < n; g++) put(g, 0);
      const pos = Math.floor(tSec / step) % n;
      const width = Math.min(8, n);
      for (let w = 0; w < width; w++) put((pos + w) % n, 255 - w * 30);
      break;
    }
    case 'ramp': {
      // Подъём 0→255 за период и сброс. Бывшая «Пила» — это была ровно эта же
      // формула с другим умолчанием периода; теперь период задаётся полем, и
      // держать два одинаковых режима незачем.
      const v = Math.round(((tSec % step) / step) * 255);
      for (let g = 0; g < n; g++) put(g, v);
      break;
    }
    case 'strobe': {
      const on = Math.floor(tSec / (step / 2)) % 2 === 0;
      for (let g = 0; g < n; g++) put(g, on ? 255 : 0);
      break;
    }
    case 'stairs': {
      // Статичная лестница: первый прибор 0, последний 255, значение растёт
      // строго по адресу. Раньше картина медленно уползала по кругу, из-за чего
      // первый адрес показывал произвольное значение (12, 47 — какое застали), а
      // в месте закольцовки был разрыв 255→0 посреди линии. Для проверки порядка
      // адресации движение не нужно и только мешает — оно есть в «Бегущей» и
      // «По очереди», а здесь важно ровное нарастание, которое видно целиком.
      for (let g = 0; g < n; g++) put(g, Math.round((g / Math.max(1, n - 1)) * 255));
      break;
    }
    case 'oddeven': {
      // Через одного: перепутанные местами или сдвинутые на единицу адреса
      // видно сразу — «шахматка» ломается.
      const flip = Math.floor(tSec / step) % 2 === 0;
      for (let g = 0; g < n; g++) put(g, (g % 2 === 0) === flip ? 255 : 0);
      break;
    }
    case 'solo': {
      // По одному за раз: обход приборов по порядку адресов — «какой это по
      // счёту» без беготни к щиту и без второго человека.
      const active = Math.floor(tSec / step) % n;
      for (let g = 0; g < n; g++) put(g, g === active ? 255 : 0);
      break;
    }
    case 'off':
      break;
  }
}

