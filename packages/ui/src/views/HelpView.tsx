import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import manualRaw from '../../../../docs/РУКОВОДСТВО.md?raw';
import planRaw from '../../../../docs/ПЛАН-ПРОВЕРКИ.md?raw';
import setupRaw from '../../../../docs/УСТАНОВКА.md?raw';
import { foldText, parseMarkdown, plainInline, renderBlocks, type MdBlock } from '../markdown';
import { CloseIcon } from '../components/Icons';

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
 * Поиск — своё поле, а не «Ctrl+F браузера» (заказчик 25.09.2026): в
 * собранном приложении у Electron поиска по странице нет вовсе, а браузерный
 * искал только в открытом документе. Здесь ищется по всем трём документам;
 * каждая находка — карточка: документ и раздел, кусок текста до и после,
 * найденное подсвечено. Щелчок — переход к месту; набранное не стирается,
 * щелчок в поле снова показывает находки.
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
    title: 'Установка',
    hint: 'Установка на новый компьютер: Windows, лицензия, драйверы, ffmpeg, сеть, автозапуск — по шагам',
    text: setupRaw,
  },
] as const;

type DocId = (typeof DOCS)[number]['id'];
export type HelpDocId = DocId;

/** Одна находка: где (документ, раздел, блок) и кусок текста вокруг. */
interface Hit {
  doc: DocId;
  /** data-block блока: «12» или «12.3» у пункта списка. */
  block: string;
  section: string;
  before: string;
  match: string;
  after: string;
}

/** Больше — уже не находка, а весь документ; просим уточнить. */
const MAX_HITS = 100;

/** Текстовые куски блоков по порядку — с тем же data-block, что на экране. */
function searchable(blocks: MdBlock[]): { block: string; text: string; heading: boolean }[] {
  const out: { block: string; text: string; heading: boolean }[] = [];
  blocks.forEach((b, i) => {
    switch (b.kind) {
      case 'hr':
        return;
      case 'ul':
      case 'ol':
        b.items.forEach((it, j) => out.push({ block: `${i}.${j}`, text: plainInline(it), heading: false }));
        return;
      case 'pre':
        out.push({ block: String(i), text: b.text, heading: false });
        return;
      case 'p':
        out.push({ block: String(i), text: plainInline(b.text), heading: false });
        return;
      default:
        out.push({ block: String(i), text: plainInline(b.text), heading: true });
    }
  });
  return out;
}

/** Кусок до совпадения — с границы слова, с многоточием, если обрезан. */
function cutBefore(s: string, n: number): string {
  if (s.length <= n) return s;
  const t = s.slice(-n);
  const sp = t.indexOf(' ');
  return '…' + (sp >= 0 && sp < n / 2 ? t.slice(sp + 1) : t);
}
function cutAfter(s: string, n: number): string {
  if (s.length <= n) return s;
  const t = s.slice(0, n);
  const sp = t.lastIndexOf(' ');
  return (sp > n / 2 ? t.slice(0, sp) : t) + '…';
}

function search(parsed: Record<DocId, MdBlock[]>, query: string): { hits: Hit[]; total: number } {
  const q = foldText(query.trim());
  if (q.length < 2) return { hits: [], total: 0 };
  const hits: Hit[] = [];
  let total = 0;
  for (const d of DOCS) {
    const blocks = parsed[d.id];
    let h2 = '';
    let h3 = '';
    for (const part of searchable(blocks)) {
      const b = blocks[Number(part.block.split('.')[0])]!;
      if (b.kind === 'h1') {
        h2 = '';
        h3 = '';
      } else if (b.kind === 'h2') {
        h2 = plainInline(b.text);
        h3 = '';
      } else if (b.kind === 'h3') h3 = plainInline(b.text);
      const hay = foldText(part.text);
      let at = hay.indexOf(q);
      while (at >= 0) {
        total++;
        if (hits.length < MAX_HITS) {
          hits.push({
            doc: d.id,
            block: part.block,
            section: [d.title, h2, part.heading ? '' : h3].filter(Boolean).join(' › '),
            before: cutBefore(part.text.slice(0, at), 60),
            match: part.text.slice(at, at + q.length),
            after: cutAfter(part.text.slice(at + q.length), 90),
          });
        }
        at = hay.indexOf(q, at + q.length);
      }
    }
  }
  return { hits, total };
}

