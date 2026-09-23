import { DMX_UNIVERSE_SIZE } from './dmx';
import { sanitizeKeys, type KeyBinding } from './keys';
import { emptyLayout, sanitizeLayout, type FountainLayout } from './layout';
import { sanitizePlaylists, sanitizeSchedules, type Playlist, type Schedule } from './playlist';
import {
  sanitizeDmxTriggers,
  sanitizeMqttBindings,
  sanitizeOscBindings,
  type DmxTrigger,
  type MqttBinding,
  type OscBinding,
} from './remote';
import { sanitizeSequenceGroups, type SequenceGroup } from './sequencegroup';
import { sanitizeShows, type Show } from './show';
import { smoothnessFromSaved } from './smoothing';
import { defaultUtilityLightConfig, sanitizeUtilityLightConfig, type UtilityLightConfig } from './utilitylight';
import { defaultFailsafeConfig, sanitizeFailsafeConfig, type FailsafeConfig } from './failsafe';
import { defaultWindLimitConfig, sanitizeWindLimitConfig, type WindLimitConfig } from './windlimit';

/**
 * Модель проекта Fountain Studio: профили устройств, патч (привязка к адресам),
 * сцены (статические картины) и секвенсоры (последовательности сцен).
 * Проект хранится открытым JSON в fountain.project.json рядом с конфигом движка.
 */

/** Роль канала внутри профиля устройства — определяет элемент управления в UI. */
export type ChannelRole =
  | 'intensity' // яркость / производительность насоса 0–255
  | 'red'
  | 'green'
  | 'blue'
  | 'white'
  | 'open' // двухпозиционный: 0 = закрыт, 255 = открыт
  | 'custom';

export interface ProfileChannel {
  name: string;
  role: ChannelRole;
}

/** Вид устройства — для группировки и подбора элементов управления. */
export type DeviceKind = 'pump' | 'valve' | 'lamp' | 'other';

export interface DeviceProfile {
  id: string;
  name: string;
  kind: DeviceKind;
  /** Каналы по порядку — их число задаёт, сколько адресов занимает устройство. */
  channels: ProfileChannel[];
  /** true — устройство двухпозиционное (клапан): каналы держат только 0 или 255. */
  twoState?: boolean;
  /** Встроенный профиль (не хранится в файле проекта, добавляется кодом). */
  builtin?: boolean;
}

/** Калибровка канала: рабочий диапазон прибора. 0 остаётся 0 (выключено), 1–255 растягиваются в min–max. */
export interface ChannelTrim {
  min: number;
  max: number;
}

/**
 * Физическое подключение Modbus к линии ПЧ (§12 п.9): либо TCP-шлюз RTU↔TCP на
 * сети (как Art-Net-ноды), либо RS-485 напрямую через USB-адаптер на движке —
 * так же, как в отдельном проекте-конфигураторе ПЧ (github.com/BelikGM/Modbus).
 * Несколько насосов с одинаковым подключением делят один физический канал
 * (мультидроп RS-485 или один шлюз) — см. PumpModbusManager.
 */
export type ModbusConnection =
  | { kind: 'tcp'; host: string; port?: number }
  | {
      kind: 'rtu';
      serialPort: string;
      baudRate?: number;
      dataBits?: 7 | 8;
      stopBits?: 1 | 2;
      parity?: 'none' | 'even' | 'odd';
    };

/**
 * Прямое управление насосом через Modbus к частотному преобразователю (ПЧ),
 * в обход DMX→аналог (§12 п.9: оба варианта на выбор per-device). Значение канала
 * интенсивности (после HTP-слияния и калибровки) 0–255 линейно отображается
 * в уставку частоты 0–freqScaleHz и пишется в holding-регистр freqRegister;
 * при наличии cmdRegister — пишется код пуска/стопа (напр. у Elhart EMD-PUMP:
 * 2 = пуск, 1 = стоп в регистр 0x2000) перед уставкой. faultRegister (если задан)
 * периодически читается (holding-регистр кода аварии, 0 = нет аварии) для
 * индикации в UI. Дефолты полей в форме патча ориентированы на карту регистров
 * Elhart EMD-PUMP (см. github.com/BelikGM/Modbus/devices/templates) — реальный
 * прибор проекта; для другой модели ПЧ значения нужно сверить с её картой регистров.
 */
