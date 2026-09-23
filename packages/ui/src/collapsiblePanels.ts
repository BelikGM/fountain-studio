import { useEffect, useLayoutEffect, type RefObject } from 'react';
import { onSettingsPanelRequest, takePendingPanel } from './navigate';

/**
 * Сворачиваемые панели — на «Настройках» (заказчик 23.09.2026) и на других
 * вкладках, где панели стоят столбиком: «Оборудование», «Поток»,
 * «Диагностика», «Внешние пульты», боковые панели «3D» (24.09.2026).
 *
 * Щелчок по заголовку панели — свернуть до плашки, повторный — раскрыть.
 * Изначально всё раскрыто.
 *
 * ── Где хранится, что свёрнуто ───────────────────────────────────────────
 * В НАСТРОЙКАХ ПРОГРАММЫ у движка (app-config.json), а не только в памяти
 * окна. Память окна привязана к адресу: у программы из исходников
 * (localhost:5180), у установленной (файл) и у браузера она разная, и выбор,
 * сделанный в одном окне, не был виден в другом. У движка он переживает
 * закрытие программы, одинаков в любом окне и попадает в резервную копию
 * настроек программы. Память окна остаётся как быстрый черновик до ответа
 * движка.
 *
 * ── Почему поверх готовой разметки, а не компонентом-обёрткой ───────────
 * Панели — это десятки отдельных функций со своим `<section className="panel">
 * <h2>`. Переписывать каждую ради одного поведения — значит десятки мест, где
 * его можно забыть. Хук сам находит панели и подхватывает новые.
 *
 * ── Анимация ─────────────────────────────────────────────────────────────
 * Высотой через Web Animations: обе высоты меряем заранее, анимируем ровно
 * между ними, по окончании высоту отпускаем. Корень помечается классом
 * panels-collapsible, и панели в нём не сжимаются колонкой (flex-shrink: 0):
 * иначе, пока на время анимации стоит overflow: hidden, браузер ужимал панель
 * до отступов, и она сперва «сворачивалась», а потом раскрывалась (замер
 * 24.09.2026).
 */

const LOCAL_KEY = 'fountain.panels.collapsed';
/** Черновик первой версии (только «Настройки», ключ — название панели). */
const LEGACY_KEY = 'fountain.settings.collapsed.v2';
const DEFAULT_COLLAPSED = false;
const ANIM_MS = 220;

/** «вкладка:название панели» → свёрнута ли. */
let state: Record<string, boolean> = loadLocal();
let sender: ((key: string, collapsed: boolean) => void) | null = null;
const reappliers = new Set<() => void>();

function loadLocal(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const old = JSON.parse(legacy) as Record<string, boolean>;
      return Object.fromEntries(Object.entries(old).map(([t, v]) => [`settings:${t}`, v]));
    }
  } catch {
    // Приватный режим или битые данные — начинаем с «всё раскрыто».
  }
  return {};
}

function saveLocal(): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  } catch {
    // Не записалось — выбор всё равно хранит движок.
  }
}

/**
 * Выбор, отправленный движку, но ещё не вернувшийся от него. Пока он в пути,
 * ответ движка по этой панели не главный: щёлкнули дважды подряд — первый
 * ответ («свёрнута») пришёл бы после второго щелчка и захлопнул бы панель.
 * Если связи не было (движок перезапускался) — отправляем снова.
 */
const pending = new Map<string, boolean>();

/** Движок прислал сохранённое состояние (сообщение config) — оно главное. */
export function setPanelStateFromEngine(map: Record<string, boolean> | undefined): void {
  if (!map) return;
  const next = { ...state };
  for (const [k, v] of Object.entries(map)) {
    if (pending.has(k)) {
      if (pending.get(k) === v) pending.delete(k);
      continue;
    }
    next[k] = v;
  }
  // Черновик из памяти окна, которого у движка ещё нет (выбор, сделанный до
  // этой версии), и не дошедшие до движка щелчки — отдаём движку.
  for (const [k, v] of Object.entries(next)) {
    if (!(k in map) || pending.has(k)) {
      pending.set(k, v);
      sender?.(k, v);
    }
  }
  state = next;
  saveLocal();
  for (const fn of reappliers) fn();
}

