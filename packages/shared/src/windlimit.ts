/**
 * Датчик ветра → безопасное снижение струй.
 *
 * ══ Что здесь решается ═══════════════════════════════════════════════════
 * Ветер сносит воду. Две беды сразу: у борта чаши вода уходит наружу и льётся
 * на людей и дорожку, а в середине — просто разваливается картина, потому что
 * вместо рисунка стоит косо сдутый столб. Значит снижать надо ВСЕ струи, а
 * крайним — внимания больше. Это и есть здешняя задача.
 *
 * ══ Порог нечувствительности ═════════════════════════════════════════════
 * Ветер 1–2 м/с на объекте — обычное дело, и трогать из-за него ничего нельзя:
 * никакой коррекции ниже `deadbandSpeed`. Это не «запас на всякий случай», а
 * прямое требование: при таком ветре зрителю ничего не заметно, а струи,
 * которые дёргаются от каждого дуновения, заметны очень.
 *
 * ══ Времена: почему не реагируем быстро ══════════════════════════════════
 * Мгновенная реакция бессмысленна физически. Насос не сбрасывает частоту
 * мгновенно, а вода, которая уже в воздухе, всё равно долетит куда летела.
 * Пока мы «отреагируем» на порыв, порыв кончится — и мы зря уронили воду.
 * Поэтому три разных времени:
 *
 *  · `activateHoldSec` (10 с) — ветер должен держаться выше порога НЕПРЕРЫВНО,
 *    прежде чем коррекция вообще включится. Порыв на 3 секунды её не включает.
 *  · `adjustHoldSec` (1,5 с) — внутри коррекции уровень меняется только после
 *    подтверждения: ветер должен продержаться выше (или ниже) нового значения
 *    всю выдержку. Сделано окном минимума/максимума, а не фильтром: порыв на
 *    полсекунды не меняет минимум за 1,5 с ВООБЩЕ, а не «почти не меняет».
 *  · `deactivateHoldSec` (10 с) — ветер должен продержаться ниже порога, чтобы
 *    коррекция снялась совсем.
 *
 * Плюс асимметрия: вверх (усилить коррекцию) — сразу, как подтвердилось, это
 * безопасность; вниз (отпустить воду) — не быстрее `levelFallPerSec`, спешить
 * поднимать воду некуда.
 *
 * ══ Плавность ════════════════════════════════════════════════════════════
 * Включение коррекции — это скачок: был полный напор, стал урезанный. Чтобы
 * струи не «ухали», сила коррекции вводится за `fadeInSec` и снимается за
 * `fadeOutSec` (снимается медленнее — см. выше).
 *
 * ══ Считаем по ТЕКУЩЕЙ высоте, а не по паспортной ════════════════════════
 * Главная поправка против прежней версии. Форсунка с паспортной высотой 15 м в
 * этот момент композиции может работать на 40 из 255 — и стоять струёй в
 * полметра. Резать её не нужно и незачем: ветер ей ничего не сделает.
 *
 * Связь значения на насосе с высотой НЕЛИНЕЙНАЯ. У центробежного насоса напор
 * идёт с квадрата оборотов, а высота струи — с напора, поэтому
 *
 *     H(L) = maxHeightM · L²,   L = значение/255
 *
 * то есть на половине значения струя не в полтора, а в ЧЕТЫРЕ раза ниже. Та же
 * зависимость зашита в 3D-визуализации (там скорость вылета `v0 = vFull·level`,
 * а высота идёт от `v²`), поэтому картинка и ограничение говорят об одном и том
 * же. Точность тут заведомо приблизительная: у настоящего насоса есть
 * минимальная частота, потери и статический напор, а форсунка может стоять
 * ниже уровня земли. Но приблизительно учитывать — несравнимо лучше, чем
 * считать всех по паспорту.
 *
 * ══ Снос: формула и наклон сопла ═════════════════════════════════════════
 * Вода в полёте разгоняется ветром не мгновенно: горизонтальная скорость
 * догоняет скорость ветра с постоянной времени τ. Плотный связный столб
 * цепляется за воздух слабо (τ больше), распылённая вода — сильно (τ меньше).
 * Решая это для полёта длиной T, получаем горизонтальное смещение
 *
 *     x(T) = U·T + (v₀ − U)·τ·(1 − e^(−T/τ))
 *
 * где v₀ — начальная горизонтальная скорость воды (у наклонного сопла она
 * есть). Время полёта — из высоты: T = 2·√(2H/g).
 *
 * Отсюда сразу два разных предела, и считаются они ОБА:
 *
 *  1. КАРТИНКА. Насколько ветер уводит струю от её обычного места:
 *     `x(T) − x₀(T) = U·(T − τ(1 − e^(−T/τ)))`. Наклон здесь сокращается —
 *     уход от ветра одинаков и у вертикальной струи, и у наклонной. Предел —
 *     `marginM`. Этот предел работает для ЛЮБОЙ форсунки, где бы она ни стояла:
 *     сдутый столб в середине чаши портит картину не меньше.
 *  2. БОРТ. Куда вода падает относительно сопла в сторону борта: `x(T)`
 *     целиком, с наклоном. Предел — свободное расстояние до борта минус запас
 *     `edgeReserveM` (вода падает не точкой, а пятном брызг). У форсунки,
 *     наклонённой ВНУТРЬ чаши, v₀ направлена от борта, и ветер сначала должен
 *     погасить её — такая форсунка терпит заметно больший ветер, и формула это
 *     даёт сама, без отдельного правила.
 *
 * Берём меньшее из двух. Направление ветра не учитываем: считаем, что дует в
 * худшую сторону — туда, где до борта ближе всего. Учесть направление честно
 * можно только вместе с направлением от датчика (в задачах).
 *
 * ══ Чего эта модель не знает ═════════════════════════════════════════════
 * Держим в голове и не выдаём за истину:
 *  · τ одна на весь объект. Точный калибр капли считается для каждой форсунки
 *    в 3D (по толщине струи и распылению), здесь — одно число, взятое в
 *    строгую сторону: защищаем самую парусящую форсунку линии.
 *  · Зависимость сноса от ветра линейна. При сильном ветре это оптимистично:
 *    там включается лобовое сопротивление, а оно квадратично.
 *  · Насос считается идеальным: без минимальной частоты и без потерь.
 *  · Направления ветра нет (см. выше).
 *  · Отметка сопла (`z`) не учитывается: полёт считается до уровня сопла. У
 *    сопла, утопленного ниже зеркала воды, настоящий полёт КОРОЧЕ — вода
 *    падает на поверхность, которая выше сопла. То есть мы берём с запасом в
 *    строгую сторону, и это осознанно.
 */

