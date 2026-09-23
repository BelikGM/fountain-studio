import { memo, useEffect, useRef } from 'react';
import { DMX_MAX_VALUE } from '@fountain-studio/shared';
import { frameBus } from '../frameBus';

/**
 * Вертикальный фейдер 0–255 (для двухпозиционных — тумблер).
 *
 * Значение фейдер берёт САМ из шины кадров (frameBus) и рисует его прямо в DOM,
 * без состояния React. Так сделано не из любви к DOM: раньше каждый фейдер
 * получал значение пропом и на каждом кадре от движка (10 раз в секунду)
 * перерисовывался весь список, а сглаживание крутило у каждого фейдера свой
 * requestAnimationFrame со setState на каждом шаге. На объекте, где приборов
 * сотни, это давало десятки тысяч перерисовок в секунду: ползунок ехал за
 * пальцем рывками, а через несколько минут окно вставало совсем.
 *
 * Сглаживание. Кадры приходят десять раз в секунду, поэтому и полоса, и цифра
 * шли ступеньками — особенно когда общий ползунок насосов двигает разом
 * полсотни фейдеров. Значение догоняет цель фильтром первого порядка: за такт
 * проходит фиксированную долю оставшегося пути, и скачок любой величины
 * сглаживается одинаково ровно. Пока тянут — постоянная времени втрое короче:
 * фейдер должен идти за пальцем, а не плыть следом.
 */

/** Постоянная времени сглаживания, мс: обычная и во время перетаскивания. */
const TAU_IDLE_MS = 105;
const TAU_DRAG_MS = 35;

interface FaderProps {
  /** Вселенная, из кадра которой берём значение (null — ещё не выбрана). */
  universe: number | null;
  /** DMX-адрес 1..512 (для подписи и для чтения кадра). */
  channel: number;
  /** Владелец адреса из патча («Насос 1 · Мощность»); нет — адрес свободен. */
  owner?: string;
  /** CSS-класс по типу прибора/роли канала (§27 доработки) — красит цифру и полосу. */
  roleClass?: string;
  /**
   * Двухпозиционный канал (клапан): у него физически только «открыт» и
   * «закрыт», промежуточных положений не бывает. Профиль уже помечен
   * twoState, и Сцены с матрицей секвенсора это учитывают — «Отладка» была
   * последним местом, где клапан оставался обычным ползунком 0–255 с
   * невидимым порогом на середине.
   */
  twoState?: boolean;
  onChange: (value: number) => void;
}

