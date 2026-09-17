/**
 * Протокол сообщений между Редактором (UI) и Движком по WebSocket.
 * Все сообщения — JSON. Кадры DMX передаются в base64.
 */

import type { FailsafeState } from './failsafe';
import type { LicenseStatus } from './license';
import type { Project } from './project';
import type { WindLimitConfig } from './windlimit';

export type TestPatternMode =
  | 'off'
  | 'sine'
  | 'chase'
  /**
   * Подъём 0→255 за период и сброс. Раньше рядом был отдельный 'slowramp' —
   * он считался ТОЙ ЖЕ формулой и отличался только умолчанием периода, что
   * теперь бессмысленно: период задаётся полем. Режимы объединены.
   */
  | 'ramp'
  | 'strobe'
  | 'stairs'
  /** Чётные/нечётные приборы через одного — ловит сдвиг и перепутанную адресацию. */
  | 'oddeven'
  /** По одному прибору за раз: «какой это по счёту» без беготни к щиту. */
  | 'solo';

/**
 * К чему применять тест-генератор (§27 доработки). 'all' — вся вселенная, как
 * было раньше: генератор подменяет собой весь кадр. Остальные — только каналы
 * приборов этого вида, остальное продолжает играть от сцен/шоу; так можно
 * гонять насосы, не гася свет, и наоборот.
 */
export type TestPatternScope = 'all' | 'pump' | 'valve' | 'lamp';

/**
 * Темп генератора в секундах. Для шаговых режимов (бегущая, чёт/нечёт, по
 * очереди) — время одного шага; для циклических (синус, подъём, строб) —
 * длительность полного цикла. «Ступени» статичны и темпа не имеют.
 * Не задан — берётся умолчание режима.
 *
 * Умолчания намеренно в одном диапазоне (0.1–6 с) — раньше разброс был от
 * 0.025 до 20 с, и переключение режима то дёргало картину, то заставляло ждать
 * полминуты. Значения подобраны так, чтобы каждый режим сразу читался глазом;
 * тонкая настройка — полем в Пульте.
 */
export const DEFAULT_PATTERN_SPEED_SEC: Record<TestPatternMode, number> = {
  off: 1,
  sine: 4,
  chase: 0.1,
  ramp: 6,
  strobe: 1,
  stairs: 0,
  oddeven: 1,
  solo: 2,
};

/** Шаговые режимы: у них speedSec — время одного шага, а не период цикла.
 *  «Ступени» сюда не входят — картина статична, темп ей не нужен. */
export const STEP_PATTERNS: TestPatternMode[] = ['chase', 'oddeven', 'solo'];

/**
 * Режимы с ПЛАВНОЙ шкалой: насос идёт через промежуточные значения, а не
 * скачет 0/255. У них клапаны держатся открытыми всё время работы генератора —
 * иначе при значении насоса ниже порога клапан закрыт и струи просто нет,
 * смотреть не на что. У остальных (строб, бегущая, по очереди, чёт/нечёт)
 * значение и так двоичное, и клапан честно повторяет его.
 */
export const ANALOG_PATTERNS: TestPatternMode[] = ['sine', 'ramp', 'stairs'];

export interface UniverseInfo {
  /** Логический номер вселенной в проекте (1..N). */
  id: number;
  label: string;
  /** Человекочитаемое описание выходов (для отображения в UI). */
  outputs: string[];
}

/** Статистика движка: качество тайминга и счётчики. */
export interface EngineStats {
  ticks: number;
  intervalMs: number;
  /** Опоздание последнего тика относительно расчётного момента, мс. */
  lastJitterMs: number;
  avgJitterMs: number;
  maxJitterMs: number;
  /** Всего отправлено кадров вселенных во все выходы. */
  framesSent: number;
  pattern: TestPatternMode;
  patternScope: TestPatternScope;
}

/** Состояние запущенного секвенсора для отображения в UI. */
export interface RunningSequenceInfo {
  sequenceId: string;
  stepIndex: number;
  paused: boolean;
}

/** Состояние транспорта шоу в движке. */
export interface ShowTransportState {
  showId: string;
  positionMs: number;
  playing: boolean;
}

/** Состояние плейлиста в движке. */
export interface PlaylistTransportState {
  playlistId: string;
  itemIndex: number;
  /** true — пауза между шоу (gap), шоу-слой пуст. */
  inGap: boolean;
}