import { airDropM, nozzleDropM, referenceAirDropM, windTauFromDrop } from './jetdrop';
import { clampSpray, type Bowl, type Nozzle } from './layout';
import type { ModbusConnection } from './project';

const G = 9.81;

// ══ Откуда берётся ветер ═══════════════════════════════════════════════════

/**
 * Источник скорости ветра. «Не учитывать» — это enabled = false: тогда
 * источник не важен и насосы от ветра не режутся вовсе.
 *
 *  · manual — ручной ввод: поле на «Отладке» или ползунок ветра в 3D. Для
 *    проверки без датчика: насосы реагируют как на настоящий ветер.
 *  · modbus — анемометр с выходом RS-485 Modbus RTU: через USB-переходник
 *    RS-485 или через шлюз Modbus TCP. Часто на той же линии, что частотники.
 *  · mqtt — показание приходит в топик MQTT (метеостанция, контроллер умного
 *    дома, ПЛК). Брокер — тот же, что на вкладке «Внешние пульты».
 *
 * Через USB-DMX/RDM ветер НЕ приходит: DMX идёт только от компьютера к
 * приборам, а RDM-анемометров на рынке практически нет. Датчику нужен свой
 * канал — поэтому и три варианта выше.
 */
export type WindSource = 'manual' | 'modbus' | 'mqtt';

/**
 * Какой сигнал выдаёт сам датчик. Компьютер читает только цифру (Modbus), а
 * аналоговый датчик — через модуль «аналог → Modbus», и тогда в регистре не
 * скорость, а то, как модуль оцифровал напряжение или ток. Поэтому шкалы
 * разные:
 *  · digital — цифровой анемометр RS-485: в регистре скорость (например, в
 *    десятых долях м/с);
 *  · volt    — 0–10 В через модуль: 0 В — безветрие, 10 В — конец шкалы датчика;
 *  · current — 4–20 мА через модуль: 4 мА — безветрие, 20 мА — конец шкалы.
 *    Ток ниже 4 мА — обрыв линии, и это видно («живой ноль»); у 0–10 В обрыв
 *    от безветрия не отличить.
 */
export type WindSensorSignal = 'digital' | 'volt' | 'current';

export interface WindSensorModbus {
  connection: ModbusConnection;
  /** Какой сигнал выдаёт датчик (см. WindSensorSignal). */
  signal: WindSensorSignal;
  /** Адрес датчика на линии, 1–247. */
  unitId: number;
  /** Регистр скорости, с 0 (как в паспорте датчика, «0x0000» — это 0). */
  register: number;
  /** holding — функция 03, input — функция 04. В паспорте датчика написано, какая. */
  registerKind: 'holding' | 'input';
  /** Цифровой датчик: единиц регистра на 1 м/с. У большинства 10: скорость в десятых долях. */
  unitsPerMs: number;
  /**
   * Аналоговый через модуль: что модуль показывает в начале шкалы (0 В или
   * 4 мА — безветрие) и в конце (10 В или 20 мА). Зависит от настройки модуля:
   * часто милливольты (0…10000) или микроамперы (4000…20000).
   */
  rawAtMin: number;
  rawAtMax: number;
  /** Скорость ветра в конце шкалы датчика, м/с — из его паспорта. */
  speedAtMax: number;
  /** Регистр направления, градусы; null — датчик направление не даёт. */
  directionRegister: number | null;
  /** Единиц регистра на 1°. Обычно 1. */
  directionUnitsPerDeg: number;
}

export interface WindSensorMqtt {
  /**
   * Полный топик, куда приходит показание. Внутри — число («3.2» или «3,2»)
   * или JSON вида {"speed": 3.2, "direction": 270}.
   */
  topic: string;
}

