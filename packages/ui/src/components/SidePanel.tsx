import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { PanelIcon } from './Icons';

/**
 * Боковая панель, которую можно сузить и свернуть (заказчик 25.09.2026: на
 * ноутбуке боковые колонки 3D съедали схему).
 *
 * Как в VS Code, Figma, Blender:
 *  · край панели тянется мышью — уже, чем по умолчанию, но не шире (шире
 *    «текущей ширины» не просили: подписи и поля рассчитаны на неё);
 *    двойной щелчок по краю — вернуть как было; с клавиатуры — стрелками;
 *  · кнопка на краю сворачивает панель в узкую полоску с названием —
 *    щелчок по полоске разворачивает обратно.
 * Ширина и «свёрнуто» запоминаются на этом компьютере (в проект не
 * попадают): это удобство человека, а не свойство фонтана.
 */

const key = (id: string): string => `fs-panel:${id}`;

function load(id: string): { width: number | null; collapsed: boolean | null } {
  try {
    const raw = localStorage.getItem(key(id));
    if (!raw) return { width: null, collapsed: null };
    const v = JSON.parse(raw) as { width?: unknown; collapsed?: unknown };
    return {
      width: typeof v.width === 'number' ? v.width : null,
      collapsed: typeof v.collapsed === 'boolean' ? v.collapsed : null,
    };
  } catch {
    return { width: null, collapsed: null };
  }
}

function save(id: string, width: number, collapsed: boolean): void {
  try {
    localStorage.setItem(key(id), JSON.stringify({ width, collapsed }));
  } catch {
    // Приватный режим — ширина не переживёт перезагрузку, и только.
  }
}

export function SidePanel({
  id,
  side,
  title,
  width: maxWidth,
  minWidth = 190,
  className = '',
  collapsedOnNarrow = false,
  children,
}: {
  /** Ключ для запоминания ширины: «layout-list», «scenes»… */
  id: string;
  /** С какой стороны окна: у левой панели тянется правый край, у правой — левый. */
  side: 'left' | 'right';
  /** Подпись на свёрнутой полоске и в подсказках. */
  title: string;
  /** Обычная (и наибольшая) ширина, px. */
  width: number;
  minWidth?: number;
  className?: string;
  /** Начинать свёрнутой на узком окне (меньше 1000 px), если человек ещё не решал сам. */
  collapsedOnNarrow?: boolean;
  children: ReactNode;
}) {
  const saved = load(id);
  // На ноутбуке с узким окном — сразу поуже, если человек не выбрал своё.
  const initial = saved.width ?? (window.innerWidth < 1366 ? Math.round(maxWidth * 0.85) : maxWidth);
  const clamp = (w: number): number => Math.max(minWidth, Math.min(maxWidth, Math.round(w)));
  const [width, setWidth] = useState(() => clamp(initial));
  const [collapsed, setCollapsed] = useState(() => saved.collapsed ?? (collapsedOnNarrow && window.innerWidth < 1000));
  const drag = useRef<{ x: number; w: number } | null>(null);

  const apply = (w: number, c: boolean): void => {
    setWidth(w);
    setCollapsed(c);
    save(id, w, c);
  };

  const onDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: width };
    document.body.classList.add('side-resizing');
  };
  const onMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    setWidth(clamp(drag.current.w + (side === 'left' ? dx : -dx)));
  };
  const onUp = (): void => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('side-resizing');
    save(id, width, false);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 48 : 16;
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key === grow) apply(clamp(width + step), false);
    else if (e.key === shrink) apply(clamp(width - step), false);
    else return;
    e.preventDefault();
  };

  if (collapsed) {
    return (
      <div
        className={`side-rail side-rail-${side}`}
        role="button"
        tabIndex={0}
        data-hint={`Показать панель «${title}»`}
        onClick={() => apply(width, false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            apply(width, false);
          }
        }}
      >
        <span className="side-rail-icon">
          <PanelIcon dir={side === 'left' ? 'right' : 'left'} />
        </span>
        <span className="side-rail-title">{title}</span>
      </div>
    );
  }

  return (
    <div className={`side-wrap side-wrap-${side}`} style={{ width }}>
      <aside className={`sidebar ${className}`.trim()}>{children}</aside>
      <div
        className="side-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Ширина панели «${title}»`}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        data-hint="Тянуть — сузить или расширить панель. Двойной щелчок — обычная ширина"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => apply(clamp(maxWidth), false)}
        onKeyDown={onKey}
      />
      <button
        className="side-collapse"
        aria-label={`Свернуть панель «${title}»`}
        data-hint={`Свернуть панель «${title}» — останется узкая полоска, щелчок по ней вернёт панель`}
        onClick={() => apply(width, true)}
      >
        <PanelIcon dir={side === 'left' ? 'left' : 'right'} />
      </button>
    </div>
  );
}
