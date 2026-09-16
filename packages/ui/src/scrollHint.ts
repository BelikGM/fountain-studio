/**
 * Полоса прокрутки: видна только когда ею пользуются, и нарисована как струя.
 *
 * Постоянная полоса занимает место всегда, а нужна секунду в минуту: на узкой
 * колонке 3D-схемы из-за неё переставала помещаться даже строка поиска. Поэтому
 * струя проявляется, пока область крутят или над ней стоит курсор, и гаснет
 * через полсекунды.
 *
 * ПОЧЕМУ КАНВА, А НЕ CSS. Бегунок, собранный из градиентов в
 * ::-webkit-scrollbar-thumb, выглядел толстой крашеной палкой: в фоне
 * псевдоэлемента нет ни размытия, ни сотен мелких капель разной яркости, ни
 * облака мороси — каждая капля там отдельный слой, и уже на полусотне всё
 * начинает тормозить. Настоящая струя — тонкий бледный шнур в россыпи брызг,
 * и нарисовать её можно только по-настоящему, на канве.
 *
 * При этом сама полоса остаётся РОДНОЙ: Chromium рисует прозрачный бегунок, и
 * за него так же тянут мышью, щёлкают по дорожке, крутят колесо. Канва лежит
 * поверх всего экрана, мышь сквозь неё проходит (pointer-events: none), а
 * струю она рисует ровно там, где сейчас стоит невидимый бегунок. Место
 * считается той же формулой, что у Chromium, — сверено по пикселям: длина =
 * доля видимого × длина дорожки, но не меньше min-height; отступ = (дорожка −
 * длина) × доля прокрутки с отбрасыванием дробной части.
 *
 * Цвет — указатель места: сверху красный, дальше через жёлтый, зелёный,
 * голубой и синий к фиолетовому внизу. Струя светится этим цветом в полную
 * силу, как подсвеченная прожектором вода в 3D-виде; сопло остаётся серым.
 *
 * Слушатели вешаются ОДИН раз на документ, в фазе перехвата: так они работают
 * для любых прокручиваемых областей, включая появившиеся позже.
 */

/** Толщина полосы, px — должна совпадать с ::-webkit-scrollbar в styles.css. */
const BAR = 16;
/** Наименьшая длина бегунка, px — min-height/min-width бегунка в styles.css. */
const MIN_THUMB = 40;
/**
 * Полная яркость держится LINGER_MS, потом за FADE_MS струя тает. Вместе
 * полсекунды: полоса нужна ровно в момент прокрутки, дальше только мешает.
 */
const LINGER_MS = 300;
const FADE_MS = 200;

/** Области, которые сейчас показывают струю, → момент последнего действия, мс. */
const live = new Map<Element, number>();

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let drawn = false;

// ---------- Где бегунок ----------

interface Thumb {
  /** Левый верхний угол полосы на экране, px. */
  x: number;
  y: number;
  /** Длина бегунка вдоль полосы, px. */
  len: number;
  /** Доля прокрутки 0..1 — по ней цвет. */
  pos: number;
}

function scrollsAlong(el: Element, axis: 'y' | 'x'): boolean {
  if (el === document.scrollingElement) return true;
  const o = getComputedStyle(el)[axis === 'y' ? 'overflowY' : 'overflowX'];
  return o === 'auto' || o === 'scroll' || o === 'overlay';
}

/** Бегунок области по оси, или null — если полосы нет или бегунок не помещается. */
function thumbOf(el: Element, axis: 'y' | 'x'): Thumb | null {
  if (!scrollsAlong(el, axis)) return null;
  const isDoc = el === document.scrollingElement;
  const box = isDoc ? document.documentElement : el;
  const he = el as HTMLElement;
  const r = isDoc ? { left: 0, top: 0 } : el.getBoundingClientRect();
  if (axis === 'y') {
    // Толщина полосы — что осталось от ширины за вычетом содержимого и рамок.
    const thick = isDoc
      ? window.innerWidth - box.clientWidth
      : he.offsetWidth - el.clientWidth - el.clientLeft - (parseFloat(getComputedStyle(el).borderRightWidth) || 0);
    if (thick < BAR / 2) return null;
    const track = box.clientHeight;
    const max = el.scrollHeight - track;
    if (max <= 0.5 || track <= 0) return null;
    const len = Math.max(Math.round((track / el.scrollHeight) * track), MIN_THUMB);
    if (len > track) return null;
    const pos = Math.min(1, Math.max(0, el.scrollTop / max));
    return {
      x: r.left + box.clientLeft + box.clientWidth,
      y: r.top + box.clientTop + Math.floor((track - len) * pos),
      len,
      pos,
    };
  }
  const thick = isDoc
    ? window.innerHeight - box.clientHeight
    : he.offsetHeight - el.clientHeight - el.clientTop - (parseFloat(getComputedStyle(el).borderBottomWidth) || 0);
  if (thick < BAR / 2) return null;
  const track = box.clientWidth;
  const max = el.scrollWidth - track;
  if (max <= 0.5 || track <= 0) return null;
  const len = Math.max(Math.round((track / el.scrollWidth) * track), MIN_THUMB);
  if (len > track) return null;
  const pos = Math.min(1, Math.max(0, el.scrollLeft / max));
  return {
    x: r.left + box.clientLeft + Math.floor((track - len) * pos),
    y: r.top + box.clientTop + box.clientHeight,
    len,
    pos,
  };
}

