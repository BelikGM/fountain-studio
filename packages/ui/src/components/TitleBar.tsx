import { useEffect, useState, type ReactNode } from 'react';
import { MenuBar, type MenuDef } from './MenuBar';

/**
 * Строка заголовка настольной программы — вместо белой системной (заказчик
 * 25.09.2026). Как у VS Code: слева логотип и меню «Файл, Правка, Вид…»,
 * посередине имя проекта, справа — значки программы, а кнопки Windows
 * «свернуть / развернуть / закрыть» система рисует поверх правого края
 * (titleBarOverlay в main.cjs). За пустое место строки окно перетаскивается,
 * двойной щелчок разворачивает — как за обычный заголовок.
 *
 * Сколько места справа занято кнопками Windows, узнаём у самого окна
 * (Window Controls Overlay): при масштабе 125–150 % они шире, чем при 100 %.
 */
export function TitleBar({ logo, menus, title, right }: { logo: ReactNode; menus: MenuDef[]; title: string; right: ReactNode }) {
  const [compact, setCompact] = useState(() => window.innerWidth < 960);
  const [controls, setControls] = useState(138);

  useEffect(() => {
    type Wco = EventTarget & { visible?: boolean; getTitlebarAreaRect?: () => DOMRect };
    const wco = (navigator as unknown as { windowControlsOverlay?: Wco }).windowControlsOverlay;
    const update = (): void => {
      setCompact(window.innerWidth < 960);
      const r = wco?.getTitlebarAreaRect?.();
      if (r && r.width > 0) setControls(Math.max(0, Math.round(window.innerWidth - (r.x + r.width))));
    };
    update();
    window.addEventListener('resize', update);
    wco?.addEventListener('geometrychange', update);
    return () => {
      window.removeEventListener('resize', update);
      wco?.removeEventListener('geometrychange', update);
    };
  }, []);

  return (
    <div className="titlebar" style={{ paddingRight: controls }}>
      <div className="titlebar-logo">{logo}</div>
      <MenuBar menus={menus} compact={compact} />
      <div className="titlebar-title">{title}</div>
      <div className="titlebar-right">{right}</div>
    </div>
  );
}