export interface ModbusPumpConfig {
  connection: ModbusConnection;
  unitId?: number; // адрес прибора на линии/шлюзе, по умолчанию 1
  freqRegister: number; // holding-регистр уставки частоты, 0-based
  freqScaleHz: number; // частота при значении канала 255, Гц (напр. 50)
  /** Единиц регистра на 1 Гц. У Elhart EMD-PUMP — 100 (уставка в сотых герца). */
  freqRegScale?: number;
  cmdRegister?: number; // holding-регистр команд пуск/стоп, 0-based
  faultRegister?: number; // holding-регистр кода аварии (0 = нет аварии), 0-based
  /**
   * Телеметрия насоса (§27 доработки, §4 п.2) — необязательные holding-регистры
   * для чтения (панель здоровья насоса в UI). Не привязано к одной модели ПЧ:
   * адрес и масштаб настраиваются per-device, как и остальные поля здесь.
   */
  currentRegister?: number; // ток, 0-based
  currentScale?: number; // единиц регистра на 1 А, по умолчанию 100 (сотые ампера)
  speedRegister?: number; // обороты, 0-based
  speedScale?: number; // единиц регистра на 1 об/мин, по умолчанию 1
  tempRegister?: number; // температура, 0-based
  tempScale?: number; // единиц регистра на 1°C, по умолчанию 10 (десятые градуса)
}

/** Устройство, поставленное в патч: профиль + вселенная + первый адрес. */
export interface PatchedDevice {
  id: string;
  name: string;
  profileId: string;
  /** Логический id вселенной проекта. */
  universe: number;
  /** Первый занимаемый DMX-адрес, 1..512. */
  address: number;
  /** Калибровка по каналам профиля; отсутствует — без масштабирования (0–255 как есть). */
  trim?: ChannelTrim[];
  /** Прямое управление через Modbus TCP (насосы с ПЧ); отсутствует — обычный DMX→аналог. */
  modbus?: ModbusPumpConfig;
  /**
   * UID этого прибора в RDM (вида «4950:00001234»), если он найден на линии
   * и привязан на вкладке «Диагностика». Нужен для одного: чтобы в
   * уведомлениях и отчётах вместо голого UID стояло понятное имя прибора
   * из патча. Сам RDM работает и без привязки.
   */
  rdmUid?: string;
}

/** Приводит UID к единому виду: строчные буквы, «манufacturer:device». */
export function normalizeRdmUid(uid: string): string {
  return uid.trim().toLowerCase();
}

/**
 * Заменяет в тексте RDM-UID на «Имя прибора (uid)» по привязке из патча.
 * Нужна уведомлениям и отчётам: «RDM-прибор 4950:00001234 ПРОПАЛ» читается
 * плохо, «Прожектор левый борт 3 (4950:00001234)» — сразу понятно, куда идти.
 */
export function namesForRdm(devices: PatchedDevice[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of devices) {
    if (d.rdmUid) map.set(normalizeRdmUid(d.rdmUid), d.name);
  }
  return map;
}

export function substituteRdmNames(text: string, names: Map<string, string>): string {
  if (names.size === 0) return text;
  return text.replace(/\b[0-9a-fA-F]{4}:[0-9a-fA-F]{8}\b/g, (uid) => {
    const name = names.get(normalizeRdmUid(uid));
    return name ? `${name} (${uid})` : uid;
  });
}

/** Итоговое значение канала с учётом калибровки. */
export function applyTrim(value: number, trim: ChannelTrim | undefined): number {
  if (!trim || value <= 0) return value;
  return Math.round(trim.min + (value * (trim.max - trim.min)) / 255);
}

