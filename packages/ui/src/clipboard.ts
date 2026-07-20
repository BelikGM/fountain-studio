/**
 * Copy/paste (§27 доработки, УХ п.13) — общий буфер в памяти вкладки, не
 * системный: элементы схемы 3D, блоки шоу, шаги секвенсора, элементы
 * плейлиста и приборы патча — разные типы данных, буфер помечен «видом»,
 * чтобы вставка в другое место экрана не подставила чужой формы объект.
 * Не переживает перезагрузку страницы — так же, как история Undo/Redo.
 */
let clip: { kind: string; data: unknown } | null = null;

export function copyToClipboard(kind: string, data: unknown): void {
  clip = { kind, data: JSON.parse(JSON.stringify(data)) as unknown };
}

export function pasteFromClipboard<T>(kind: string): T | null {
  return clip && clip.kind === kind ? (JSON.parse(JSON.stringify(clip.data)) as T) : null;
}

export function clipboardHasKind(kind: string): boolean {
  return clip?.kind === kind;
}
