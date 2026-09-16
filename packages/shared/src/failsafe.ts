/**
 * Аварийное отключение (failsafe): что делать, когда движок перестал нормально
 * выдавать кадры на линию.
 *
 * Зачем. DMX512 — протокол состояния: приёмник держит ПОСЛЕДНЕЕ принятое
 * значение. Если поток кадров прервался, приборы не гаснут сами — насос
 * продолжит крутиться на той же уставке, клапан останется открытым, струя —
 * поднятой. Для фонтана без дежурного это опаснее, чем погасить всё.
 *
 * Поэтому движок сам следит за двумя вещами и, если беда длится дольше
 * timeoutSec, принудительно кладёт в кадр безопасные значения:
 *  · такт встал — event loop подвис (сон Windows, тяжёлая операция, антивирус);
 *  · выход не доставляет — USB-интерфейс выдернули, порт закрылся.
 *
 * Когда причина уходит, движок так же сам возвращается к обычной картине —
 * продолжает слать то, что должно идти по сценам/шоу.
 *
 * Чего этим НЕ закрыть: если процесс движка убит целиком, слать безопасный
 * кадр уже некому — там работает сторож (`npm run engine:watchdog`), который
 * поднимает движок заново, а поднявшийся движок стартует с нулей.
 */
export interface FailsafeConfig {
  enabled: boolean;
  /** Сколько секунд беды терпим, прежде чем гасить. */
  timeoutSec: number;
  /** Гасить ли заодно свет (воду гасим всегда). */
  lights: boolean;
}

export function defaultFailsafeConfig(): FailsafeConfig {
  return { enabled: true, timeoutSec: 10, lights: true };
}

export const FAILSAFE_TIMEOUT_MIN_SEC = 3;
export const FAILSAFE_TIMEOUT_MAX_SEC = 120;

export function sanitizeFailsafeConfig(raw: unknown): FailsafeConfig {
  const d = defaultFailsafeConfig();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<FailsafeConfig>;
  const t = Math.round(Number(r.timeoutSec));
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    timeoutSec: Number.isFinite(t) ? Math.min(FAILSAFE_TIMEOUT_MAX_SEC, Math.max(FAILSAFE_TIMEOUT_MIN_SEC, t)) : d.timeoutSec,
    lights: typeof r.lights === 'boolean' ? r.lights : d.lights,
  };
}

/** Что сейчас с аварийным отключением — для вкладки «Настройки» и уведомлений. */
export interface FailsafeState {
  active: boolean;
  /** Человеческая причина, пока active; пусто, когда всё в порядке. */
  reason: string;
  /** С какого момента держится (unix-время, мс); 0 — не активно. */
  sinceMs: number;
  /** Сколько раз срабатывало с запуска движка. */
  trips: number;
}
