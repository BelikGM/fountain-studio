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

import type { Bowl, Nozzle } from './layout';

const G = 9.81;

export interface WindLimitConfig {
  enabled: boolean;
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
   * Постоянная разгона воды ветром, с. Плотная связная струя — 5–6, обычная —
   * 4, сильно распылённая или туман — 2–2,5. Одна на весь объект: движок
   * снижает напор общим решением и не знает, какая форсунка сидит на этом
   * насосе, поэтому значение взято в строгую сторону.
   */
  tauSec: number;
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

export function defaultWindLimitConfig(): WindLimitConfig {
  return {
    enabled: false,
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
    tauSec: 4,
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

/** Вертикальная форсунка без чаши — для предпросмотра и запасного случая. */
export function plainWindNozzle(maxHeightM: number): WindNozzle {
  return { maxHeightM, tiltDeg: 0, tiltOutward: 0, roomM: Infinity };
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
  return { maxHeightM: Math.max(0.05, n.maxHeightM), tiltDeg: n.tiltDeg, tiltOutward, roomM };
}

// ══ Физика полёта ══════════════════════════════════════════════════════════

/** Время полёта воды до уровня сопла, с — подъём плюс падение. */
export function windFlightSec(heightM: number): number {
  return 2 * Math.sqrt((2 * Math.max(0.0001, heightM)) / G);
}

/**
 * Насколько ветер уводит струю от её обычного места, м — предел по КАРТИНКЕ.
 * Наклон сопла здесь не участвует: он сдвигает и место падения, и «обычное»
 * место одинаково, поэтому в разности сокращается.
 */
export function windDriftM(speedMs: number, heightM: number, tauSec: number): number {
  const t = windFlightSec(heightM);
  const tau = Math.max(0.2, tauSec);
  return Math.max(0, speedMs) * (t - tau * (1 - Math.exp(-t / tau)));
}

/**
 * Куда падает вода относительно сопла в сторону борта, м (наружу — плюс).
 * Отрицательное значение — вода падает внутрь чаши, дальше от борта, чем
 * вылетела: так бывает у сопла, наклонённого к центру.
 */
export function windLandingM(speedMs: number, heightM: number, nz: WindNozzle, tauSec: number): number {
  const h = Math.max(0.0001, heightM);
  const vz = Math.sqrt(2 * G * h);
  const t = (2 * vz) / G;
  const tau = Math.max(0.2, tauSec);
  const k = tau * (1 - Math.exp(-t / tau));
  // Наклон 90° и больше физически не струя, а слив: ограничиваем, иначе
  // тангенс уходит в бесконечность и расчёт теряет смысл.
  const tilt = Math.max(0, Math.min(80, nz.tiltDeg));
  const v0 = Math.tan((tilt * Math.PI) / 180) * vz * nz.tiltOutward;
  const u = Math.max(0, speedMs);
  return u * t + (v0 - u) * k;
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
      if (windDriftM(speedMs, h, cfg.tauSec) > cfg.marginM) pictureOk = false;
      else byPicture = level;
    }
    if (edgeOk) {
      if (windLandingM(speedMs, h, nz, cfg.tauSec) > room) edgeOk = false;
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
  return {
    enabled: r.enabled === true,
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
    tauSec: num(r.tauSec, d.tauSec, 0.5, 20),
    minPercent: Math.round(num(r.minPercent, d.minPercent, 0, 100)),
    // Старые проекты знали maxSpeed вместо stopSpeed — переносим по смыслу:
    // там это была скорость «дальше некуда снижать», здесь — «глушим».
    stopSpeed: num(r.stopSpeed ?? r.maxSpeed, d.stopSpeed, 0, 60),
    maxPlausibleSpeed: num(r.maxPlausibleSpeed, d.maxPlausibleSpeed, 5, 100),
  };
}
