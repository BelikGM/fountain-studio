import { useState } from 'react';
import manualRaw from '../../../../docs/РУКОВОДСТВО.md?raw';
import planRaw from '../../../../docs/ПЛАН-ПРОВЕРКИ.md?raw';
import setupRaw from '../../../../docs/УСТАНОВКА.md?raw';
import { renderMarkdown } from '../markdown';

/**
 * Встроенная справка (§27 доработки, раздел «Продукт») — документы проекта
 * прямо в приложении, кнопкой «?» из любой вкладки.
 *
 * Документов три, и это разные задачи, поэтому они переключаются, а не слиты
 * в один: руководство — про РАБОТУ в программе, план проверки — про то, как
 * пройти всё по порядку и убедиться, что работает, установка — про подготовку
 * нового компьютера. Один документ на репозиторий и на приложение: тексты
 * импортируются как raw на этапе сборки (Vite ?raw), поэтому правка в docs/
 * сразу видна в программе и не может с ней разойтись.
 *
 * Разметка разбирается своим markdown→JSX (см. markdown.tsx): рантайм-парсер
 * ради трёх файлов не тянем. Поиск по тексту — штатный Ctrl+F браузера.
 */
const DOCS = [
  { id: 'manual', title: 'Руководство', hint: 'Как пользоваться программой: разделы, сборка шоу, частые вопросы', text: manualRaw },
  {
    id: 'plan',
    title: 'План проверки',
    hint: 'С нуля до про: собрать объект и проверить всю программу по порядку, без фонтана',
    text: planRaw,
  },
  {
    id: 'setup',
    title: 'Установка на новый ПК',
    hint: 'Windows, лицензия, драйверы, ffmpeg, сеть, автозапуск — по шагам',
    text: setupRaw,
  },
] as const;

export function HelpView({ onClose }: { onClose: () => void }) {
  const [docId, setDocId] = useState<(typeof DOCS)[number]['id']>('manual');
  const doc = DOCS.find((d) => d.id === docId) ?? DOCS[0];
  const blocks = renderMarkdown(doc.text);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="form-row">
          <span className="panel-title" style={{ width: 'auto' }}>
            Справка
          </span>
          {DOCS.map((d) => (
            <button
              key={d.id}
              className={d.id === docId ? 'btn active' : 'btn'}
              data-hint={d.hint}
              onClick={() => setDocId(d.id)}
            >
              {d.title}
            </button>
          ))}
          <span className="dim">поиск по тексту — Ctrl+F</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Закрыть
          </button>
        </div>
        {/* key — чтобы при смене документа прокрутка начиналась сверху, а не
            оставалась там, где человек читал предыдущий. */}
        <div className="help-body" key={docId}>
          {blocks}
        </div>
      </div>
    </div>
  );
}
