/**
 * Живые кадры DMX — МИМО React.
 *
 * От какой грабли. Кадры приходят от движка десять раз в секунду по каждой
 * вселенной, и раньше каждый кадр писался в состояние React. Это перерисовывало
 * всё приложение: на «Отладке» — заново все фейдеры (на объекте их до 512 на
 * вселенную), и каждый фейдер ещё и сам крутил свой requestAnimationFrame со
 * setState на каждом шаге сглаживания. На объекте с парой сотен приборов
 * получались десятки тысяч перерисовок в секунду: ползунок ехал за пальцем
 * рывками, тест-генераторы дёргались, а через несколько минут окно переставало
 * отвечать вовсе.
 *
 * Как теперь. Кадры складываются в обычные массивы, а не в состояние React.
 * Тому, кто показывает живые значения (фейдер, 3D), даётся подписка: один общий
 * requestAnimationFrame на страницу вызывает всех подписчиков, и они пишут
 * ПРЯМО В DOM — высоту полосы и цифру. React в этом не участвует и ничего не
 * перерисовывает.
 *
 * Такт крутится только когда есть что двигать: подписчик возвращает true, пока
 * его значение ещё догоняет цель. Значения устоялись — такт останавливается и
 * просыпается на следующем кадре от движка (push) или от нажатия (wake).
 */

/** Кадр каждой вселенной: id → 512 байт. Объекты те же самые, меняется содержимое. */
export type Frames = Record<number, Uint8Array>;

/** Подписчик: рисует своё значение и возвращает true, пока ещё двигается. */
export type FrameSubscriber = () => boolean;

const logical: Frames = {};
const wire: Frames = {};
const subs = new Set<FrameSubscriber>();
/** Пришли новые данные (или кто-то разбудил) — нужен ещё хотя бы один такт. */
let dirty = false;
let raf = 0;

function schedule(): void {
  if (raf !== 0 || subs.size === 0) return;
  raf = requestAnimationFrame(tick);
}

function tick(): void {
  raf = 0;
  dirty = false;
  let moving = false;
  for (const fn of subs) {
    // Ошибка одного подписчика не должна ронять остальных: на «Отладке» их
    // сотни, и упавший такт остановил бы показ всем сразу.
    try {
      if (fn()) moving = true;
    } catch (err) {
      console.error('[frameBus] подписчик кадров упал:', err);
    }
  }
  if (moving || dirty) schedule();
}

export const frameBus = {
  /** Расчётные кадры (адреса проекта) — по ним работают фейдеры и отладка. */
  logical,
  /** Кадры ЛИНИИ (после переадресации) — по ним рисуется 3D: там объект, а не расчёт. */
  wire,

  /** Новый кадр от движка. */
  push(universe: number, data: Uint8Array, wireData: Uint8Array): void {
    logical[universe] = data;
    wire[universe] = wireData;
    dirty = true;
    schedule();
  },

  /** Значение адреса (1…512) расчётного кадра. */
  value(universe: number | null, channel: number): number {
    if (universe === null) return 0;
    return logical[universe]?.[channel - 1] ?? 0;
  },

  /** Разбудить такт: нажали на фейдер, а данных от движка ещё не было. */
  wake(): void {
    dirty = true;
    schedule();
  },

  subscribe(fn: FrameSubscriber): () => void {
    subs.add(fn);
    dirty = true;
    schedule();
    return () => {
      subs.delete(fn);
    };
  },

  /** Сменился объект или список вселенных — старые кадры больше не про этот фонтан. */
  reset(): void {
    for (const key of Object.keys(logical)) delete logical[Number(key)];
    for (const key of Object.keys(wire)) delete wire[Number(key)];
    dirty = true;
    schedule();
  },
};
