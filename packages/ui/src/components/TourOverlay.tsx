import { useEffect, useState } from 'react';

/**
 * Тур при первом запуске (§27 доработки, раздел «Продукт») — подсказки
 * поверх интерфейса по маршруту из docs/РУКОВОДСТВО.md §4 («С нуля до готового
 * шоу»): Оборудование → 3D → Сцены → Шоу, а перед ними шаг про Отладку — вкладку,
 * на которой программа открывается (сам он в маршрут постройки не входит,
 * но без него тур уводил с Отладки, не сказав, что это). Не все 8 шагов
 * руководства — тур задуман коротким, полный маршрут остаётся в Справке
 * (кнопка «?»).
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
    // Меряем кнопку каждый кадр, пока показан шаг. Раньше здесь был двойной
    // rAF — он ловил только переключение вкладки (класс .active жирнее, другая
    // ширина), но не более поздние перекомпоновки шапки. А их хватает: строка
    // «версия N» приходит от движка асинхронно и раздвигает блок бренда,
    // статус лицензии меняет набор вкладок, дошрифт догружается. Любая из них
    // сдвигает вкладки уже ПОСЛЕ замера — и подсветка остаётся стоять левее
    // реальной кнопки (ровно то, что было видно на «Оборудовании»). Кадр стоит
    // одного getBoundingClientRect и живёт только 4 шага тура.
    let raf = 0;
    let prev: DOMRect | null = null;
    const tick = (): void => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${def.tabId}"]`);
      const next = el ? el.getBoundingClientRect() : null;
      // setState только когда рамка реально поехала — иначе лишний рендер каждый кадр.
      const moved =
        (next === null) !== (prev === null) ||
        (next !== null &&
          prev !== null &&
          (next.left !== prev.left || next.top !== prev.top || next.width !== prev.width || next.height !== prev.height));
      if (moved) {
        prev = next;
        setRect(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
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