/** Состояние воспроизведения движка. */
export interface PlaybackState {
  /** Включённая статическая сцена (картина) или null. */
  activeSceneId: string | null;
  running: RunningSequenceInfo[];
  show: ShowTransportState | null;
  playlist: PlaylistTransportState | null;
  /** Пауза всего (§27 доработки, УХ п.1): картина заморожена, таймеры не идут, в 0 не гасим. */
  pausedAll: boolean;
}

/** Art-Net нода, найденная опросом ArtPoll (§12 п.3: мониторинг из тех. помещения). */
export interface ArtNetNodeInfo {
  ip: string;
  shortName: string;
  longName: string;
  /** Port-Address выходных портов ноды (нумерация Art-Net с 0). */
  outputUniverses: number[];
  /** Мс с последнего ответа (на момент отправки состояния). */
  ageMs: number;
  lost: boolean;
}

/** RDM-прибор из TOD (Table of Devices) ноды. */
export interface RdmDeviceInfo {
  /** ESTA UID вида "4d4f:12345678" (производитель:устройство). */
  uid: string;
  nodeIp: string;
  /** Port-Address, где прибор обнаружен. */
  universe: number;
  ageMs: number;
  lost: boolean;
}

export interface NetworkEvent {
  /** Unix-время события, мс. */
  atMs: number;
  text: string;
}

/** Состояние сети: ноды, RDM-приборы, журнал появлений/пропаж. */
export interface NetworkState {
  enabled: boolean;
  nodes: ArtNetNodeInfo[];
  rdmDevices: RdmDeviceInfo[];
  log: NetworkEvent[];
}

/**
 * Универсальный слой RDM (§3 доработки, §22): GET/SET параметров, одинаковых
 * по спецификации ANSI E1.20 для любого прибора — DEVICE_INFO, ярлыки
 * (производитель/модель/версия ПО), IDENTIFY (мигнуть), DMX_START_ADDRESS
 * (прочитать/переставить адрес удалённо). Опциональные PID конкретных
 * производителей (сенсоры, статус-сообщения) сюда сознательно не входят —
 * их поддержка и формат различаются прибор от прибора.
 */
export interface RdmDeviceInfoPayload {
  protocolVersion: string;
  deviceModelId: number;
  productCategory: number;
  softwareVersionId: number;
  dmxFootprint: number;
  dmxStartAddress: number;
  subDeviceCount: number;
  sensorCount: number;
}

export type RdmAction =
  | 'deviceInfo'
  | 'labels'
  | 'getIdentify'
  | 'setIdentify'
  | 'getAddress'
  | 'setAddress'
  /** Опрос всех датчиков прибора: сколько их — прибор сообщает сам. */
  | 'sensors';

/** Один датчик прибора: что меряет, чем и сколько намерил. */
export interface RdmSensorReading {
  index: number;
  /** Человекочитаемое: «Температура», «Напряжение»… */
  typeName: string;
  /** Имя от самого прибора, если он его дал. */
  description: string;
  unit: string;
  value: number;
  lowest: number;
  highest: number;
}

/** Состояние насоса, управляемого напрямую по Modbus (§12 п.9). */
export interface PumpModbusStatus {
  deviceId: string;
  connected: boolean;
  /** Последняя записанная уставка частоты, Гц. */
  lastFreqHz: number;
  /** Код аварии из faultRegister (0 = нет аварии); null — регистр не задан в конфиге. */
  faultCode: number | null;
  /** Мс с последней успешной записи/чтения; -1 — успешного обмена ещё не было. */
  ageMs: number;
  lastError: string | null;
  /** Телеметрия (§27 доработки, §4 п.2) — null, если соответствующий регистр не задан в конфиге. */
  currentA: number | null;
  speedRpm: number | null;
  tempC: number | null;
}

export interface ModbusState {
  pumps: PumpModbusStatus[];
}

/**
 * Периодический именованный снимок fountain.project.json (§27 доработки, УХ п.5) —
 * отдельно от непрерывного живого автосохранения: защита от «сам всё сломал»,
 * а не от потери процесса.
 */
