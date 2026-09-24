/**
 * Стрелки числовых полей — всегда ровно на шаг от того числа, что в поле.
 *
 * Заказчик 24.09.2026: «стрелка сначала прибавляет 0,1, потом 0,5». Так
 * делает сам браузер: шаг он отсчитывает от нижнего предела (min), а не от
 * числа в поле. Поле «от 0,1, шаг 0,5» у браузера ходит по сетке 0,1 — 0,6 —
 * 1,1 …, и из 3 первый шаг вверх — 3,1, дальше уже по 0,5. То же после
 * набранного руками числа не по сетке: из 3,2 вверх — 3,6 (сетка 0,1 + 0,5k).
 *
 * Полей с числами в программе под сотню, поэтому правим один раз на весь
 * документ, а не в каждом поле: клавиши ↑/↓ считаем сами, а шаг кнопками
 * поля и колёсиком поправляем до того, как значение увидит React (слушатель
 * на документе в фазе захвата срабатывает раньше обработчиков React).
 * Пределы берём из min/max самого поля.
 */

/** Сколько знаков после запятой у числа — чтобы 0,1 + 0,2 не давало 0,30000000000000004. */
function decimals(x: number): number {
  const s = String(x);
  if (s.includes('e')) return 6;
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(6, s.length - i - 1);
}

/** Число на один шаг вверх (dir = 1) или вниз (dir = −1), в пределах. */
export function stepNumber(cur: number, dir: 1 | -1, step: number, min?: number, max?: number): number {
  const f = 10 ** Math.max(decimals(step), decimals(cur));
  let v = Math.round((cur + dir * step) * f) / f;
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  return v;
}

const attrNum = (s: string): number | undefined => {
  if (s.trim() === '') return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
};

const isNumberInput = (t: EventTarget | null): t is HTMLInputElement => t instanceof HTMLInputElement && t.type === 'number';

let installed = false;

export function installNumberSteps(doc: Document = document): void {
  if (installed) return;
  installed = true;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  /** Что было в поле до шага браузера. */
  const before = new WeakMap<HTMLInputElement, string>();
  /** Своё событие ввода (после ↑/↓) поправлять не надо. */
  let own = false;

  const next = (el: HTMLInputElement, from: number, dir: 1 | -1): string => {
    const step = attrNum(el.step) ?? 1;
    return String(stepNumber(from, dir, step > 0 ? step : 1, attrNum(el.min), attrNum(el.max)));
  };
  const remember = (e: Event): void => {
    if (isNumberInput(e.target)) before.set(e.target, e.target.value);
  };
  doc.addEventListener('focusin', remember, true);
  doc.addEventListener('pointerdown', remember, true);
  doc.addEventListener('wheel', remember, { capture: true, passive: true });

  doc.addEventListener(
    'keydown',
    (e) => {
      const el = e.target;
      if (!isNumberInput(el) || e.defaultPrevented || el.readOnly || el.disabled) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const dir = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : null;
      if (dir === null) return;
      e.preventDefault();
      const cur = Number(el.value);
      const from = el.value.trim() !== '' && Number.isFinite(cur) ? cur : (attrNum(el.min) ?? 0);
      const v = next(el, from, dir);
      if (v === el.value) return;
      setValue.call(el, v);
      before.set(el, v);
      own = true;
      try {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } finally {
        own = false;
      }
    },
    true,
  );

  doc.addEventListener(
    'input',
    (e) => {
      const el = e.target;
      if (own || !isNumberInput(el)) return;
      // Набор с клавиатуры, вставка, стирание — это правка человека, её не трогаем.
      const kind = (e as Partial<InputEvent>).inputType;
      const typed = typeof kind === 'string' && kind !== '';
      const was = before.get(el);
      if (!typed && was !== undefined && was.trim() !== '') {
        const prev = Number(was);
        const now = Number(el.value);
        const step = attrNum(el.step) ?? 1;
        // Шаг браузера — не дальше одного шага; число, вписанное скриптом
        // (проверки интерфейса), шагом не считается.
        if (Number.isFinite(prev) && Number.isFinite(now) && now !== prev && Math.abs(now - prev) <= step + 1e-9) {
          const v = next(el, prev, now > prev ? 1 : -1);
          if (v !== el.value) setValue.call(el, v);
        }
      }
      before.set(el, el.value);
    },
    true,
  );
}
