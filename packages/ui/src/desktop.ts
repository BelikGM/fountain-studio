/**
 * Мостик к настольной программе (packages/app/preload.cjs). В браузере его
 * нет — там своей строки заголовка и меню не рисуем: у браузера своё окно.
 */
export interface DesktopApi {
  desktop?: true;
  onOpenProject(handler: (dir: string) => void): void;
  chooseProjectFolder(startIn?: string): Promise<string>;
  setTitleBarColors?(color: string, symbolColor: string): void;
  closeWindow?(): void;
  toggleFullScreen?(): void;
  quitApp?(): void;
  getZoom?(): number;
  setZoom?(factor: number): void;
}

export function desktopApi(): DesktopApi | null {
  return (window as unknown as { fountainApp?: DesktopApi }).fountainApp ?? null;
}

/**
 * Редактор открыт в настольной программе, а не во вкладке браузера.
 * `?titlebar=1` — показать строку заголовка и без программы: для проверки
 * вёрстки снимками (scripts/ui-shot.cjs открывает редактор без preload).
 */
export function isDesktop(): boolean {
  return desktopApi()?.desktop === true || new URLSearchParams(location.search).get('titlebar') === '1';
}

/** Ступени масштаба интерфейса в меню «Вид». */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
const ZOOM_KEY = 'fs-zoom';

/** Сохранённый масштаб — на этом компьютере, в проект не попадает. */
export function loadZoom(): number {
  try {
    const v = Number(localStorage.getItem(ZOOM_KEY));
    return ZOOM_STEPS.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function saveZoom(v: number): void {
  try {
    localStorage.setItem(ZOOM_KEY, String(v));
  } catch {
    // Приватный режим — масштаб не переживёт перезапуск, и только.
  }
}
