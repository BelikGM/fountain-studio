/**
 * 3D-схема фонтана: чаши, форсунки и прожекторы с координатами в метрах.
 * Элементы схемы привязываются к устройствам патча — визуализатор берёт их
 * значения из живых DMX-кадров движка, поэтому превью честное.
 * Ось X — вправо, Y — «вглубь» (план как на чертеже), Z — вверх.
 */

export type BowlShape = 'circle' | 'rect';

export interface Bowl {
  id: string;
  name: string;
  shape: BowlShape;
  /** Центр чаши в плане, м. */
  x: number;
  y: number;
  /** Радиус для circle, м. */
  radius: number;
  /** Размеры для rect: width по X, length по Y, м. */
  width: number;
  length: number;
  /** Высота борта от дна, м (только визуализация). */
  height: number;
  /**
   * Толщина борта, м. Растёт ВНУТРЬ чаши: радиус и размеры меряют по крайним
   * точкам, поэтому снаружи чаша от толщины не меняется, а зеркало воды и дно
   * становятся меньше. Раньше борт был стенкой нулевой толщины — «жесть в
   * миллиметр», которая воду не удержит и выглядит ненастояще.
   */
  wallThicknessM: number;
  /** Цвет борта — камень, бетон, плитка бывают разные. */
  rimColor: string;
  /**
   * Картинка облицовки борта (фото камня, плитки) — data URL уменьшенного
   * JPEG, не больше 512 px по стороне: столько хватает на плитку, а проект
   * остаётся лёгким (он ходит по сети целиком при каждой правке). null — просто цвет.
   */
  rimTexture: string | null;
  /** Размер одной плитки картинки на борту, м: картинка повторяется, а не растягивается на всю чашу. */
  rimTileM: number;
  /**
   * Отметка дна чаши над нулём площадки, м. Ради неё всё и затевалось:
   * многоуровневый фонтан — это несколько чаш на разных отметках, вода из
   * верхней переливается в нижнюю.
   */
  elevationM: number;
  /** Уровень воды от дна чаши, м. Ниже борта — видно стенку изнутри. */
  waterDepthM: number;
  /** Скругление углов прямоугольной чаши, м. */
  cornerRadiusM: number;
  /** Что рисовать: борт, зеркало воды, дно. Позволяет собирать разрезы и сухие площадки. */
  showRim: boolean;
  showWater: boolean;
  showFloor: boolean;
  /**
   * Перелив через борт: вода идёт плёнкой по наружной стенке вниз. У
   * многоуровневых чаш это основной видимый эффект между ярусами.
   */
  spillover: boolean;
  /** Высота, на которую плёнка перелива спускается по стенке, м (не ниже земли). */
  spilloverDropM: number;
  /**
   * Бугорок перелива над кромкой борта, м: вода, переваливая через край,
   * вспухает и чуть пенится. 0 — ровная плёнка.
   */
  spilloverBulgeM: number;
  /**
   * Своя 3D-модель вместо встроенной: имя файла из packages/ui/public/models.
   * null — рисуем встроенной геометрией. Хранится именно имя файла, а не путь:
   * проект должен открываться на другой машине, где папка лежит иначе.
   */
  modelFile: string | null;
  /** Множитель размера модели поверх подгонки под габарит элемента. */
  modelScale: number;
}

/** Умолчания дополнительных свойств чаши — подмешиваются во всех местах создания. */
export const BOWL_DEFAULTS = {
  modelFile: null as string | null,
  modelScale: 1,
  elevationM: 0,
  waterDepthM: 0.25,
  cornerRadiusM: 0,
  wallThicknessM: 0.15,
  rimColor: '#6b6f75',
  rimTexture: null as string | null,
  rimTileM: 0.5,
  spilloverBulgeM: 0.03,
  showRim: true,
  showWater: true,
  showFloor: true,
  spillover: false,
  spilloverDropM: 0.6,
};

/** Тип форсунки — задаёт форму струи и умолчания физики. */
export type NozzleKind =
  | 'straight' // прямая струя
  | 'fan' // веер
  | 'canopy' // шатёр
  | 'flower' // цветок
  | 'veil' // вуаль (плёнка)
  | 'mist' // туман / рассеивающая
  | 'foam' // пенная
  | 'laminar' // ламинарная
  | 'rotating' // вращающаяся: сопло крутится на месте вокруг своей оси
  | 'orbit' // моторная по окружности: сопло ЕДЕТ по кругу вокруг центра
  | 'variable'; // вариативная: конус раскрывается/собирается, два насоса