function sanitizeModbusConnection(raw: unknown): ModbusConnection | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'tcp') {
    if (typeof r.host !== 'string' || r.host.trim() === '') return undefined;
    const conn: ModbusConnection = { kind: 'tcp', host: r.host.trim() };
    if (Number.isInteger(r.port) && (r.port as number) > 0 && (r.port as number) <= 65535) {
      conn.port = r.port as number;
    }
    return conn;
  }
  if (r.kind === 'rtu') {
    if (typeof r.serialPort !== 'string' || r.serialPort.trim() === '') return undefined;
    const conn: ModbusConnection = { kind: 'rtu', serialPort: r.serialPort.trim() };
    if (Number.isInteger(r.baudRate) && (r.baudRate as number) > 0) conn.baudRate = r.baudRate as number;
    if (r.dataBits === 7 || r.dataBits === 8) conn.dataBits = r.dataBits;
    if (r.stopBits === 1 || r.stopBits === 2) conn.stopBits = r.stopBits;
    if (r.parity === 'none' || r.parity === 'even' || r.parity === 'odd') conn.parity = r.parity;
    return conn;
  }
  return undefined;
}

/** Приводит произвольный объект к валидной Modbus-конфигурации насоса или undefined. */
export function sanitizeModbusConfig(raw: unknown): ModbusPumpConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const connection = sanitizeModbusConnection(r.connection);
  if (!connection) return undefined;
  if (!Number.isInteger(r.freqRegister) || (r.freqRegister as number) < 0) return undefined;
  if (typeof r.freqScaleHz !== 'number' || !Number.isFinite(r.freqScaleHz) || r.freqScaleHz <= 0) return undefined;
  const config: ModbusPumpConfig = {
    connection,
    freqRegister: r.freqRegister as number,
    freqScaleHz: r.freqScaleHz,
  };
  if (Number.isInteger(r.unitId) && (r.unitId as number) >= 0 && (r.unitId as number) <= 255) {
    config.unitId = r.unitId as number;
  }
  if (Number.isInteger(r.freqRegScale) && (r.freqRegScale as number) > 0) config.freqRegScale = r.freqRegScale as number;
  if (Number.isInteger(r.cmdRegister) && (r.cmdRegister as number) >= 0) config.cmdRegister = r.cmdRegister as number;
  if (Number.isInteger(r.faultRegister) && (r.faultRegister as number) >= 0) {
    config.faultRegister = r.faultRegister as number;
  }
  const tele = (reg: unknown, scale: unknown): { register?: number; scale?: number } => {
    if (!Number.isInteger(reg) || (reg as number) < 0) return {};
    const out: { register?: number; scale?: number } = { register: reg as number };
    if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) out.scale = scale;
    return out;
  };
  const cur = tele(r.currentRegister, r.currentScale);
  if (cur.register !== undefined) {
    config.currentRegister = cur.register;
    if (cur.scale !== undefined) config.currentScale = cur.scale;
  }
  const speed = tele(r.speedRegister, r.speedScale);
  if (speed.register !== undefined) {
    config.speedRegister = speed.register;
    if (speed.scale !== undefined) config.speedScale = speed.scale;
  }
  const temp = tele(r.tempRegister, r.tempScale);
  if (temp.register !== undefined) {
    config.tempRegister = temp.register;
    if (temp.scale !== undefined) config.tempScale = temp.scale;
  }
  return config;
}

/** Обмен адресами (и вселенными) двух устройств — «физически перепутаны». */
export function swapDeviceAddresses(project: Project, aId: string, bId: string): Project {
  const a = project.devices.find((d) => d.id === aId);
  const b = project.devices.find((d) => d.id === bId);
  if (!a || !b) return project;
  return {
    ...project,
    devices: project.devices.map((d) => {
      if (d.id === aId) return { ...d, universe: b.universe, address: b.address };
      if (d.id === bId) return { ...d, universe: a.universe, address: a.address };
      return d;
    }),
  };
}

/** Сдвиг адресов выбранных устройств на delta (вставили прибор в середину линии). */
export function shiftDeviceAddresses(project: Project, ids: string[], delta: number): Project {
  const set = new Set(ids);
  return {
    ...project,
    devices: project.devices.map((d) => (set.has(d.id) ? { ...d, address: d.address + delta } : d)),
  };
}

/** Статическая картина: deviceId → значения каналов устройства по порядку профиля. */
export interface Scene {
  id: string;
  name: string;
  values: Record<string, number[]>;
}

