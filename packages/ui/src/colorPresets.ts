/** Цветовые пресеты (§27 доработки, УХ п.15) — быстрый клик вместо открытия палитры. Общие для ScenesView и ConsoleView. */
export const COLOR_PRESETS: { name: string; hex: string }[] = [
  { name: 'Красный', hex: '#ff0000' },
  { name: 'Оранжевый', hex: '#ff8000' },
  { name: 'Жёлтый', hex: '#ffe000' },
  { name: 'Зелёный', hex: '#00ff40' },
  { name: 'Голубой', hex: '#00e0ff' },
  { name: 'Синий', hex: '#2040ff' },
  { name: 'Фиолетовый', hex: '#a020ff' },
  { name: 'Розовый', hex: '#ff40c0' },
  { name: 'Белый', hex: '#ffffff' },
  { name: 'Тёплый белый', hex: '#ffcf94' },
];

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) || 0,
    parseInt(hex.slice(3, 5), 16) || 0,
    parseInt(hex.slice(5, 7), 16) || 0,
  ];
}
