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
      {/* Треугольник по центру своей рамки (x 5,3…18,8): раньше он стоял правее
          на 2,7 единицы, и зазор слева от него выходил больше, чем до подписи. */}
      <path d="M5.3 4.8v14.4a1 1 0 0 0 1.54.84l11-7.2a1 1 0 0 0 0-1.68l-11-7.2A1 1 0 0 0 5.3 4.8Z" />
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

/** Загрузить из файла: стрелка вверх над лотком — как в проводнике и браузерах. */
export function UploadIcon() {
  return (
    <svg {...ICON_PROPS} width={12} height={12} aria-hidden="true">
      <path d="M12 15V4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M4 17v3h16v-3" />
    </svg>
  );
}

/**
 * Стрелка клавиши (↑ ↓ ← →) — значком, а не буквой шрифта. Символ стрелки в
 * Arial сидит на базовой линии текста и при масштабе экрана Windows 125–150 %
 * уезжал ниже середины кнопки и обрезался снизу (замечание 24.09.2026).
 * Значок центрируется по кнопке точно при любом масштабе.
 */
export function KeyArrowIcon({ dir }: { dir: 'up' | 'down' | 'left' | 'right' }) {
  const rot = { up: 0, right: 90, down: 180, left: 270 }[dir];
  return (
    <svg {...ICON_PROPS} width={13} height={13} aria-label={{ up: 'вверх', down: 'вниз', left: 'влево', right: 'вправо' }[dir]} style={{ transform: `rotate(${rot}deg)`, display: 'block' }}>
      <path d="M12 20V4" />
      <path d="M6 10l6-6 6 6" />
    </svg>
  );
}

/**
 * «Перейти туда»: стрелка вправо значком. Символ «→» шрифта сидит ниже
 * середины кнопки (замечание 24.09.2026), значок в .btn-icon — ровно по центру.
 */
export function ArrowRightIcon() {
  return (
    <svg {...ICON_PROPS} width={13} height={13} aria-hidden="true">
      <path d="M4 12h15" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

/** «Назад»: стрелка влево значком — по той же причине, что и ArrowRightIcon. */
export function ArrowLeftIcon() {
  return (
    <svg {...ICON_PROPS} width={13} height={13} aria-hidden="true">
      <path d="M20 12H5" />
      <path d="M11 6l-6 6 6 6" />
    </svg>
  );
}

/**
 * «Добавить»: плюс значком. Символ «+» шрифта стоит с разными отступами слева
 * и справа (у него свои поля в шрифте, а после него ещё пробел), и в кнопке
 * «+ Вселенная» он висел не посередине своего места (замечание 24.09.2026).
 * В .btn-icon отступ слева и зазор до подписи одинаковые.
 */
export function PlusIcon() {
  return (
    <svg {...ICON_PROPS} width={12} height={12} aria-hidden="true">
      <path d="M12 4v16" />
      <path d="M4 12h16" />
    </svg>
  );
}

/** Закрыть — крестик значком (а не «✕» шрифта: тот сидит ниже середины). */
export function CloseIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...ICON_PROPS} width={size} height={size} aria-hidden="true">
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  );
}

/**
 * Сохранить — дискета. Кнопка «● Сохранить» словами не помещалась в шапку на
 * 1280–1600 px, когда есть несохранённые правки (замер 24.09.2026); значок
 * в жёлтой рамке + подсказка занимают вчетверо меньше места.
 */
export function SaveIcon() {
  return (
    <svg {...ICON_PROPS} width={14} height={14} aria-hidden="true">
      <path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M8 3v5h7V3" />
      <path d="M8 21v-7h8v7" />
    </svg>
  );
}

/**
 * Проект — папка. Раньше в шапке стоял эмодзи «🏛» (здание с колоннами): что
 * он значит, было непонятно, и сидел он ниже середины кнопки (24.09.2026).
 */