export const NOZZLE_KINDS: { id: NozzleKind; label: string }[] = [
  { id: 'straight', label: 'Прямая струя' },
  { id: 'fan', label: 'Веер' },
  { id: 'canopy', label: 'Шатёр' },
  { id: 'flower', label: 'Цветок' },
  { id: 'veil', label: 'Вуаль' },
  { id: 'mist', label: 'Туман' },
  { id: 'foam', label: 'Пенная' },
  { id: 'laminar', label: 'Ламинарная' },
  { id: 'rotating', label: 'Вращающаяся' },
  { id: 'orbit', label: 'Моторная' },
  { id: 'variable', label: 'Вариативная' },
];

export interface Nozzle {
  id: string;
  name: string;
  kind: NozzleKind;
  /** Позиция сопла, м (z — над уровнем воды). */
  x: number;
  y: number;
  z: number;
  /** Наклон от вертикали, градусы (0 — вверх). */
  tiltDeg: number;
  /** Азимут наклона, градусы (0 — вдоль +X, против часовой). */
  headingDeg: number;
  /** Высота струи при значении 255, м. */
  maxHeightM: number;
  /** Диаметр струи у сопла, м — толщина у основания (§27 доработки, п.12). */
  widthM: number;
  /** Угол раскрытия конуса, ° — только kind='variable' (двухнасосная). */
  coneAngleDeg: number;
  /** Скорость вращения направления, °/с — только kind='rotating'. */
  rotationSpeedDegPerSec: number;
  /**
   * Радиус объезда для моторной насадки, м.
   *
   * У «вращающейся» крутится только НАПРАВЛЕНИЕ сопла — само оно стоит на
   * месте. У моторной сопло физически едет по окружности этого радиуса вокруг
   * точки установки: привод возит каретку по кольцевой направляющей. Ноль —
   * объезда нет, насадка ведёт себя как вращающаяся.
   */
  orbitRadiusM?: number;
  /**
   * Сколько сопел на одном приводе, шт.
   *
   * Вращающиеся и моторные насадки почти всегда ставят кустом по 3–5 штук на
   * ОДИН насос: и вода одна, и адрес один. Поэтому это не разные форсунки в
   * схеме, а одна запись с числом сопел — они раскладываются по кругу ровно,
   * с равными углами между собой.
   */
  jetCount?: number;
  /**
   * Направление вращения: против часовой стрелки.
   *
   * Отдельным признаком, а не знаком скорости: «минус 40 градусов в секунду»
   * читается как ошибка ввода, а галочка «против часовой» — как настройка.
   * Скорость при этом всегда положительная.
   */
  spinCcw?: boolean;
  /**
   * Сопло ДИНАМИЧЕСКОЕ: доворачивается вслед за кареткой (моторная насадка).
   *
   * Динамическое закреплено по радиусу кольца, и при объезде его азимут меняется
   * вместе с положением — получается бегущий по кругу веер. Наклон при этом
   * любой: сопло может смотреть и наружу от центра, и внутрь, к нему.
   *
   * Статичное зафиксировано жёстко: при объезде меняется только место, а бьёт
   * оно всё время в одну сторону. На объекте встречается и так, и так, поэтому
   * выбор явный.
   */
  orbitFaceOut?: boolean;
  /**
   * Насколько струя распыляется к концу: 0 — почти не распадается (стеклянный
   * шнур), 1 — расходится пеной и брызгами. Это не то же самое, что диаметр:
   * при одной толщине одна насадка бьёт плотным столбом, другая — облаком.
   * У каждого типа свой допустимый диапазон (см. SPRAY_RANGE): пенная не
   * бывает совсем без пены, ламинарная — с обильной.
   */
  sprayFactor: number;
  /** Инерция давления: время разгона и спада (фильтр 1-го порядка), мс. */
  riseMs: number;
  fallMs: number;
  /** Насос (канал intensity) — производительность струи. null — не привязан. */
  pumpDeviceId: string | null;
  /** Второй насос — только kind='variable' (раскрытие конуса своим напором). null — не привязан. */
  pump2DeviceId: string | null;
  /** Клапан (0/255) — отсечение струи. null — клапана нет. */
  valveDeviceId: string | null;
  /**
   * Своя 3D-модель вместо встроенной: имя файла из packages/ui/public/models.
   * null — рисуем встроенной геометрией. Хранится именно имя файла, а не путь:
   * проект должен открываться на другой машине, где папка лежит иначе.
   */
  modelFile: string | null;
  /** Множитель размера модели поверх подгонки под габарит элемента. */
  modelScale: number;
  /** Прожектор, подсвечивающий эту струю (цвет частиц). */
  lightDeviceId: string | null;
  /**
   * Дополнительные устройства сверх основных. На объекте одну форсунку нередко
   * питают два и более насоса, а подсвечивают несколько светильников — одной
   * привязки на роль не хватает. Основные поля выше остались как есть (они
   * задают «главное» устройство роли и на них завязаны генераторы и физика
   * струи), а сюда добавляется всё остальное той же роли.
   *
   * pump2DeviceId в этот счёт не входит: у вариативной форсунки это не «ещё
   * один насос подачи», а отдельный орган управления — раскрытие конуса.
   */
  extraPumpDeviceIds: string[];
  extraValveDeviceIds: string[];
  extraLightDeviceIds: string[];
  /**
   * Дополнительные насосы раскрытия конуса у вариативной форсунки. Роль редкая,
   * но правило одно на все привязки: раз добавлять второе устройство можно
   * везде, то и здесь тоже — иначе непонятно, почему у одной строки «+» есть,
   * а у соседней нет.
   */
  extraPump2DeviceIds: string[];
}