export interface SequenceStep {
  sceneId: string;
  /** Длительность шага, мс (фейд идёт внутри неё). */
  holdMs: number;
  /** Плавный переход из предыдущего состояния, мс. 0 — резкое переключение. */
  fadeMs: number;
}

export type SequenceMode = 'loop' | 'once';

export interface Sequence {
  id: string;
  name: string;
  mode: SequenceMode;
  steps: SequenceStep[];
  /**
   * Эффект плавности на весь секвенсор (§27 доработки, УХ п.16) — отдельно
   * от fadeMs шага (тот — фиксированный переход между двумя конкретными
   * шагами; это — постоянный фильтр на весь выходной поток секвенсора,
   * например «на свет плавность нужна, а на воду нет» — у них разные
   * секвенсоры). Нет поля — Quick (как сейчас, без изменений).
   */
  effect?: { mode: 'rate' | 'decay'; smoothness: number };
}

export interface Project {
  formatVersion: 1;
  name: string;
  /** Пользовательские профили (встроенные добавляются кодом, см. BUILTIN_PROFILES). */
  profiles: DeviceProfile[];
  devices: PatchedDevice[];
  scenes: Scene[];
  sequences: Sequence[];
  /** Группы секвенсоров — синхронный/параллельный запуск нескольких вместе (§27 доработки). */
  sequenceGroups: SequenceGroup[];
  shows: Show[];
  playlists: Playlist[];
  /** Расписания: несколько, у каждого галочка «активно» (см. playlist.ts). */
  schedules: Schedule[];
  keys: KeyBinding[];
  /** Привязки OSC-адресов и MQTT-топиков к действиям (§1 доработки: удалённое управление). */
  oscBindings: OscBinding[];
  mqttBindings: MqttBinding[];
  /** Триггеры по входящему DMX (§27 доработки, §4 п.4). */
  dmxTriggers: DmxTrigger[];
  /** Безопасное снижение струй по ветру (§27 доработки, §4 п.1). */
  windLimit: WindLimitConfig;
  /** Аварийное отключение при пропаже вывода на линию (см. failsafe.ts). */
  failsafe: FailsafeConfig;
  /**
   * Холостая сцена (§27 доработки, по примеру прежнего приложения —
   * «Color Form») — держится на выходе, когда ничего не играет (нет активной
   * сцены/секвенсора/шоу), вместо гашения в чёрное. null — как раньше,
   * чёрное. Пауза между элементами плейлиста — намеренное затемнение, туда
   * не подставляется (см. Playback.tick).
   */
  idleSceneId: string | null;
  /** Служебное освещение по времени суток, независимо от расписания шоу (§27 доработки, «Switches»). */
  utilityLight: UtilityLightConfig;
  /**
   * Переадресация каналов: universeId → { выходной адрес: адрес-источник }.
   * Хранятся только изменённые адреса, остальные идут «сами в себя».
   * См. applyAddressRemap — там же объяснено, почему источник справа.
   */
  addressRemap: AddressRemap;
  /**
   * Свои цвета объекта — рядом со встроенными пресетами.
   *
   * Живут в ПРОЕКТЕ, а не в настройках программы: фирменные цвета заказчика,
   * подобранный оттенок подсветки чаши — всё это свойство конкретного фонтана
   * и должно уезжать вместе с файлом проекта на другой компьютер.
   */
  colorPalette: ColorSwatch[];
  /** 3D-схема фонтана (вкладка «3D»). */
  layout: FountainLayout;
}

/** Сохранённый цвет пользовательской палитры. */
export interface ColorSwatch {
  name: string;
  /** #rrggbb в нижнем регистре. */
  hex: string;
}

/** Пропускаем только настоящие «#rrggbb» — цвет уходит прямо в разметку. */
function sanitizeColorPalette(raw: unknown): ColorSwatch[] {
  if (!Array.isArray(raw)) return [];
  const out: ColorSwatch[] = [];
  for (const s of raw as ColorSwatch[]) {
    if (!s || typeof s.hex !== 'string') continue;
    const hex = s.hex.trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) continue;
    const name = typeof s.name === 'string' && s.name.trim() !== '' ? s.name.trim().slice(0, 40) : hex;
    if (out.some((x) => x.hex === hex)) continue;
    out.push({ name, hex });
    if (out.length >= 60) break;
  }
  return out;
}

