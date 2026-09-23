import { useEffect, useLayoutEffect, type RefObject } from 'react';
import { onSettingsPanelRequest, takePendingPanel } from './navigate';

/**
 * Сворачиваемые панели «Настроек» (заказчик 23.09.2026).
 *
 * Панелей два десятка, и нужное приходилось искать прокруткой. Теперь каждая
 * сворачивается до своей плашки с названием: щелчок по плашке — свернуть,
 * повторный — раскрыть. Изначально всё РАСКРЫТО (уточнение заказчика
 * 24.09.2026), выбор каждой панели запоминается на этом компьютере.
 *
 * Почему поверх готовой разметки, а не компонентом-обёрткой. Панели — это
 * два десятка отдельных функций со своим `<section className="panel"><h2>`.
 * Переписывать каждую ради одного поведения — значит двадцать мест, где его
 * можно забыть, и каждая новая панель снова без него. Здесь хук сам находит
 * панели вкладки при каждой отрисовке и подхватывает новые.
 *
 * Анимация — высотой через Web Animations: обе высоты (до и после) меряем
 * заранее, анимируем ровно между ними, по окончании высоту отпускаем — панель
 * снова растёт сама (раскрыли подробности, пришёл ответ движка). Первая
 * версия анимировала max-height и считала стартовую высоту по заголовку — при
 * раскрытии панель сперва сжималась с 46 до 26 пикселей и только потом
 * рывком открывалась (замер 24.09.2026).
 */

/** v2: при смене умолчания на «раскрыто» прежние отметки сброшены. */
const KEY = 'fountain.settings.collapsed.v2';
/** Изначально панели раскрыты — так просил заказчик (24.09.2026). */
const DEFAULT_COLLAPSED = false;
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

function setCollapsed(section: HTMLElement, collapsed: boolean, animate: boolean): void {
  const h2 = section.querySelector(':scope > h2') as HTMLElement | null;
  if (!h2) return;
  // Видимая высота — ДО отмены прежней анимации: щёлкнули посреди неё —
  // продолжаем с того места, где панель сейчас, а не прыгаем.
  const from = section.getBoundingClientRect().height;
  const prev = (section as HTMLElement & { _anim?: Animation })._anim;
  prev?.cancel();
  // Состояние — сразу: по нему поворачивается стрелка, не дожидаясь конца анимации.
  section.dataset.collapsed = collapsed ? '1' : '0';
  h2.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  if (!animate || typeof section.animate !== 'function') {
    section.classList.toggle('panel-collapsed', collapsed);
    return;
  }
  // Конечную высоту меряем синхронно, до кадра: глаз промежуточного состояния не увидит.
  section.classList.toggle('panel-collapsed', collapsed);
  const to = section.getBoundingClientRect().height;
  // На время анимации содержимое видно (и при сворачивании тоже), лишнее обрезаем.
  section.classList.remove('panel-collapsed');
  section.style.overflow = 'hidden';
  const anim = section.animate([{ height: `${from}px` }, { height: `${to}px` }], {
    duration: ANIM_MS,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
  });
  (section as HTMLElement & { _anim?: Animation })._anim = anim;
  const finish = (): void => {
    section.style.overflow = '';
    section.classList.toggle('panel-collapsed', section.dataset.collapsed === '1');
  };
  anim.onfinish = finish;
  anim.oncancel = finish;
}

/** Раскрыть панель по названию и прокрутить к ней (кнопка «Перейти» из полосы). */
function reveal(root: HTMLElement, title: string): boolean {
  const section = [...root.querySelectorAll<HTMLElement>(':scope > section.panel')].find((s) => titleOf(s) === title);
  if (!section) return false;
  if (section.dataset.collapsed === '1') {
    setCollapsed(section, false, true);
    saveState(title, false);
  }
  // Прокручиваем после раскрытия — иначе прокрутка считает по свёрнутой высоте.
  window.setTimeout(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }), ANIM_MS + 20);
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