/** Что можно показать про уведомления в интерфейсе — токена здесь нет и быть не должно. */
export interface TelegramStatus {
  enabled: boolean;
  hasToken: boolean;
  chatId: string;
  queued: number;
  dailyHour: number;
  alarms: boolean;
  /** Имя бота (@name) по токену — чтобы знать, куда слать /start. */
  botName: string;
  /** Номера тем форума по разделам; 0 — раздел идёт в общий чат. */
  topicAlarm: number;
  topicReport: number;
  topicState: number;
  /** Раскладывать по объектам темами, когда темы доступны. */
  topicsBySite: boolean;
  /** Доступны ли темы в этом чате: null — ещё не выяснено (нет связи или получателя). */
  topicsAvailable: boolean | null;
  /** Сколько тем объектов уже заведено. */
  siteTopicCount: number;
  /** Тихий режим действует до этого момента (unix, мс); 0 — выключен. */
  quietUntilMs: number;
}

export interface BackupInfo {
  /** Эталон — защищённый снимок, который не прореживается и не переписывается автоматикой. */
  reference?: boolean;
  /** Имя файла в папке backups/ рядом с проектом, содержит метку времени. */
  file: string;
  atMs: number;
  sizeBytes: number;
}

/**
 * Запись журнала событий (§27 доработки, §3 п.1) — что и когда сработало:
 * расписание, пульты (OSC/MQTT), клавиши, ошибки движка. Раньше это было
 * видно только в консоли процесса движка; source — короткий тег вида
 * «schedule»/«osc»/«mqtt»/«net»/«key»/«modbus», совпадает с префиксом [xxx]
 * в консольных логах движка.
 */
export interface LogEvent {
  id: number;
  tsMs: number;
  source: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  /**
   * «Прибор/узел вернулся в строй». Ставится явно источником события, а не
   * угадывается по тексту: уведомления по этой пометке шлют «✅
   * Восстановлено», а обычные info-события (запуск сцены и т.п.) в
   * Telegram не попадают.
   */
  kind?: 'recovery';
}

/**
 * Конфигурация DMX-выхода вселенной — редактируемая часть fountain.config.json
 * (вкладка «Настройки»). Зеркало OutputConfig движка.
 */
export interface ConfigOutput {
  type: 'artnet' | 'sacn' | 'usb-dmx' | 'open-dmx' | 'musidora';
  /** IP ноды (artnet) — обязателен, если не broadcast. */
  host?: string;
  port?: number;
  /** Номер вселенной протокола: Art-Net с 0, sACN с 1. */
  universe: number;
  broadcast?: boolean;
  priority?: number;
  /**
   * COM-порт (usb-dmx, open-dmx). У musidora — выбор интерфейса: пусто —
   * первый свободный (как FontanPlay), серийный номер FTDI или «COMn».
   */
  path?: string;
  baudRate?: number;
  /** Интерфейс FountanPlay: выход 1…3 (разъём DMX; у USB2DMX — 1 и 2). */
  musidoraOut?: number;
}

/** FTDI-устройство, найденное драйвером D2XX (ответ на scanUsbDmx). */
export interface UsbFtdiDevice {
  index: number;
  serial: string;
  description: string;
  type: string;
  id: number;
  opened: boolean;
}

/** COM-порт системы (ответ на scanUsbDmx). */
export interface UsbSerialPort {
  path: string;
  manufacturer: string;
  vendorId: string;
  productId: string;
  serialNumber: string;
}

/** Состояние открытого интерфейса Musidora. */
export interface MusidoraLinkInfo {
  target: string;
  phase: 'loading' | 'searching' | 'open' | 'error';
  text: string;
  serial: string;
  description: string;
  outs: number[];
  framesOk: number;
  framesFailed: number;
  lastOkMs: number;
}

/**
 * Почему не удалось выйти на драйвер FTDI. Разделяем «драйвера вообще нет»
 * (надо скачать и поставить) и «драйвер есть, но интерфейс ни разу не
 * подключали к этому ПК» (Windows положит библиотеку сама при подключении).
 */
export type UsbDriverProblem = 'no-driver' | 'no-device' | 'wrong-bitness' | 'broken' | 'other';

/** Всё про USB-DMX на этом компьютере — для вкладки «Настройки». */
export interface UsbDmxScan {
  /** Библиотека драйвера FTDI (ftd2xx.dll): версия или причина, почему нет. */
  d2xx: { ok: true; version: string; dll: string } | { ok: false; error: string; problem: UsbDriverProblem };
  ftdi: UsbFtdiDevice[];
  ports: UsbSerialPort[];
  links: MusidoraLinkInfo[];
  /** Время снимка на движке. */
  atMs: number;
}

export interface ConfigUniverse {
  id: number;
  label?: string;
  outputs: ConfigOutput[];
}