/** universeId → { выходной адрес (1..512): адрес, откуда брать значение }. */
export type AddressRemap = Record<number, Record<number, number>>;

/**
 * Переадресация каналов — для случая, когда смонтировали не так, как в схеме.
 *
 * Проект остаётся правильным: форсунка по-прежнему знает свой насос, сцены
 * пишут в те же адреса. Меняется только то, что уходит в линию.
 *
 * Направление выбрано «тянущим»: в таблице СЛЕВА выходной адрес, СПРАВА адрес,
 * откуда он берёт значение. Это не прихоть — так задача решается без узких
 * мест:
 *
 *  · у каждого выходного адреса ровно один источник, значит конфликтов «двое
 *    пишут в один адрес» не бывает в принципе;
 *  · «многие к одному» получается само: поставьте адресам 1…10 источником 1 —
 *    все десять повторят первый;
 *  · обмен местами 1↔2 работает как ожидается, и цепочек-петель не возникает:
 *    источники читаются из кадра ДО переадресации, поэтому «а берёт у б,
 *    который берёт у в» невозможно — все берут из одного исходного кадра.
 *
 * Возвращает НОВЫЙ кадр; исходный не меняется.
 */
export function applyAddressRemap(frame: Uint8Array, map: Record<number, number> | undefined): Uint8Array {
  if (!map) return frame;
  const keys = Object.keys(map);
  if (keys.length === 0) return frame;
  const out = frame.slice();
  for (const key of keys) {
    const dst = Number(key);
    const src = map[dst];
    if (!Number.isFinite(dst) || !Number.isFinite(src)) continue;
    if (dst < 1 || dst > frame.length || src === undefined || src < 1 || src > frame.length) continue;
    out[dst - 1] = frame[src - 1]!;
  }
  return out;
}

/** Приводит переадресацию к корректному виду: только целые адреса 1..512, без «сам в себя». */
export function sanitizeAddressRemap(raw: unknown, size = 512): AddressRemap {
  const out: AddressRemap = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [uKey, table] of Object.entries(raw as Record<string, unknown>)) {
    const universe = Number(uKey);
    if (!Number.isInteger(universe) || typeof table !== 'object' || table === null) continue;
    const clean: Record<number, number> = {};
    for (const [dKey, sRaw] of Object.entries(table as Record<string, unknown>)) {
      const dst = Number(dKey);
      const src = Number(sRaw);
      if (!Number.isInteger(dst) || !Number.isInteger(src)) continue;
      if (dst < 1 || dst > size || src < 1 || src > size) continue;
      if (dst === src) continue; // тождественное не храним
      clean[dst] = src;
    }
    if (Object.keys(clean).length > 0) out[universe] = clean;
  }
  return out;
}

/** Встроенные профили — типовые устройства фонтана. */
export const BUILTIN_PROFILES: DeviceProfile[] = [
  {
    id: 'pump',
    name: 'Насос (плавно 0–255)',
    kind: 'pump',
    // «Скорость», а не «Мощность»: канал задаёт уставку оборотов (через ПЧ —
    // частоту), а не потребляемую мощность в киловаттах. Мощность насос
    // потребляет сам, в зависимости от режима, и в DMX её не задают. Тем же
    // словом оперирует телеметрия Modbus (speedRpm), так что название сходится
    // с тем, что видно на вкладке насоса.
    channels: [{ name: 'Скорость', role: 'intensity' }],
    builtin: true,
  },
  {
    id: 'valve',
    name: 'Клапан (открыт/закрыт)',
    kind: 'valve',
    // «Положение» — имя КАНАЛА, а его значения уже «Открыт»/«Закрыт». Раньше
    // канал назывался «Открыт», и в подписях выходило «Клапан 1 · Открыт» —
    // читается как состояние прибора, хотя это столбец управления. С
    // «Положением» строка становится «Клапан 1 · Положение», а открыт он или
    // закрыт — показывает само значение.
    channels: [{ name: 'Положение', role: 'open' }],
    twoState: true,
    builtin: true,
  },
  {
    id: 'dimmer',
    name: 'Одноканальный свет',
    kind: 'lamp',
    channels: [{ name: 'Яркость', role: 'intensity' }],
    builtin: true,
  },
  {
    id: 'rgb',
    name: 'Светильник RGB',
    kind: 'lamp',
    channels: [
      // Имена каналов по-русски: «Свет 1 · R» на ползунке читается как шифр.
      { name: 'Красный', role: 'red' },
      { name: 'Зелёный', role: 'green' },
      { name: 'Синий', role: 'blue' },
    ],
    builtin: true,
  },
  {
    id: 'rgbw',
    name: 'Светильник RGBW',
    kind: 'lamp',
    channels: [
      { name: 'Красный', role: 'red' },
      { name: 'Зелёный', role: 'green' },
      { name: 'Синий', role: 'blue' },
      { name: 'Белый', role: 'white' },
    ],
    builtin: true,
  },
];

