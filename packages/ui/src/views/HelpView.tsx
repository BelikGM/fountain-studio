import manualRaw from '../../../../docs/РУКОВОДСТВО.md?raw';
import { renderMarkdown } from '../markdown';

/**
 * Встроенная справка (§27 доработки, раздел «Продукт») — docs/РУКОВОДСТВО.md
 * прямо в приложении, кнопкой «?» из любой вкладки. Один документ на
 * репозиторий и на приложение — импортируется как raw-текст на этапе
 * сборки (Vite ?raw), парсится хендролленным markdown→JSX (см. markdown.tsx)
 * без библиотеки; не тянем рантайм-парсер ради одного файла. Поиск по тексту —
 * штатный Ctrl+F браузера, отдельный своё изобретать незачем.
 */
export function HelpView({ onClose }: { onClose: () => void }) {
  const blocks = renderMarkdown(manualRaw);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="form-row">
          <span className="panel-title" style={{ width: 'auto' }}>
            Справка
          </span>
          <span className="dim">поиск по тексту — Ctrl+F</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Закрыть
          </button>
        </div>
        <div className="help-body">{blocks}</div>
      </div>
    </div>
  );
}