/** UI → Движок */
export type ClientMessage =
  | { type: 'setChannel'; universe: number; channel: number; value: number }
  | { type: 'setChannels'; universe: number; start: number; values: number[] }
  | { type: 'blackout' }
  // Пауза всего: заморозить текущую картину (не гасить) и остановить все таймеры
  // воспроизведения до resumeAll. Отдельно от blackout — см. Console/ConsoleView.
  | { type: 'pauseAll' }
  | { type: 'resumeAll' }
  | { type: 'testPattern'; mode: TestPatternMode; scope?: TestPatternScope; speedSec?: number }
  // Проект: полная замена (редактор шлёт после каждого изменения, движок сохраняет на диск).
  | { type: 'updateProject'; project: Project }
  // Ctrl+S (§27 доработки, УХ п.6): принудительный немедленный flush на диск —
  // живое автосохранение и так непрерывное (дебаунс 500мс), эта команда просто
  // не даёт ждать и подтверждает результат в UI.
  | { type: 'saveNow' }
  // Транспорт воспроизведения.
  | { type: 'setScene'; sceneId: string | null }
  | { type: 'startSequence'; sequenceId: string }
  | { type: 'pauseSequence'; sequenceId: string }
  | { type: 'resumeSequence'; sequenceId: string }
  | { type: 'stopSequence'; sequenceId: string }
  // Группы секвенсоров (§27 доработки) — запускает/останавливает/ставит на
  // паузу всех участников группы в одном тике движка (см. Playback.startGroup).
  | { type: 'startSequenceGroup'; groupId: string }
  | { type: 'pauseSequenceGroup'; groupId: string }
  | { type: 'resumeSequenceGroup'; groupId: string }
  | { type: 'stopSequenceGroup'; groupId: string }
  | { type: 'stopAllPlayback' }
  // Транспорт шоу. Аудио играет редактор; syncShow — периодическая коррекция
  // позиции движка по аудио-часам (мастер-клок — звук).
  | { type: 'playShow'; showId: string; positionMs: number }
  | { type: 'pauseShow' }
  | { type: 'seekShow'; positionMs: number }
  | { type: 'syncShow'; positionMs: number }
  | { type: 'stopShow' }
  // Аудиофайлы шоу: хранятся движком в папке audio/ рядом с проектом.
  | { type: 'uploadAudio'; name: string; dataBase64: string }
  | { type: 'getAudio'; name: string }
  // Экспорт/импорт проекта одним файлом (§27 доработки) — .zip: project.json
  // + вся папка audio/, тем же base64-путём, что и загрузка аудио выше.
  | { type: 'exportProject' }
  | { type: 'importProject'; dataBase64: string }
  // Лицензия (§27 доработки) — активация содержимым файла fountain.license.json,
  // проверка целиком на движке (см. engine/license.ts).
  | { type: 'activateLicense'; fileText: string }
  // Плейлисты: исполняет движок автономно (мастер-часы — тик движка).
  | { type: 'playPlaylist'; playlistId: string; itemIndex?: number }
  | { type: 'skipPlaylist'; dir: 1 | -1 }
  | { type: 'stopPlaylist' }
  // Немедленный опрос сети (ArtPoll + ArtTodRequest вне расписания).
  | { type: 'refreshNetwork' }
  // USB-DMX: найти FTDI-устройства и COM-порты, состояние интерфейсов Musidora.
  | { type: 'scanUsbDmx' }
  /*
   * Проекты: объект — это папка, её можно открыть, создать или закрыть на
   * ходу. У всех четырёх — общая пара флагов на случай несохранённых правок
   * в открытом сейчас объекте (см. ProjectStore.isDirty в движке):
   *   force   — переключать, не спрашивая (ответ человека на предупреждение);
   *   discard — и правки при этом ЗАБЫТЬ, а не сохранить (без force игнорируется).
   * Без force движок при грязном хранилище не переключает, а присылает
   * projectResult{ unsavedChanges: true } — редактор показывает диалог, и уже
   * ОТ ЭТОГО клика на сервер уходит повтор той же команды с force (и, если
   * выбрали «не сохранять», с discard).
   */
  | { type: 'openProject'; dir: string; force?: boolean; discard?: boolean }
  | { type: 'createProject'; name: string; parentDir?: string; force?: boolean; discard?: boolean }
  /** «Сохранить как»: копия открытого объекта под новым именем (и, если задано, в другой папке). */
  | { type: 'copyProject'; name: string; parentDir?: string; force?: boolean; discard?: boolean }
  | { type: 'closeProject'; force?: boolean; discard?: boolean }
  | { type: 'forgetProject'; dir: string }
  // Захват входящего ArtDMX (§17 п.1): снимок кадра вселенной проекта и период цикла.
  | { type: 'getDmxCapture'; universe: number }
  | { type: 'measureDmxCycle'; universe: number }
  // RDM (§3 доработки): GET/SET по обнаруженному через TOD UID.
  | { type: 'rdmRequest'; uid: string; action: 'deviceInfo' | 'labels' | 'getIdentify' | 'getAddress' | 'sensors' }
  | { type: 'rdmRequest'; uid: string; action: 'setIdentify'; on: boolean }
  | { type: 'rdmRequest'; uid: string; action: 'setAddress'; address: number }
  // Настройки движка (вкладка «Настройки»): вселенные и шаг тика. Движок
  // применяет на лету (воспроизведение останавливается) и сохраняет в
  // fountain.config.json.
  | { type: 'updateConfig'; tickMs: number; universes: ConfigUniverse[] }
  // Авто-бэкапы проекта (§27 доработки, УХ п.5) — отдельно от updateConfig: смена
  // интервала не трогает воспроизведение.
  | { type: 'updateBackupConfig'; enabled: boolean; intervalMin: number }
  | { type: 'listBackups' }
  | { type: 'takeBackupNow' }
  | { type: 'restoreBackup'; file: string }
  | { type: 'setReferenceBackup' }
  /** Настройка уведомлений в Telegram. Токен уходит на движок и там же остаётся. */
  | {
      type: 'updateTelegram';
      token?: string;
      chatId?: string;
      enabled?: boolean;
      dailyHour?: number;
      alarms?: boolean;
      topicAlarm?: number;
      topicReport?: number;
      topicState?: number;
      topicsBySite?: boolean;
    }
  | { type: 'testTelegram' }
  /** Тихий режим на N часов (0 — снять): не слать аварии во время работ на объекте. */
  | { type: 'setTelegramQuiet'; hours: number }
  // Журнал событий (§27 доработки, §3 п.1): источники на стороне редактора
  // (сейчас — клавиатурные привязки из вкладки «Клавиши») сами не видны
  // движку, поэтому явно сообщают о срабатывании, чтобы попасть в общий
  // журнал наравне с расписанием/OSC/MQTT.
  | { type: 'clientEvent'; source: string; message: string }
  // Автозапуск движка при входе в Windows (§27 доработки, §3 п.3) — обёртка
  // над задачей планировщика (та же, что раньше ставилась PowerShell-скриптом).
  | { type: 'getAutostart' }
  | { type: 'setAutostart'; enabled: boolean }
  // Ручной ввод скорости ветра (§27 доработки, §4 п.1) — задел под будущий
  // датчик по Modbus/MQTT: тот будет слать то же самое сообщение сам.
  | { type: 'setWindSpeed'; speedMs: number | null };