export function FolderIcon() {
  return (
    <svg {...ICON_PROPS} width={14} height={14} aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

/*
 * Значки вместо символов шрифта и эмодзи в кнопках (24.09.2026). Символы
 * «⚙ ⧉ ⚡ 🎬 ♪ ⬇» стоят каждый по своей линии и со своими полями: пиксельная
 * проверка находила их на 1–3 px выше или ниже подписи, а поля слева и справа
 * — разными. Значок SVG в .btn-icon встаёт ровно. Правило — docs/ВЁРСТКА.md.
 */

/** Настройка (калибровка прибора) — шестерёнка. */
export function GearIcon() {
  return (
    <svg {...ICON_PROPS} width={14} height={14} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

/** Копировать — два листа. */
export function CopyIcon() {
  return (
    <svg {...ICON_PROPS} width={13} height={13} aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** Уменьшить (масштаб шкалы). */
export function MinusIcon() {
  return (
    <svg {...ICON_PROPS} width={12} height={12} aria-hidden="true">
      <path d="M4 12h16" />
    </svg>
  );
}

/** Сглаживание дорожки — плавная волна. */
export function WaveIcon() {
  return (
    <svg {...ICON_PROPS} width={14} height={14} aria-hidden="true">
      <path d="M2 12c2.5-6 5.5-6 8 0s5.5 6 8 0 2-3 4-3" />
    </svg>
  );
}

/** Эффекты дорожки — ползунки микшера. */
export function SlidersIcon() {
  return (
    <svg {...ICON_PROPS} width={13} height={13} aria-hidden="true">
      <path d="M6 3v18M12 3v18M18 3v18" />
      <path d="M4 15h4M10 8h4M16 13h4" />
    </svg>
  );
}

/** Обменять — две стрелки навстречу. */
export function SwapIcon() {
  return (
    <svg {...ICON_PROPS} width={13} height={13} aria-hidden="true">
      <path d="M4 8h15l-4-4" />
      <path d="M20 16H5l4 4" />
    </svg>
  );
}

/** Скачать / сохранить в файл: стрелка вниз в лоток. */
export function DownloadIcon() {
  return (
    <svg {...ICON_PROPS} width={12} height={12} aria-hidden="true">
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 17v3h16v-3" />
    </svg>
  );
}

/** Автоматика (генератор, автопостановка) — молния. */
export function BoltIcon() {
  return (
    <svg {...ICON_PROPS} width={13} height={13} aria-hidden="true">
      <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8Z" />
    </svg>
  );
}

/** Из видео — кадр плёнки. */
export function FilmIcon() {
  return (
    <svg {...ICON_PROPS} width={14} height={14} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
    </svg>
  );
}

/** Видеоролик — камера. */
export function VideoIcon() {
  return (
    <svg {...ICON_PROPS} width={14} height={14} aria-hidden="true">
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M16 10l6-3v10l-6-3" />
    </svg>
  );
}

/** Музыка — нота. */
export function MusicIcon() {
  return (
    <svg {...ICON_PROPS} width={13} height={13} aria-hidden="true">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

/** Запись — залитый кружок. */
export function RecordIcon() {
  return (
    <svg {...ICON_PROPS} width={10} height={10} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="currentColor" />
    </svg>
  );
}

/** Вернуть вид (камера 3D) — круговая стрелка. */
export function ResetViewIcon() {
  return (
    <svg {...ICON_PROPS} width={13} height={13} aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 3v6h6" />
    </svg>
  );
}

/** Справка — вопросительный знак значком: символ «?» шрифта стоял на 3 px выше середины кружка. */
export function HelpIcon() {
  return (
    <svg {...ICON_PROPS} width={14} height={14} aria-hidden="true">
      {/* Поднят на 1,3 единицы: без этого знак стоял ниже середины кружка. */}
      <path d="M9 7.9a3 3 0 0 1 5.8 1c0 2-3 2.6-3 4.3" />
      <path d="M11.8 16.9h.01" strokeWidth={2.6} />
    </svg>
  );
}
