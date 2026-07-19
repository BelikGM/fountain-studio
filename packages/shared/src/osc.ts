/**
 * Разбор OSC 1.0 (Open Sound Control) — минимум для пультов вроде TouchOSC:
 * одно сообщение (адрес + типизированные аргументы), без бандлов и без масок
 * адресов (bindings сверяются точным совпадением строки, см. remote.ts).
 * Формат: null-terminated ASCII-строки, дополненные нулями до кратности 4;
 * аргументы типов i (int32), f (float32), s (string) — этого достаточно для
 * кнопок и фейдеров типичного контрол-пульта.
 */
export interface OscMessage {
  address: string;
  args: (number | string)[];
}

function readOscString(buf: Buffer, offset: number): { value: string; next: number } | null {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) return null; // нет терминатора — обрезанный пакет
  const value = buf.toString('ascii', offset, end);
  const next = (end + 4) & ~3; // + минимум один \0, выровнено на 4 байта
  return { value, next };
}

export function parseOscMessage(buf: Buffer): OscMessage | null {
  if (buf.length < 4 || buf[0] !== 0x2f /* '/' */) return null; // не сообщение (бандлы начинаются с '#')
  const addr = readOscString(buf, 0);
  if (!addr) return null;
  if (addr.next >= buf.length) return { address: addr.value, args: [] };
  const tags = readOscString(buf, addr.next);
  if (!tags || !tags.value.startsWith(',')) return { address: addr.value, args: [] };
  let offset = tags.next;
  const args: (number | string)[] = [];
  for (const t of tags.value.slice(1)) {
    if (t === 'f') {
      if (offset + 4 > buf.length) break;
      args.push(buf.readFloatBE(offset));
      offset += 4;
    } else if (t === 'i') {
      if (offset + 4 > buf.length) break;
      args.push(buf.readInt32BE(offset));
      offset += 4;
    } else if (t === 's') {
      const s = readOscString(buf, offset);
      if (!s) break;
      args.push(s.value);
      offset = s.next;
    } else {
      break; // неизвестный/неподдерживаемый тип аргумента — адрес уже разобран, дальше не идём
    }
  }
  return { address: addr.value, args };
}

function padOscString(s: string): Buffer {
  const body = Buffer.from(s, 'ascii');
  const len = (body.length + 1 + 3) & ~3; // + минимум один \0, выровнено на 4
  const out = Buffer.alloc(len);
  body.copy(out, 0);
  return out;
}

/** Сборка простого OSC-сообщения (для статуса/подтверждений, если понадобится слать наружу). */
export function encodeOscMessage(address: string, args: (number | string)[] = []): Buffer {
  const addrBuf = padOscString(address);
  const tags = ',' + args.map((a) => (typeof a === 'string' ? 's' : 'f')).join('');
  const tagsBuf = padOscString(tags);
  const argBufs = args.map((a) => {
    if (typeof a === 'string') return padOscString(a);
    const b = Buffer.alloc(4);
    b.writeFloatBE(a, 0);
    return b;
  });
  return Buffer.concat([addrBuf, tagsBuf, ...argBufs]);
}
