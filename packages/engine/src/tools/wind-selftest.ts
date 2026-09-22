/**
 * Самопроверка ветрового ограничения: пороги, выдержки, геометрия форсунки.
 *
 * Почему отдельным файлом, а не в смоуке: здесь проверяется ПОВЕДЕНИЕ ВО
 * ВРЕМЕНИ — «десять секунд подряд», «затишье не считается», «подтверждение за
 * полторы секунды». Прогонять это живым движком значило бы ждать минуты; здесь
 * время подаётся шагами и вся проверка идёт за доли секунды.
 *
 * Запуск: npm -w @fountain-studio/engine run wind-test
 */
import {
  airDropM,
  bowlRoom,
  jetWindTauSec,
  nozzleDropM,
  NOZZLE_KINDS,
  referenceAirDropM,
  edgeRoomM,
  defaultWindLimitConfig,
  initialWindCorrectionState,
  jetHeightM,
  jetLevelForHeight,
  plainWindNozzle,
  sanitizeWindLimitConfig,
  stepWindCorrection,
  windAllowedLevel,
  windCapDmx,
  windDriftM,
  windLandingM,
  windNozzleFor,
  type Bowl,
  type Nozzle,
  type WindCorrectionState,
  type WindLimitConfig,
  type WindNozzle,
} from '@fountain-studio/shared';