export const Fader = memo(function Fader({
  universe,
  channel,
  owner,
  roleClass,
  twoState,
  onChange,
}: FaderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLElement | null>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  /** Значение под пальцем: пока тянут, показываем его, а не кадр движка. */
  const dragRef = useRef<number | null>(null);
  /**
   * Размер шкалы, замеренный в начале протяжки. Мерить его на каждом движении
   * нельзя: мы только что поменяли высоту полосы, и замер заставляет браузер
   * тут же пересчитать раскладку ВСЕХ фейдеров страницы. На 400 фейдерах это
   * было ~20 мс на каждое движение мыши — ползунок отставал от пальца.
   */
  const rectRef = useRef<DOMRect | null>(null);
  /** Сглаженное значение (с дробной частью) и последнее НАРИСОВАННОЕ целое. */
  const smoothRef = useRef(0);
  const paintedRef = useRef(Number.NaN);

  const paint = (value: number): void => {
    if (paintedRef.current === value) return;
    paintedRef.current = value;
    const open = value >= 128;
    // Масштаб, а не высота — см. .fader-fill в styles.css: без пересчёта раскладки.
    if (fillRef.current) fillRef.current.style.transform = `scaleY(${twoState ? (open ? 1 : 0) : value / DMX_MAX_VALUE})`;
    if (textRef.current) textRef.current.textContent = twoState ? (open ? 'Откр' : 'Закр') : String(value);
    if (twoState) {
      const btn = trackRef.current;
      if (btn) {
        btn.setAttribute(
          'data-hint',
          `${owner ?? `адрес ${channel}`} — ${open ? 'открыт' : 'закрыт'}, нажмите чтобы переключить`,
        );
      }
    }
  };

  // Подписка на шину кадров: один общий такт на страницу, рисуем в DOM.
  useEffect(() => {
    smoothRef.current = frameBus.value(universe, channel);
    paintedRef.current = Number.NaN;
    paint(Math.round(smoothRef.current));
    let lastMs = performance.now();
    return frameBus.subscribe(() => {
      const now = performance.now();
      const dt = Math.min(100, now - lastMs);
      lastMs = now;
      const dragging = dragRef.current !== null;
      const target = dragging ? dragRef.current! : frameBus.value(universe, channel);
      const k = 1 - Math.exp(-dt / (dragging ? TAU_DRAG_MS : TAU_IDLE_MS));
      let next = smoothRef.current + (target - smoothRef.current) * k;
      // Разница меньше половины единицы DMX — доводим сразу: иначе фильтр
      // бесконечно подбирается к цели и такт никогда не останавливается.
      const settled = Math.abs(target - next) < 0.5;
      if (settled) next = target;
      smoothRef.current = next;
      paint(Math.round(next));
      return !settled;
    });
  }, [universe, channel, twoState, owner]);

  const setDragging = (on: boolean): void => {
    rootRef.current?.classList.toggle('fader-dragging', on);
  };

  const applyPointer = (clientY: number): void => {
    const track = trackRef.current;
    if (!track) return;
    const rect = rectRef.current ?? track.getBoundingClientRect();
    const ratio = 1 - (clientY - rect.top) / rect.height;
    const v = Math.max(0, Math.min(DMX_MAX_VALUE, Math.round(ratio * DMX_MAX_VALUE)));
    dragRef.current = v;
    // Рисуем сразу, не дожидаясь такта: палец не должен ждать кадра.
    smoothRef.current = v;
    paint(v);
    frameBus.wake();
    onChange(v);
  };

  const toggle = (): void => {
    const v = paintedRef.current >= 128 ? 0 : DMX_MAX_VALUE;
    dragRef.current = v;
    smoothRef.current = v;
    paint(v);
    frameBus.wake();
    onChange(v);
    // Тумблер не тянут — через миг снова показываем то, что на линии.
    window.setTimeout(() => {
      dragRef.current = null;
      frameBus.wake();
    }, 250);
  };

  const cls = (owner ? `fader fader-owned ${roleClass ?? ''}` : 'fader') + (twoState ? ' fader-two-state' : '');

  if (twoState) {
    return (
      <div ref={rootRef} className={cls}>
        <div className="fader-value" ref={textRef}>
          Закр
        </div>
        <button
          type="button"
          className="fader-track fader-toggle"
          ref={(n) => {
            trackRef.current = n;
          }}
          onClick={toggle}
        >
          <div className="fader-fill" ref={fillRef} />
          {owner && <span className="fader-name">{owner}</span>}
        </button>
        <div className="fader-channel">{channel}</div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={cls} data-hint={owner ?? `адрес ${channel} свободен`}>
      <div className="fader-value" ref={textRef}>
        0
      </div>
      <div
        ref={(n) => {
          trackRef.current = n;
        }}
        className="fader-track"
        onPointerDown={(e) => {
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Захват недоступен (перо, эмуляция) — тянуть всё равно можно,
            // пока указатель над шкалой.
          }
          rectRef.current = e.currentTarget.getBoundingClientRect();
          setDragging(true);
          applyPointer(e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) applyPointer(e.clientY);
        }}
        onPointerUp={() => {
          rectRef.current = null;
          setDragging(false);
          dragRef.current = null;
          frameBus.wake();
        }}
      >
        <div className="fader-fill" ref={fillRef} />
        {/*
          Имя прибора — прямо на шкале, снизу вверх. Раньше под ползунком был
          только номер адреса, а чей он — только в подсказке: чтобы найти
          «Насос 3», приходилось водить мышью по всем подряд.
        */}
        {owner && <span className="fader-name">{owner}</span>}
      </div>
      <div className="fader-channel">{channel}</div>
    </div>
  );
});
