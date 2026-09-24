import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronIcon } from './Icons';

/**
 * Вкладки в шапке, которые не помещаются, уходят в «Ещё ▾».
 *
 * Заказчик 25.09.2026: на окне 1180 px правые вкладки просто обрезались
 * краем окна — «Настройки», «Клавиатура» и дальше пропадали, а перенести их
 * было некуда. Так делают навигацию GitHub, YouTube, Material Design
 * («priority+»): видно столько вкладок, сколько влезает, остальные — в
 * меню; открытая вкладка видна всегда. Ширины меряются по-настоящему
 * (скрытый ряд со всеми вкладками), поэтому работает на ЛЮБОЙ ширине окна, а
 * не только на заранее выбранных, и при любом масштабе Windows.
 */
export interface TabItem {
  id: string;
  label: string;
  hint?: string;
}

export function TabsBar({
  tabs,
  active,
  onPick,
}: {
  tabs: TabItem[];
  /** Открытая вкладка; null — ни одна не подсвечена (открыты «Проекты»). */
  active: string | null;
  onPick: (id: string) => void;
}) {
  const navRef = useRef<HTMLElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  /** Замер: ширины вкладок, кнопки «Ещё», зазор и сколько места у ряда. */
  const [m, setM] = useState<{ widths: number[]; more: number; gap: number; avail: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const measure = measureRef.current;
    if (!nav || !measure) return;
    const compute = (): void => {
      const cells = [...measure.children] as HTMLElement[];
      const widths = cells.map((c) => c.getBoundingClientRect().width);
      const more = widths.pop() ?? 0;
      const gap = parseFloat(getComputedStyle(measure).columnGap) || 0;
      const avail = nav.clientWidth;
      setM((prev) =>
        prev && prev.avail === avail && prev.more === more && prev.gap === gap && prev.widths.join() === widths.join()
          ? prev
          : { widths, more, gap, avail },
      );
    };
    const ro = new ResizeObserver(compute);
    ro.observe(nav);
    // Ширины вкладок меняются и без смены ширины окна: шрифт догрузился,
    // сработало правило @media с другими полями.
    ro.observe(measure);
    compute();
    return () => ro.disconnect();
  }, [tabs]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (!moreRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  /*
   * Какие вкладки видны. Открытая — всегда: её ширина откладывается первой,
   * потом по порядку остальные, пока влезают вместе с «Ещё». Раньше открытая
   * просто занимала место последней видимой — и если она шире («Внешние
   * пульты» вместо «Плейлисты»), ряд вылезал на значки справа.
   */
  const activeIdx = tabs.findIndex((t) => t.id === active);
  const pick = new Set<number>();
  if (!m || m.widths.length !== tabs.length) {
    tabs.forEach((_, i) => pick.add(i));
  } else {
    const all = m.widths.reduce((sum, w) => sum + w, 0) + m.gap * Math.max(0, tabs.length - 1);
    if (all <= m.avail + 0.5) tabs.forEach((_, i) => pick.add(i));
    else {
      let used = m.more;
      if (activeIdx >= 0) {
        used += m.widths[activeIdx]! + m.gap;
        pick.add(activeIdx);
      }
      for (let i = 0; i < tabs.length; i++) {
        if (i === activeIdx) continue;
        if (used + m.widths[i]! + m.gap > m.avail + 0.5) break;
        used += m.widths[i]! + m.gap;
        pick.add(i);
      }
    }
  }
  const shown = tabs.filter((_, i) => pick.has(i));
  const shownIds = new Set(shown.map((t) => t.id));
  const hidden = tabs.filter((t) => !shownIds.has(t.id));

  const tabButton = (t: TabItem, measuring = false) => (
    <button
      key={t.id}
      data-tour={measuring ? undefined : t.id}
      className={t.id === active && !measuring ? 'tab active' : 'tab'}
      data-hint={measuring ? undefined : t.hint}
      tabIndex={measuring ? -1 : undefined}
      onClick={measuring ? undefined : () => onPick(t.id)}
    >
      {t.label}
    </button>
  );

  return (
    <nav className="tabs" ref={navRef}>
      {/* Невидимый ряд со ВСЕМИ вкладками и кнопкой «Ещё» — только для замера ширин. */}
      <div className="tabs-measure" ref={measureRef} aria-hidden="true">
        {tabs.map((t) => tabButton(t, true))}
        <button className="tab tabs-more" tabIndex={-1}>
          Ещё
          <ChevronIcon />
        </button>
      </div>
      {shown.map((t) => tabButton(t))}
      {hidden.length > 0 && (
        <div className="tabs-more-wrap" ref={moreRef}>
          <button
            className={menuOpen ? 'tab tabs-more open' : 'tab tabs-more'}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-hint={`Не поместились: ${hidden.map((t) => t.label).join(', ')}`}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            Ещё
            <ChevronIcon />
          </button>
          {menuOpen && (
            <div className="menu-drop tabs-more-drop" role="menu">
              {hidden.map((t) => (
                <button
                  key={t.id}
                  role="menuitem"
                  className="menu-item"
                  data-hint={t.hint}
                  onClick={() => {
                    setMenuOpen(false);
                    onPick(t.id);
                  }}
                >
                  <span className="menu-item-label">{t.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </nav>
  );
}
