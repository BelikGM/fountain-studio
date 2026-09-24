import { useState, type CSSProperties, type FocusEvent } from 'react';

/**
 * Числовое поле, в котором можно спокойно набрать число целиком.
 *
 * Обычное `<input type="number" value={x} onChange={→Number}>` мешает
 * печатать: стёрли цифру — пустое поле тут же превращается в 0, набрали «-» —
 * поле сбрасывается. А в таблице приборов было хуже (заказчик 24.09.2026):
 * адрес «10» уже пересекался с другим прибором, строка переезжала по
 * сортировке, и курсор из поля пропадал посреди набора «109».
 *
 * Здесь, пока поле в фокусе, показывается то, что набрано, а наружу уходит
 * каждое ГОДНОЕ промежуточное число (правка видна сразу, как и раньше). Не
 * годное (пусто, вне пределов) — не уходит; при выходе из поля число
 * подрезается в пределы, пустое возвращается к прежнему значению.
 */
export function NumInput({
  value,
  onChange,
  min,
  max,
  step,
  integer = false,
  className = 'input input-num',
  style,
  disabled,
  hint,
  onFocus,
  onBlur,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  hint?: string;
  onFocus?: (e: FocusEvent<HTMLInputElement>) => void;
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
}) {
  /** Набранный текст, пока поле в фокусе; null — показываем значение. */
  const [text, setText] = useState<string | null>(null);
  const parse = (t: string): number | null => {
    if (t.trim() === '') return null;
    const v = Number(t.replace(',', '.'));
    if (!Number.isFinite(v)) return null;
    return integer ? Math.round(v) : v;
  };
  const inRange = (v: number): boolean => (min === undefined || v >= min) && (max === undefined || v <= max);
  const clamp = (v: number): number => Math.min(max ?? v, Math.max(min ?? v, v));
  return (
    <input
      className={className}
      style={style}
      type="number"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      data-hint={hint}
      value={text ?? String(value)}
      onFocus={(e) => {
        setText(String(value));
        onFocus?.(e);
      }}
      onChange={(e) => {
        setText(e.target.value);
        const v = parse(e.target.value);
        if (v !== null && inRange(v) && v !== value) onChange(v);
      }}
      onBlur={(e) => {
        const v = text === null ? null : parse(text);
        setText(null);
        if (v !== null && clamp(v) !== value) onChange(clamp(v));
        onBlur?.(e);
      }}
    />
  );
}