export interface WindLimitConfig {
  /** false — ветер не учитывается вовсе, насосы от него не режутся. */
  enabled: boolean;
  /** Откуда берётся скорость ветра (см. WindSource). */
  source: WindSource;
  modbus: WindSensorModbus;
  mqtt: WindSensorMqtt;
  /**
   * Через сколько секунд молчания датчик считается пропавшим: в журнал и в
   * Telegram уходит авария. Последнее показание при этом ДЕРЖИТСЯ — снять
   * ограничение из-за замолчавшего датчика значило бы поднять струи в
   * ветер, которого мы просто больше не видим.
   */
  sensorLostSec: number;
  /**
   * Ниже этого ветра (м/с) не делаем НИЧЕГО и ни для каких струй.
   *
   * 2 м/с — потому что такой ветер на объекте бывает постоянно, а видно его
   * только на самых высоких струях и то едва. Реагировать на него — значит
   * шевелить воду весь день без причины.
   */
  deadbandSpeed: number;
  /**
   * Сколько секунд ветер должен держаться выше порога НЕПРЕРЫВНО, прежде чем
   * коррекция включится.
   *
   * 10 с: порывом метеорологи считают превышение длиной от 3 с, а нам нужно
   * отличить «задуло» от «дунуло». Десять секунд заведомо больше порыва и
   * заметно меньше перемены погоды. Мгновенная реакция всё равно невозможна:
   * насос сбрасывает частоту не сразу, а вода, уже летящая в воздухе,
   * долетит куда летела.
   */
  activateHoldSec: number;
  /**
   * Сколько секунд ветер должен держаться НИЖЕ порога, чтобы коррекция
   * снялась совсем. Столько же, сколько на включение: и там и тут решаем, что
   * погода переменилась, а не дунуло.
   */
  deactivateHoldSec: number;
  /**
   * Подтверждение изменения уровня внутри коррекции, с.
   *
   * Уровень меняется, только если ветер продержался выше (ниже) нового
   * значения ВСЮ выдержку. Считается окном минимума/максимума, поэтому порыв
   * короче выдержки не меняет уровень вообще.
   */
  adjustHoldSec: number;
  /**
   * Опасный ветер (м/с): выше него не ждём `activateHoldSec`, а включаемся
   * через `fastHoldSec`. 0 — не торопиться никогда.
   *
   * Зачем: ждать десять секунд имеет смысл при обычном ветре, когда цена
   * ошибки — некрасивая картинка. При ветре, на котором фонтан пора глушить,
   * десять секунд бездействия — это лужа на дорожке.
   *
   * 3 секунды, а не две: порывом метеорологи считают превышение длиной ОТ 3 с,
   * значит всё, что короче, — порыв, и на него реагировать нельзя даже при
   * опасной скорости (всё равно не успеем, а фонтан погасим на полминуты).
   */
  fastSpeed: number;
  fastHoldSec: number;
  /** За сколько секунд коррекция вводится в полную силу. */
  fadeInSec: number;
  /** За сколько секунд снимается. Дольше ввода: поднимать воду спешить некуда. */
  fadeOutSec: number;
  /**
   * Быстрее этого (м/с за секунду) расчётная скорость НЕ УБЫВАЕТ. Растёт она
   * сразу, как подтвердилась: вверх — безопасность, вниз — красота.
   */
  levelFallPerSec: number;
  /**
   * Допустимый уход струи от её обычного места под ветром, м — предел по
   * КАРТИНКЕ, работает для любой форсунки, где бы она ни стояла.
   * 0,6 м — это «заметно, но ещё рисунок, а не косой столб».
   */
  marginM: number;
  /**
   * Запас от борта чаши, м: вода должна падать внутрь с этим запасом. Нужен
   * потому, что вода падает не точкой, а пятном брызг, и «ровно на борт» —
   * это уже на дорожку.
   *
   * Берётся НЕ БОЛЬШЕ половины того расстояния, которое есть (см.
   * EDGE_RESERVE_MAX_SHARE). Иначе форсунка, поставленная в 20 см от борта —
   * а кольцо по борту чаши это обычная раскладка, — при запасе 30 см получала
   * бы ноль допустимого сноса и глохла от любого ветра выше порога. Она
   * действительно самая уязвимая, но «выключить навсегда» — не защита, а
   * поломка.
   */
  edgeReserveM: number;
  /**
   * Строгость расчёта сноса, множитель. 1,0 — как считает модель капли
   * (`jetdrop.ts`), откалиброванная по замерам с объекта.
   *
   * Отдельного «времени сцепки с ветром» в настройках больше нет, и это
   * принципиально: сцепка зависит от КОНКРЕТНОГО сопла (тип, диаметр,
   * распыление) и от того, как высоко бьёт струя, — всё это уже есть в схеме,
   * и вводить ещё одно число на весь объект значило бы спорить со схемой.
   * Прежние 4 с на весь объект давали для пятиметровой струи 20 мм при 15 м/с
   * снос 6,5 м против замеренных на объекте 2 м — ограничение было втрое
   * строже реальности.
   *
   * Этот множитель — запас поверх расчёта, если на объекте видно, что сносит
   * сильнее (открытая площадка, порывистое место): 1,3 значит «считать снос на
   * 30 % больше». Меньше единицы ставить не стоит без своих замеров.
   */
  driftFactor: number;
  /** 0–100 — ниже этого предел не опускаем: совсем сухой фонтан тоже не нужен. */
  minPercent: number;
  /** м/с — выше этого ветра фонтан выключается совсем (0 — не выключать). */
  stopSpeed: number;
  /**
   * Показания выше этого (м/с) считаем обрывом линии или сбоем датчика и
   * игнорируем. 40 м/с — это ураган, при котором фонтан давно выключен
   * руками; всё, что больше, — почти наверняка мусор в кадре Modbus.
   */
  maxPlausibleSpeed: number;
}