/** Все насосы раскрытия конуса (только kind='variable'). */
export function nozzlePump2Ids(n: Nozzle): string[] {
  return [n.pump2DeviceId, ...(n.extraPump2DeviceIds ?? [])].filter((id): id is string => !!id);
}

/** Все насосы подачи форсунки: основной плюс добавленные (без насоса раскрытия конуса). */
export function nozzlePumpIds(n: Nozzle): string[] {
  return [n.pumpDeviceId, ...(n.extraPumpDeviceIds ?? [])].filter((id): id is string => !!id);
}

/** Все клапаны форсунки. */
export function nozzleValveIds(n: Nozzle): string[] {
  return [n.valveDeviceId, ...(n.extraValveDeviceIds ?? [])].filter((id): id is string => !!id);
}

/** Все светильники, подсвечивающие эту струю. */
export function nozzleLightIds(n: Nozzle): string[] {
  return [n.lightDeviceId, ...(n.extraLightDeviceIds ?? [])].filter((id): id is string => !!id);
}

/** Прожектор на схеме (сам светильник; цвет — из устройства патча). */
export interface LayoutLight {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  deviceId: string | null;
  /**
   * Куда светит: наклон от вертикали и азимут — теми же углами, что у форсунки,
   * чтобы не заводить второй способ задавать направление. Наклон 0 — строго
   * вверх, 90 — горизонтально, 180 — вниз; азимут 0..360. Вместе это даёт любое
   * направление в пространстве. У форсунки наклон ограничен 85° намеренно —
   * струя вниз физически бессмысленна, а прожектор светит куда угодно.
   */
  tiltDeg: number;
  headingDeg: number;
  /** Угол раскрытия луча, ° (полный конус). */
  beamAngleDeg: number;
  /** Дальность луча при полной яркости, м; яркость канала укорачивает его пропорционально. */
  rangeM: number;
  /** Габарит корпуса, м (диаметр). Подводные бывают от 60 мм до 300 мм. */
  sizeM: number;
  /**
   * Насколько плотно виден сам луч, 0..1 — это про КАРТИНКУ, а не про прибор.
   * Яркость свечения задаёт DMX-канал, а здесь задаётся, сколько «дымки» в
   * воздухе: в сухом воздухе луча почти не видно, в мороси он читается столбом.
   * 0 — луч не рисовать вовсе, оставить только светящуюся линзу.
   */
  beamDensity: number;
  /**
   * Своя 3D-модель вместо встроенной: имя файла из packages/ui/public/models.
   * null — рисуем встроенной геометрией. Хранится именно имя файла, а не путь:
   * проект должен открываться на другой машине, где папка лежит иначе.
   */
  modelFile: string | null;
  /** Множитель размера модели поверх подгонки под габарит элемента. */
  modelScale: number;
}

/**
 * Допустимый разброс распыления по типам: [минимум, максимум, умолчание].
 * Диапазоны разные, потому что типы отличаются не только толщиной струи —
 * пенная насадка физически не может выдать стеклянный шнур, а ламинарная
 * тем и ценна, что почти не пылит.
 */
export const SPRAY_RANGE: Record<NozzleKind, [number, number, number]> = {
  straight: [0.05, 0.7, 0.3],
  laminar: [0, 0.2, 0.05],
  fan: [0.2, 0.9, 0.5],
  canopy: [0.15, 0.8, 0.4],
  flower: [0.15, 0.8, 0.4],
  veil: [0.2, 0.9, 0.5],
  mist: [0.6, 1, 0.9],
  // Пенная: нижний порог опущен с 0.5 — на 0.5 она брызгала во все стороны
  // даже в самом «собранном» положении. Совсем без пены она всё равно не
  // бывает, но 0.2 даёт плотный кипящий столб вместо облака брызг.
  foam: [0.2, 1, 0.5],
  rotating: [0.1, 0.7, 0.35],
  // Моторная — та же прямая струя: её отличает путь по кольцу, а не распыл.
  orbit: [0.05, 0.7, 0.3],
  // Вариативная в собранном положении — та же прямая: и распыл тот же.
  variable: [0.05, 0.7, 0.3],
};

/** Приводит распыление к допустимому для типа диапазону. */
export function clampSpray(kind: NozzleKind, v: number): number {
  const [lo, hi] = SPRAY_RANGE[kind];
  return Math.min(hi, Math.max(lo, v));
}

