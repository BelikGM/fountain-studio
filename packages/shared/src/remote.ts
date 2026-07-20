/**
 * Общее действие для дистанционного управления (OSC, MQTT) — то же самое, что
 * умеют клавиши (keys.ts) и расписание (playlist.ts::ScheduleAction), но
 * отдельный тип: у клавиш/расписания уже есть свои устоявшиеся формы, трогать
 * их не нужно, а OSC/MQTT — новые потребители с одинаковыми нуждами обоих.
 * Диспетчеризация в движке — remotedispatch.ts.
 */
export type RemoteAction =
  | { type: 'scene'; refId: string }
  | { type: 'sequence'; refId: string }
  | { type: 'show'; refId: string }
  | { type: 'playlist'; refId: string }
  | { type: 'stopAll' }
  | { type: 'blackout' };

export interface OscBinding {
  id: string;
  /** OSC-адрес вида "/scene/1" — точное совпадение (без масок OSC-паттернов). */
  address: string;
  action: RemoteAction;
}

export interface MqttBinding {
  id: string;
  /** Суффикс топика команд после `${topicPrefix}/cmd/`, напр. "scene-a". */
  topic: string;
  action: RemoteAction;
}

/**
 * Триггер по входящему DMX (§27 доработки, §4 п.4) — внешний пульт/консоль
 * шлёт DMX в наш захват (тот же путь, что getDmxCapture/measureDmxCycle),
 * значение канала в диапазоне [valueMin, valueMax] запускает действие.
 * Срабатывает по фронту (переход снаружи диапазона внутрь) — держащийся на
 * значении фейдер/кнопка не спамит действие на каждый кадр DMX (~40 Гц),
 * тот же принцип, что у OSC-биндингов (там отдельно игнорируется «отпускание»).
 */
export interface DmxTrigger {
  id: string;
  universe: number;
  /** DMX-адрес канала, 1..512. */
  address: number;
  /** Включительно: valueMin <= value <= valueMax — «внутри диапазона». */
  valueMin: number;
  valueMax: number;
  action: RemoteAction;
}

type RemoteIds = { scenes: Set<string>; sequences: Set<string>; shows: Set<string>; playlists: Set<string> };

function sanitizeRemoteAction(a: unknown, ids: RemoteIds): RemoteAction | null {
  if (!a || typeof a !== 'object') return null;
  const r = a as { type?: unknown; refId?: unknown };
  if (r.type === 'stopAll' || r.type === 'blackout') return { type: r.type };
  if (r.type === 'scene' && typeof r.refId === 'string' && ids.scenes.has(r.refId)) return { type: 'scene', refId: r.refId };
  if (r.type === 'sequence' && typeof r.refId === 'string' && ids.sequences.has(r.refId)) {
    return { type: 'sequence', refId: r.refId };
  }
  if (r.type === 'show' && typeof r.refId === 'string' && ids.shows.has(r.refId)) return { type: 'show', refId: r.refId };
  if (r.type === 'playlist' && typeof r.refId === 'string' && ids.playlists.has(r.refId)) {
    return { type: 'playlist', refId: r.refId };
  }
  return null;
}

export function sanitizeOscBindings(raw: unknown, ids: RemoteIds): OscBinding[] {
  if (!Array.isArray(raw)) return [];
  const out: OscBinding[] = [];
  const used = new Set<string>();
  for (const b of raw as OscBinding[]) {
    if (!b || typeof b.id !== 'string' || typeof b.address !== 'string' || !b.address.startsWith('/')) continue;
    if (used.has(b.address)) continue;
    const action = sanitizeRemoteAction(b.action, ids);
    if (!action) continue;
    used.add(b.address);
    out.push({ id: b.id, address: b.address, action });
  }
  return out;
}

export function sanitizeMqttBindings(raw: unknown, ids: RemoteIds): MqttBinding[] {
  if (!Array.isArray(raw)) return [];
  const out: MqttBinding[] = [];
  const used = new Set<string>();
  for (const b of raw as MqttBinding[]) {
    if (!b || typeof b.id !== 'string' || typeof b.topic !== 'string' || b.topic.trim() === '') continue;
    if (used.has(b.topic)) continue;
    const action = sanitizeRemoteAction(b.action, ids);
    if (!action) continue;
    used.add(b.topic);
    out.push({ id: b.id, topic: b.topic.trim(), action });
  }
  return out;
}

export function sanitizeDmxTriggers(raw: unknown, ids: RemoteIds): DmxTrigger[] {
  if (!Array.isArray(raw)) return [];
  const out: DmxTrigger[] = [];
  for (const t of raw as DmxTrigger[]) {
    if (!t || typeof t.id !== 'string') continue;
    if (!Number.isInteger(t.universe) || t.universe < 1) continue;
    if (!Number.isInteger(t.address) || t.address < 1 || t.address > 512) continue;
    const action = sanitizeRemoteAction(t.action, ids);
    if (!action) continue;
    const valueMin = Number.isFinite(t.valueMin) ? Math.max(0, Math.min(255, Math.round(t.valueMin))) : 128;
    const valueMax = Number.isFinite(t.valueMax) ? Math.max(valueMin, Math.min(255, Math.round(t.valueMax))) : 255;
    out.push({ id: t.id, universe: t.universe, address: t.address, valueMin, valueMax, action });
  }
  return out;
}