export function defaultWindSensorModbus(): WindSensorModbus {
  return {
    connection: { kind: 'rtu', serialPort: '', baudRate: 9600 },
    unitId: 1,
    register: 0,
    registerKind: 'holding',
    signal: 'digital',
    unitsPerMs: 10,
    rawAtMin: 0,
    rawAtMax: 10000,
    speedAtMax: 30,
    directionRegister: null,
    directionUnitsPerDeg: 1,
  };
}

export function defaultWindLimitConfig(): WindLimitConfig {
  return {
    enabled: false,
    source: 'manual',
    modbus: defaultWindSensorModbus(),
    mqtt: { topic: '' },
    sensorLostSec: 10,
    deadbandSpeed: 2,
    activateHoldSec: 10,
    deactivateHoldSec: 10,
    adjustHoldSec: 1.5,
    fastSpeed: 12,
    fastHoldSec: 3,
    fadeInSec: 3,
    fadeOutSec: 6,
    levelFallPerSec: 0.5,
    marginM: 0.6,
    edgeReserveM: 0.3,
    driftFactor: 1,
    minPercent: 25,
    stopSpeed: 12,
    maxPlausibleSpeed: 40,
  };
}

// ══ Состояние во времени ═══════════════════════════════════════════════════

/** Одно показание в окне подтверждения. */
interface WindSample {
  atSec: number;
  raw: number;
}

export interface WindCorrectionState {
  /** Коррекция включена (выдержка на включение пройдена). */
  active: boolean;
  /** Расчётная скорость, по которой считается предел, м/с. 0 — коррекции нет. */
  level: number;
  /** Сила коррекции 0..1 — ею вводим и снимаем плавно. */
  fade: number;
  /** Секунд подряд ветер не ниже порога. */
  aboveSec: number;
  /** Секунд подряд ветер ниже порога. */
  belowSec: number;
  /** Секунд подряд ветер не ниже «опасного» — для быстрого включения. */
  fastSec: number;
  /** Окно последних показаний для подтверждения (длиной adjustHoldSec). */
  window: WindSample[];
  /** Монотонные часы состояния, с — по ним чистится окно. */
  clockSec: number;
}

export function initialWindCorrectionState(): WindCorrectionState {
  return { active: false, level: 0, fade: 0, aboveSec: 0, belowSec: 0, fastSec: 0, window: [], clockSec: 0 };
}

/**
 * Один шаг: новое показание датчика → новое состояние коррекции.
 *
 * Возвращает НОВЫЙ объект (состояние неизменяемое): так его удобно проверять
 * и невозможно случайно испортить из другого места.
 */
export function stepWindCorrection(
  state: WindCorrectionState,
  raw: number,
  dtSec: number,
  cfg: WindLimitConfig,
): WindCorrectionState {
  // Заведомо невозможное показание — ИГНОРИРУЕМ целиком, а не сглаживаем:
  // если протянуть мусор через фильтр, он всё равно частично просочится.
  // Время при этом не двигаем: обрыв линии не должен ни копить выдержку на
  // включение, ни копить тишину на выключение.
  if (!Number.isFinite(raw) || raw < 0 || raw > cfg.maxPlausibleSpeed) return state;

  const dt = Math.min(5, Math.max(0, dtSec));
  const clockSec = state.clockSec + dt;
  const hold = Math.max(0.05, cfg.adjustHoldSec);

  // Окно подтверждения: показания за последние adjustHoldSec.
  const window = [...state.window, { atSec: clockSec, raw }].filter((s) => s.atSec >= clockSec - hold);

  const above = raw >= cfg.deadbandSpeed;
  const aboveSec = above ? state.aboveSec + dt : 0;
  const belowSec = above ? 0 : state.belowSec + dt;
  const fastSec = cfg.fastSpeed > 0 && raw >= cfg.fastSpeed ? state.fastSec + dt : 0;

  let active = state.active;
  let level = state.level;

  if (!active) {
    const slowReady = aboveSec >= cfg.activateHoldSec;
    const fastReady = cfg.fastSpeed > 0 && fastSec >= Math.max(0.1, cfg.fastHoldSec);
    if (slowReady || fastReady) {
      active = true;
      // Стартуем с ПОДТВЕРЖДЁННОГО значения: ветер дует уже десять секунд,
      // ползти к нему с нуля незачем — вода всё это время летела бы как при
      // безветрии. Минимум окна, а не текущее показание: так одиночный пик в
      // момент включения не задерёт уровень.
      level = Math.max(cfg.deadbandSpeed, windowMin(window));
    }
  } else if (belowSec >= cfg.deactivateHoldSec) {
    // Ветер кончился. Уровень НЕ обнуляем сразу: он ещё нужен, пока сила
    // коррекции сходит на нет, иначе струи подскочили бы мгновенно.
    active = false;
  } else if (coversWholeWindow(window, hold)) {
    const lo = windowMin(window);
    const hi = windowMax(window);
    if (lo > level) {
      // Ветер всю выдержку был не ниже lo — усиливаем сразу: это безопасность.
      level = lo;
    } else if (hi < level) {
      // Всю выдержку был не выше hi — отпускаем, но не быстрее разрешённого.
      const target = Math.max(cfg.deadbandSpeed, hi);
      level = Math.max(target, level - Math.max(0.01, cfg.levelFallPerSec) * dt);
    }
  }

  let fade = active
    ? Math.min(1, state.fade + dt / Math.max(0.1, cfg.fadeInSec))
    : Math.max(0, state.fade - dt / Math.max(0.1, cfg.fadeOutSec));
  if (!active && fade <= 0) {
    fade = 0;
    level = 0;
  }

  return { active, level, fade, aboveSec, belowSec, fastSec, window, clockSec };
}