/** Умолчания прожектора — узкий конус вверх на 6 м, как у типового подводного. */
export const LIGHT_DEFAULTS = {
  tiltDeg: 0,
  headingDeg: 0,
  beamAngleDeg: 25,
  rangeM: 6,
  sizeM: 0.16,
  beamDensity: 0.32,
  modelFile: null as string | null,
  modelScale: 1,
};

/**
 * Контур (§27 доработки, по примеру прежнего приложения) — именованная
 * группа форсунок как живой объект: в отличие от Мастера нового объекта
 * (разовый штамп при создании), группа хранится и позволяет вернуться и
 * разом повернуть/сдвинуть/перекрасить весь набор форсунок позже.
 */
export interface NozzleGroup {
  id: string;
  name: string;
  nozzleIds: string[];
  /**
   * Прожекторы контура. Подсветка ставится по той же дуге, что и форсунки, и
   * крутить её отдельно от них бессмысленно — поэтому они входят в контур
   * наравне с насадками.
   */
  lightIds: string[];
  /**
   * Текущий угол поворота контура, °. Хранится, чтобы поле в свойствах
   * показывало абсолютный угол и крутило разницу: иначе «повернуть на 15°»
   * надо было бы нажимать кнопкой, а число в поле ничего не значило бы.
   */
  rotationDeg: number;
  /**
   * Накопленный сдвиг контура, м. Хранится по той же причине, что и угол:
   * поля показывают, НА СКОЛЬКО контур уже сдвинут от исходного места, а
   * двигается он на разницу — поэтому кнопка «Сдвинуть» не нужна.
   */
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

export interface FountainLayout {
  bowls: Bowl[];
  nozzles: Nozzle[];
  lights: LayoutLight[];
  nozzleGroups: NozzleGroup[];
}

export function emptyLayout(): FountainLayout {
  return { bowls: [], nozzles: [], lights: [], nozzleGroups: [] };
}

/** Центр (среднее X/Y) форсунок группы — точка вращения для rotateNozzleGroup. */
export function nozzleGroupCentroid(
  nozzles: Nozzle[],
  nozzleIds: string[],
  lights: LayoutLight[] = [],
  lightIds: string[] = [],
): { x: number; y: number } {
  const pts: { x: number; y: number }[] = [
    ...nozzles.filter((n) => nozzleIds.includes(n.id)),
    ...lights.filter((l) => lightIds.includes(l.id)),
  ];
  if (pts.length === 0) return { x: 0, y: 0 };
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

/**
 * Поворот и сдвиг всего контура — форсунок и прожекторов вместе, вокруг общего
 * центра. Отдельные функции только для форсунок оставлены ниже: ими пользуется
 * временное выделение, где прожекторов не бывает.
 */
export function rotateGroup(
  layout: FountainLayout,
  nozzleIds: string[],
  lightIds: string[],
  angleDeg: number,
): { nozzles: Nozzle[]; lights: LayoutLight[] } {
  const { x: cx, y: cy } = nozzleGroupCentroid(layout.nozzles, nozzleIds, layout.lights, lightIds);
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const spin = <T extends { x: number; y: number; headingDeg: number }>(o: T): T => ({
    ...o,
    x: Math.round((cx + (o.x - cx) * cos - (o.y - cy) * sin) * 1000) / 1000,
    y: Math.round((cy + (o.x - cx) * sin + (o.y - cy) * cos) * 1000) / 1000,
    headingDeg: (((o.headingDeg + angleDeg) % 360) + 360) % 360,
  });
  return {
    nozzles: layout.nozzles.map((n) => (nozzleIds.includes(n.id) ? spin(n) : n)),
    lights: layout.lights.map((l) => (lightIds.includes(l.id) ? spin(l) : l)),
  };
}

/** Сдвиг всего контура — форсунок и прожекторов вместе. */
export function translateGroup(
  layout: FountainLayout,
  nozzleIds: string[],
  lightIds: string[],
  dx: number,
  dy: number,
  dz = 0,
): { nozzles: Nozzle[]; lights: LayoutLight[] } {
  const move = <T extends { x: number; y: number; z: number }>(o: T): T => ({
    ...o,
    x: Math.round((o.x + dx) * 1000) / 1000,
    y: Math.round((o.y + dy) * 1000) / 1000,
    z: Math.round((o.z + dz) * 1000) / 1000,
  });
  return {
    nozzles: layout.nozzles.map((n) => (nozzleIds.includes(n.id) ? move(n) : n)),
    lights: layout.lights.map((l) => (lightIds.includes(l.id) ? move(l) : l)),
  };
}

/** Поворачивает форсунки группы на angleDeg (против часовой) вокруг их центра — позиция и азимут (headingDeg). */
export function rotateNozzleGroup(nozzles: Nozzle[], nozzleIds: string[], angleDeg: number): Nozzle[] {
  const { x: cx, y: cy } = nozzleGroupCentroid(nozzles, nozzleIds);
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return nozzles.map((n) => {
    if (!nozzleIds.includes(n.id)) return n;
    const dx = n.x - cx;
    const dy = n.y - cy;
    return {
      ...n,
      x: Math.round((cx + dx * cos - dy * sin) * 1000) / 1000,
      y: Math.round((cy + dx * sin + dy * cos) * 1000) / 1000,
      headingDeg: ((n.headingDeg + angleDeg) % 360 + 360) % 360,
    };
  });
}

/** Сдвигает форсунки группы на (dx,dy). */
export function translateNozzleGroup(nozzles: Nozzle[], nozzleIds: string[], dx: number, dy: number): Nozzle[] {
  return nozzles.map((n) =>
    nozzleIds.includes(n.id)
      ? { ...n, x: Math.round((n.x + dx) * 1000) / 1000, y: Math.round((n.y + dy) * 1000) / 1000 }
      : n,
  );
}

/**
 * Умолчания физики струи по типу форсунки.
 *
 * Высоты и диаметры сопла — средние значения каталогов архитектурных фонтанов
 * (Safe-Rain: пенная «cascade» 0,5–14 м, распыляющая «spraying jet» 1–11,5 м с
 * каплей не крупнее 1 мм; прямые струи в коммерческих сериях до 30 м, в
 * типовом городском фонтане 4–8 м). Взяты именно средние: с них удобно
 * начинать, а не с краёв диапазона.
 *
 * riseMs — разгон НАПОРА до полного, то есть инерция водяного столба: давление
 * линии толкает воду в стояке снизу, и на разгон нужно время. Это не время
 * полёта струи (полёт считается баллистикой отдельно) и не ход клапана. Именно
 * поэтому короткое открытие клапана — меньше riseMs — до полной высоты не
 * добивает: вода выходит ещё не на полной скорости.
 *
 * fallMs — выбег НАСОСА. На спаде клапан свой: он воду режет, а не выбегает,
 * поэтому при закрытии действует VALVE_RESPONSE_MS, а не fallMs — на этом и
 * держатся резкие выстрелы и «подбивы» на разогнанном насосе.
 */
export function nozzleDefaults(
  kind: NozzleKind,
): {
  maxHeightM: number;
  riseMs: number;
  fallMs: number;
  widthM: number;
  coneAngleDeg: number;
  rotationSpeedDegPerSec: number;
  /**
   * Радиус объезда для моторной насадки, м.
   *
   * У «вращающейся» крутится только НАПРАВЛЕНИЕ сопла — само оно стоит на
   * месте. У моторной сопло физически едет по окружности этого радиуса вокруг
   * точки установки: привод возит каретку по кольцевой направляющей. Ноль —
   * объезда нет, насадка ведёт себя как вращающаяся.
   */
  orbitRadiusM?: number;
  /**
   * Сколько сопел на одном приводе, шт.
   *
   * Вращающиеся и моторные насадки почти всегда ставят кустом по 3–5 штук на
   * ОДИН насос: и вода одна, и адрес один. Поэтому это не разные форсунки в
   * схеме, а одна запись с числом сопел — они раскладываются по кругу ровно,
   * с равными углами между собой.
   */
  jetCount?: number;
  /**
   * Направление вращения: против часовой стрелки.
   *
   * Отдельным признаком, а не знаком скорости: «минус 40 градусов в секунду»
   * читается как ошибка ввода, а галочка «против часовой» — как настройка.
   * Скорость при этом всегда положительная.
   */
  spinCcw?: boolean;
  /**
   * Сопло ДИНАМИЧЕСКОЕ: доворачивается вслед за кареткой (моторная насадка).
   *
   * Динамическое закреплено по радиусу кольца, и при объезде его азимут меняется
   * вместе с положением — получается бегущий по кругу веер. Наклон при этом
   * любой: сопло может смотреть и наружу от центра, и внутрь, к нему.
   *
   * Статичное зафиксировано жёстко: при объезде меняется только место, а бьёт
   * оно всё время в одну сторону. На объекте встречается и так, и так, поэтому
   * выбор явный.
   */
  orbitFaceOut?: boolean;
  sprayFactor: number;
  modelFile: string | null;
  modelScale: number;
} {
  const extra = {
    /**
     * Диаметр сопла по умолчанию — 20 мм у ВСЕХ типов. При 8–10 мм струя в 3D
     * выглядела скудной ниткой; 20 мм — ходовой размер городских насадок, и
     * с него удобнее начинать, подгоняя уже под конкретную форсунку.
     */
    widthM: 0.02,
    coneAngleDeg: 25,
    rotationSpeedDegPerSec: 60,
    orbitRadiusM: 0,
    jetCount: 1,
    spinCcw: false,
    orbitFaceOut: true,
    sprayFactor: SPRAY_RANGE[kind][2],
    modelFile: null as string | null,
    modelScale: 1,
  };
  switch (kind) {
    // Пенная (cascade/frothy): широкое сопло DN25–DN50, воздух подмешивается
    // через эжектор — столб низкий и тяжёлый, привод разгоняется дольше всех.
    case 'foam':
      return { maxHeightM: 2.5, riseMs: 1000, fallMs: 1400, ...extra, widthM: 0.02 };
    // Распыляющая: широкая головка, капля до 1 мм, лёгкая — разгон быстрый.
    case 'mist':
      return { maxHeightM: 2, riseMs: 400, fallMs: 600, ...extra, widthM: 0.02 };
    case 'fan':
      return { maxHeightM: 2, riseMs: 600, fallMs: 800, ...extra, widthM: 0.02 };
    case 'veil':
      return { maxHeightM: 1, riseMs: 600, fallMs: 800, ...extra, widthM: 0.02 };
    // Ламинарная: сопло крупное (12–25 мм), скорость низкая — отсюда и
    // спокойная высота, и быстрый отклик.
    case 'laminar':
      return { maxHeightM: 3, riseMs: 500, fallMs: 700, ...extra, widthM: 0.02 };
    case 'canopy':
      return { maxHeightM: 1.2, riseMs: 600, fallMs: 800, ...extra, widthM: 0.02 };
    case 'flower':
      return { maxHeightM: 1.5, riseMs: 600, fallMs: 800, ...extra, widthM: 0.02 };
    // Вращающаяся: типовые «танцующие» головки ведут луч медленно, 10–60 °/с.
    case 'rotating':
      return { maxHeightM: 4, riseMs: 800, fallMs: 1000, ...extra, widthM: 0.02, rotationSpeedDegPerSec: 30 };
    case 'orbit':
      // Кольцо метрового радиуса и неспешный объезд — так это и ставят: круг
      // виден целиком, а струя успевает прорисоваться по всей окружности.
      return {
        maxHeightM: 3,
        riseMs: 700,
        fallMs: 900,
        ...extra,
        widthM: 0.02,
        rotationSpeedDegPerSec: 24,
        orbitRadiusM: 1,
      };
    case 'variable':
      // 60° — полный угол раскрытия, как его меряют на объекте: шире у вариативных
      // насадок практически не делают, вода начинает просто разлетаться.
      return { maxHeightM: 5, riseMs: 700, fallMs: 900, ...extra, widthM: 0.02, coneAngleDeg: 60 };
    // Прямая струя (vertical jet): в городском фонтане 4–8 м.
    default:
      return { maxHeightM: 6, riseMs: 900, fallMs: 1200, ...extra, widthM: 0.02 };
  }
}

/**
 * Фигуры расстановки форсунок.
 *
 * Кольцо было единственной фигурой, а на площадке нужны и квадратные бассейны,
 * и треугольные островки, и звезда к празднику. Сама раскладка — в figure.ts
 * (figurePoints): вершины заняты всегда, остальное по сторонам; размеры — как
 * их меряют на объекте; нумерация сверху по часовой стрелке.
 */
export type LayoutShape = 'ring' | 'square' | 'rect' | 'triangle' | 'star';

export const LAYOUT_SHAPES: {
  id: LayoutShape;
  label: string;
  /**
   * Меньше этого числа раскладывать по фигуре нечего.
   *
   * У кольца это ОДНА форсунка: по кругу встаёт любое количество, и запрещать
   * тут нечего — две дают линию, три треугольник, четыре квадрат, и всё это
   * рабочие расстановки. У фигур с углами предел равен числу сторон: меньше — и
   * от фигуры остаётся часть периметра, а не фигура.
   */
  min: number;
  /** Числа, на которых форсунки попадают точно на вершины и середины сторон. */
  nice: number[];
}[] = [
  { id: 'ring', label: 'Кольцо', min: 1, nice: [8, 12, 16, 24] },
  { id: 'square', label: 'Квадрат', min: 4, nice: [4, 8, 12, 16] },
  { id: 'rect', label: 'Прямоугольник', min: 4, nice: [4, 6, 8, 12] },
  { id: 'triangle', label: 'Треугольник', min: 3, nice: [3, 6, 9, 12] },
  { id: 'star', label: 'Звезда', min: 10, nice: [10, 20, 30, 40] },
];

/** Ближайшее «хорошее» число для фигуры — им подсказываем в интерфейсе. */
export function snapShapeCount(shape: LayoutShape, count: number): number {
  const def = LAYOUT_SHAPES.find((s) => s.id === shape)!;
  const n = Math.max(def.min, Math.round(count));
  if (shape === 'ring') return n;
  const step = shape === 'star' ? 10 : shape === 'triangle' ? 3 : 4;
  return Math.max(def.min, Math.round(n / step) * step);
}

/** Позиции по кольцу (генератор расстановки): count точек радиуса radius вокруг центра. */
export function ringPositions(
  count: number,
  radius: number,
  centerX = 0,
  centerY = 0,
  startDeg = 0,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const a = ((startDeg + (360 * i) / count) * Math.PI) / 180;
    out.push({ x: centerX + radius * Math.cos(a), y: centerY + radius * Math.sin(a) });
  }
  return out;
}

/** Позиции по отрезку от (x1,y1) до (x2,y2) включительно. */
export function linePositions(
  count: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    out.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
  }
  return out;
}