let failed = 0;
let passed = 0;
function check(ok: boolean, name: string, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const cfg: WindLimitConfig = { ...defaultWindLimitConfig(), enabled: true };

/** Держим показание raw секунд secs; шаг 0,1 с — как у настоящего тика, но крупнее. */
function hold(st: WindCorrectionState, raw: number, secs: number, step = 0.1): WindCorrectionState {
  let cur = st;
  for (let t = 0; t < secs - 1e-9; t += step) cur = stepWindCorrection(cur, raw, step, cfg);
  return cur;
}
const fresh = (): WindCorrectionState => initialWindCorrectionState();

console.log('— Порог нечувствительности —');
{
  check(!hold(fresh(), 0, 60).active, 'штиль: коррекции нет');
  check(!hold(fresh(), 1.9, 120).active, 'ветер 1,9 м/с две минуты — коррекции нет (порог 2 м/с)');
  const at = hold(fresh(), 2, 15);
  check(at.active, 'ровно на пороге 2 м/с через 15 с коррекция включается (порог включительно)');
  check(hold(fresh(), 1.99, 600).fade === 0, 'десять минут под порогом — сила коррекции ноль');
  // Проверка на то, что порог именно НИЖНИЙ, а не «мёртвая зона вокруг нуля».
  const below = hold(fresh(), 1.5, 30);
  check(below.level === 0 && below.aboveSec === 0, 'под порогом выдержка на включение не копится');
}

console.log('— Выдержка на включение —');
{
  check(!hold(fresh(), 9, 9.5).active, 'ветер 9 м/с 9,5 с — ещё не включились');
  check(hold(fresh(), 9, 10.1).active, 'тот же ветер 10,1 с — включились');
  // Прерывание: ветер упал под порог в середине — счётчик обнуляется.
  let st = hold(fresh(), 9, 8);
  st = hold(st, 1, 1);
  st = hold(st, 9, 8);
  check(!st.active, 'ветер 8 с, провал под порог на 1 с, снова 8 с — коррекция НЕ включилась');
  check(hold(st, 9, 3).active, 'после провала выдержка отсчитывается заново и через 11 с включает');
  // Порывистая погода: ветер скачет через порог — ничего не включается.
  let gusty = fresh();
  for (let i = 0; i < 20; i++) {
    gusty = hold(gusty, 9, 2);
    gusty = hold(gusty, 1, 2);
  }
  check(!gusty.active, 'порывы 9 м/с по 2 с с провалами по 2 с — коррекция так и не включилась');
  // А вот при ОПАСНОЙ скорости порывы длиной от 3 с — уже не порывы, а погода:
  // такие включают коррекцию быстро (см. fastSpeed).
  let squall = fresh();
  squall = hold(squall, 13, 3.2);
  check(squall.active, 'шквал 13 м/с длиной 3,2 с коррекцию включает — это уже не порыв');
}

console.log('— Быстрое включение при опасном ветре —');
{
  check(hold(fresh(), 13, 3.2).active, 'ветер 13 м/с (выше опасного 12) включает коррекцию за 3 с, а не за 10');
  check(!hold(fresh(), 13, 2.5).active, 'он же длиной 2,5 с — не включает: короче порыва, реагировать нельзя');
  check(!hold(fresh(), 11.9, 5).active, 'ветер 11,9 м/с быстрое включение не запускает — ждёт общую выдержку');
  const off: WindLimitConfig = { ...cfg, fastSpeed: 0 };
  let st = fresh();
  for (let t = 0; t < 5; t += 0.1) st = stepWindCorrection(st, 30, 0.1, off);
  check(!st.active, 'fastSpeed=0 — быстрого включения нет даже при 30 м/с');
}

console.log('— Изменение уровня внутри коррекции —');
{
  const on = hold(fresh(), 5, 12);
  check(on.active && Math.abs(on.level - 5) < 0.2, `включились на 5 м/с (уровень ${on.level.toFixed(2)})`);

  // Порыв короче выдержки подтверждения уровень не двигает ВООБЩЕ.
  const short = hold(on, 12, 0.5);
  check(Math.abs(short.level - on.level) < 1e-9, `порыв 12 м/с на 0,5 с уровень не изменил (${short.level.toFixed(2)})`);

  // Подтверждённый рост поднимает уровень сразу — это безопасность.
  const up = hold(on, 12, 2);
  check(up.level > 11, `ветер 12 м/с, подтверждённый за 2 с, поднял уровень до ${up.level.toFixed(1)}`);

  // Спад короче выдержки уровень не двигает.
  const dipShort = hold(up, 4, 0.5);
  check(Math.abs(dipShort.level - up.level) < 1e-9, 'провал 0,5 с уровень не опустил');

  // Подтверждённый спад отпускает, но не быстрее разрешённой скорости.
  const down = hold(up, 4, 2);
  const fallMax = up.level - cfg.levelFallPerSec * 2 - 0.2;
  check(down.level < up.level && down.level >= fallMax, `спад идёт не быстрее ${cfg.levelFallPerSec} м/с за секунду (стало ${down.level.toFixed(2)})`);
  const long = hold(up, 4, 30);
  check(Math.abs(long.level - 4) < 0.2, `за 30 с спад дошёл до подтверждённых 4 м/с (${long.level.toFixed(2)})`);

  // Уровень не опускается ниже порога, пока коррекция включена: иначе
  // получилось бы «коррекция есть, но считаем по нулю».
  const toFloor = hold(up, 2.5, 60);
  check(toFloor.level >= cfg.deadbandSpeed, `уровень не уходит ниже порога (${toFloor.level.toFixed(2)})`);

  // Дребезг вокруг одного значения не раскачивает уровень.
  let jitter = hold(fresh(), 6, 12);
  const before = jitter.level;
  for (let i = 0; i < 40; i++) {
    jitter = hold(jitter, 6.3, 0.3);
    jitter = hold(jitter, 5.7, 0.3);
  }
  check(Math.abs(jitter.level - before) < 1.2, `дребезг ±0,3 м/с не раскачал уровень (${before.toFixed(2)} → ${jitter.level.toFixed(2)})`);
}

console.log('— Снятие коррекции —');
{
  const on = hold(fresh(), 8, 12);
  check(hold(on, 1, 9.5).active, 'затишье 9,5 с коррекцию не снимает');
  const offSt = hold(on, 1, 10.5);
  check(!offSt.active, 'затишье 10,5 с — коррекция выключена');
  check(offSt.fade > 0, 'но сила ещё не ноль: коррекция сходит плавно, струи не подскакивают');
  const gone = hold(on, 1, 40);
  check(gone.fade === 0 && gone.level === 0, 'через 40 с затишья коррекции нет совсем');
  // Вернулся ветер до конца спада — включаемся не мгновенно, выдержка честная.
  const back = hold(offSt, 9, 5);
  check(!back.active, 'ветер вернулся через 5 с — выдержка на включение отсчитывается заново');
  check(hold(back, 9, 6).active, 'и через 11 с снова включается');
}

console.log('— Плавность ввода и снятия —');
{
  const half = hold(fresh(), 8, 10.1 + cfg.fadeInSec / 2);
  check(half.fade > 0.3 && half.fade < 0.8, `на середине ввода сила коррекции ${half.fade.toFixed(2)} — не 0 и не 1`);
  const full = hold(fresh(), 8, 10.1 + cfg.fadeInSec + 0.5);
  check(full.fade === 1, 'через fadeInSec коррекция в полную силу');
  check(cfg.fadeOutSec > cfg.fadeInSec, 'снятие медленнее ввода: убирать воду быстро, поднимать не спеша');
  // Монотонность ввода: сила ни на одном шаге не уменьшается, пока ветер держится.
  let st = hold(fresh(), 8, 10.1);
  let mono = true;
  for (let i = 0; i < 60; i++) {
    const next = stepWindCorrection(st, 8, 0.1, cfg);
    if (next.fade < st.fade - 1e-9) mono = false;
    st = next;
  }
  check(mono, 'пока ветер держится, сила коррекции только растёт — без дрожания');
}

console.log('— Мусор с датчика —');
{
  const on = hold(fresh(), 8, 12);
  check(stepWindCorrection(on, 900, 1, cfg) === on, '900 м/с (обрыв линии) — состояние не изменилось вообще');
  check(stepWindCorrection(on, -5, 1, cfg) === on, 'отрицательное показание отброшено');
  check(stepWindCorrection(on, NaN, 1, cfg) === on, 'NaN отброшен');
  check(stepWindCorrection(on, Infinity, 1, cfg) === on, 'бесконечность отброшена');
  // Главное: мусор не должен СНИМАТЬ коррекцию, притворяясь затишьем.
  let st = on;
  for (let i = 0; i < 200; i++) st = stepWindCorrection(st, 900, 0.1, cfg);
  check(st.active, '20 с мусора коррекцию не сняли — обрыв датчика не считается затишьем');
  // И не должен её включать.
  let st2 = fresh();
  for (let i = 0; i < 200; i++) st2 = stepWindCorrection(st2, 900, 0.1, cfg);
  check(!st2.active, 'и не включили — мусор не считается ветром');
}

console.log('— Высота струи от значения на насосе —');
{
  check(jetHeightM(1, 6) === 6, 'полный насос — паспортная высота');
  check(jetHeightM(0, 6) === 0, 'ноль — струи нет');
  check(Math.abs(jetHeightM(0.5, 6) - 1.5) < 1e-9, 'половина значения — четверть высоты (нелинейно, H ∝ L²)');
  check(jetHeightM(0.5, 6) < 6 * 0.5, 'на половине значения струя НИЖЕ половины — это и есть нелинейность');
  const l = jetLevelForHeight(1.5, 6);
  check(Math.abs(l - 0.5) < 1e-9, 'обратное преобразование сходится');
  check(jetLevelForHeight(99, 6) === 1 && jetLevelForHeight(-1, 6) === 0, 'вне диапазона обрезается');
  // 40 из 255 у пятнадцатиметровой форсунки — это струя меньше полуметра.
  const h40 = jetHeightM(40 / 255, 15);
  check(h40 < 0.5, `15-метровая форсунка на 40/255 даёт ${h40.toFixed(2)} м — резать нечего`);
}

console.log('— Предел по текущему значению, а не по паспорту —');
{
  const tall = plainWindNozzle(15);
  // Главная поправка: у приглушённой высокой форсунки предел ВЫШЕ её текущего
  // значения, то есть коррекция её не трогает.
  const cap = windCapDmx(5, 1, cfg, tall);
  check(cap > 40, `15-метровая форсунка при 5 м/с: предел ${cap}/255 — значение 40 останется нетронутым`);
  check(cap < 255, 'но на полном напоре та же форсунка режется');
  // На каждой скорости предел не растёт с ветром.
  let prev = 256;
  let monotone = true;
  for (let u = 0.5; u <= 11.5; u += 0.5) {
    const c = windCapDmx(u, 1, cfg, tall);
    if (c > prev) monotone = false;
    prev = c;
  }
  check(monotone, 'чем сильнее ветер, тем ниже предел — без провалов и скачков вверх');
  check(windCapDmx(12, 1, cfg, tall) === 0, 'выше stopSpeed — ноль');
  check(windCapDmx(11.9, 1, cfg, tall) >= Math.round((cfg.minPercent / 100) * 255) - 1, 'до stopSpeed не опускаемся ниже минимальной мощности');
  check(windCapDmx(8, 0, cfg, tall) === 255, 'сила коррекции ноль — предела нет');
  const halfFade = windCapDmx(8, 0.5, cfg, tall);
  const fullFade = windCapDmx(8, 1, cfg, tall);
  check(halfFade > fullFade && halfFade < 255, `на половине силы предел посередине (${halfFade} против ${fullFade})`);
  check(windCapDmx(8, 1, { ...cfg, enabled: false }, tall) === 255, 'выключенное ограничение ничего не режет');
}

console.log('— Высокие струи режутся раньше низких —');
{
  // Ветер выбран такой, чтобы разница была видна на всех трёх высотах: при
  // 3 м/с низкие струи ещё вообще не ограничиваются.
  const low = windAllowedLevel(6, cfg, plainWindNozzle(2));
  const mid = windAllowedLevel(6, cfg, plainWindNozzle(6));
  const high = windAllowedLevel(6, cfg, plainWindNozzle(15));
  check(low > mid && mid > high, `при 6 м/с: 2 м → ${(low * 100) | 0}%, 6 м → ${(mid * 100) | 0}%, 15 м → ${(high * 100) | 0}%`);
  check(windAllowedLevel(3, cfg, plainWindNozzle(2)) === 1, 'двухметровой струе 3 м/с не мешают вовсе');
  // Предел не растёт с высотой ни на одном шаге — иначе где-то ошибка знака.
  let prevH = 2;
  let monoH = true;
  for (let h = 2; h <= 20; h += 0.5) {
    const v = windAllowedLevel(6, cfg, plainWindNozzle(h));
    if (v > windAllowedLevel(6, cfg, plainWindNozzle(prevH)) + 1e-9) monoH = false;
    prevH = h;
  }
  check(monoH, 'чем выше струя, тем ниже её предел — без исключений');
  // Порог начала снижения у каждой высоты свой.
  const threshold = (maxH: number): number => {
    for (let u = 0.1; u <= 20; u += 0.1) if (windAllowedLevel(u, cfg, plainWindNozzle(maxH)) < 1) return u;
    return -1;
  };
  const t1 = threshold(1);
  const t15 = threshold(15);
  check(t1 > t15 * 5, `порог у метровой струи (${t1.toFixed(1)} м/с) в разы выше, чем у пятнадцатиметровой (${t15.toFixed(1)} м/с)`);
  check(t15 < cfg.deadbandSpeed, 'у пятнадцатиметровой порог ниже зоны нечувствительности — её ограничивает именно порог по ветру');
}

console.log('— Снос и наклон сопла —');
{
  const drop = referenceAirDropM();
  const vertical: WindNozzle = { maxHeightM: 6, airDropM: drop, tiltDeg: 0, tiltOutward: 0, roomM: Infinity };
  const inward: WindNozzle = { maxHeightM: 6, airDropM: drop, tiltDeg: 30, tiltOutward: -1, roomM: Infinity };
  const outward: WindNozzle = { maxHeightM: 6, airDropM: drop, tiltDeg: 30, tiltOutward: 1, roomM: Infinity };
  const misty: WindNozzle = { ...vertical, airDropM: airDropM(nozzleDropM('mist', 0.02, 0.9), 0.9) };

  check(windDriftM(0, 6, vertical) === 0, 'без ветра уводить струю нечему');
  check(windDriftM(5, 6, vertical) > windDriftM(5, 2, vertical), 'высокую струю уводит дальше низкой');
  check(windDriftM(10, 6, vertical) > windDriftM(5, 6, vertical), 'сильнее ветер — дальше уводит');
  check(windDriftM(5, 6, misty) > windDriftM(5, 6, vertical), 'туман сносит сильнее плотной струи той же высоты');
  check(
    windDriftM(5, 6, vertical, 2) > windDriftM(5, 6, vertical),
    'строгость ×2 считает снос больше — запас на порывистое место',
  );

  // Наклон внутрь: вода падает ближе к центру, наружу — дальше от него.
  check(windLandingM(0, 6, inward) < 0, 'сопло к центру: без ветра вода падает внутрь чаши');
  check(windLandingM(0, 6, outward) > 0, 'сопло к борту: без ветра вода падает в сторону борта');
  check(Math.abs(windLandingM(0, 6, vertical)) < 1e-9, 'вертикальное сопло без ветра падает туда же, откуда вылетело');
  check(
    windLandingM(6, 6, inward) < windLandingM(6, 6, vertical),
    'при одном ветре наклонённая к центру струя оказывается дальше от борта, чем вертикальная',
  );
  // Уход ОТ ВЕТРА одинаков — наклон в разности сокращается, и это не случайность.
  const dv = windLandingM(6, 6, vertical) - windLandingM(0, 6, vertical);
  const di = windLandingM(6, 6, inward) - windLandingM(0, 6, inward);
  check(Math.abs(dv - di) < 1e-6, 'ветер уводит наклонную и вертикальную струю на одинаковую величину');
  check(Math.abs(dv - windDriftM(6, 6, vertical)) < 1e-6, 'и эта величина — ровно windDriftM (предел по картинке)');
}

console.log('— Сцепка с ветром: сверка с замерами на объекте —');
{
  /*
   * Это не «проверка кода», а проверка КАЛИБРОВКИ, и она важнее остальных.
   * Заказчик замерил с натуры (15.09.2026): прямую струю 20 мм высотой 5 м при
   * ветре 15 м/с сносит примерно на 2 м, десятиметровую — на 4–5 м. До
   * объединения ветровое ограничение считало по одному числу τ = 4 с и давало
   * для пятиметровой 6,5 м — втрое больше замеренного, то есть резало струи
   * куда раньше, чем требует реальность.
   *
   * Если кто-то поправит коэффициенты модели капли, эти три строки упадут — и
   * это правильно: менять их можно только вместе с новыми замерами.
   */
  const jet = (maxHeightM: number): WindNozzle => ({
    maxHeightM,
    airDropM: airDropM(nozzleDropM('straight', 0.02, 0.3), 0.3),
    tiltDeg: 0,
    tiltOutward: 0,
    roomM: Infinity,
  });
  const d5 = windDriftM(15, 5, jet(5));
  const d10 = windDriftM(15, 10, jet(10));
  check(Math.abs(d5 - 2) < 0.4, `струя 5 м при 15 м/с сносится на ${d5.toFixed(2)} м — замерено «примерно 2 м»`);
  check(d10 > 4 && d10 < 5.2, `струя 10 м при 15 м/с — ${d10.toFixed(2)} м, замерено «4–5 м»`);
  check(d10 / d5 > 2.05, `десятиметровую сносит БОЛЬШЕ чем вдвое дальше пятиметровой (${(d10 / d5).toFixed(2)}×) — поправка на скорость работает`);

  // Порядок величин τ по типам сопел.
  const tau = (kind: Parameters<typeof jetWindTauSec>[0], widthM: number, spray: number, h: number): number =>
    jetWindTauSec(kind, widthM, spray, Math.sqrt(2 * 9.81 * h));
  const tauStraight = tau('straight', 0.02, 0.3, 5);
  const tauMist = tau('mist', 0.02, 0.9, 5);
  const tauLaminar = tau('laminar', 0.02, 0.05, 5);
  check(tauStraight > 12 && tauStraight < 17, `прямая струя 20 мм: сцепка ${tauStraight.toFixed(1)} с (ожидаем 14–15)`);
  check(tauMist < 3, `туман: ${tauMist.toFixed(1)} с — сдувает почти сразу`);
  check(tauMist < tauStraight / 4, 'туман цепляется за ветер в разы сильнее плотной струи');
  check(tauLaminar >= tauStraight * 0.8, `ламинарная не парусит сильнее прямой (${tauLaminar.toFixed(1)} с)`);
  check(tau('straight', 0.02, 0.3, 15) < tauStraight, 'высокая струя бьёт быстрее — её сцепка меньше, сносит сильнее');

  // Таблица калибров заполнена для ВСЕХ типов: забытый тип дал бы undefined и
  // расчёт молча съехал бы в NaN.
  const kinds = NOZZLE_KINDS.map((k) => k.id);
  check(
    kinds.every((k) => Number.isFinite(nozzleDropM(k, 0.02, 0.3)) && nozzleDropM(k, 0.02, 0.3) > 0),
    'калибр капли посчитан для всех типов форсунок',
    kinds.filter((k) => !Number.isFinite(nozzleDropM(k, 0.02, 0.3))).join(),
  );
  check(
    kinds.every((k) => Number.isFinite(tau(k, 0.02, 0.3, 5)) && tau(k, 0.02, 0.3, 5) > 0),
    'сцепка с ветром посчитана для всех типов форсунок',
  );
  // Тип сопла действительно входит в расчёт насоса, а не только в картинку.
  const capMist = windCapDmx(4, 1, cfg, { ...jet(6), airDropM: airDropM(nozzleDropM('mist', 0.02, 0.9), 0.9) });
  const capStraight = windCapDmx(4, 1, cfg, jet(6));
  check(capMist < capStraight, `туман режется сильнее прямой струи той же высоты (${capMist} против ${capStraight})`);
}

console.log('— Расстояние до борта чаши —');
{
  const round: Bowl = {
    id: 'b1', name: 'Круглая', shape: 'circle', x: 0, y: 0, radius: 5,
    width: 10, length: 10, height: 0.3, elevationM: 0, waterDepthM: 0.25, cornerRadiusM: 0,
    showRim: true, showWater: true, showFloor: true, spillover: false, spilloverDropM: 0.6,
    modelFile: null, modelScale: 1,
  };
  const rect: Bowl = { ...round, id: 'b2', shape: 'rect', x: 20, y: 0, width: 8, length: 4 };

  check(Math.abs(bowlRoom(0, 0, [round]).roomM - 5) < 1e-9, 'в центре круглой чаши до борта — радиус');
  check(Math.abs(bowlRoom(4, 0, [round]).roomM - 1) < 1e-9, 'у борта круглой чаши — остаток радиуса');
  const out = bowlRoom(4, 0, [round]);
  check(Math.abs(out.outX - 1) < 1e-9 && Math.abs(out.outY) < 1e-9, 'наружу — по радиусу от центра');
  check(!Number.isFinite(bowlRoom(9, 0, [round]).roomM), 'точка вне чаши — расстояние неизвестно, предел по борту не применяем');
  check(!Number.isFinite(bowlRoom(0, 0, []).roomM), 'чаш нет — тоже неизвестно');
  check(Math.abs(bowlRoom(20, 0, [rect]).roomM - 2) < 1e-9, 'в прямоугольной чаше берётся ближняя стенка (2, а не 4)');
  check(bowlRoom(23, 0, [rect]).outX === 1, 'у правой стенки наружу — вправо');
  const rectSide = bowlRoom(20, 1.5, [rect]);
  check(rectSide.outY === 1 && rectSide.outX === 0, 'у длинной стенки наружу — вдоль Y');
  // Вложенные чаши: берём ту, где до борта ближе — она и ограничивает.
  const inner: Bowl = { ...round, id: 'b3', radius: 1.5 };
  check(Math.abs(bowlRoom(1, 0, [round, inner]).roomM - 0.5) < 1e-9, 'из вложенных чаш выбирается самая тесная');
}

console.log('— Форсунка у борта режется сильнее центральной —');
{
  const bowl: Bowl = {
    id: 'b', name: 'Чаша', shape: 'circle', x: 0, y: 0, radius: 5,
    width: 10, length: 10, height: 0.3, elevationM: 0, waterDepthM: 0.25, cornerRadiusM: 0,
    showRim: true, showWater: true, showFloor: true, spillover: false, spilloverDropM: 0.6,
    modelFile: null, modelScale: 1,
  };
  const base: Nozzle = {
    id: 'n', name: 'Ф', kind: 'straight', x: 0, y: 0, z: 0, tiltDeg: 0, headingDeg: 0,
    maxHeightM: 6, widthM: 0.03, coneAngleDeg: 25, rotationSpeedDegPerSec: 60, sprayFactor: 0.3,
    riseMs: 400, fallMs: 600, pumpDeviceId: null, pump2DeviceId: null, valveDeviceId: null,
  } as unknown as Nozzle;

  const center = windNozzleFor({ ...base, x: 0, y: 0 }, [bowl]);
  const edge = windNozzleFor({ ...base, x: 4.7, y: 0 }, [bowl]);
  check(center.roomM > edge.roomM, `до борта: в центре ${center.roomM} м, у борта ${edge.roomM} м`);
  const capCenter = windCapDmx(4, 1, cfg, center);
  const capEdge = windCapDmx(4, 1, cfg, edge);
  check(capEdge < capCenter, `форсунка у борта режется сильнее центральной (${capEdge} против ${capCenter} из 255)`);
  check(capCenter < 255, 'но и центральную режем: сдутый столб портит картину не меньше');

  // Наклон внутрь у той же приборной форсунки — терпит больший ветер.
  const edgeInward = windNozzleFor({ ...base, x: 4.7, y: 0, tiltDeg: 30, headingDeg: 180 }, [bowl]);
  check(edgeInward.tiltOutward < -0.9, 'сопло у правого борта с азимутом 180° смотрит к центру');
  check(
    windCapDmx(4, 1, cfg, edgeInward) > capEdge,
    `наклонённая к центру форсунка у борта терпит больше (${windCapDmx(4, 1, cfg, edgeInward)} против ${capEdge})`,
  );
  const edgeOutward = windNozzleFor({ ...base, x: 4.7, y: 0, tiltDeg: 30, headingDeg: 0 }, [bowl]);
  check(edgeOutward.tiltOutward > 0.9, 'азимут 0° у правого борта — сопло смотрит наружу');
  check(windCapDmx(4, 1, cfg, edgeOutward) <= capEdge, 'а наклонённая к борту — терпит меньше');

  // Вращающиеся и моторные считаем смотрящими наружу: их азимут меняется на ходу.
  const spinning = windNozzleFor({ ...base, x: 4.7, y: 0, tiltDeg: 30, headingDeg: 180, kind: 'rotating' }, [bowl]);
  check(spinning.tiltOutward === 1, 'вращающаяся насадка считается смотрящей наружу — защищаем худшее положение');

  // Запас от борта: больше запас — строже предел. Считать надо там, где именно
  // борт и ограничивает: дальше от него первым упирается предел по картинке.
  const near = windNozzleFor({ ...base, x: 4.3, y: 0 }, [bowl]);
  const noReserve: WindLimitConfig = { ...cfg, edgeReserveM: 0 };
  check(
    windCapDmx(4, 1, cfg, near) < windCapDmx(4, 1, noReserve, near),
    `запас у борта режет сильнее, чем без него (${windCapDmx(4, 1, cfg, near)} против ${windCapDmx(4, 1, noReserve, near)})`,
  );

  /*
   * Форсунка у самого борта — самая уязвимая, но «выключить навсегда» не
   * защита, а поломка: кольцо форсунок по борту чаши это обычная раскладка.
   * Поэтому запас берётся не больше половины того места, что есть.
   */
  const atRim = windNozzleFor({ ...base, x: 4.8, y: 0 }, [bowl]);
  check(Math.abs(edgeRoomM(atRim, cfg) - 0.1) < 1e-9, `в 20 см от борта остаётся 0,1 м допуска, а не ноль (${edgeRoomM(atRim, cfg)})`);
  const atRimCap = windCapDmx(3, 1, cfg, atRim);
  check(atRimCap > 0, `форсунка в 20 см от борта при 3 м/с работает приглушённо, а не глохнет (${atRimCap}/255)`);
  check(atRimCap < windCapDmx(3, 1, cfg, center), 'но заметно слабее центральной');
  check(edgeRoomM(plainWindNozzle(6), cfg) === Infinity, 'без чаши предела по борту нет');

  /*
   * Вода за борт — не предмет торга. Если даже приглушённая струя перелетает
   * борт, предел уходит НИЖЕ «минимальной мощности»: пусть эта форсунка стоит.
   * Минимальная мощность существует против предела по картинке, а не против
   * безопасности.
   */
  const floorDmx = Math.round((cfg.minPercent / 100) * 255);
  // Форсунка вплотную к борту (5 см) при сильном ветре: тут уже никакая
  // «минимальная мощность» не спасает — вода пойдёт наружу.
  const hugRim = windNozzleFor({ ...base, x: 4.95, y: 0 }, [bowl]);
  check(
    windCapDmx(11, 1, cfg, hugRim) < floorDmx,
    `при 11 м/с форсунка в 5 см от борта режется ниже минимальной мощности (${windCapDmx(11, 1, cfg, hugRim)} против пола ${floorDmx})`,
  );
  check(
    windCapDmx(11, 1, cfg, center) >= floorDmx,
    'а центральная ниже минимальной мощности не опускается: там ограничение только по картинке',
  );
}

console.log('— Чтение настроек с диска —');
{
  const d = defaultWindLimitConfig();
  check(sanitizeWindLimitConfig(null).deadbandSpeed === d.deadbandSpeed, 'мусор вместо настроек — заводские значения');
  check(sanitizeWindLimitConfig({ enabled: 'да' }).enabled === false, 'enabled только настоящим true');
  check(sanitizeWindLimitConfig({ deadbandSpeed: -5 }).deadbandSpeed === 0, 'отрицательный порог подтянут к нулю');
  check(sanitizeWindLimitConfig({ deadbandSpeed: 999 }).deadbandSpeed === 20, 'запредельный порог обрезан');
  check(sanitizeWindLimitConfig({ maxSpeed: 9 }).stopSpeed === 9, 'старое поле maxSpeed переносится в stopSpeed');
  check(sanitizeWindLimitConfig({ releaseHoldSec: 25 }).deactivateHoldSec === 25, 'старая выдержка на возврат становится выдержкой на снятие');
  check(sanitizeWindLimitConfig({ attackSec: 2 }).adjustHoldSec === 2, 'старая attackSec становится выдержкой подтверждения');
  check(sanitizeWindLimitConfig({ driftFactor: 0 }).driftFactor === 0.3, 'нулевая строгость не пропускается — она обнулила бы весь расчёт');
  check(sanitizeWindLimitConfig({ driftFactor: 99 }).driftFactor === 5, 'запредельная строгость обрезана');
  // Прежнее «время сцепки» в проектах игнорируется намеренно: оно было одним
  // числом на объект и втрое завышало снос. Открытие старого проекта — это
  // исправление расчёта, а не потеря настройки.
  check(sanitizeWindLimitConfig({ tauSec: 4 }).driftFactor === d.driftFactor, 'старое поле tauSec не переносится — считаем по модели капли');
  check(sanitizeWindLimitConfig({ minPercent: 33.7 }).minPercent === 34, 'минимальная мощность — целое');
}

console.log('— Устойчивость: длинный прогон случайным ветром —');
{
  /**
   * Смысл: за час случайной погоды состояние не должно ни развалиться (NaN,
   * отрицательный уровень), ни «залипнуть» включённым при штиле.
   * Псевдослучайность своя и с постоянным зерном — тест должен быть
   * повторяемым, иначе однажды он упадёт и это невозможно будет разобрать.
   */
  let seed = 20260919;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let st = fresh();
  let bad = '';
  for (let i = 0; i < 36000; i++) {
    const raw = rnd() < 0.02 ? 900 : rnd() * 14;
    st = stepWindCorrection(st, raw, 0.1, cfg);
    if (!Number.isFinite(st.level) || st.level < 0 || st.fade < 0 || st.fade > 1) {
      bad = `шаг ${i}: level=${st.level}, fade=${st.fade}`;
      break;
    }
    if (st.window.length > 100) {
      bad = `шаг ${i}: окно разрослось до ${st.window.length}`;
      break;
    }
  }
  check(bad === '', 'час случайной погоды (в том числе с обрывами датчика) состояние не развалил', bad);
  const afterCalm = hold(st, 0, 60);
  check(!afterCalm.active && afterCalm.fade === 0, 'после часа погоды и минуты штиля коррекция снята');
}

/*
 * ── Живой движок: предел доходит до конца ────────────────────────────────
 *
 * Эта проверка появилась после настоящей ошибки, которую чистые функции не
 * ловили. В движке пределы по насосам пересчитывались не каждый тик (перебор
 * высот для сотни насосов двадцать раз в секунду — впустую), а «когда ветер
 * или сила коррекции изменились больше чем на 0,05». Последний шаг силы
 * (0,98 → 1,0) в этот допуск не попадал, пересчёт не запускался — и насос
 * застывал на 5 из 255 вместо нуля. НАВСЕГДА. Ровно так же мог не сработать
 * переход через «стоп»: посчитали на 11,99 м/с, стало 12,03 — фонтан
 * остался бы работать при ветре, на котором его положено глушить.
 *
 * Поэтому здесь поднимается настоящий движок со своим тиком: только он
 * проходит через кэш пределов.
 */
async function liveEngineCheck(): Promise<void> {
  console.log('— Живой движок: глушение доходит до нуля —');
  const { Engine } = await import('../engine');
  const { emptyProject, sanitizeProject } = await import('@fountain-studio/shared');

  const engine = new Engine({
    server: { port: 9597 },
    timing: { tickMs: 50, spinMs: 2, uiFrameMs: 100 },
    audio: { player: 'none', ffplayPath: '', volumeDb: 0, muted: false, bassDb: 0, trebleDb: 0 },
    universes: [{ id: 1, label: 'Вселенная 1', outputs: [] }],
    backup: { enabled: false, intervalMin: 60 },
  } as never);

  // Выдержки укорочены: проверяется не «сколько ждём» (это выше, чистыми
  // функциями), а что кэш пределов доходит до конечного значения.
  const fast = {
    ...defaultWindLimitConfig(),
    enabled: true,
    activateHoldSec: 0.2,
    deactivateHoldSec: 0.2,
    adjustHoldSec: 0.1,
    fastHoldSec: 0.2,
    fadeInSec: 0.3,
    fadeOutSec: 0.3,
    // Спад расчётной скорости тоже ускорен: с заводскими 0,5 м/с за секунду
    // путь с 15 до 5 м/с занял бы двадцать секунд, а проверяется здесь не он.
    levelFallPerSec: 20,
  };
  // Со СХЕМОЙ, а не на запасной форсунке: у запасной (4 м, прямая 20 мм) снос
  // при умеренном ветре ещё укладывается в допуск, и предел просто не действует —
  // проверять на ней «предел устоялся» было бы нечего.
  engine.setProject(
    sanitizeProject({
      ...emptyProject('Проверка ветра'),
      devices: [{ id: 'p1', name: 'Насос', profileId: 'pump', universe: 1, address: 1 }],
      layout: {
        bowls: [],
        lights: [],
        nozzles: [
          {
            id: 'n1',
            name: 'Высокая',
            kind: 'straight',
            x: 0,
            y: 0,
            z: 0,
            tiltDeg: 0,
            headingDeg: 0,
            maxHeightM: 12,
            widthM: 0.02,
            sprayFactor: 0.3,
            pumpDeviceId: 'p1',
            pump2DeviceId: null,
            valveDeviceId: null,
          },
        ],
      },
      windLimit: fast,
    } as never),
  );
  engine.start();
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const out = (): number => engine.universes[0]!.out[0]!;
  /**
   * Дождаться условия. Пределы взяты с большим запасом намеренно: проверяется
   * ЧТО происходит, а не за сколько миллисекунд, а на загруженной машине
   * (рядом идёт сборка) тик движка плывёт. Тест не должен падать от этого.
   */
  const until = async (cond: () => boolean, limitMs = 8000): Promise<void> => {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < limitMs) await sleep(50);
  };
  /** Дождаться, пока значение перестанет меняться: переходы идут плавно. */
  const settle = async (limitMs = 8000): Promise<number> => {
    const t0 = Date.now();
    let prev = -1;
    while (Date.now() - t0 < limitMs) {
      const v = out();
      if (v === prev) return v;
      prev = v;
      await sleep(300);
    }
    return out();
  };
  try {
    engine.setChannel(1, 1, 200);
    await until(() => out() === 200);
    check(out() === 200, 'без ветра насос на заданных 200');

    // Выше stopSpeed — обязан дойти ровно до нуля, а не «почти».
    engine.setWindSpeed(15);
    await until(() => out() === 0);
    check(out() === 0, `ветер 15 м/с (выше «стоп» 12) — насос доведён до нуля, а не до ${out()}`);
    await sleep(400);
    check(out() === 0, 'и остаётся нулём, а не всплывает обратно');

    // Ветер спал до умеренного — насос оживает, но приглушённым. Это и есть
    // проверка «кэш пределов доходит до конечного значения» в обратную сторону.
    engine.setWindSpeed(5);
    await until(() => out() > 0);
    check(out() > 0, 'ветер спал до 5 м/с — насос ожил');
    const at5 = await settle();
    check(at5 > 0 && at5 < 200, `и работает приглушённым: ${at5} из 255`);
    await sleep(500);
    check(out() === at5, `предел устоялся, а не ползёт дальше (${at5} → ${out()})`);

    // Снова на границу «стоп» — вверх реагируем сразу, без выдержки на спад.
    engine.setWindSpeed(12);
    await until(() => out() === 0);
    check(out() === 0, `ровно 12 м/с — граница включительная, снова ноль (${out()})`);

    // Снятие показания возвращает полный напор.
    engine.setWindSpeed(null);
    await until(() => out() === 200);
    check(out() === 200, `сброс показания вернул полные 200 (${out()})`);
  } finally {
    engine.stop();
  }
}