function windowMin(w: WindSample[]): number {
  let m = Infinity;
  for (const s of w) m = Math.min(m, s.raw);
  return Number.isFinite(m) ? m : 0;
}

function windowMax(w: WindSample[]): number {
  let m = 0;
  for (const s of w) m = Math.max(m, s.raw);
  return m;
}

/**
 * Накопилось ли показаний на всю выдержку. Пока окно короче, менять уровень
 * нельзя: «минимум за 1,5 с» по трём показаниям за 0,1 с — это не минимум за
 * 1,5 с, а самообман.
 */
function coversWholeWindow(w: WindSample[], holdSec: number): boolean {
  const first = w[0];
  const last = w[w.length - 1];
  if (!first || !last) return false;
  return last.atSec - first.atSec >= holdSec * 0.9;
}

// ══ Геометрия форсунки ═════════════════════════════════════════════════════

/** Что о форсунке нужно знать ветровому расчёту. */
export interface WindNozzle {
  /** Высота струи при полном насосе (значение 255), м. */
  maxHeightM: number;
  /**
   * Аэродинамический калибр капли этой струи, м (см. `jetdrop.ts`). Из него и
   * из скорости вылета получается сцепка с ветром: туман сдувает почти сразу,
   * плотный столб почти нет. Считается один раз при загрузке схемы — от высоты
   * зависит только поправка на скорость.
   */
  airDropM: number;
  /** Наклон от вертикали, °. 0 — строго вверх. */
  tiltDeg: number;
  /**
   * Куда смотрит наклон относительно борта: +1 — прямо к борту (наружу),
   * −1 — к центру чаши, 0 — вдоль борта. Это косинус угла между азимутом
   * наклона и направлением «наружу» в самом узком месте.
   */
  tiltOutward: number;
  /**
   * Свободное расстояние по горизонтали от сопла до борта чаши в самую
   * близкую сторону, м. Infinity — чаша неизвестна (сопло не попало ни в
   * одну), тогда предел по борту не применяется, остаётся только картинка.
   */
  roomM: number;
}

/**
 * Опорная форсунка: вертикальная прямая струя 20 мм без чаши. Для
 * предпросмотра в настройках и для насосов, не привязанных к схеме — про них
 * ничего не известно, и выдумывать тип сопла нельзя.
 */
export function plainWindNozzle(maxHeightM: number): WindNozzle {
  return { maxHeightM, airDropM: referenceAirDropM(), tiltDeg: 0, tiltOutward: 0, roomM: Infinity };
}

/**
 * Свободное место до борта и направление «наружу» для точки в плане.
 *
 * Берём чашу, которая точку СОДЕРЖИТ; если их несколько (вложенные ярусы) —
 * ту, где до борта ближе. Ни одна не содержит — Infinity: сопло стоит на
 * сухой площадке или чаша не нарисована, и выдумывать расстояние нельзя.
 */
export function bowlRoom(x: number, y: number, bowls: Bowl[]): { roomM: number; outX: number; outY: number } {
  let best = { roomM: Infinity, outX: 0, outY: 0 };
  for (const b of bowls) {
    if (b.shape === 'circle') {
      const dx = x - b.x;
      const dy = y - b.y;
      const d = Math.hypot(dx, dy);
      const room = b.radius - d;
      if (room < 0) continue; // точка снаружи этой чаши
      if (room < best.roomM) {
        // Наружу — по радиусу от центра. В самом центре направление не
        // определено, и это не беда: там до борта одинаково во все стороны.
        const k = d > 1e-6 ? 1 / d : 0;
        best = { roomM: room, outX: dx * k, outY: dy * k };
      }
    } else {
      const dx = x - b.x;
      const dy = y - b.y;
      const roomX = b.width / 2 - Math.abs(dx);
      const roomY = b.length / 2 - Math.abs(dy);
      if (roomX < 0 || roomY < 0) continue;
      const room = Math.min(roomX, roomY);
      if (room < best.roomM) {
        // Наружу — к ближайшей стенке.
        best =
          roomX <= roomY
            ? { roomM: room, outX: dx >= 0 ? 1 : -1, outY: 0 }
            : { roomM: room, outX: 0, outY: dy >= 0 ? 1 : -1 };
      }
    }
  }
  return best;
}

/**
 * Форсунка схемы → то, что нужно ветровому расчёту.
 *
 * Вращающиеся и моторные насадки считаем смотрящими НАРУЖУ: их азимут меняется
 * на ходу, и в какой-то момент он неизбежно направлен к борту. Брать среднее
 * значило бы защищать среднее положение, а на объекте вода льётся в худшем.
 */
