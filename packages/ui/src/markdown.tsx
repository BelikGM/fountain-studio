import type { ReactNode } from 'react';

/**
 * Минимальный markdown → JSX — только подмножество, которое реально
 * используют документы справки (заголовки h1-h3, **жирный**, `код`,
 * ```блоки```, списки - и 1., ---). Без библиотеки: по конвенции проекта не
 * тянуть зависимость ради разбора трёх документов (см. hand-rolled DXF-парсер).
 *
 * Разбор и отрисовка разделены (parseMarkdown → renderBlocks): поиску по
 * справке нужны те же блоки, что и на экране, с теми же номерами, — иначе
 * находка вела бы не туда (см. HelpView).
 */

export type MdBlock =
  | { kind: 'h1' | 'h2' | 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'pre'; text: string }
  | { kind: 'hr' };

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let i = 0;
  let listBuf: { ordered: boolean; items: string[] } | null = null;
  const flushList = (): void => {
    if (!listBuf) return;
    out.push({ kind: listBuf.ordered ? 'ol' : 'ul', items: listBuf.items });
    listBuf = null;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++;
      flushList();
      out.push({ kind: 'pre', text: codeLines.join('\n') });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      out.push({ kind: (['h1', 'h2', 'h3'] as const)[h[1]!.length - 1]!, text: h[2]! });
      i++;
      continue;
    }
    if (line.trim() === '---') {
      flushList();
      out.push({ kind: 'hr' });
      i++;
      continue;
    }
    const ulMatch = /^-\s+(.*)$/.exec(line);
    if (ulMatch) {
      if (!listBuf || listBuf.ordered) {
        flushList();
        listBuf = { ordered: false, items: [] };
      }
      listBuf.items.push(ulMatch[1]!);
      i++;
      continue;
    }
    const olMatch = /^\d+\.\s+(.*)$/.exec(line);
    if (olMatch) {
      if (!listBuf || !listBuf.ordered) {
        flushList();
        listBuf = { ordered: true, items: [] };
      }
      listBuf.items.push(olMatch[1]!);
      i++;
      continue;
    }
    // Продолжение пункта списка (строка с отступом) — в тот же пункт.
    if (listBuf && /^\s{2,}\S/.test(line)) {
      listBuf.items[listBuf.items.length - 1] += ' ' + line.trim();
      i++;
      continue;
    }
    if (line.trim() === '') {
      flushList();
      i++;
      continue;
    }
    flushList();
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !lines[i]!.startsWith('#') &&
      !lines[i]!.startsWith('```') &&
      lines[i]!.trim() !== '---' &&
      !/^-\s+/.test(lines[i]!) &&
      !/^\d+\.\s+/.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    out.push({ kind: 'p', text: paraLines.join(' ') });
  }
  flushList();
  return out;
}

/** Текст без разметки — то, что человек видит на экране (для поиска). */
export function plainInline(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
}

/** Сравнение для поиска: без регистра и с «ё» = «е». */
export function foldText(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

/** Подсветить совпадения запроса в куске текста. */
function highlight(text: string, query: string, key: { n: number }): ReactNode[] {
  const q = foldText(query.trim());
  if (q.length < 2) return [text];
  const hay = foldText(text);
  const out: ReactNode[] = [];
  let at = 0;
  for (;;) {
    const i = hay.indexOf(q, at);
    if (i < 0) break;
    if (i > at) out.push(text.slice(at, i));
    out.push(
      <mark key={`m${key.n++}`} className="help-hit">
        {text.slice(i, i + q.length)}
      </mark>,
    );
    at = i + q.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function renderInline(text: string, query: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  const key = { n: 0 };
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(...highlight(text.slice(last, m.index), query, key));
    // Внутри жирного бывает `код` — разбираем его тем же способом.
    if (m[1] !== undefined) parts.push(<strong key={`s${key.n++}`}>{renderInline(m[1], query)}</strong>);
    else parts.push(<code key={`c${key.n++}`}>{highlight(m[2]!, query, key)}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(...highlight(text.slice(last), query, key));
  return parts;
}

/**
 * Блоки в JSX. У каждого — data-block (номер блока, у пункта списка —
 * «блок.пункт»): по нему поиск прокручивает к находке. query — подсветить
 * совпадения во всём документе.
 */
export function renderBlocks(blocks: MdBlock[], query = ''): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.kind) {
      case 'h1':
        return <h1 key={i} data-block={i}>{renderInline(b.text, query)}</h1>;
      case 'h2':
        return <h2 key={i} data-block={i}>{renderInline(b.text, query)}</h2>;
      case 'h3':
        return <h3 key={i} data-block={i}>{renderInline(b.text, query)}</h3>;
      case 'p':
        return <p key={i} data-block={i}>{renderInline(b.text, query)}</p>;
      case 'pre':
        return (
          <pre key={i} data-block={i}>
            <code>{highlight(b.text, query, { n: 0 })}</code>
          </pre>
        );
      case 'hr':
        return <hr key={i} />;
      case 'ul':
      case 'ol': {
        const items = b.items.map((it, j) => (
          <li key={j} data-block={`${i}.${j}`}>
            {renderInline(it, query)}
          </li>
        ));
        return b.kind === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>;
      }
    }
  });
}

export function renderMarkdown(src: string): ReactNode[] {
  return renderBlocks(parseMarkdown(src));
}
