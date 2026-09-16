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
