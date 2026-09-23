import { useEffect, useLayoutEffect, type RefObject } from 'react';
import { onSettingsPanelRequest, takePendingPanel } from './navigate';

/**
 * Сворачиваемые панели «Настроек» (заказчик 23.09.2026).
 *
 * Панелей два десятка, и нужное приходилось искать прокруткой. Теперь каждая
 * сворачивается до своей плашки с названием: щелчок по плашке — раскрыть,
 * повторный — свернуть. Изначально всё свёрнуто, выбор каждой панели
 * запоминается на этом компьютере.
 *
 * Почему поверх готовой разметки, а не компонентом-обёрткой. Панели — это
 * два десятка отдельных функций со своим `<section className="panel"><h2>`.
 * Переписывать каждую ради одного поведения — значит двадцать мест, где его
 * можно забыть, и каждая новая панель снова без него. Здесь хук сам находит
 * панели вкладки при каждой отрисовке и подхватывает новые.
 *
 * Анимация — по max-height: высоту раскрытой панели меряем перед стартом, а
 * по окончании снимаем ограничение, чтобы панель могла расти (раскрыли
 * подробности, пришёл ответ движка).
 */

const KEY = 'fountain.settings.collapsed';
/** Изначально панели свёрнуты — так просил заказчик. */
const DEFAULT_COLLAPSED = true;
const ANIM_MS = 220;

function loadState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    return v && typeof v === 'object' ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveState(title: string, collapsed: boolean): void {
  try {
    const all = loadState();
    all[title] = collapsed;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Приватный режим — выбор просто не переживёт перезапуск.
  }
}

/** Название панели — текст её заголовка без стрелки. */
function titleOf(section: HTMLElement): string {
  const h2 = section.querySelector(':scope > h2');
  if (!h2) return '';
  const own = (h2 as HTMLElement).dataset.title;
  return own ?? (h2.textContent ?? '').trim();
}

/** Высота плашки свёрнутой панели: заголовок плюс внутренние отступы. */
function collapsedHeight(section: HTMLElement, h2: HTMLElement): number {
  const cs = getComputedStyle(section);
  return h2.offsetHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
}

function setCollapsed(section: HTMLElement, collapsed: boolean, animate: boolean): void {
  const h2 = section.querySelector(':scope > h2') as HTMLElement | null;
  if (!h2) return;
  section.dataset.collapsed = collapsed ? '1' : '0';
  h2.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  const done = (): void => {
    section.style.maxHeight = '';
    section.style.overflow = '';
    section.classList.toggle('panel-collapsed', section.dataset.collapsed === '1');
  };
  if (!animate) {
    done();
    return;
  }
  if (collapsed) {
    // Сворачиваем: от нынешней высоты к высоте плашки, потом прячем содержимое.
    section.style.overflow = 'hidden';
    section.style.maxHeight = `${section.scrollHeight}px`;
    void section.offsetHeight;
    section.classList.add('panel-animating');
    section.style.maxHeight = `${collapsedHeight(section, h2)}px`;
  } else {
    // Раскрываем: показываем содержимое, меряем полную высоту и растём до неё.
    const from = collapsedHeight(section, h2);
    section.classList.remove('panel-collapsed');
    section.style.overflow = 'hidden';
    section.style.maxHeight = `${from}px`;
    void section.offsetHeight;
    section.classList.add('panel-animating');
    section.style.maxHeight = `${section.scrollHeight}px`;
  }
  window.setTimeout(() => {
    section.classList.remove('panel-animating');
    done();
  }, ANIM_MS + 30);
}

/** Раскрыть панель по названию и прокрутить к ней (кнопка «Перейти» из полосы). */
function reveal(root: HTMLElement, title: string): boolean {
  const section = [...root.querySelectorAll<HTMLElement>(':scope > section.panel')].find((s) => titleOf(s) === title);
  if (!section) return false;
  if (section.dataset.collapsed === '1') {
    setCollapsed(section, false, true);
    saveState(title, false);
  }
  // Ждём начала раскрытия — иначе прокрутка считает по свёрнутой высоте.
  window.setTimeout(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  section.classList.add('panel-flash');
  window.setTimeout(() => section.classList.remove('panel-flash'), 1600);
  return true;
}

export function useCollapsiblePanels(rootRef: RefObject<HTMLElement | null>): void {
  // На каждой отрисовке: панели появляются и пропадают (нет проекта — нет
  // «Аварийного отключения»), новые подхватываем, известные не трогаем.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const state = loadState();
    for (const section of root.querySelectorAll<HTMLElement>(':scope > section.panel')) {
      if (section.dataset.collapsible === '1') continue;
      const h2 = section.querySelector(':scope > h2') as HTMLElement | null;
      if (!h2) continue;
      const title = (h2.textContent ?? '').trim();
      if (!title) continue;
      h2.dataset.title = title;
      section.dataset.collapsible = '1';
      h2.classList.add('panel-toggle');
      h2.setAttribute('role', 'button');
      h2.tabIndex = 0;
      const chevron = document.createElement('span');
      chevron.className = 'panel-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      h2.appendChild(chevron);
      const toggle = (): void => {
        const next = section.dataset.collapsed !== '1';
        setCollapsed(section, next, true);
        saveState(title, next);
      };
      h2.addEventListener('click', (e) => {
        // Кнопки и поля внутри заголовка (если есть) работают как раньше.
        if ((e.target as HTMLElement).closest('button, input, select, a, label')) return;
        toggle();
      });
      h2.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
      setCollapsed(section, state[title] ?? DEFAULT_COLLAPSED, false);
    }
  });

  // Переход к панели из другой вкладки («Перейти» в полосе про гашение).
  useEffect(() => {
    const root = rootRef.current;
    const pending = takePendingPanel();
    if (root && pending) window.setTimeout(() => reveal(root, pending), 50);
    return onSettingsPanelRequest((title) => {
      const r = rootRef.current;
      if (r) window.setTimeout(() => reveal(r, title), 50);
    });
  }, [rootRef]);
}