const num = (v: unknown, def: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Ссылка на устройство: сохраняется, только если устройство существует в патче. */
const devRef = (v: unknown, deviceIds: Set<string>): string | null =>
  typeof v === 'string' && deviceIds.has(v) ? v : null;

/** То же для списка: оставляем только живые ссылки, без дублей. */
const devRefList = (v: unknown, deviceIds: Set<string>): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string' && deviceIds.has(x)))]
    : [];

/**
 * Имя файла своей 3D-модели: только имя, без путей и подъёма по дереву. В
 * проекте это обычный текст, который правят руками, а попадает он прямо в
 * адрес загрузки — пускать туда «../» нельзя.
 */
const modelRef = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.includes('/') || s.includes('\\') || s.includes('..')) return null;
  return /\.(glb|gltf)$/i.test(s) ? s : null;
};

/** Приводит произвольный JSON к корректной схеме (битые элементы отбрасываются). */
export function sanitizeLayout(raw: unknown, deviceIds: Set<string>): FountainLayout {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const layout = emptyLayout();
  if (Array.isArray(r.bowls)) {
    for (const b of r.bowls as Bowl[]) {
      if (!b || typeof b.id !== 'string') continue;
      layout.bowls.push({
        id: b.id,
        name: typeof b.name === 'string' ? b.name : 'Чаша',
        shape: b.shape === 'rect' ? 'rect' : 'circle',
        x: round3(num(b.x, 0, -1000, 1000)),
        y: round3(num(b.y, 0, -1000, 1000)),
        radius: round3(num(b.radius, 5, 0.1, 500)),
        width: round3(num(b.width, 10, 0.1, 1000)),
        length: round3(num(b.length, 6, 0.1, 1000)),
        height: round3(num(b.height, 0.3, 0, 5)),
        wallThicknessM: round3(num(b.wallThicknessM, 0.15, 0.01, 5)),
        rimColor: typeof b.rimColor === 'string' && /^#[0-9a-f]{6}$/i.test(b.rimColor) ? b.rimColor : '#6b6f75',
        // Только картинка, вложенная в проект; ссылки на чужие адреса не принимаем.
        rimTexture: typeof b.rimTexture === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(b.rimTexture) ? b.rimTexture : null,
        rimTileM: round3(num(b.rimTileM, 0.5, 0.05, 20)),
        elevationM: round3(num(b.elevationM, 0, -20, 50)),
        waterDepthM: round3(num(b.waterDepthM, 0.25, 0, 5)),
        cornerRadiusM: round3(num(b.cornerRadiusM, 0, 0, 50)),
        showRim: b.showRim !== false,
        showWater: b.showWater !== false,
        showFloor: b.showFloor !== false,
        spillover: b.spillover === true,
        spilloverDropM: round3(num(b.spilloverDropM, 0.6, 0.02, 20)),
        spilloverBulgeM: round3(num(b.spilloverBulgeM, 0.03, 0, 0.3)),
        modelFile: modelRef(b.modelFile),
        modelScale: round3(num(b.modelScale, 1, 0.05, 20)),
      });
    }
  }
  const kinds = new Set(NOZZLE_KINDS.map((k) => k.id));
  if (Array.isArray(r.nozzles)) {
    for (const n of r.nozzles as Nozzle[]) {
      if (!n || typeof n.id !== 'string') continue;
      const kind = kinds.has(n.kind) ? n.kind : 'straight';
      const def = nozzleDefaults(kind);
      layout.nozzles.push({
        id: n.id,
        name: typeof n.name === 'string' ? n.name : 'Форсунка',
        kind,
        x: round3(num(n.x, 0, -1000, 1000)),
        y: round3(num(n.y, 0, -1000, 1000)),
        z: round3(num(n.z, 0, -10, 50)),
        // Наклон в обе стороны: наружу от центра и внутрь, к нему.
        tiltDeg: round3(num(n.tiltDeg, 0, -90, 90)),
        headingDeg: round3(num(n.headingDeg, 0, 0, 360)),
        maxHeightM: round3(num(n.maxHeightM, def.maxHeightM, 0.1, 100)),
        widthM: round3(num(n.widthM, def.widthM, 0.005, 2)),
        coneAngleDeg: round3(num(n.coneAngleDeg, def.coneAngleDeg, 1, 90)),
        // Сторона вращения — отдельным признаком (spinCcw), поэтому сама
        // скорость только положительная. Старые проекты с отрицательной
        // скоростью читаются: знак переносится в признак ниже.
        rotationSpeedDegPerSec: Math.abs(
          round3(num(n.rotationSpeedDegPerSec, def.rotationSpeedDegPerSec, -720, 720)),
        ),
        spinCcw: n.spinCcw === true || num(n.rotationSpeedDegPerSec, 0, -720, 720) < 0,
        orbitRadiusM: round3(num(n.orbitRadiusM, def.orbitRadiusM ?? 0, 0, 50)),
        jetCount: Math.round(num(n.jetCount, def.jetCount ?? 1, 1, 20)),
        orbitFaceOut: n.orbitFaceOut !== false,
        sprayFactor: clampSpray(kind, num(n.sprayFactor, def.sprayFactor, 0, 1)),
        riseMs: Math.round(num(n.riseMs, def.riseMs, 0, 60000)),
        fallMs: Math.round(num(n.fallMs, def.fallMs, 0, 60000)),
        pumpDeviceId: devRef(n.pumpDeviceId, deviceIds),
        pump2DeviceId: devRef(n.pump2DeviceId, deviceIds),
        valveDeviceId: devRef(n.valveDeviceId, deviceIds),
        lightDeviceId: devRef(n.lightDeviceId, deviceIds),
        // Списки чистим так же, как одиночные ссылки: удалённое из патча
        // устройство не должно остаться висеть в схеме. Старые проекты полей
        // не имеют — читаются как пустые списки, поведение не меняется.
        extraPumpDeviceIds: devRefList(n.extraPumpDeviceIds, deviceIds),
        extraValveDeviceIds: devRefList(n.extraValveDeviceIds, deviceIds),
        extraLightDeviceIds: devRefList(n.extraLightDeviceIds, deviceIds),
        extraPump2DeviceIds: devRefList(n.extraPump2DeviceIds, deviceIds),
        modelFile: modelRef(n.modelFile),
        modelScale: round3(num(n.modelScale, 1, 0.05, 20)),
      });
    }
  }
  if (Array.isArray(r.lights)) {
    for (const l of r.lights as LayoutLight[]) {
      if (!l || typeof l.id !== 'string') continue;
      layout.lights.push({
        id: l.id,
        name: typeof l.name === 'string' ? l.name : 'Прожектор',
        x: round3(num(l.x, 0, -1000, 1000)),
        y: round3(num(l.y, 0, -1000, 1000)),
        z: round3(num(l.z, 0, -10, 50)),
        deviceId: devRef(l.deviceId, deviceIds),
        tiltDeg: round3(num(l.tiltDeg, LIGHT_DEFAULTS.tiltDeg, 0, 180)),
        headingDeg: round3(num(l.headingDeg, LIGHT_DEFAULTS.headingDeg, 0, 360)),
        beamAngleDeg: round3(num(l.beamAngleDeg, LIGHT_DEFAULTS.beamAngleDeg, 1, 170)),
        rangeM: round3(num(l.rangeM, LIGHT_DEFAULTS.rangeM, 0.1, 100)),
        sizeM: round3(num(l.sizeM, LIGHT_DEFAULTS.sizeM, 0.03, 1)),
        beamDensity: round3(num(l.beamDensity, LIGHT_DEFAULTS.beamDensity, 0, 1)),
        modelFile: modelRef(l.modelFile),
        modelScale: round3(num(l.modelScale, 1, 0.05, 20)),
      });
    }
  }
  const nozzleIds = new Set(layout.nozzles.map((n) => n.id));
  const lightIdSet = new Set(layout.lights.map((l) => l.id));
  if (Array.isArray(r.nozzleGroups)) {
    for (const g of r.nozzleGroups as NozzleGroup[]) {
      if (!g || typeof g.id !== 'string') continue;
      layout.nozzleGroups.push({
        id: g.id,
        name: typeof g.name === 'string' ? g.name : 'Контур',
        nozzleIds: Array.isArray(g.nozzleIds)
          ? [...new Set(g.nozzleIds.filter((id): id is string => typeof id === 'string' && nozzleIds.has(id)))]
          : [],
        lightIds: Array.isArray(g.lightIds)
          ? [...new Set(g.lightIds.filter((id): id is string => typeof id === 'string' && lightIdSet.has(id)))]
          : [],
        rotationDeg: round3(num(g.rotationDeg, 0, -3600, 3600)),
        offsetX: round3(num(g.offsetX, 0, -1000, 1000)),
        offsetY: round3(num(g.offsetY, 0, -1000, 1000)),
        offsetZ: round3(num(g.offsetZ, 0, -100, 100)),
      });
    }
  }
  return layout;
}
