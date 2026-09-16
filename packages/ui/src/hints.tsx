import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Свои подсказки вместо браузерных.
 *
 * Родной `title` выглядит чужеродно (системный жёлтый ярлык), появляется через
 * секунду, обрывает длинный текст и не умеет переносы строк. Здесь один общий
 * ярлык на всё приложение: любой элемент с атрибутом `data-hint` показывает его
 * содержимое рядом с собой.
 *
 * Почему один общий, а не компонент на каждую подсказку: подсказки стоят внутри
 * панелей с прокруткой, а всё, что нарисовано внутри такой панели, обрезается её
 * краями. Общий ярлык живёт в самом верху страницы и позиционируется
 * координатами экрана, поэтому не обрезается никогда и не требует переписывать
 * разметку — достаточно заменить `title` на `data-hint`.
 */
const SHOW_DELAY_MS = 280;

export function HintHost() {
  const [hint, setHint] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  /** На каком элементе сейчас курсор — чтобы не перезапускать таймер на каждый пиксель. */
  const overRef = useRef<Element | null>(null);
  /** Элемент, на который нажали: его подсказка молчит, пока курсор не уйдёт с него. */
  const pressedRef = useRef<Element | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hintOf = (t: EventTarget | null): HTMLElement | null =>
      ((t as HTMLElement | null)?.closest?.('[data-hint]') as HTMLElement | null) ?? null;
    const clear = (): void => {
      window.clearTimeout(timer.current);
      overRef.current = null;
      setHint(null);
    };
    /**
     * Нажали на элемент — его подсказка больше не нужна, пока курсор не уйдёт
     * с него. Раньше нажатие сбрасывало подсказку, но первое же движение мыши
     * над тем же элементом заводило её снова — и у раскрытого списка (select)
     * ярлык ложился прямо поверх вариантов выбора.
     */
    const onDown = (e: MouseEvent): void => {
      clear();
      pressedRef.current = hintOf(e.target);
      overRef.current = pressedRef.current;
    };
    const onOver = (e: MouseEvent): void => {
      const el = hintOf(e.target);
      // Слушаем движение, а не только вход в элемент: mouseover приходит не
      // всегда (например, когда курсор уже стоял над элементом к моменту
      // появления разметки), и подсказка тогда не показывалась вовсе.
      if (el === overRef.current) return;
      overRef.current = el;
      window.clearTimeout(timer.current);
      if (el !== pressedRef.current) pressedRef.current = null;
      if (!el || el === pressedRef.current) {
        setHint(null);
        return;
      }
      const text = el.getAttribute('data-hint') ?? '';
      if (!text) {
        setHint(null);
        return;
      }
      timer.current = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        // Снизу, если сверху не помещается, — иначе подсказка уедет за экран.
        const below = r.top < 140;
        setHint({
          text,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(below ? r.bottom + 8 : r.top - 8),
          below,
        });
      }, SHOW_DELAY_MS);
    };
    window.addEventListener('mousemove', onOver, true);
    window.addEventListener('mouseover', onOver, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('wheel', clear, true);
    window.addEventListener('keydown', clear, true);
    return () => {
      window.removeEventListener('mousemove', onOver, true);
      window.removeEventListener('mouseover', onOver, true);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('wheel', clear, true);
      window.removeEventListener('keydown', clear, true);
      window.clearTimeout(timer.current);
    };
  }, []);

  /**
   * Подсказку у края экрана надо подвинуть внутрь — иначе половина текста
   * оказывается за границей окна. Считаем ПОСЛЕ отрисовки: заранее ширину
   * ярлыка не знать, она зависит от длины текста и переносов.
   *
   * Двигаем сам узел, а не состояние: перерисовка от собственного измерения
   * вызвала бы бесконечный круг. Хвостик при этом сдвигаем в обратную сторону,
   * чтобы он остался под элементом, к которому подсказка относится.
   */
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !hint) return;
    el.style.left = `${hint.x}px`;
    el.style.top = `${hint.y}px`;
    el.style.setProperty('--tail-dx', '0px');
    const pad = 8;
    const r = el.getBoundingClientRect();
    let dx = 0;
    let dy = 0;
    if (r.left < pad) dx = pad - r.left;
    else if (r.right > window.innerWidth - pad) dx = window.innerWidth - pad - r.right;
    if (r.top < pad) dy = pad - r.top;
    else if (r.bottom > window.innerHeight - pad) dy = window.innerHeight - pad - r.bottom;
    if (dx !== 0 || dy !== 0) {
      el.style.left = `${hint.x + dx}px`;
      el.style.top = `${hint.y + dy}px`;
      el.style.setProperty('--tail-dx', `${-dx}px`);
    }
  }, [hint]);

  if (!hint) return null;
  return (
    <div
      ref={boxRef}
      className={hint.below ? 'hint-bubble hint-below' : 'hint-bubble'}
      style={{ left: hint.x, top: hint.y }}
      role="tooltip"
    >
      {hint.text}
    </div>
  );
}
