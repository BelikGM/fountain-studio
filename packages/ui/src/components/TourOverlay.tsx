import { useEffect, useState } from 'react';

/**
 * Тур при первом запуске (§27 доработки, раздел «Продукт») — подсказки
 * поверх интерфейса по маршруту из docs/MANUAL.md §4 («С нуля до готового
 * шоу»): Приборы → 3D → Сцены → Шоу. Не все 8 шагов руководства — тур
 * задуман коротким, полный маршрут остаётся в Справке (кнопка «?»).
 */
export interface TourStepDef {
  tabId: string;
  title: string;
  text: string;
}

export function TourOverlay({
  steps,
  step,
  onNext,
  onSkip,
}: {
  steps: TourStepDef[];
  step: number;
  onNext: () => void;
  onSkip: () => void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const def = steps[step]!;

  useEffect(() => {
    const update = (): void => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${def.tabId}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [def.tabId]);

  const isLast = step === steps.length - 1;
  const calloutLeft = rect ? Math.min(Math.max(12, rect.left), window.innerWidth - 300) : 12;

  return (
    <div className="tour-overlay">
      {rect && (
        <div
          className="tour-spotlight"
          style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }}
        />
      )}
      <div className="tour-callout" style={{ left: calloutLeft, top: rect ? rect.bottom + 14 : 60 }}>
        <div className="tour-callout-title">{def.title}</div>
        <p>{def.text}</p>
        <div className="form-row">
          <button className="btn btn-small" onClick={onSkip}>
            Пропустить
          </button>
          <span className="dim">
            {step + 1} / {steps.length}
          </span>
          <span className="spacer" />
          <button className="btn active" onClick={onNext}>
            {isLast ? 'Готово' : 'Далее →'}
          </button>
        </div>
      </div>
    </div>
  );
}
