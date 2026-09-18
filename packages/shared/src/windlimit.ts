/**
 * Датчик ветра → безопасное снижение струй.
 *
 * ── Почему прежний расчёт был неверен ─────────────────────────────────────
 * Раньше это была одна линейка на весь объект: до 8 м/с ничего, дальше
 * линейно вниз до 20 % к 15 м/с. Две ошибки сразу.
 *
 * Первая — порог. 8 м/с это уже крепкий ветер; шестиметровую струю к этому
 * моменту сносит на несколько метров, и вода льётся на людей задолго до того,
 * как автоматика вообще проснётся.
 *
 * Вторая — высота струи не учитывалась вовсе, хотя именно она всё и решает.
 *
 * ── Как считается теперь ──────────────────────────────────────────────────
 * Вода в полёте разгоняется ветром не мгновенно: её горизонтальная скорость
 * догоняет скорость ветра с постоянной времени τ. Связный плотный столб
 * цепляется за воздух слабо (τ больше), распылённая вода — сильно (τ меньше).
 * За время полёта T сносит на
 *
 *     s = U · (T − τ · (1 − e^(−T/τ)))
 *
 * Время полёта до чаши берётся из высоты: T = 2·√(2H/g). При T ≪ τ формула
 * вырождается в s ≈ U·T²/(2τ), то есть снос растёт ЛИНЕЙНО с высотой струи —
 * ровно поэтому высокие струи надо резать раньше и сильнее низких.
 *
 * Считаем не «процент по ветру», а ДОПУСТИМУЮ ВЫСОТУ: ту, при которой снос не
 * превышает marginM. Высота идёт от квадрата напора, поэтому насос режется в
 * √(h_доп / H) от заданного.
 *
 * Пример на 6-метровой струе (τ = 4 с, допуск сноса 0,6 м):
 *   1 м/с — 100 % · 2 м/с — 75 % · 4 м/с — 52 % · 6 м/с — 42 % · 8 м/с — 36 %.
 * Для 15-метровой струи снижение начинается уже около 0,5 м/с.
 *
 * Выше stopSpeed фонтан глушится полностью: при таком ветре картины всё равно
 * нет, а вода уходит за борт чаши целиком.
 */

export interface WindLimitConfig {
  enabled: boolean;
  /**
   * Допустимый снос воды от оси струи, м. Больше него — начинаем снижать.
   * 0,6 м это примерно «вода ещё падает в чашу, а не на дорожку».
   */
  marginM: number;
  /**
   * Постоянная разгона воды ветром, с. Плотная связная струя — 5–6,
   * обычная — 4, сильно распылённая или туман — 2–2,5.
   *
   * Здесь она ОДНА на весь фонтан, и это осознанно: движок снижает напор
   * общим решением и не знает, какая форсунка сидит на этом насосе. Поэтому
   * заводское значение 4 с — это «вода средней плотности», то есть капля
   * около 4 мм, и по ней ограничение выходит чуть строже, чем картинка в 3D,
   * где каждой форсунке считается свой калибр (см. airDrop в FountainScene:
   * у прямой струи 10 мм получается ~5,8 с, у веера ~3,9 с). Запас в
   * строгую сторону и нужен: защищать надо самую парусящую форсунку линии, а
   * не среднюю.
   */
  tauSec: number;
  /** 0–100 — ниже этого насос не опускаем: совсем сухой фонтан тоже не нужен. */
  minPercent: number;
  /** м/с — выше этого ветра фонтан выключается совсем (0 — не выключать). */
  stopSpeed: number;
  /**
   * За сколько секунд сглаженный ветер догоняет ВЫРОСШЕЕ показание.
   * Коротко (≈1 с): порыв на полсекунды почти не поднимет расчётное
   * значение, а настоящий ветер — поднимет за пару секунд.
   */
  attackSec: number;
  /**
   * За сколько секунд сглаженный ветер отпускает УПАВШЕЕ показание.
   * Заметно дольше подъёма: между порывами ветер проваливается почти до
   * нуля, и если возвращать высоту так же быстро, струи начнут «дышать» —
   * то вверх, то вниз, на глазах у людей. Поднимать воду обратно спешить
   * некуда, а вот убирать — надо быстро.
   */
  releaseSec: number;
  /**
   * Сколько секунд ветер должен ДЕРЖАТЬСЯ ниже текущего расчётного, прежде
   * чем вообще начнём поднимать струи обратно.
   *
   * Без этой выдержки фильтр начинает отпускать сразу, пусть и медленно, а
   * между порывами ветер проваливается почти в ноль каждые несколько
   * секунд — и вода принималась бы «дышать». 10 с выбраны по тому, как
   * ветер устроен: порывом метеорологи считают превышение длиной от 3 с, а
   * затишья между порывами в шквалистую погоду — как раз секунды. Десять
   * секунд заведомо длиннее затишья, но короче настоящей перемены погоды.
   */
  releaseHoldSec: number;
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
    marginM: 0.6,
    tauSec: 4,
    minPercent: 25,
    stopSpeed: 12,
    attackSec: 1,
    releaseSec: 15,
    releaseHoldSec: 10,
    maxPlausibleSpeed: 40,
  };
}

/**
 * Состояние сглаживания ветра. Хранится в движке между тиками: фильтру нужно
 * помнить не только последнее значение, но и сколько уже длится затишье.
 */
export interface WindSmoothState {
  /** Расчётная скорость, по которой режутся насосы; null — показаний ещё не было. */
  smoothed: number | null;
  /**
   * Сколько секунд подряд сырое показание держится НИЖЕ расчётного. Пока
   * меньше releaseHoldSec — высоту не поднимаем вовсе (см. там же почему).
   */
  belowSec: number;
}