/** Недавно открытый объект — строка на экране выбора проекта. */
export interface RecentProjectInfo {
  dir: string;
  name: string;
  openedAtMs: number;
  /** Папку удалили или унесли — открыть нельзя, можно только убрать из списка. */
  missing: boolean;
}

/** Что сейчас с проектами: какой открыт и какие открывали раньше. */
export interface ProjectsState {
  /** Открытый объект; null — ни одного, редактор показывает выбор проекта. */
  current: { dir: string; name: string } | null;
  recent: RecentProjectInfo[];
  /** Куда программа складывает новые объекты по умолчанию. */
  projectsRoot: string;
}

/** Движок → UI */
export type ServerMessage =
  | { type: 'hello'; version: string; tickMs: number; universes: UniverseInfo[] }
  /** Редактируемая конфигурация движка (шлётся при подключении и после updateConfig). */
  | { type: 'config'; tickMs: number; universes: ConfigUniverse[] }
  | { type: 'stats'; stats: EngineStats }
  /**
   * Кадр вселенной. data — РАСЧЁТНЫЙ кадр по адресам проекта (по нему работают
   * фейдеры Пульта: вы двигаете свой адрес и видите своё значение). wire — то,
   * что после переадресации реально уходит в кабель; приходит, только если у
   * вселенной есть переадресация, иначе он совпадает с data. По wire рисуется
   * 3D-вид: там должно быть видно, что произойдёт на объекте.
   */
  | { type: 'frame'; universe: number; data: string; wire?: string }
  | { type: 'project'; project: Project }
  | { type: 'playback'; state: PlaybackState }
  | { type: 'network'; state: NetworkState }
  | { type: 'modbus'; state: ModbusState }
  /** Список проектов и какой открыт (при подключении и после любой смены). */
  | { type: 'projects'; state: ProjectsState }
  /**
   * Ответ на openProject/createProject/copyProject/closeProject — с причиной,
   * если не вышло. unsavedChanges — особый случай отказа: не «не вышло», а
   * «сначала спросите человека» (см. force/discard у этих команд); targetName —
   * во что предлагаем переключиться, для текста диалога.
   */
  | { type: 'projectResult'; ok: boolean; message: string; unsavedChanges?: boolean; targetName?: string }
  /** Аварийное отключение включилось или снялось (см. failsafe.ts). */
  | { type: 'failsafe'; state: FailsafeState }
  /** Ответ на scanUsbDmx (только запросившему). */
  | { type: 'usbDmxScan'; scan: UsbDmxScan }
  /** Ответ на getAudio (только запросившему клиенту); dataBase64 = '' — файла нет. */
  | { type: 'audio'; name: string; dataBase64: string }
  /** Ответ на exportProject — готовый .zip для скачивания. */
  | { type: 'projectExport'; filename: string; dataBase64: string }
  /** Ответ на importProject — успех/ошибка (например, не ZIP или битый project.json). */
  | { type: 'importResult'; ok: boolean; message: string }
  /** Статус лицензии — при подключении и после activateLicense. */
  | { type: 'license'; status: LicenseStatus }
  /** Ответ на getDmxCapture: последний кадр внешнего ArtDMX; data = '' — захвата нет. */
  | { type: 'dmxCapture'; universe: number; data: string; ageMs: number; fromIp: string; frames: number }
  /** Ответ на measureDmxCycle. */
  | { type: 'dmxCycle'; universe: number; periodMs: number | null; confidence: number; analyzedMs: number }
  /** Статус удалённого управления (§1 доработки): включено ли, есть ли связь. */
  | { type: 'remoteStatus'; osc: { enabled: boolean }; mqtt: { enabled: boolean; connected: boolean } }
  // Ответы на rdmRequest.
  | { type: 'rdmResponse'; uid: string; ok: false; action: RdmAction; error: string }
  | { type: 'rdmResponse'; uid: string; ok: true; action: 'deviceInfo'; deviceInfo: RdmDeviceInfoPayload }
  | { type: 'rdmResponse'; uid: string; ok: true; action: 'labels'; manufacturer: string; model: string; softwareVersion: string }
  | { type: 'rdmResponse'; uid: string; ok: true; action: 'getIdentify' | 'setIdentify'; identify: boolean }
  | { type: 'rdmResponse'; uid: string; ok: true; action: 'getAddress' | 'setAddress'; address: number }
  /** Показания всех датчиков прибора — пустой список означает «датчиков нет». */
  | { type: 'rdmResponse'; uid: string; ok: true; action: 'sensors'; sensors: RdmSensorReading[] }
  /** Настройка авто-бэкапов (шлётся при подключении и после updateBackupConfig). */
  | { type: 'backupConfig'; enabled: boolean; intervalMin: number }
  /** Список снимков (шлётся при подключении, после listBackups и после снятия нового снимка). */
  | { type: 'backupList'; backups: BackupInfo[] }
  /** Состояние уведомлений — БЕЗ токена: наружу уходит только «настроено или нет». */
  | { type: 'telegram'; state: TelegramStatus }
  | { type: 'telegramTest'; ok: boolean; error?: string }
  /** Ответ на saveNow. */
  | { type: 'saved'; atMs: number }
  /** Новое событие в журнале (шлётся всем клиентам сразу при возникновении). */
  | { type: 'logEvent'; event: LogEvent }
  /** История журнала (шлётся при подключении). */
  | { type: 'logHistory'; events: LogEvent[] }
  /** Статус автозапуска (шлётся при подключении и после setAutostart). */
  | { type: 'autostartState'; supported: boolean; enabled: boolean; error?: string }
  /** Ветер и текущее ограничение (шлётся при подключении и после setWindSpeed). */
  | { type: 'windState'; speedMs: number | null; limitPercent: number; config: WindLimitConfig };