// ── Источник ветра и датчик (22.09.2026) ──────────────────────────────────
//
// Откуда берётся ветер: не учитывать / ручной ввод / датчик по Modbus / по
// MQTT. Датчик опрашивается по-настоящему — поддельным анемометром на TCP
// (Modbus TCP, как шлюз RS-485 ↔ сеть), функциями 03 и 04.
async function sensorCheck(): Promise<void> {
  console.log('— источник ветра и датчик —');
  const { emptyProject, sanitizeProject, sanitizeWindLimitConfig: sanitizeWind, parseWindPayload } = await import('@fountain-studio/shared');
  const net = await import('node:net');
  const { eventLog } = await import('../eventlog');
  const { Engine } = await import('../engine');

  // Разбор настроек: старые объекты и мусор.
  const old = sanitizeWind({ enabled: true });
  check(old.enabled && old.source === 'manual', 'старый объект с включённым ветром — ручной ввод, как и было');
  check(sanitizeWind({ source: 'modbus' }).source === 'modbus', 'источник «датчик Modbus» сохраняется');
  check(sanitizeWind({ source: 'радио' }).source === 'manual', 'непонятный источник — ручной ввод');
  check(sanitizeWind({ modbus: { unitId: 999 } }).modbus.unitId === 247, 'адрес датчика не больше 247');
  check(sanitizeWind({ modbus: { unitsPerMs: 0 } }).modbus.unitsPerMs === 10, 'нулевой масштаб — заводские 10');
  check(sanitizeWind({ mqtt: { topic: 'weather/#' } }).mqtt.topic === 'weather/', 'маски MQTT из топика убраны');
  check(sanitizeWind({ sensorLostSec: 0 }).sensorLostSec === 2, 'датчик считается пропавшим не раньше 2 с');

  // Показание из MQTT.
  check(parseWindPayload('3.2')?.speedMs === 3.2, 'MQTT: «3.2»');
  check(parseWindPayload('3,2')?.speedMs === 3.2, 'MQTT: «3,2» с запятой');
  const js = parseWindPayload('{"speed": 4.5, "direction": 270}');
  check(js?.speedMs === 4.5 && js.directionDeg === 270, 'MQTT: JSON со скоростью и направлением');
  check(parseWindPayload('ветрено') === null, 'MQTT: текст без числа — не показание');

  // Поддельный анемометр: holding 0 = 32 (3,2 м/с), holding 1 = 270°,
  // input 0 = 45 (4,5 м/с). Запись (06) — для насоса на той же линии.
  const holding = new Map<number, number>([
    [0, 32],
    [1, 270],
  ]);
  const input = new Map<number, number>([[0, 45]]);
  let silent = false;
  const sockets = new Set<import('node:net').Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('data', (buf: Buffer) => {
      if (silent) return;
      for (let off = 0; off + 8 <= buf.length; ) {
        const len = buf.readUInt16BE(off + 4);
        const unit = buf.readUInt8(off + 6);
        const pdu = buf.subarray(off + 7, off + 6 + len);
        const fc = pdu.readUInt8(0);
        let resp: Buffer;
        if (fc === 3 || fc === 4) {
          const v = (fc === 3 ? holding : input).get(pdu.readUInt16BE(1)) ?? 0;
          resp = Buffer.from([fc, 2, (v >> 8) & 0xff, v & 0xff]);
        } else resp = pdu; // 06 — эхо
        const head = Buffer.alloc(7);
        buf.copy(head, 0, off, off + 4);
        head.writeUInt16BE(resp.length + 1, 4);
        head.writeUInt8(unit, 6);
        sock.write(Buffer.concat([head, resp]));
        off += 6 + len;
      }
    });
  });
  await new Promise<void>((r) => server.listen(15502, '127.0.0.1', () => r()));

  const events: string[] = [];
  const unsub = eventLog.subscribe((e) => {
    if (e.source === 'wind') events.push(`${e.level}:${e.message}`);
  });

  const engine = new Engine({
    server: { port: 9598 },
    timing: { tickMs: 50, spinMs: 2, uiFrameMs: 100 },
    audio: { player: 'none', ffplayPath: '', volumeDb: 0, muted: false, bassDb: 0, trebleDb: 0 },
    universes: [{ id: 1, label: 'Вселенная 1', outputs: [] }],
    backup: { enabled: false, intervalMin: 60 },
  } as never);
  const sensorCfg = {
    ...defaultWindLimitConfig(),
    enabled: true,
    source: 'modbus' as const,
    activateHoldSec: 0.2,
    deactivateHoldSec: 0.2,
    fadeInSec: 0.3,
    sensorLostSec: 2,
    modbus: {
      connection: { kind: 'tcp' as const, host: '127.0.0.1', port: 15502 },
      unitId: 1,
      register: 0,
      registerKind: 'holding' as const,
      unitsPerMs: 10,
      directionRegister: 1,
      directionUnitsPerDeg: 1,
    },
  };
  const project = (windLimit: unknown, withPump = false): never =>
    sanitizeProject({
      ...emptyProject('Датчик ветра'),
      devices: [
        {
          id: 'p1',
          name: 'Насос',
          profileId: 'pump',
          universe: 1,
          address: 1,
          ...(withPump
            ? { modbus: { connection: { kind: 'tcp', host: '127.0.0.1', port: 15502 }, unitId: 2, freqRegister: 10, freqScaleHz: 50 } }
            : {}),
        },
      ],
      windLimit,
    } as never) as never;
  const changes: boolean[] = [];
  engine.onWindChange = () => changes.push(engine.windState().correcting);
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const until = async (cond: () => boolean, limitMs = 8000): Promise<void> => {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < limitMs) await sleep(50);
  };
  engine.setProject(project(sensorCfg, true));
  engine.start();
  try {
    await until(() => engine.windState().speedMs === 3.2);
    const ws = engine.windState();
    check(ws.speedMs === 3.2, `датчик по Modbus (функция 03): 32 единицы = 3,2 м/с (${ws.speedMs})`);
    check(ws.directionDeg === 270, `направление с датчика: 270° (${ws.directionDeg})`);
    check(ws.sensor?.online === true, 'датчик на связи');
    const pool = (engine.modbusPool as unknown as { transports: Map<string, unknown> }).transports;
    check(pool.size === 1, `насос и датчик на одной линии — одно подключение, а не два (${pool.size})`);

    check(engine.setManualWind(9) === false, 'при датчике ручной ввод не принимается');
    await sleep(300);
    check(engine.windState().speedMs === 3.2, 'и показание датчика не перебито');

    // Коррекция вошла в силу — редактор должен об этом узнать сам.
    await until(() => engine.windState().correcting);
    await sleep(400);
    check(changes.includes(true), 'коррекция вошла в силу — редактору сообщено без нового ввода');

    engine.setProject(project({ ...sensorCfg, modbus: { ...sensorCfg.modbus, registerKind: 'input', directionRegister: null } }, true));
    await until(() => engine.windState().speedMs === 4.5);
    check(engine.windState().speedMs === 4.5, `функция 04 (input-регистр): 4,5 м/с (${engine.windState().speedMs})`);

    // Датчик 4–20 мА через модуль: ноль шкалы не равен нулю регистра.
    engine.setProject(project({ ...sensorCfg, modbus: { ...sensorCfg.modbus, registerKind: 'input', directionRegister: null, zeroRaw: 5 } }, true));
    await until(() => engine.windState().speedMs === 4);
    check(engine.windState().speedMs === 4, `«при безветрии» 5: (45 − 5) / 10 = 4 м/с (${engine.windState().speedMs})`);
    // Обрыв петли 4–20 мА: сигнал падает ниже нуля шкалы — неисправность, а не
    // штиль. Изображаем самим сигналом, а не сменой настроек (смена настроек —
    // это другой датчик, и показание сбрасывается честно).
    input.set(0, 2);
    await until(() => (engine.windState().sensor?.error ?? '').includes('обрыв'), 5000);
    check((engine.windState().sensor?.error ?? '').includes('обрыв'), 'сигнал ниже нуля шкалы — «обрыв линии», а не 0 м/с');
    check(engine.windState().speedMs === 4, `и ветер не сброшен в ноль — держим 4 м/с (${engine.windState().speedMs})`);
    input.set(0, 45);
    engine.setProject(project({ ...sensorCfg, modbus: { ...sensorCfg.modbus, registerKind: 'input', directionRegister: null } }, true));
    await until(() => engine.windState().speedMs === 4.5);
    events.length = 0;

    // Датчик замолчал — показание держится, в журнале авария (одна).
    silent = true;
    await until(() => engine.windState().sensor?.holding === true, 10000);
    const held = engine.windState();
    check(held.sensor?.holding === true && held.speedMs === 4.5, `датчик молчит — держим последние 4,5 м/с (${held.speedMs})`);
    // Авария пишется на ближайшем опросе после срока — ждём её, а не миг «держим».
    await until(() => events.some((e) => e.startsWith('warn:') && e.includes('не отвечает')), 3000);
    await sleep(1500);
    const lostEvents = events.filter((e) => e.startsWith('warn:') && e.includes('не отвечает'));
    check(lostEvents.length === 1, `в журнале одна авария «не отвечает», а не строка в секунду (${lostEvents.length})`);
    silent = false;
    await until(() => engine.windState().sensor?.online === true, 10000);
    check(events.some((e) => e.includes('снова на связи')), 'датчик вернулся — «снова на связи» в журнале');

    // Ручной ввод: показание датчика не остаётся висеть.
    engine.setProject(project({ ...sensorCfg, source: 'manual' }));
    check(engine.windState().speedMs === null, 'переключили на ручной ввод — показание датчика сброшено');
    check(engine.setManualWind(6) === true && engine.windState().speedMs === 6, 'ручной ввод принят');

    // «Не учитывать»: ни показания, ни ручного ввода.
    engine.setProject(project({ ...sensorCfg, enabled: false }));
    check(engine.windState().speedMs === null, '«не учитывать ветер» — показание сброшено');
    check(engine.setManualWind(5) === false, '«не учитывать ветер» — ручной ввод не принимается');

    // MQTT: свой топик — показание, чужой — мимо, мусор — ошибка в статусе.
    engine.setProject(project({ ...sensorCfg, source: 'mqtt', mqtt: { topic: 'weather/wind' } }));
    check(engine.windSensor.mqttTopic === 'weather/wind', 'MQTT: топик датчика известен подписке');
    engine.windSensor.handleMqtt('weather/other', '9');
    check(engine.windState().speedMs === null, 'MQTT: чужой топик — не показание');
    engine.windSensor.handleMqtt('weather/wind', '{"speed": 7.5, "direction": 90}');
    check(engine.windState().speedMs === 7.5 && engine.windState().directionDeg === 90, 'MQTT: JSON со скоростью и направлением принят');
    engine.windSensor.handleMqtt('weather/wind', 'ветрено');
    check(
      engine.windState().speedMs === 7.5 && engine.windState().sensor?.online === true,
      'MQTT: мусор в топике не сбивает свежее показание и не роняет «на связи»',
    );
  } finally {
    unsub();
    engine.stop();
    for (const s of sockets) s.destroy();
    server.close();
  }
}

void liveEngineCheck()
  .then(() => sensorCheck())
  .catch((err) => {
    failed++;
    console.error('  ✖ живой движок: проверка не прошла —', err);
  })
  .finally(() => {
    console.log(`\nветер: пройдено ${passed}, ошибок ${failed}`);
    process.exitCode = failed ? 1 : 0;
  });
