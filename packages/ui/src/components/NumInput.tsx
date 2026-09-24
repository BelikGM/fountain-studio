import { useRef, useState, type CSSProperties, type FocusEvent } from 'react';

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
 * годное (пусто, вне пределов) — не уходит, поле подсвечивается красным, а
 * onDraft сообщает набранное, чтобы рядом можно было написать причину. При
 * выходе из поля число подрезается в пределы, пустое возвращается к прежнему.
 *
 * Стрелки — всегда ровно на шаг от числа в поле: это общее правило для всех
 * числовых полей программы (numStep.ts).
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
  onDraft,
  commitOnBlur = false,
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
  /** Что набрано, пока поле в фокусе (и вне пределов тоже); null — поле отпущено или пусто. */
  onDraft?: (v: number | null) => void;
  /**
   * Наружу — только при выходе из поля или Enter, без промежуточных чисел.
   * Для адреса прибора (заказчик 25.09.2026): набирая «513» поверх «51…»,
   * поле на миг ставило прибор на 51, и соседний прибор на 51 краснел
   * «пересечением». Esc — вернуть, как было.
   */
  commitOnBlur?: boolean;
}) {
  /** Набранный текст, пока поле в фокусе; null — показываем значение. */
  const [text, setText] = useState<string | null>(null);
  /** Esc: выйти из поля, ничего не меняя (blur срабатывает раньше, чем обновится text). */
  const cancel = useRef(false);
  const parse = (t: string): number | null => {
    if (t.trim() === '') return null;
    const v = Number(t.replace(',', '.'));
    if (!Number.isFinite(v)) return null;
    return integer ? Math.round(v) : v;
  };
  const inRange = (v: number): boolean => (min === undefined || v >= min) && (max === undefined || v <= max);
  const clamp = (v: number): number => Math.min(max ?? v, Math.max(min ?? v, v));
  const typed = text === null ? null : parse(text);
  const outside = typed !== null && !inRange(typed);
  const limits =
    min !== undefined && max !== undefined ? `от ${min} до ${max}` : min !== undefined ? `не меньше ${min}` : `не больше ${max}`;

  return (
    <input
      className={outside ? `${className} input-error` : className}
      style={style}
      type="number"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      data-hint={outside ? `Допустимо ${limits}. Выйдете из поля — число подрежется до ближайшего допустимого.` : hint}
      value={text ?? String(value)}
      onFocus={(e) => {
        setText(String(value));
        onFocus?.(e);
      }}
      onChange={(e) => {
        const v = parse(e.target.value);
        // Набранный текст держим, только пока поле в фокусе: иначе после
        // смены значения снаружи (кнопка «40» рядом) поле показывало бы старое.
        if (document.activeElement === e.target) setText(e.target.value);
        onDraft?.(v);
        if (!commitOnBlur && v !== null && inRange(v) && v !== value) onChange(v);
      }}
      onKeyDown={
        commitOnBlur
          ? (e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') {
                cancel.current = true;
                e.currentTarget.blur();
              }
            }
          : undefined
      }
      onBlur={(e) => {
        const v = text === null || cancel.current ? null : parse(text);
        cancel.current = false;
        setText(null);
        onDraft?.(null);
        if (v !== null && clamp(v) !== value) onChange(clamp(v));
        onBlur?.(e);
      }}
    />
  );
}