export function initialWindSmoothState(): WindSmoothState {
  return { smoothed: null, belowSec: 0 };
}

/**
 * Один шаг сглаживания показаний ветра: фильтр первого порядка с разными
 * постоянными на рост и на спад плюс выдержка перед подъёмом.
 *
 * Зачем вообще: ограничение струй нельзя дёргать по каждому показанию
 * датчика. Порыв на полсекунды или дребезг на линии Modbus уронил бы воду на
 * глазах у людей и через секунду поднял обратно. Поэтому расчёт идёт не по
 * «сырому» значению, а по сглаженному: вырос ветер — догоняем за ~attackSec
 * (быстро, это безопасность), упал — сначала выдерживаем releaseHoldSec и
 * только потом отпускаем за ~releaseSec.
 */
export function stepWindSmoothing(
  state: WindSmoothState,
  raw: number,
  dtSec: number,
  cfg: Pick<WindLimitConfig, 'attackSec' | 'releaseSec' | 'releaseHoldSec' | 'maxPlausibleSpeed'>,
): WindSmoothState {
  // Заведомо невозможное показание — не сглаживаем, а ИГНОРИРУЕМ целиком:
  // если протянуть его через фильтр, мусор всё равно частично просочится.
  if (!Number.isFinite(raw) || raw < 0 || raw > cfg.maxPlausibleSpeed) return state;
  // Первое показание берём как есть: иначе ограничение ползло бы с нуля, и
  // первые секунды вода летела бы так, будто ветра нет.
  if (state.smoothed === null) return { smoothed: raw, belowSec: 0 };

  const dt = Math.max(0, dtSec);
  const prev = state.smoothed;

  if (raw >= prev) {
    // Ветер вырос — догоняем быстро и сбрасываем накопленную «тишину».
    const k = 1 - Math.exp(-dt / Math.max(0.05, cfg.attackSec));
    return { smoothed: prev + (raw - prev) * k, belowSec: 0 };
  }

  // Ветер ниже расчётного. Сначала выдерживаем паузу: провал между порывами
  // длится секунды, и поднимать на нём струи нельзя.
  const belowSec = state.belowSec + dt;
  if (belowSec < cfg.releaseHoldSec) return { smoothed: prev, belowSec };
  const k = 1 - Math.exp(-dt / Math.max(0.05, cfg.releaseSec));
  return { smoothed: prev + (raw - prev) * k, belowSec };
}

const G = 9.81;

/** Время полёта воды до чаши, с — подъём плюс падение. */
export function windFlightSec(heightM: number): number {
  return 2 * Math.sqrt((2 * Math.max(0.05, heightM)) / G);
}

/** Снос струи высотой heightM при ветре speedMs, м. */
export function windDriftM(speedMs: number, heightM: number, tauSec: number): number {
  const t = windFlightSec(heightM);
  const tau = Math.max(0.2, tauSec);
  return Math.max(0, speedMs) * (t - tau * (1 - Math.exp(-t / tau)));
}

/**
 * Какая высота струи ещё укладывается в допустимый снос, м.
 * Ищем делением пополам: формула монотонна по высоте, разбирать её аналитически
 * незачем.
 */
export function windAllowedHeightM(speedMs: number, cfg: WindLimitConfig): number {
  if (speedMs <= 0.01) return Infinity;
  let lo = 0.05;
  let hi = 60;
  if (windDriftM(speedMs, hi, cfg.tauSec) <= cfg.marginM) return hi;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (windDriftM(speedMs, mid, cfg.tauSec) > cfg.marginM) hi = mid;
    else lo = mid;
  }
  return lo;
}

/**
 * Сколько процентов от заданного напора оставить насосу, который поднимает
 * струю высотой heightM. 100 — без ограничений, 0 — стоп.
 */
export function computeWindLimitPercent(speedMs: number, cfg: WindLimitConfig, heightM: number): number {
  if (!cfg.enabled) return 100;
  if (cfg.stopSpeed > 0 && speedMs >= cfg.stopSpeed) return 0;
  const allowed = windAllowedHeightM(speedMs, cfg);
  if (!Number.isFinite(allowed) || allowed >= heightM) return 100;
  // Высота идёт от КВАДРАТА напора, поэтому напор режется корнем отношения.
  const pct = Math.round(Math.sqrt(allowed / Math.max(0.05, heightM)) * 100);
  return Math.max(cfg.minPercent, Math.min(100, pct));
}

export function sanitizeWindLimitConfig(raw: unknown): WindLimitConfig {
  const d = defaultWindLimitConfig();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<WindLimitConfig> & { warnSpeed?: number; maxSpeed?: number };
  const num = (v: unknown, def: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
  return {
    enabled: r.enabled === true,
    marginM: num(r.marginM, d.marginM, 0.05, 10),
    tauSec: num(r.tauSec, d.tauSec, 0.5, 20),
    minPercent: Math.round(num(r.minPercent, d.minPercent, 0, 100)),
    // Старые проекты знали maxSpeed вместо stopSpeed — переносим по смыслу:
    // там это была скорость «дальше некуда снижать», здесь — «глушим».
    stopSpeed: num(r.stopSpeed ?? r.maxSpeed, d.stopSpeed, 0, 60),
    // Верхняя граница у attack — 10 с: дольше «подтверждать» опасный ветер
    // уже небезопасно, вода всё это время летит на дорожку.
    attackSec: num(r.attackSec, d.attackSec, 0.1, 10),
    releaseSec: num(r.releaseSec, d.releaseSec, 0.5, 120),
    releaseHoldSec: num(r.releaseHoldSec, d.releaseHoldSec, 0, 120),
    maxPlausibleSpeed: num(r.maxPlausibleSpeed, d.maxPlausibleSpeed, 5, 100),
  };
}