export function emptyProject(name = 'Новый проект'): Project {
  return {
    formatVersion: 1,
    name,
    profiles: [],
    devices: [],
    scenes: [],
    sequences: [],
    sequenceGroups: [],
    shows: [],
    playlists: [],
    schedules: [{ id: 'main', name: 'Основное', enabled: true, entries: [] }],
    keys: [],
    oscBindings: [],
    mqttBindings: [],
    dmxTriggers: [],
    windLimit: defaultWindLimitConfig(),
    failsafe: defaultFailsafeConfig(),
    idleSceneId: null,
    utilityLight: defaultUtilityLightConfig(),
    addressRemap: {},
    colorPalette: [],
    layout: emptyLayout(),
  };
}

/** Все профили проекта: встроенные + пользовательские (пользовательский с тем же id побеждает). */
export function allProfiles(project: Project): DeviceProfile[] {
  const custom = new Map(project.profiles.map((p) => [p.id, p]));
  return [...BUILTIN_PROFILES.filter((p) => !custom.has(p.id)), ...project.profiles];
}

export function profileMap(project: Project): Map<string, DeviceProfile> {
  return new Map(allProfiles(project).map((p) => [p.id, p]));
}

/** Диапазон адресов устройства (включительно). end может выйти за 512 — это ошибка патча. */
export function deviceRange(
  device: PatchedDevice,
  profiles: Map<string, DeviceProfile>,
): { start: number; end: number } {
  const size = profiles.get(device.profileId)?.channels.length ?? 1;
  return { start: device.address, end: device.address + size - 1 };
}

export interface PatchIssues {
  /** id устройств, чьи адреса пересекаются с другим устройством той же вселенной. */
  collisions: Set<string>;
  /** id устройств, выходящих за пределы 1..512. */
  outOfRange: Set<string>;
}

export function findPatchIssues(project: Project): PatchIssues {
  const profiles = profileMap(project);
  const collisions = new Set<string>();
  const outOfRange = new Set<string>();
  const byUniverse = new Map<number, PatchedDevice[]>();
  for (const d of project.devices) {
    const r = deviceRange(d, profiles);
    if (r.start < 1 || r.end > DMX_UNIVERSE_SIZE) outOfRange.add(d.id);
    const list = byUniverse.get(d.universe) ?? [];
    list.push(d);
    byUniverse.set(d.universe, list);
  }
  for (const list of byUniverse.values()) {
    for (let i = 0; i < list.length; i++) {
      const a = deviceRange(list[i]!, profiles);
      for (let j = i + 1; j < list.length; j++) {
        const b = deviceRange(list[j]!, profiles);
        if (a.start <= b.end && b.start <= a.end) {
          collisions.add(list[i]!.id);
          collisions.add(list[j]!.id);
        }
      }
    }
  }
  return { collisions, outOfRange };
}

/**
 * Первый свободный адрес во вселенной, где помещается устройство размером size,
 * начиная поиск с fromAddress. null — свободного места нет.
 */
