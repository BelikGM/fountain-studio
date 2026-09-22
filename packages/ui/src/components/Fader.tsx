import { useEffect, useRef, useState } from 'react';
import { DMX_MAX_VALUE } from '@fountain-studio/shared';

/**
 * Плавное значение фейдера.
 *
 * Кадры DMX приходят двадцать раз в секунду, поэтому и полоса, и цифра
 * прыгали ступеньками: особенно заметно, когда общий ползунок насосов двигает
 * разом полсотни фейдеров. Здесь значение догоняет заданное фильтром первого
 * порядка — за кадр проходит фиксированную долю оставшегося пути, поэтому
 * скачок любой величины сглаживается одинаково ровно.
 *
 * Во время перетаскивания постоянная времени втрое короче: фейдер должен
 * идти за пальцем, а не плыть следом.
 */
function useSmoothValue(target: number, dragging: boolean): number {
  const [shown, setShown] = useState(target);
  const currentRef = useRef(target);
  const rafRef = useRef(0);
  const lastRef = useRef(0);

  useEffect(() => {
    // Разница меньше единицы DMX — анимировать нечего.
    if (Math.abs(currentRef.current - target) < 1) {
      currentRef.current = target;
      setShown(target);
      return;
    }
    const tauMs = dragging ? 35 : 105;
    lastRef.current = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(100, now - lastRef.current);
      lastRef.current = now;
      const k = 1 - Math.exp(-dt / tauMs);
      currentRef.current += (target - currentRef.current) * k;
      if (Math.abs(target - currentRef.current) < 0.5) {
        currentRef.current = target;
        setShown(target);
        return;
      }
      setShown(Math.round(currentRef.current));
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, dragging]);

  return shown;
}

interface FaderProps {
  /** DMX-адрес 1..512 (для подписи). */
  channel: number;
  value: number;
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

/** Вертикальный фейдер 0–255 (для двухпозиционных — тумблер) с управлением мышью/тачем. */
export function Fader({ channel, value, owner, roleClass, twoState, onChange }: FaderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragValue, setDragValue] = useState<number | null>(null);

  const dragging = dragValue !== null;
  const shown = useSmoothValue(dragValue ?? value, dragging);
  const isOpen = shown >= 128;

  const applyPointer = (clientY: number): void => {
    const rect = trackRef.current!.getBoundingClientRect();
    const ratio = 1 - (clientY - rect.top) / rect.height;
    const v = Math.max(0, Math.min(DMX_MAX_VALUE, Math.round(ratio * DMX_MAX_VALUE)));
    setDragValue(v);
    onChange(v);
  };

  const toggle = (): void => {
    const v = isOpen ? 0 : DMX_MAX_VALUE;
    setDragValue(v);
    onChange(v);
  };

  const cls =
    (owner ? `fader fader-owned ${roleClass ?? ''}` : 'fader') + (dragging ? ' fader-dragging' : '');

  if (twoState) {
    return (
      <div
        className={`${cls} fader-two-state`}
        data-hint={`${owner ?? `адрес ${channel}`} — ${isOpen ? 'открыт' : 'закрыт'}, нажмите чтобы переключить`}
      >
        <div className="fader-value">{isOpen ? 'Откр' : 'Закр'}</div>
        <button type="button" className="fader-track fader-toggle" onClick={toggle}>
          <div className="fader-fill" style={{ height: isOpen ? '100%' : '0%' }} />
          {owner && <span className="fader-name">{owner}</span>}
        </button>
        <div className="fader-channel">{channel}</div>
      </div>
    );
  }

  return (
    <div className={cls} data-hint={owner ?? `адрес ${channel} свободен`}>
      <div className="fader-value">{shown}</div>
      <div
        ref={trackRef}
        className="fader-track"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          applyPointer(e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) applyPointer(e.clientY);
        }}
        onPointerUp={() => setDragValue(null)}
      >
        <div className="fader-fill" style={{ height: `${(shown / DMX_MAX_VALUE) * 100}%` }} />
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
}
