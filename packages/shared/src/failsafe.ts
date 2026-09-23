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
  /**
   * Что гасить — три отдельные галочки (заказчик 23.09.2026). Раньше вода
   * гасилась всегда, а свет — по галочке «Гасить и свет»; на части объектов
   * клапаны держат открытыми (ливнёвка, перелив), а насосы глушат, и
   * наоборот. По умолчанию — всё.
   */
  pumps: boolean;
  valves: boolean;
  lights: boolean;
}

export function defaultFailsafeConfig(): FailsafeConfig {
  return { enabled: true, timeoutSec: 10, pumps: true, valves: true, lights: true };
}

/** Что именно гасится — для журнала и подписей («насосы, клапаны и свет»). */
export function failsafeTargetsText(cfg: Pick<FailsafeConfig, 'pumps' | 'valves' | 'lights'>): string {
  const parts = [cfg.pumps ? 'насосы' : '', cfg.valves ? 'клапаны' : '', cfg.lights ? 'свет' : ''].filter(Boolean);
  if (parts.length === 0) return 'ничего (все три галочки сняты)';
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} и ${parts[parts.length - 1]}`;
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
    pumps: typeof r.pumps === 'boolean' ? r.pumps : d.pumps,
    valves: typeof r.valves === 'boolean' ? r.valves : d.valves,
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
  /**
   * Выход прямо сейчас не доставляет кадры приборам (интерфейс не найден,
   * порт закрыт, кабель выдернут). Отдельно от active, потому что это две
   * разные вещи, и на столе видно только вторую: беда может длиться, а
   * гашение — не сработать (режим отладки) или ещё не отсчитать timeoutSec.
   * Пока флага не было, полоса с кнопкой «выключить на время отладки» то
   * появлялась, то исчезала — по мгновенному active, а не по причине.
   */
  linkBad: boolean;
  /** Режим отладки: гашение на этом компьютере не срабатывает (см. setBenchMode). */
  benchMode: boolean;
}
