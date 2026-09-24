/**
 * Мостик между окном и главным процессом — на считанные случаи.
 *
 * Человек дважды щёлкнул файл .fsproj в папке объекта, а программа уже
 * запущена: Windows поднимает вторую копию, та передаёт путь первой (см.
 * second-instance в main.cjs), и первой надо сказать окну «открой вот этот
 * объект». Окно дальше просит движок по своему WebSocket — так же, как если
 * бы объект выбрали в списке.
 *
 * Ещё — своя строка заголовка с меню (25.09.2026): цвета системных кнопок
 * окна под тему, «Закрыть окно», «Во весь экран», «Остановить фонтан и
 * выйти», масштаб интерфейса. Только эти действия — не общий доступ к системе.
 *
 * Больше наружу ничего не открываем: чем меньше мостиков, тем меньше способов
 * из страницы дотянуться до системы.
 */
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('fountainApp', {
  /** Вызывается, когда из Проводника попросили открыть объект. */
  onOpenProject(handler) {
    ipcRenderer.on('open-project', (_e, dir) => {
      if (typeof dir === 'string' && dir !== '') handler(dir);
    });
  },
  /**
   * Обычный выбор папки Windows. Просить человека вводить путь руками —
   * издевательство: папку с объектом он ищет мышкой, как любую другую.
   * Возвращает путь или пустую строку, если выбор отменили.
   */
  chooseProjectFolder(startIn) {
    return ipcRenderer.invoke('choose-project-folder', startIn);
  },
  /** Редактор открыт в настольной программе — рисовать свою строку заголовка. */
  desktop: true,
  /** Цвета системных кнопок окна (свернуть, развернуть, закрыть) — под тему. */
  setTitleBarColors(color, symbolColor) {
    ipcRenderer.send('titlebar-colors', { color: String(color), symbolColor: String(symbolColor) });
  },
  closeWindow() {
    ipcRenderer.send('window-close');
  },
  toggleFullScreen() {
    ipcRenderer.send('window-fullscreen');
  },
  quitApp() {
    ipcRenderer.send('app-quit');
  },
  /** Масштаб интерфейса: 1 — как есть, 0,8 — мельче (маленький экран), 1,25 — крупнее. */
  getZoom() {
    return webFrame.getZoomFactor();
  },
  setZoom(factor) {
    const f = Number(factor);
    if (Number.isFinite(f) && f >= 0.5 && f <= 2) webFrame.setZoomFactor(f);
  },
});