export function HelpView({
  onClose,
  initialDoc = 'manual',
  focusSearch = false,
}: {
  onClose: () => void;
  initialDoc?: DocId;
  /** Открыть сразу с курсором в поиске (меню «Правка» → «Найти в справке»). */
  focusSearch?: boolean;
}) {
  const [docId, setDocId] = useState<DocId>(initialDoc);
  const [query, setQuery] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** Куда перейти после смены документа: data-block находки. */
  const [target, setTarget] = useState<{ doc: DocId; block: string; n: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const parsed = useMemo(
    () => Object.fromEntries(DOCS.map((d) => [d.id, parseMarkdown(d.text)])) as Record<DocId, MdBlock[]>,
    [],
  );
  const doc = DOCS.find((d) => d.id === docId) ?? DOCS[0];
  const found = useMemo(() => search(parsed, query), [parsed, query]);
  const q = query.trim();
  const blocks = useMemo(() => renderBlocks(parsed[docId], q.length >= 2 ? q : ''), [parsed, docId, q]);

  // Прокрутить к находке, когда документ уже на экране.
  useEffect(() => {
    if (!target || target.doc !== docId) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-block="${target.block}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('help-target');
    // Перезапуск подсветки: класс снят и поставлен заново в следующем кадре.
    requestAnimationFrame(() => el.classList.add('help-target'));
  }, [target, docId]);

  // Щелчок мимо поля и находок — список прячется, набранное остаётся.
  useEffect(() => {
    if (!listOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setListOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [listOpen]);

  // Ctrl+F в справке — в своё поле поиска; Esc — закрыть список, потом справку.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setListOpen(true);
      } else if (e.key === 'Escape') {
        if (listOpen) setListOpen(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listOpen, onClose]);

  const open = (h: Hit): void => {
    setDocId(h.doc);
    setTarget((prev) => ({ doc: h.doc, block: h.block, n: (prev?.n ?? 0) + 1 }));
    setListOpen(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="help-head">
          <span className="panel-title help-title">Справка</span>
          <div className="help-docs">
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
          </div>
          <div className="help-search" ref={boxRef}>
            <div className={q ? 'help-search-field filled' : 'help-search-field'} onClick={() => inputRef.current?.focus()}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <circle cx="6.8" cy="6.8" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path d="M10.3 10.3 L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <input
                ref={inputRef}
                autoFocus={focusSearch}
                value={query}
                placeholder="Поиск по справке"
                aria-label="Поиск по справке"
                onFocus={() => setListOpen(true)}
                onClick={() => setListOpen(true)}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                  setListOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setListOpen(true);
                    setActive((a) => Math.min(found.hits.length - 1, a + 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((a) => Math.max(0, a - 1));
                  } else if (e.key === 'Enter' && found.hits[active]) {
                    e.preventDefault();
                    open(found.hits[active]!);
                  }
                }}
              />
              {q.length >= 2 && <span className="dim help-search-count">{found.total}</span>}
            </div>
            {listOpen && q.length >= 2 && (
              <div className="help-results" role="listbox">
                {found.hits.length === 0 ? (
                  <p className="dim help-results-empty">Ничего не найдено.</p>
                ) : (
                  <>
                    {found.total > found.hits.length && (
                      <p className="dim help-results-empty">
                        Показаны первые {found.hits.length} из {found.total} — уточните запрос.
                      </p>
                    )}
                    {found.hits.map((h, i) => (
                      <button
                        key={`${h.doc}-${h.block}-${i}`}
                        className={i === active ? 'help-result active' : 'help-result'}
                        role="option"
                        aria-selected={i === active}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => open(h)}
                      >
                        <span className="help-result-section">{h.section}</span>
                        <span className="help-result-text">
                          {h.before}
                          <mark className="help-hit">{h.match}</mark>
                          {h.after}
                        </span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
          <button className="btn btn-icon help-close" onClick={onClose}>
            <CloseIcon />
            Закрыть
          </button>
        </div>
        {/* key — чтобы при смене документа прокрутка начиналась сверху, а не
            оставалась там, где человек читал предыдущий. */}
        <div className="help-body" key={doc.id} ref={bodyRef}>
          {blocks as ReactNode}
        </div>
      </div>
    </div>
  );
}
