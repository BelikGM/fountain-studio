/**
 * Переход на вкладку из вложенного компонента (например, «Мастер нового
 * объекта» на Оборудовании предлагает сразу перейти на 3D и расставить кольцом).
 * Вкладка живёт в App.tsx — простая подписка, чтобы не тащить коллбэк через
 * все уровни пропсов ради одного редкого перехода.
 */
type Listener = (tab: string) => void;
let listener: Listener | null = null;

export function registerTabNavigator(fn: Listener | null): void {
  listener = fn;
}

export function requestTab(tab: string): void {
  listener?.(tab);
}

/**
 * Переход к конкретной панели «Настроек» (кнопка «Перейти» в полосе про
 * аварийное гашение). Мало открыть вкладку: панелей там два десятка и они
 * свёрнуты — нужная раскрывается и прокручивается в вид (см. SettingsView).
 * Запрос живёт здесь до того, как «Настройки» смонтируются и заберут его.
 */
let pendingPanel: string | null = null;
const panelListeners = new Set<(title: string) => void>();

export function requestSettingsPanel(title: string): void {
  // «Настройки» уже открыты — сразу к панели; нет — запрос ждёт их монтирования.
  if (panelListeners.size > 0) for (const fn of panelListeners) fn(title);
  else pendingPanel = title;
  requestTab('settings');
}

/** Забрать отложенный запрос (один раз) — зовут «Настройки» при монтировании. */
export function takePendingPanel(): string | null {
  const t = pendingPanel;
  pendingPanel = null;
  return t;
}

export function onSettingsPanelRequest(fn: (title: string) => void): () => void {
  panelListeners.add(fn);
  return () => {
    panelListeners.delete(fn);
  };
}
