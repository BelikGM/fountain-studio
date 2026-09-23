/** Мелкие line-иконки для значков в строках списков (карандаш/мусорка и т.п.) — без эмодзи, единый стиль. */
const ICON_PROPS = {
  viewBox: '0 0 24 24',
  width: 14,
  height: 14,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function PencilIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

/**
 * Ветер: три потока с завитками — так ветер рисуют в сводках погоды и на
 * значках метеостанций, читается без подписи.
 */
export function WindIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...ICON_PROPS} width={size} height={size} aria-hidden="true">
      <path d="M9.6 4.6A2 2 0 1 1 11 8H2" />
      <path d="M12.6 19.4A2 2 0 1 0 14 16H2" />
      <path d="M17.7 7.7A2.5 2.5 0 1 1 19.5 12H2" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

/**
 * Значки транспорта (пуск/пауза/стоп). Раньше это были символы ▶ ⏸ ■ прямо
 * в тексте кнопки — их рисует шрифт эмодзи со своими метриками, из-за чего
 * значок садился ниже базовой линии подписи и выглядел «кривым». SVG с
 * currentColor лишён этой проблемы: он центрируется флексом кнопки
 * (.btn-icon), а не гадает по шрифту, и красится в цвет текста.
 */
const TRANSPORT_PROPS = {
  viewBox: '0 0 24 24',
  // 10px ≈ высота заглавной буквы при шрифте 13px (Segoe UI, cap height ~0.7em).
  // При 12px значок был выше «П» и вылезал за базовую линию: флекс центрует его
  // по строчному боксу (15px) математически точно, но глазу он всё равно читался
  // тяжелее и ниже подписи. На высоте заглавных верх и низ значка совпадают с
  // верхом и низом букв — пара выглядит на одной линии.
  width: 10,
  height: 10,
  fill: 'currentColor',
  'aria-hidden': true as const,
  focusable: 'false' as const,
};

export function PlayIcon() {
  return (
    <svg {...TRANSPORT_PROPS}>
      <path d="M8 4.8v14.4a1 1 0 0 0 1.54.84l11-7.2a1 1 0 0 0 0-1.68l-11-7.2A1 1 0 0 0 8 4.8Z" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg {...TRANSPORT_PROPS}>
      <rect x="6" y="4.5" width="4.5" height="15" rx="1.2" />
      <rect x="13.5" y="4.5" width="4.5" height="15" rx="1.2" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg {...TRANSPORT_PROPS}>
      <rect x="5.5" y="5.5" width="13" height="13" rx="1.6" />
    </svg>
  );
}

export function PrevIcon() {
  return (
    <svg {...TRANSPORT_PROPS}>
      <rect x="4" y="5" width="3" height="14" rx="1" />
      <path d="M20 5.6v12.8a1 1 0 0 1-1.55.83l-9.6-6.4a1 1 0 0 1 0-1.66l9.6-6.4A1 1 0 0 1 20 5.6Z" />
    </svg>
  );
}

export function NextIcon() {
  return (
    <svg {...TRANSPORT_PROPS}>
      <path d="M4 5.6v12.8a1 1 0 0 0 1.55.83l9.6-6.4a1 1 0 0 0 0-1.66l-9.6-6.4A1 1 0 0 0 4 5.6Z" />
      <rect x="17" y="5" width="3" height="14" rx="1" />
    </svg>
  );
}

/**
 * Глаз — «показывать в 3D». Перечёркнутый — элемент скрыт. Так же, как в
 * слоях Photoshop, Blender и MADRIX: значок читается без подписи.
 */
export function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}