/**
 * Видимая часть области с учётом обрезающих предков и окна.
 *
 * Без неё струя вложенного списка, частично уехавшего за край родителя,
 * рисовалась бы поверх соседних панелей: канва лежит над всем экраном и сама
 * ничего не обрезает.
 */
function clipOf(el: Element): { l: number; t: number; r: number; b: number } | null {
  let l = 0;
  let t = 0;
  let r = window.innerWidth;
  let b = window.innerHeight;
  if (el !== document.scrollingElement) {
    const own = el.getBoundingClientRect();
    l = Math.max(l, own.left);
    t = Math.max(t, own.top);
    r = Math.min(r, own.right);
    b = Math.min(b, own.bottom);
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const pr = p.getBoundingClientRect();
      l = Math.max(l, pr.left + p.clientLeft);
      t = Math.max(t, pr.top + p.clientTop);
      r = Math.min(r, pr.left + p.clientLeft + p.clientWidth);
      b = Math.min(b, pr.top + p.clientTop + p.clientHeight);
    }
  }
  return r - l > 0 && b - t > 0 ? { l, t, r, b } : null;
}

// ---------- Рисунок струи ----------

/** Детерминированный генератор: у бегунка одной длины капли всегда на тех же местах. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number): number {
  const u = Math.max(1e-6, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Высота сопла внизу бегунка, px. */
function nozzleHeight(len: number): number {
  return Math.max(5, Math.min(11, len * 0.1));
}