export function windNozzleFor(n: Nozzle, bowls: Bowl[]): WindNozzle {
  const { roomM, outX, outY } = bowlRoom(n.x, n.y, bowls);
  const spins = n.kind === 'rotating' || n.kind === 'orbit';
  let tiltOutward = 1;
  if (!spins && (outX !== 0 || outY !== 0)) {
    const h = (n.headingDeg * Math.PI) / 180;
    tiltOutward = Math.cos(h) * outX + Math.sin(h) * outY;
  }
  const spray = clampSpray(n.kind, n.sprayFactor);
  return {
    maxHeightM: Math.max(0.05, n.maxHeightM),
    // Тип сопла входит в расчёт именно здесь: калибр капли у тумана и у
    // ламинарной струи различается на порядок, а от него и зависит, насколько
    // ветер вообще способен эту воду унести.
    airDropM: airDropM(nozzleDropM(n.kind, n.widthM, spray), spray),
    tiltDeg: n.tiltDeg,
    tiltOutward,
    roomM,
  };
}

// ══ Физика полёта ══════════════════════════════════════════════════════════

/** Время полёта воды до уровня сопла, с — подъём плюс падение. */
export function windFlightSec(heightM: number): number {
  return 2 * Math.sqrt((2 * Math.max(0.0001, heightM)) / G);
}

/**
 * Разложение полёта на то, что нужно обоим пределам: время, множитель инерции
 * и сцепка с ветром для ЭТОЙ высоты.
 *
 * τ зависит от высоты, а не только от сопла: высокая струя бьёт быстрее, вода
 * рвётся на капли мельче, и сносит её сильнее, чем только за счёт долгого
 * полёта (см. speedDropFactor в jetdrop.ts).
 */
function flightParts(heightM: number, nz: WindNozzle): { t: number; vz: number; k: number } {
  const h = Math.max(0.0001, heightM);
  const vz = Math.sqrt(2 * G * h);
  const t = (2 * vz) / G;
  const tau = Math.max(0.2, windTauFromDrop(nz.airDropM, vz));
  return { t, vz, k: tau * (1 - Math.exp(-t / tau)) };
}

/**
 * Насколько ветер уводит струю от её обычного места, м — предел по КАРТИНКЕ.
 * Наклон сопла здесь не участвует: он сдвигает и место падения, и «обычное»
 * место одинаково, поэтому в разности сокращается.
 */
export function windDriftM(speedMs: number, heightM: number, nz: WindNozzle, driftFactor = 1): number {
  const { t, k } = flightParts(heightM, nz);
  return Math.max(0, speedMs) * (t - k) * Math.max(0, driftFactor);
}

/**
 * Куда падает вода относительно сопла в сторону борта, м (наружу — плюс).
 * Отрицательное значение — вода падает внутрь чаши, дальше от борта, чем
 * вылетела: так бывает у сопла, наклонённого к центру.
 *
 * Строгость (`driftFactor`) применяется только к ВЕТРОВОЙ части: собственный
 * бросок наклонной струи от неё не зависит, это геометрия сопла.
 */
export function windLandingM(speedMs: number, heightM: number, nz: WindNozzle, driftFactor = 1): number {
  const { t, vz, k } = flightParts(heightM, nz);
  // Наклон 90° и больше физически не струя, а слив: ограничиваем, иначе
  // тангенс уходит в бесконечность и расчёт теряет смысл.
  const tilt = Math.max(0, Math.min(80, nz.tiltDeg));
  const own = Math.tan((tilt * Math.PI) / 180) * vz * nz.tiltOutward * k;
  const u = Math.max(0, speedMs);
  return own + u * (t - k) * Math.max(0, driftFactor);
}

/** Высота струи при доле насоса L (0..1), м. Нелинейно: H ∝ L². */
export function jetHeightM(level: number, maxHeightM: number): number {
  const l = Math.max(0, Math.min(1, level));
  return maxHeightM * l * l;
}

/** Обратное: какая доля насоса даёт такую высоту. */
export function jetLevelForHeight(heightM: number, maxHeightM: number): number {
  if (maxHeightM <= 0) return 0;
  return Math.max(0, Math.min(1, Math.sqrt(Math.max(0, heightM) / maxHeightM)));
}

/** Сколько шагов перебираем по доле насоса: 1/128 ≈ 2 единицы DMX. */
const LEVEL_STEPS = 128;

/**
 * Какую долю расстояния до борта можно съесть запасом. Половина: у форсунки
 * у самого борта запас сжимается вместе с её местом, и она продолжает
 * работать — только очень приглушённо.
 */
const EDGE_RESERVE_MAX_SHARE = 0.5;

/** Сколько места до борта остаётся форсунке после запаса, м. */
export function edgeRoomM(nz: WindNozzle, cfg: WindLimitConfig): number {
  if (!Number.isFinite(nz.roomM)) return Infinity;
  const reserve = Math.min(cfg.edgeReserveM, Math.max(0, nz.roomM) * EDGE_RESERVE_MAX_SHARE);
  return Math.max(0.02, nz.roomM - reserve);
}

/**
 * Предел доли насоса (0..1) для этой форсунки при этом ветре.
 *
 * Перебором снизу вверх, а не делением пополам, и намеренно: у наклонного
 * сопла место падения по высоте НЕ монотонно (чем выше бьёт наклонная струя,
 * тем дальше внутрь чаши она уносит воду). Деление пополам на немонотонной
 * функции даёт случайный ответ, а перебор снизу честно находит границу, до
 * которой безопасны ВСЕ значения, а не только найденное.
 */
