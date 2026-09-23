/**
 * Настройки управления камерой 3D-вида.
 *
 * Умолчания OrbitControls (вращение 1.0, панорама 1.0) на этой сцене
 * несбалансированы: вращение уносит вид от одного движения мыши, а панорама,
 * наоборот, еле ползёт. Здесь заданы выверенные значения и дана регулировка —
 * чувствительность мыши у всех разная, и это предпочтение конкретного
 * компьютера, а не часть проекта, поэтому хранится в localStorage.
 */
export interface ViewPrefs {
  /** Множитель скорости вращения (ЛКМ). */
  rotateSpeed: number;
  /** Множитель скорости панорамы (ПКМ). */
  panSpeed: number;
}

const KEY = 'fountain.view.prefs';

/** Умолчания: вращение приторможено вдвое, панорама ускорена вдвое. */
export const VIEW_PREF_DEFAULTS: ViewPrefs = { rotateSpeed: 0.45, panSpeed: 2 };
/** Допустимые пределы регулировок [минимум, максимум, шаг]. */
/**
 * Шаг — 0,01: ползунок почти непрерывный (заказчик 24.09.2026: шаг 0,05 и
 * 0,1 ощущался ступеньками).
 */
export const VIEW_PREF_LIMITS = {
  rotateSpeed: [0.1, 1.5, 0.01] as const,
  panSpeed: [0.3, 5, 0.01] as const,
};

const clamp = (v: number, [lo, hi]: readonly [number, number, number]): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : NaN;

function load(): ViewPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...VIEW_PREF_DEFAULTS };
    const p = JSON.parse(raw) as Partial<ViewPrefs>;
    const r = clamp(Number(p.rotateSpeed), VIEW_PREF_LIMITS.rotateSpeed);
    const pa = clamp(Number(p.panSpeed), VIEW_PREF_LIMITS.panSpeed);
    return {
      rotateSpeed: Number.isFinite(r) ? r : VIEW_PREF_DEFAULTS.rotateSpeed,
      panSpeed: Number.isFinite(pa) ? pa : VIEW_PREF_DEFAULTS.panSpeed,
    };
  } catch {
    return { ...VIEW_PREF_DEFAULTS };
  }
}

let current: ViewPrefs = load();
const listeners = new Set<(p: ViewPrefs) => void>();

/** Текущие настройки управления камерой. */
export function viewPrefs(): ViewPrefs {
  return current;
}

/** Меняет настройки и сразу применяет их ко всем открытым сценам. */
export function setViewPrefs(patch: Partial<ViewPrefs>): void {
  const next: ViewPrefs = {
    rotateSpeed: clamp(patch.rotateSpeed ?? current.rotateSpeed, VIEW_PREF_LIMITS.rotateSpeed),
    panSpeed: clamp(patch.panSpeed ?? current.panSpeed, VIEW_PREF_LIMITS.panSpeed),
  };
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Приватный режим браузера — настройка просто не переживёт перезапуск.
  }
  for (const f of listeners) f(next);
}

/** Подписка на изменение — сцена применяет новые скорости без перезагрузки. */
export function onViewPrefs(f: (p: ViewPrefs) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
