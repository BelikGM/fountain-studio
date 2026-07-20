/**
 * Датчик ветра → безопасное снижение струй (§27 доработки, §4 п.1) —
 * классическая фонтанная автоматика: ветер выше порога — высота струй
 * (мощность насосов) ограничивается. Применяется только к каналам intensity
 * устройств-насосов (kind='pump') — свет не трогает.
 *
 * Пока нет конкретной модели анемометра под рукой — источник скорости ветра
 * ручной ввод оператора (вкладка «Настройки»), тот же расчёт лимита; когда
 * появится датчик по Modbus/MQTT, он будет просто писать то же значение
 * автоматически вместо ручного ввода — сам расчёт трогать не придётся.
 */
export interface WindLimitConfig {
  enabled: boolean;
  /** м/с — до этой скорости ограничения нет (100%). */
  warnSpeed: number;
  /** м/с — на этой скорости и выше высота снижена до minPercent. */
  maxSpeed: number;
  /** 0–100 — до какого % снижается мощность насосов при maxSpeed и выше. */
  minPercent: number;
}

export function defaultWindLimitConfig(): WindLimitConfig {
  return { enabled: false, warnSpeed: 8, maxSpeed: 15, minPercent: 20 };
}

/** 100 — без ограничений; линейно снижается между warnSpeed и maxSpeed. */
export function computeWindLimitPercent(speedMs: number, cfg: WindLimitConfig): number {
  if (!cfg.enabled) return 100;
  if (speedMs <= cfg.warnSpeed) return 100;
  if (speedMs >= cfg.maxSpeed) return cfg.minPercent;
  const t = (speedMs - cfg.warnSpeed) / (cfg.maxSpeed - cfg.warnSpeed);
  return Math.round(100 - t * (100 - cfg.minPercent));
}

export function sanitizeWindLimitConfig(raw: unknown): WindLimitConfig {
  const d = defaultWindLimitConfig();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<WindLimitConfig>;
  const warnSpeed = Number.isFinite(r.warnSpeed) ? Math.max(0, r.warnSpeed!) : d.warnSpeed;
  const maxSpeed = Number.isFinite(r.maxSpeed) ? Math.max(warnSpeed + 0.1, r.maxSpeed!) : Math.max(warnSpeed + 1, d.maxSpeed);
  const minPercent = Number.isFinite(r.minPercent) ? Math.max(0, Math.min(100, Math.round(r.minPercent!))) : d.minPercent;
  return { enabled: r.enabled === true, warnSpeed, maxSpeed, minPercent };
}
