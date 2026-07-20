/**
 * Группа секвенсоров (§27 доработки — «сделать правильно» синхронный/
 * параллельный запуск, который в прежнем приложении был реализован плохо и
 * упразднён). Идея та же — запустить несколько секвенсоров вместе одним
 * действием (например, воду и свет), но без отдельной машины синхронизации:
 * достаточно вызвать start на каждом участнике в ОДНОМ тике движка. Наши
 * секвенсоры уже считают elapsed от абсолютного nowMs (не копят дельты
 * тик-к-тику), так что участники, стартовавшие в один и тот же момент,
 * физически не могут разойтись по времени — в отличие от инкрементальных
 * таймеров, которые и были причиной старого бага.
 */
export interface SequenceGroup {
  id: string;
  name: string;
  sequenceIds: string[];
}

export function sanitizeSequenceGroups(raw: unknown, sequenceIds: Set<string>): SequenceGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: SequenceGroup[] = [];
  for (const g of raw as SequenceGroup[]) {
    if (!g || typeof g.id !== 'string') continue;
    out.push({
      id: g.id,
      name: typeof g.name === 'string' ? g.name : 'Группа',
      sequenceIds: Array.isArray(g.sequenceIds)
        ? [...new Set(g.sequenceIds.filter((id): id is string => typeof id === 'string' && sequenceIds.has(id)))]
        : [],
    });
  }
  return out;
}
