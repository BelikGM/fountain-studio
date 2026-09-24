import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronIcon, MenuIcon } from './Icons';

/**
 * Строка меню программы — «Файл, Правка, Вид…», как в Visual Studio Code
 * (заказчик 25.09.2026). Рисуется своими средствами, а не системным меню
 * Windows: системное белое и выбивалось из тёмного окна. На узком окне
 * пункты сворачиваются в одну кнопку «меню» — так же делает VS Code.
 */
export type MenuEntry =
  | {
      kind?: 'item';
      label: string;
      /** Подпись сочетания справа, например «Ctrl+S». */
      shortcut?: string;
      onClick?: () => void;
      disabled?: boolean;
      /** Галочка слева (переключатели: тема, открытая вкладка). */
      checked?: boolean;
      hint?: string;
      submenu?: MenuEntry[];
    }
  | { kind: 'sep' }
  | { kind: 'note'; label: string };

export interface MenuDef {
  id: string;
  label: string;
  items: MenuEntry[];
}

/** Стрелки ↑↓ ходят по пунктам открытого списка. */
function moveFocus(e: ReactKeyboardEvent<HTMLDivElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > .menu-item:not(:disabled)')];
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
  items[next]!.focus();
}

function MenuList({ items, onDone, className = '' }: { items: MenuEntry[]; onDone: () => void; className?: string }) {
  const [sub, setSub] = useState<number | null>(null);
  return (
    <div className={`menu-drop ${className}`} role="menu" onKeyDown={moveFocus}>
      {items.map((it, i) => {
        if (it.kind === 'sep') return <div key={i} className="menu-sep" role="separator" />;
        if (it.kind === 'note') {
          return (
            <div key={i} className="menu-note">
              {it.label}
            </div>
          );
        }
        const hasSub = !!it.submenu && it.submenu.length > 0;
        return (
          <div key={i} className="menu-item-wrap" onMouseEnter={() => setSub(hasSub ? i : null)}>
            <button
              className={sub === i ? 'menu-item open' : 'menu-item'}
              role="menuitem"
              disabled={it.disabled}
              data-hint={it.hint}
              aria-haspopup={hasSub ? 'menu' : undefined}
              onClick={() => {
                if (hasSub) {
                  setSub(sub === i ? null : i);
                  return;
                }
                onDone();
                it.onClick?.();
              }}
              onKeyDown={(e) => {
                if (hasSub && e.key === 'ArrowRight') {
                  e.preventDefault();
                  setSub(i);
                }
              }}
            >
              <span className="menu-item-check" aria-hidden="true">
                {it.checked ? <CheckMark /> : null}
              </span>
              <span className="menu-item-label">{it.label}</span>
              {it.shortcut && <span className="menu-item-key">{it.shortcut}</span>}
              {hasSub && <ChevronIcon dir="right" size={11} />}
            </button>
            {hasSub && sub === i && <MenuList items={it.submenu!} onDone={onDone} className="menu-sub" />}
          </div>
        );
      })}
    </div>
  );
}

function CheckMark() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function MenuBar({ menus, compact }: { menus: MenuDef[]; compact: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null);
    };
    const onBlur = (): void => setOpen(null);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);

  const done = (): void => setOpen(null);

  if (compact) {
    // Узкое окно: одна кнопка, в ней те же меню подменю.
    const all: MenuEntry[] = menus.map((m) => ({ label: m.label, submenu: m.items }));
    return (
      <div className="menubar" ref={rootRef}>
        <div className="menubar-top">
          <button
            className={open ? 'menubar-btn menubar-burger open' : 'menubar-btn menubar-burger'}
            aria-label="Меню"
            data-hint="Меню программы"
            onClick={() => setOpen(open ? null : 'all')}
          >
            <MenuIcon />
          </button>
          {open && <MenuList items={all} onDone={done} />}
        </div>
      </div>
    );
  }

  return (
    <div className="menubar" ref={rootRef}>
      {menus.map((m) => (
        <div key={m.id} className="menubar-top">
          <button
            className={open === m.id ? 'menubar-btn open' : 'menubar-btn'}
            aria-haspopup="menu"
            aria-expanded={open === m.id}
            onClick={() => setOpen(open === m.id ? null : m.id)}
            // Одно меню уже открыто — соседнее открывается наведением, как в любой программе.
            onMouseEnter={() => {
              if (open !== null && open !== m.id) setOpen(m.id);
            }}
          >
            {m.label}
          </button>
          {open === m.id && <MenuList items={m.items} onDone={done} />}
        </div>
      ))}
    </div>
  );
}
