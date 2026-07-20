/**
 * Служебное освещение (§27 доработки, по примеру прежнего приложения —
 * «Switches») — простое вкл/выкл по времени суток для выбранных приборов
 * (например, периметральная подсветка), независимо от основного расписания
 * шоу/плейлистов. «Всегда включено» — обязательный ручной оверрайд (в старом
 * приложении расписание без него работало нестабильно — здесь он не костыль
 * для бага, а штатная кнопка «не доверяю расписанию сегодня»).
 */
export interface UtilityLightConfig {
  enabled: boolean;
  deviceIds: string[];
  always: boolean;
  /** «ЧЧ:ММ», локальное время ПК движка. */
  onTime: string;
  offTime: string;
}

export function defaultUtilityLightConfig(): UtilityLightConfig {
  return { enabled: false, deviceIds: [], always: false, onTime: '20:00', offTime: '23:00' };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function sanitizeUtilityLightConfig(raw: unknown, deviceIds: Set<string>): UtilityLightConfig {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<UtilityLightConfig>;
  return {
    enabled: r.enabled === true,
    deviceIds: Array.isArray(r.deviceIds)
      ? r.deviceIds.filter((id): id is string => typeof id === 'string' && deviceIds.has(id))
      : [],
    always: r.always === true,
    onTime: typeof r.onTime === 'string' && TIME_RE.test(r.onTime) ? r.onTime : '20:00',
    offTime: typeof r.offTime === 'string' && TIME_RE.test(r.offTime) ? r.offTime : '23:00',
  };
}

/** Попадает ли now в окно onTime–offTime (окно переходит через полночь, если onTime > offTime). Не проверяет enabled. */
export function isUtilityLightOn(cfg: UtilityLightConfig, now: Date): boolean {
  if (cfg.always) return true;
  const mins = now.getHours() * 60 + now.getMinutes();
  const [onH, onM] = cfg.onTime.split(':').map(Number);
  const [offH, offM] = cfg.offTime.split(':').map(Number);
  const on = onH! * 60 + onM!;
  const off = offH! * 60 + offM!;
  if (on === off) return true;
  return on < off ? mins >= on && mins < off : mins >= on || mins < off;
}
