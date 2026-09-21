import { clampSmoothness, smoothReachSec, SMOOTHNESS_MAX, SMOOTHNESS_MIN } from '@fountain-studio/shared';

/**
 * Поле «плавность 1…100» — одно на все эффекты плавности (дорожки шоу и
 * секвенсоры), чтобы шкала везде читалась одинаково: больше — плавнее, и рядом
 * сразу сказано время. Раньше в «Шоу» было «сила 1…100», а в «Секвенсорах»
 * просто «Сила:», и шла она наоборот — 1 была самой плавной (см. smoothing.ts).
 */
export function SmoothnessField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <>
      <label data-hint="Больше — плавнее. 1 — переход за 0,1 с (почти мгновенно), 100 — за 10 с. Каждая единица — десятая доля секунды.">
        плавность {SMOOTHNESS_MIN}…{SMOOTHNESS_MAX}:{' '}
        <input
          className="input input-num"
          type="number"
          min={SMOOTHNESS_MIN}
          max={SMOOTHNESS_MAX}
          value={value}
          onChange={(ev) => onChange(clampSmoothness(Number(ev.target.value) || SMOOTHNESS_MIN))}
        />
      </label>
      <span
        className="dim"
        data-hint="За сколько значение доходит до цели при полном перепаде 0 → 255 (с точностью до одной единицы). Меньший перепад проходит быстрее."
      >
        ≈ {smoothReachSec(value).toLocaleString('ru-RU')} с до цели
      </span>
    </>
  );
}