export function windAllowedLevel(speedMs: number, cfg: WindLimitConfig, nz: WindNozzle): number {
  if (!cfg.enabled) return 1;
  if (cfg.stopSpeed > 0 && speedMs >= cfg.stopSpeed) return 0;
  if (speedMs <= 0) return 1;
  const room = edgeRoomM(nz, cfg);
  // Два предела считаем ОТДЕЛЬНО, потому что и относимся к ним по-разному:
  // «картинка» — дело вкуса и ей положен пол по мощности, «борт» — это вода на
  // людях, и там никакого пола быть не может.
  let byPicture = 0;
  let byEdge = 0;
  let pictureOk = true;
  let edgeOk = true;
  for (let i = 1; i <= LEVEL_STEPS; i++) {
    const level = i / LEVEL_STEPS;
    const h = jetHeightM(level, nz.maxHeightM);
    if (pictureOk) {
      if (windDriftM(speedMs, h, nz, cfg.driftFactor) > cfg.marginM) pictureOk = false;
      else byPicture = level;
    }
    if (edgeOk) {
      if (windLandingM(speedMs, h, nz, cfg.driftFactor) > room) edgeOk = false;
      else byEdge = level;
    }
    if (!pictureOk && !edgeOk) break;
  }
  // Пол по мощности: совсем сухой фонтан тоже никому не нужен — но только
  // против предела по картинке. Если вода перелетает борт, «минимальная
  // мощность» не оправдание: пусть эта форсунка стоит.
  const picture = Math.max(Math.min(1, cfg.minPercent / 100), byPicture);
  return Math.min(picture, byEdge);
}

/**
 * Итоговый предел значения на насосе, 0..255, с учётом силы коррекции.
 *
 * Сила `fade` нужна, чтобы коррекция входила и выходила плавно: 0 — предел не
 * действует (255), 1 — действует целиком.
 */
export function windCapDmx(speedMs: number, fade: number, cfg: WindLimitConfig, nz: WindNozzle): number {
  if (!cfg.enabled || fade <= 0) return 255;
  const allowed = windAllowedLevel(speedMs, cfg, nz);
  const f = Math.max(0, Math.min(1, fade));
  const eff = 1 - f * (1 - allowed);
  return Math.max(0, Math.min(255, Math.round(eff * 255)));
}

/**
 * Сколько процентов мощности останется струе, которая сейчас работает НА
 * ПОЛНУЮ. Для предпросмотра в настройках и для строки состояния: одно число
 * на объект, самое строгое.
 */
export function computeWindLimitPercent(speedMs: number, cfg: WindLimitConfig, heightM: number): number {
  if (!cfg.enabled) return 100;
  return Math.round(windAllowedLevel(speedMs, cfg, plainWindNozzle(heightM)) * 100);
}

// ══ Чтение настроек с диска ════════════════════════════════════════════════