export function nextFreeAddress(
  project: Project,
  universe: number,
  size: number,
  fromAddress = 1,
): number | null {
  const profiles = profileMap(project);
  const occupied = new Uint8Array(DMX_UNIVERSE_SIZE + 1);
  for (const d of project.devices) {
    if (d.universe !== universe) continue;
    const r = deviceRange(d, profiles);
    for (let a = Math.max(1, r.start); a <= Math.min(DMX_UNIVERSE_SIZE, r.end); a++) occupied[a] = 1;
  }
  for (let start = Math.max(1, fromAddress); start + size - 1 <= DMX_UNIVERSE_SIZE; start++) {
    let free = true;
    for (let a = start; a < start + size; a++) {
      if (occupied[a]) {
        free = false;
        start = a; // перескок к концу занятого блока (цикл затем сделает +1)
        break;
      }
    }
    if (free) return start;
  }
  return null;
}

/** Короткий уникальный id для сущностей проекта. */
export function uid(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

/**
 * Приводит произвольный JSON к корректной структуре проекта: добавляет недостающие
 * поля, отбрасывает битые записи. Используется движком при загрузке файла и приёме
 * проекта от редактора — гарантия, что дальше по коду структура всегда валидна.
 */
export function sanitizeProject(raw: unknown): Project {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const project: Project = {
    formatVersion: 1,
    name: typeof r.name === 'string' && r.name.trim() !== '' ? r.name : 'Новый проект',
    profiles: [],
    devices: [],
    scenes: [],
    sequences: [],
    sequenceGroups: [],
    shows: [],
    playlists: [],
    schedules: [{ id: 'main', name: 'Основное', enabled: true, entries: [] }],
    keys: [],
    oscBindings: [],
    mqttBindings: [],
    dmxTriggers: [],
    windLimit: defaultWindLimitConfig(),
    failsafe: defaultFailsafeConfig(),
    idleSceneId: null,
    utilityLight: defaultUtilityLightConfig(),
    addressRemap: sanitizeAddressRemap(r.addressRemap),
    colorPalette: sanitizeColorPalette(r.colorPalette),
    layout: emptyLayout(),
  };
  if (Array.isArray(r.profiles)) {
    for (const p of r.profiles as DeviceProfile[]) {
      if (!p || typeof p.id !== 'string' || !Array.isArray(p.channels) || p.channels.length === 0) continue;
      project.profiles.push({
        id: p.id,
        name: typeof p.name === 'string' ? p.name : p.id,
        kind: (['pump', 'valve', 'lamp', 'other'] as DeviceKind[]).includes(p.kind) ? p.kind : 'other',
        channels: p.channels
          .filter((c) => c && typeof c === 'object')
          .map((c) => ({ name: typeof c.name === 'string' ? c.name : '?', role: c.role ?? 'custom' })),
        twoState: p.twoState === true || undefined,
      });
    }
  }
  const profiles = profileMap(project);
  if (Array.isArray(r.devices)) {
    for (const d of r.devices as PatchedDevice[]) {
      if (!d || typeof d.id !== 'string' || !profiles.has(d.profileId)) continue;
      const channelCount = profiles.get(d.profileId)!.channels.length;
      let trim: ChannelTrim[] | undefined;
      if (Array.isArray(d.trim)) {
        trim = Array.from({ length: channelCount }, (_, k) => {
          const t = d.trim![k];
          const min = t && Number.isFinite(t.min) ? Math.max(0, Math.min(255, Math.round(t.min))) : 0;
          const max = t && Number.isFinite(t.max) ? Math.max(min, Math.min(255, Math.round(t.max))) : 255;
          return { min, max };
        });
        // Полностью нейтральная калибровка не хранится.
        if (trim.every((t) => t.min === 0 && t.max === 255)) trim = undefined;
      }
      const modbus = sanitizeModbusConfig(d.modbus);
      const rdmUid = typeof d.rdmUid === 'string' && /^[0-9a-fA-F]{4}:[0-9a-fA-F]{8}$/.test(d.rdmUid.trim())
        ? normalizeRdmUid(d.rdmUid)
        : undefined;
      project.devices.push({
        id: d.id,
        name: typeof d.name === 'string' ? d.name : d.id,
        profileId: d.profileId,
        universe: Number.isInteger(d.universe) ? d.universe : 1,
        address: Number.isInteger(d.address) ? Math.max(1, Math.min(DMX_UNIVERSE_SIZE, d.address)) : 1,
        ...(trim ? { trim } : {}),
        ...(modbus ? { modbus } : {}),
        ...(rdmUid ? { rdmUid } : {}),
      });
    }
  }
  const deviceIds = new Set(project.devices.map((d) => d.id));
  if (Array.isArray(r.scenes)) {
    for (const s of r.scenes as Scene[]) {
      if (!s || typeof s.id !== 'string') continue;
      const values: Record<string, number[]> = {};
      if (s.values && typeof s.values === 'object') {
        for (const [devId, vals] of Object.entries(s.values)) {
          if (!deviceIds.has(devId) || !Array.isArray(vals)) continue;
          values[devId] = vals.map((v) => (Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0));
        }
      }
      project.scenes.push({ id: s.id, name: typeof s.name === 'string' ? s.name : s.id, values });
    }
  }
  const sceneIds = new Set(project.scenes.map((s) => s.id));
  if (Array.isArray(r.sequences)) {
    // (шоу санируются ниже, когда известны id сцен и секвенсоров)
    for (const q of r.sequences as Sequence[]) {
      if (!q || typeof q.id !== 'string') continue;
      const effect =
        q.effect && (q.effect.mode === 'rate' || q.effect.mode === 'decay')
          ? { mode: q.effect.mode, smoothness: smoothnessFromSaved(q.effect as { smoothness?: unknown; strength?: unknown }) }
          : undefined;
      project.sequences.push({
        id: q.id,
        name: typeof q.name === 'string' ? q.name : q.id,
        mode: q.mode === 'once' ? 'once' : 'loop',
        steps: (Array.isArray(q.steps) ? q.steps : [])
          .filter((st) => st && sceneIds.has(st.sceneId))
          .map((st) => ({
            sceneId: st.sceneId,
            holdMs: Number.isFinite(st.holdMs) ? Math.max(50, Math.round(st.holdMs)) : 1000,
            fadeMs: Number.isFinite(st.fadeMs) ? Math.max(0, Math.round(st.fadeMs)) : 0,
          })),
        ...(effect ? { effect } : {}),
      });
    }
  }
  project.sequenceGroups = sanitizeSequenceGroups(r.sequenceGroups, new Set(project.sequences.map((q) => q.id)));
  project.shows = sanitizeShows(
    r.shows,
    sceneIds,
    new Set(project.sequences.map((q) => q.id)),
    deviceIds,
  );
  project.playlists = sanitizePlaylists(r.playlists, new Set(project.shows.map((s) => s.id)));
  const sequenceGroupIds = new Set(project.sequenceGroups.map((g) => g.id));
  project.schedules = sanitizeSchedules(r.schedules, (r as { schedule?: unknown }).schedule, {
    playlists: new Set(project.playlists.map((p) => p.id)),
    shows: new Set(project.shows.map((s) => s.id)),
    sequences: new Set(project.sequences.map((q) => q.id)),
    sequenceGroups: sequenceGroupIds,
    scenes: sceneIds,
  });
  const remoteIds = {
    scenes: sceneIds,
    sequences: new Set(project.sequences.map((q) => q.id)),
    sequenceGroups: sequenceGroupIds,
    shows: new Set(project.shows.map((s) => s.id)),
    playlists: new Set(project.playlists.map((p) => p.id)),
  };
  project.keys = sanitizeKeys(r.keys, remoteIds);
  project.oscBindings = sanitizeOscBindings(r.oscBindings, remoteIds);
  project.mqttBindings = sanitizeMqttBindings(r.mqttBindings, remoteIds);
  project.dmxTriggers = sanitizeDmxTriggers(r.dmxTriggers, remoteIds);
  project.windLimit = sanitizeWindLimitConfig(r.windLimit);
  project.failsafe = sanitizeFailsafeConfig(r.failsafe);
  project.idleSceneId =
    typeof r.idleSceneId === 'string' && project.scenes.some((s) => s.id === r.idleSceneId) ? r.idleSceneId : null;
  project.utilityLight = sanitizeUtilityLightConfig(r.utilityLight, deviceIds);
  project.layout = sanitizeLayout(r.layout, deviceIds);
  return project;
}