/** Как отправлять движку изменения — задаёт useEngine при подключении. */
export function registerPanelStateSender(fn: ((key: string, collapsed: boolean) => void) | null): void {
  sender = fn;
}

function remember(key: string, collapsed: boolean): void {
  state = { ...state, [key]: collapsed };
  saveLocal();
  pending.set(key, collapsed);
  sender?.(key, collapsed);
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

/** Панели корня: прямые дети, а у раскладки с боковыми колонками — дети колонок. */
function panelsOf(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(':scope > section.panel, :scope > aside > section.panel')];
}

/** Раскрыть панель по названию и прокрутить к ней (кнопка «Перейти» из полосы). */
function reveal(root: HTMLElement, scope: string, title: string): boolean {
  const section = panelsOf(root).find((s) => titleOf(s) === title);
  if (!section) return false;
  if (section.dataset.collapsed === '1') {
    setCollapsed(section, false, true);
    remember(`${scope}:${title}`, false);
  }
  // Прокручиваем после раскрытия — иначе прокрутка считает по свёрнутой высоте.
  window.setTimeout(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }), ANIM_MS + 20);
  section.classList.add('panel-flash');
  window.setTimeout(() => section.classList.remove('panel-flash'), 1600);
  return true;
}

/**
 * Сделать сворачиваемыми панели внутри root. scope — имя вкладки: у панелей
 * с одинаковыми названиями на разных вкладках своё состояние.
 */
export function useCollapsiblePanels(rootRef: RefObject<HTMLElement | null>, scope: string): void {
  // На каждой отрисовке: панели появляются и пропадают (нет проекта — нет
  // «Аварийного отключения», в 3D меняется выбранный элемент), новые
  // подхватываем, известные не трогаем.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.classList.add('panels-collapsible');
    for (const aside of root.querySelectorAll<HTMLElement>(':scope > aside')) aside.classList.add('panels-collapsible');
    for (const section of panelsOf(root)) {
      if (section.dataset.collapsible === '1') continue;
      if (section.dataset.nocollapse === '1') continue;
      const h2 = section.querySelector(':scope > h2') as HTMLElement | null;
      if (!h2) continue;
      // Имя панели — постоянное: у заголовков со счётчиком или кнопкой
      // («Приборы (12)», «RDM-приборы (3)») оно задано в data-title, иначе
      // запомненное состояние терялось бы, стоило числу поменяться.
      const title = (h2.dataset.title ?? h2.textContent ?? '').trim();
      // Заголовок без текста (например, строка поиска) — не плашка, не сворачиваем.
      if (!title) continue;
      const key = `${scope}:${title}`;
      h2.dataset.title = title;
      section.dataset.collapsible = '1';
      section.dataset.panelKey = key;
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
        remember(key, next);
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
      setCollapsed(section, state[key] ?? DEFAULT_COLLAPSED, false);
    }
  });

  // Сохранённое состояние пришло от движка позже, чем нарисовались панели
  // (запуск программы), — раскладываем без анимации.
  useEffect(() => {
    const apply = (): void => {
      const root = rootRef.current;
      if (!root) return;
      for (const section of panelsOf(root)) {
        const key = section.dataset.panelKey;
        if (!key) continue;
        const want = state[key] ?? DEFAULT_COLLAPSED;
        if ((section.dataset.collapsed === '1') !== want) setCollapsed(section, want, false);
      }
    };
    reappliers.add(apply);
    return () => {
      reappliers.delete(apply);
    };
  }, [rootRef]);

  // Переход к панели из другой вкладки («Перейти» в полосе про гашение) — только «Настройки».
  useEffect(() => {
    if (scope !== 'settings') return;
    const root = rootRef.current;
    const pending = takePendingPanel();
    if (root && pending) window.setTimeout(() => reveal(root, scope, pending), 50);
    return onSettingsPanelRequest((title) => {
      const r = rootRef.current;
      if (r) window.setTimeout(() => reveal(r, scope, title), 50);
    });
  }, [rootRef, scope]);
}
