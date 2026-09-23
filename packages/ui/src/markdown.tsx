import type { ReactNode } from 'react';

/**
 * Минимальный markdown → JSX — только подмножество, которое реально
 * использует docs/РУКОВОДСТВО.md (заголовки h1-h3, **жирный**, `код`, ```блоки```,
 * списки - и 1., ---). Без библиотеки: по конвенции проекта не тянуть
 * зависимость ради разбора одного документа (см. hand-rolled DXF-парсер).
 */

function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] !== undefined) parts.push(<strong key={key++}>{m[1]}</strong>);
    else parts.push(<code key={key++}>{m[2]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  let listBuf: { ordered: boolean; items: string[] } | null = null;

  const flushList = (): void => {
    if (!listBuf) return;
    const items = listBuf.items;
    out.push(
      listBuf.ordered ? (
        <ol key={key++}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key++}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ul>
      ),
    );
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
      out.push(
        <pre key={key++}>
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    if (line.startsWith('### ')) {
      flushList();
      out.push(<h3 key={key++}>{renderInline(line.slice(4))}</h3>);
      i++;
      continue;
    }
    if (line.startsWith('## ')) {
      flushList();
      out.push(<h2 key={key++}>{renderInline(line.slice(3))}</h2>);
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      flushList();
      out.push(<h1 key={key++}>{renderInline(line.slice(2))}</h1>);
      i++;
      continue;
    }
    if (line.trim() === '---') {
      flushList();
      out.push(<hr key={key++} />);
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
    out.push(<p key={key++}>{renderInline(paraLines.join(' '))}</p>);
  }
  flushList();
  return out;
}