/** Белый с прозрачностью — рисунок идёт в «маску», цвет положения кладётся потом. */
function white(a: number): string {
  return `rgba(255,255,255,${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

/**
 * Струя в две маски — белым с прозрачностью, без цвета:
 *  - body: брызги, шапка и мягкое свечение — окрашиваются насыщенным цветом
 *    положения;
 *  - hot: светящийся стержень и самые яркие точки шапки — поверх, светлее,
 *    как раскалённая сердцевина подсвеченной струи.
 *
 * Строение — как у подсвеченной прямой струи в 3D-виде:
 *  - стержень ОДНОЙ толщины от сопла до самой шапки. Никакого сужения к верху:
 *    на форсунке оно у распадающегося цилиндра уместно, а на полосе давало
 *    некрасивую «талию» — струя худела, а потом снова раздавалась брызгами;
 *  - брызги по всей длине, кверху гуще и шире — ровным конусом от сопла;
 *  - наверху плотная шапка во всю ширину полосы, плавно продолжающая конус.
 * Прежняя бледная вода с лёгким отсветом на тёмном фоне почти не читалась:
 * цвет должен светить, а не угадываться.
 */
function paintBody(g: CanvasRenderingContext2D, len: number): void {
  const cx = BAR / 2;
  const rand = rng(len * 7919 + 17);
  const mouth = len - nozzleHeight(len);
  const capH = Math.max(10, Math.min(64, len * 0.11));
  const reach = Math.max(1, mouth - capH * 0.5);

  // Свечение вокруг стержня — ровная полоса, без сужения.
  g.filter = 'blur(2.2px)';
  const halo = g.createLinearGradient(0, mouth, 0, 0);
  halo.addColorStop(0, white(0.4));
  halo.addColorStop(1, white(0.3));
  g.fillStyle = halo;
  g.fillRect(cx - 2.6, capH * 0.4, 5.2, mouth - capH * 0.4);
  g.filter = 'none';

  // Брызги: разлёт растёт от сопла к шапке ровным конусом, плотность — тоже.
  const drops = Math.round(len * 1.5);
  for (let i = 0; i < drops; i++) {
    let k = rand();
    for (let tries = 0; tries < 6 && rand() * 1.65 > 0.35 + 1.3 * k * k; tries++) k = rand();
    const v = mouth - k * reach;
    const sigma = 0.9 + 3.0 * k;
    const off = Math.max(-7.3, Math.min(7.3, gauss(rand) * sigma));
    const rad = 0.42 + 0.55 * rand() * rand();
    g.fillStyle = white(0.5 + 0.5 * rand());
    g.beginPath();
    g.arc(cx + off, v, rad, 0, Math.PI * 2);
    g.fill();
  }

  // Шапка: мягкое пятно света и плотная россыпь во всю ширину полосы.
  g.save();
  g.filter = 'blur(2.4px)';
  g.translate(cx, capH * 0.5);
  g.scale(1, (capH * 0.55) / 6.8);
  const glow = g.createRadialGradient(0, 0, 0, 0, 0, 6.8);
  glow.addColorStop(0, white(0.75));
  glow.addColorStop(0.6, white(0.35));
  glow.addColorStop(1, white(0));
  g.fillStyle = glow;
  g.beginPath();
  g.arc(0, 0, 6.8, 0, Math.PI * 2);
  g.fill();
  g.restore();

  const dust = Math.round(capH * 9);
  for (let i = 0; i < dust; i++) {
    const dx = (rand() * 2 - 1) * 7.2;
    const dy = rand() * capH * 1.05;
    // Верх скруглён: у краёв полосы шапка начинается чуть ниже.
    const edge = Math.abs(dx) / 7.2;
    if (dy < edge * edge * capH * 0.35 + 0.6) continue;
    const rad = 0.45 + 0.5 * rand() * rand();
    g.fillStyle = white(0.55 + 0.45 * rand());
    g.beginPath();
    g.arc(cx + dx, dy, rad, 0, Math.PI * 2);
    g.fill();
  }
}

/** Светящийся стержень и яркие точки шапки — поверх брызг, светлее их. */
function paintHot(g: CanvasRenderingContext2D, len: number): void {
  const cx = BAR / 2;
  const rand = rng(len * 104729 + 3);
  const mouth = len - nozzleHeight(len);
  const capH = Math.max(10, Math.min(64, len * 0.11));

  // Стержень: 2,4 px по всей длине, до самой шапки, с мягким краем.
  g.filter = 'blur(0.6px)';
  g.fillStyle = white(1);
  g.fillRect(cx - 1.2, capH * 0.3, 2.4, mouth - capH * 0.3 + 0.5);
  g.filter = 'none';

  // Яркие искры в шапке и немного по стержню.
  const sparks = Math.round(capH * 1.6 + len * 0.08);
  for (let i = 0; i < sparks; i++) {
    const inCap = rand() < 0.75;
    const x = cx + (rand() * 2 - 1) * (inCap ? 6 : 2.2);
    const y = inCap ? 1 + rand() * capH * 0.9 : capH + rand() * (mouth - capH);
    g.fillStyle = white(0.6 + 0.4 * rand());
    g.beginPath();
    g.arc(x, y, 0.45 + 0.35 * rand(), 0, Math.PI * 2);
    g.fill();
  }
}

/**
 * Сопло — серая насадка, как корпус форсунки на схеме. Не подкрашивается:
 * цвет — у воды, а металл остаётся металлом.
 */
function paintNozzle(g: CanvasRenderingContext2D, len: number): void {
  const cx = BAR / 2;
  const h = nozzleHeight(len);
  const top = len - h;
  const w = 7;
  const body = g.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0);
  body.addColorStop(0, '#2f3439');
  body.addColorStop(0.4, '#8d949b');
  body.addColorStop(0.58, '#a9b0b6');
  body.addColorStop(1, '#3a4046');
  g.fillStyle = body;
  g.beginPath();
  g.moveTo(cx - w / 2, len);
  g.lineTo(cx - 1.7, top + 1.2);
  g.quadraticCurveTo(cx, top - 0.5, cx + 1.7, top + 1.2);
  g.lineTo(cx + w / 2, len);
  g.closePath();
  g.fill();
  // Светлый срез наверху — отделяет насадку от воды.
  g.fillStyle = 'rgba(210,216,222,0.85)';
  g.fillRect(cx - 1.5, top + 0.5, 3, 0.9);
}

const bodySprites = new Map<string, HTMLCanvasElement>();
const hotSprites = new Map<string, HTMLCanvasElement>();
const nozzleSprites = new Map<string, HTMLCanvasElement>();

function cached(
  store: Map<string, HTMLCanvasElement>,
  len: number,
  dpr: number,
  paint: (g: CanvasRenderingContext2D, len: number) => void,
): HTMLCanvasElement {
  const key = `${len}|${dpr}`;
  const hit = store.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = Math.ceil(BAR * dpr);
  c.height = Math.ceil(len * dpr);
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  paint(g, len);
  store.set(key, c);
  // Длины меняются при смене содержимого — старые рисунки не копим.
  if (store.size > 40) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  return c;
}

/** Рабочие канвы для окраски — по одной на маску, без выделений памяти в кадре. */
const tintCanvases: HTMLCanvasElement[] = [];

/** Маска, окрашенная в цвет: прозрачность от маски, цвет — сплошной. */
function colored(slot: number, mask: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const c = (tintCanvases[slot] ??= document.createElement('canvas'));
  if (c.width !== mask.width) c.width = mask.width;
  if (c.height !== mask.height) c.height = mask.height;
  const g = c.getContext('2d')!;
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, c.width, c.height);
  g.drawImage(mask, 0, 0);
  // source-atop красит только нарисованное и сохраняет его прозрачность.
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'source-over';
  return c;
}

/**
 * Цвет положения: насыщенный, светящийся. Оттенок по кругу от красного (0°)
 * до фиолетового (285°); дальше круг вернулся бы к красному, и низ списка
 * красился бы как верх.
 */
function hueOf(pos: number): number {
  return Math.round(Math.max(0, Math.min(1, pos)) * 285);
}

// ---------- Кадр ----------

function ensureCanvas(): CanvasRenderingContext2D {
  if (ctx && canvas) return ctx;
  canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '100vw',
    height: '100vh',
    pointerEvents: 'none',
    zIndex: '2147483000',
  });
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d')!;
  return ctx;
}

function frame(): void {
  raf = 0;
  const g = ensureCanvas();
  const cv = canvas!;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  } else if (drawn) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
  }
  drawn = false;
  const now = performance.now();
  for (const [el, at] of live) {
    const age = now - at;
    const alpha = age <= LINGER_MS ? 1 : 1 - (age - LINGER_MS) / FADE_MS;
    if (alpha <= 0 || !el.isConnected) {
      live.delete(el);
      continue;
    }
    const clip = clipOf(el);
    if (!clip) continue;
    for (const axis of ['y', 'x'] as const) {
      const th = thumbOf(el, axis);
      if (!th) continue;
      const hue = hueOf(th.pos);
      const bodyImg = colored(0, cached(bodySprites, th.len, dpr, paintBody), `hsl(${hue} 100% 60%)`);
      const hotImg = colored(1, cached(hotSprites, th.len, dpr, paintHot), `hsl(${hue} 100% 84%)`);
      const nozzleImg = cached(nozzleSprites, th.len, dpr, paintNozzle);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.save();
      g.beginPath();
      g.rect(clip.l, clip.t, clip.r - clip.l, clip.b - clip.t);
      g.clip();
      g.globalAlpha = alpha;
      if (axis === 'x') {
        // Лежачая полоса: сопло слева, морось справа.
        g.translate(th.x + th.len, th.y);
        g.rotate(Math.PI / 2);
      } else {
        g.translate(th.x, th.y);
      }
      g.drawImage(bodyImg, 0, 0, BAR, th.len);
      g.drawImage(hotImg, 0, 0, BAR, th.len);
      g.drawImage(nozzleImg, 0, 0, BAR, th.len);
      g.restore();
      drawn = true;
    }
  }
  if (live.size > 0) {
    raf = requestAnimationFrame(frame);
  } else if (drawn) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    drawn = false;
  }
}

function wake(el: Element): void {
  live.set(el, performance.now());
  if (!raf) raf = requestAnimationFrame(frame);
}

export function installScrollHint(): void {
  // scroll не всплывает, поэтому слушаем в фазе перехвата на документе.
  document.addEventListener(
    'scroll',
    (e) => {
      const el = e.target === document ? document.scrollingElement : e.target;
      if (el instanceof Element) wake(el);
    },
    true,
  );
  // Курсор над прокручиваемой областью — полосу тоже показываем: человек ещё
  // не крутанул, но уже целится. Берём ближайшую область, которая правда
  // прокручивается, а не просто обрезает лишнее (overflow: hidden).
  document.addEventListener(
    'mouseover',
    (e) => {
      for (let el = e.target as Element | null; el && el !== document.body; el = el.parentElement) {
        const y = el.scrollHeight - el.clientHeight > 4 && scrollsAlong(el, 'y');
        const x = el.scrollWidth - el.clientWidth > 4 && scrollsAlong(el, 'x');
        if (y || x) {
          wake(el);
          return;
        }
      }
    },
    true,
  );
}