export function sanitizeWindLimitConfig(raw: unknown): WindLimitConfig {
  const d = defaultWindLimitConfig();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<WindLimitConfig> & {
    warnSpeed?: number;
    maxSpeed?: number;
    attackSec?: number;
    releaseSec?: number;
    releaseHoldSec?: number;
  };
  const num = (v: unknown, def: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
  // До 22.09.2026 источника не было: включённый ветер вводился только руками.
  const source: WindSource = r.source === 'modbus' || r.source === 'mqtt' ? r.source : 'manual';
  return {
    enabled: r.enabled === true,
    source,
    modbus: sanitizeWindSensorModbus(r.modbus),
    // Маски «#» и «+» убираем: показание сверяется с топиком точно, а маска
    // превратила бы подписку на свой датчик в подписку на чужие.
    mqtt: { topic: typeof r.mqtt?.topic === 'string' ? r.mqtt.topic.replace(/[#+]/g, '').trim() : '' },
    sensorLostSec: num(r.sensorLostSec, d.sensorLostSec, 2, 600),
    deadbandSpeed: num(r.deadbandSpeed, d.deadbandSpeed, 0, 20),
    // Прежние версии знали выдержку только на возврат (releaseHoldSec) — она
    // по смыслу и есть «сколько ждать, что ветер кончился».
    activateHoldSec: num(r.activateHoldSec, d.activateHoldSec, 0, 120),
    deactivateHoldSec: num(r.deactivateHoldSec ?? r.releaseHoldSec, d.deactivateHoldSec, 0, 300),
    adjustHoldSec: num(r.adjustHoldSec ?? r.attackSec, d.adjustHoldSec, 0.1, 30),
    fastSpeed: num(r.fastSpeed, d.fastSpeed, 0, 60),
    fastHoldSec: num(r.fastHoldSec, d.fastHoldSec, 0.1, 60),
    fadeInSec: num(r.fadeInSec, d.fadeInSec, 0.1, 60),
    fadeOutSec: num(r.fadeOutSec ?? r.releaseSec, d.fadeOutSec, 0.1, 120),
    levelFallPerSec: num(r.levelFallPerSec, d.levelFallPerSec, 0.01, 20),
    marginM: num(r.marginM, d.marginM, 0.05, 10),
    edgeReserveM: num(r.edgeReserveM, d.edgeReserveM, 0, 5),
    // Прежнее «время сцепки с ветром» (tauSec) осознанно НЕ переносим: оно
    // было одним числом на объект и втрое завышало снос. Проекты открываются с
    // расчётом по модели капли, это исправление, а не потеря настройки.
    driftFactor: num(r.driftFactor, d.driftFactor, 0.3, 5),
    minPercent: Math.round(num(r.minPercent, d.minPercent, 0, 100)),
    // Старые проекты знали maxSpeed вместо stopSpeed — переносим по смыслу:
    // там это была скорость «дальше некуда снижать», здесь — «глушим».
    stopSpeed: num(r.stopSpeed ?? r.maxSpeed, d.stopSpeed, 0, 60),
    maxPlausibleSpeed: num(r.maxPlausibleSpeed, d.maxPlausibleSpeed, 5, 100),
  };
}

// ══ Датчик ветра: разбор настроек и показаний ═════════════════════════════

function sanitizeWindConnection(raw: unknown): ModbusConnection {
  const d = defaultWindSensorModbus().connection;
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const port = (v: unknown, def: number): number => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 1 && n <= 65535 ? n : def;
  };
  if (r.kind === 'tcp') {
    return { kind: 'tcp', host: typeof r.host === 'string' ? r.host.trim() : '', port: port(r.port, 502) };
  }
  const baud = Math.round(Number(r.baudRate));
  return {
    kind: 'rtu',
    serialPort: typeof r.serialPort === 'string' ? r.serialPort.trim() : '',
    baudRate: [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].includes(baud) ? baud : 9600,
    ...(r.dataBits === 7 ? { dataBits: 7 as const } : {}),
    ...(r.stopBits === 2 ? { stopBits: 2 as const } : {}),
    ...(r.parity === 'even' || r.parity === 'odd' ? { parity: r.parity } : {}),
  };
}

export function sanitizeWindSensorModbus(raw: unknown): WindSensorModbus {
  const d = defaultWindSensorModbus();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<WindSensorModbus>;
  const int = (v: unknown, def: number, lo: number, hi: number): number => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
  };
  const scale = Number(r.unitsPerMs);
  const dirScale = Number(r.directionUnitsPerDeg);
  return {
    connection: sanitizeWindConnection(r.connection),
    unitId: int(r.unitId, d.unitId, 1, 247),
    register: int(r.register, d.register, 0, 65535),
    registerKind: r.registerKind === 'input' ? 'input' : 'holding',
    signal: r.signal === 'volt' || r.signal === 'current' ? r.signal : 'digital',
    unitsPerMs: Number.isFinite(scale) && scale > 0 ? scale : d.unitsPerMs,
    rawAtMin: int(r.rawAtMin, d.rawAtMin, 0, 65535),
    // Конец шкалы должен быть выше начала — иначе делить не на что.
    rawAtMax: Math.max(int(r.rawAtMin, d.rawAtMin, 0, 65535) + 1, int(r.rawAtMax, d.rawAtMax, 1, 65535)),
    speedAtMax: (() => {
      const v = Number(r.speedAtMax);
      return Number.isFinite(v) && v > 0 && v <= 100 ? v : d.speedAtMax;
    })(),
    directionRegister:
      r.directionRegister === null || r.directionRegister === undefined ? null : int(r.directionRegister, 0, 0, 65535),
    directionUnitsPerDeg: Number.isFinite(dirScale) && dirScale > 0 ? dirScale : d.directionUnitsPerDeg,
  };
}

/**
 * Показание из MQTT: число («3.2», «3,2») или JSON с полем скорости и,
 * если есть, направления. null — показания в сообщении нет.
 */
export function parseWindPayload(payload: string): { speedMs: number; directionDeg: number | null } | null {
  const text = payload.trim();
  const plain = Number(text.replace(',', '.'));
  if (text !== '' && Number.isFinite(plain)) return { speedMs: plain, directionDeg: null };
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (!o || typeof o !== 'object') return null;
    const pick = (keys: string[]): number | null => {
      for (const k of keys) {
        const v = Number(o[k]);
        if (o[k] !== undefined && o[k] !== null && Number.isFinite(v)) return v;
      }
      return null;
    };
    const speed = pick(['speed', 'windSpeed', 'wind_speed', 'wind', 'value']);
    if (speed === null) return null;
    return { speedMs: speed, directionDeg: pick(['direction', 'windDirection', 'wind_direction', 'dir']) };
  } catch {
    return null;
  }
}

/** Что сейчас с датчиком ветра — для «Настроек», «Отладки» и 3D. */
export interface WindSensorStatus {
  /** Датчик отвечает. */
  online: boolean;
  /** Сколько секунд назад было последнее показание; null — ещё не было ни одного. */
  lastOkAgoSec: number | null;
  /** Почему показаний нет: порт не указан, нет ответа, показание вне разумного… */
  error: string | null;
  /** Датчик пропал, держим последнее показание. */
  holding: boolean;
  /** Направление, откуда дует, °; null — датчик его не даёт. */
  directionDeg: number | null;
  /** Что сейчас в регистре скорости — по этому числу настраивают шкалу. */
  raw: number | null;
}

/**
 * Скорость из числа в регистре — по типу выхода датчика. null — сигнал ниже
 * начала шкалы 4–20 мА: это обрыв линии, а не безветрие.
 */
export function windSpeedFromRaw(raw: number, m: WindSensorModbus): number | null {
  if (m.signal === 'digital') return Math.max(0, raw / m.unitsPerMs);
  const span = m.rawAtMax - m.rawAtMin;
  if (m.signal === 'current' && raw < m.rawAtMin - span * 0.05) return null;
  return Math.max(0, ((raw - m.rawAtMin) / span) * m.speedAtMax);
}
