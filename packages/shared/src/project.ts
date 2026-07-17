import { DMX_UNIVERSE_SIZE } from './dmx';

/**
 * Модель проекта Fountain Studio: профили устройств, патч (привязка к адресам),
 * сцены (статические картины) и секвенсоры (последовательности сцен).
 * Проект хранится открытым JSON в fountain.project.json рядом с конфигом движка.
 */

/** Роль канала внутри профиля устройства — определяет элемент управления в UI. */
export type ChannelRole =
  | 'intensity' // яркость / производительность насоса 0–255
  | 'red'
  | 'green'
  | 'blue'
  | 'white'
  | 'open' // двухпозиционный: 0 = закрыт, 255 = открыт
  | 'custom';

export interface ProfileChannel {
  name: string;
  role: ChannelRole;
}

/** Вид устройства — для группировки и подбора элементов управления. */
export type DeviceKind = 'pump' | 'valve' | 'lamp' | 'other';

export interface DeviceProfile {
  id: string;
  name: string;
  kind: DeviceKind;
  /** Каналы по порядку — их число задаёт, сколько адресов занимает устройство. */
  channels: ProfileChannel[];
  /** true — устройство двухпозиционное (клапан): каналы держат только 0 или 255. */
  twoState?: boolean;
  /** Встроенный профиль (не хранится в файле проекта, добавляется кодом). */
  builtin?: boolean;
}

/** Устройство, поставленное в патч: профиль + вселенная + первый адрес. */
export interface PatchedDevice {
  id: string;
  name: string;
  profileId: string;
  /** Логический id вселенной проекта. */
  universe: number;
  /** Первый занимаемый DMX-адрес, 1..512. */
  address: number;
}

/** Статическая картина: deviceId → значения каналов устройства по порядку профиля. */
export interface Scene {
  id: string;
  name: string;
  values: Record<string, number[]>;
}

export interface SequenceStep {
  sceneId: string;
  /** Длительность шага, мс (фейд идёт внутри неё). */
  holdMs: number;
  /** Плавный переход из предыдущего состояния, мс. 0 — резкое переключение. */
  fadeMs: number;
}

export type SequenceMode = 'loop' | 'once';

export interface Sequence {
  id: string;
  name: string;
  mode: SequenceMode;
  steps: SequenceStep[];
}

export interface Project {
  formatVersion: 1;
  name: string;
  /** Пользовательские профили (встроенные добавляются кодом, см. BUILTIN_PROFILES). */
  profiles: DeviceProfile[];
  devices: PatchedDevice[];
  scenes: Scene[];
  sequences: Sequence[];
}

/** Встроенные профили — типовые устройства фонтана. */
export const BUILTIN_PROFILES: DeviceProfile[] = [
  {
    id: 'pump',
    name: 'Насос (аналог 0–255)',
    kind: 'pump',
    channels: [{ name: 'Мощность', role: 'intensity' }],
    builtin: true,
  },
  {
    id: 'valve',
    name: 'Клапан (откр/закр)',
    kind: 'valve',
    channels: [{ name: 'Открыт', role: 'open' }],
    twoState: true,
    builtin: true,
  },
  {
    id: 'dimmer',
    name: 'Одноканальный свет',
    kind: 'lamp',
    channels: [{ name: 'Яркость', role: 'intensity' }],
    builtin: true,
  },
  {
    id: 'rgb',
    name: 'Светильник RGB',
    kind: 'lamp',
    channels: [
      { name: 'R', role: 'red' },
      { name: 'G', role: 'green' },
      { name: 'B', role: 'blue' },
    ],
    builtin: true,
  },
  {
    id: 'rgbw',
    name: 'Светильник RGBW',
    kind: 'lamp',
    channels: [
      { name: 'R', role: 'red' },
      { name: 'G', role: 'green' },
      { name: 'B', role: 'blue' },
      { name: 'W', role: 'white' },
    ],
    builtin: true,
  },
];

export function emptyProject(name = 'Новый проект'): Project {
  return { formatVersion: 1, name, profiles: [], devices: [], scenes: [], sequences: [] };
}

/** Все профили проекта: встроенные + пользовательские (пользовательский с тем же id побеждает). */
export function allProfiles(project: Project): DeviceProfile[] {
  const custom = new Map(project.profiles.map((p) => [p.id, p]));
  return [...BUILTIN_PROFILES.filter((p) => !custom.has(p.id)), ...project.profiles];
}

export function profileMap(project: Project): Map<string, DeviceProfile> {
  return new Map(allProfiles(project).map((p) => [p.id, p]));
}

/** Диапазон адресов устройства (включительно). end может выйти за 512 — это ошибка патча. */
export function deviceRange(
  device: PatchedDevice,
  profiles: Map<string, DeviceProfile>,
): { start: number; end: number } {
  const size = profiles.get(device.profileId)?.channels.length ?? 1;
  return { start: device.address, end: device.address + size - 1 };
}

export interface PatchIssues {
  /** id устройств, чьи адреса пересекаются с другим устройством той же вселенной. */
  collisions: Set<string>;
  /** id устройств, выходящих за пределы 1..512. */
  outOfRange: Set<string>;
}

export function findPatchIssues(project: Project): PatchIssues {
  const profiles = profileMap(project);
  const collisions = new Set<string>();
  const outOfRange = new Set<string>();
  const byUniverse = new Map<number, PatchedDevice[]>();
  for (const d of project.devices) {
    const r = deviceRange(d, profiles);
    if (r.start < 1 || r.end > DMX_UNIVERSE_SIZE) outOfRange.add(d.id);
    const list = byUniverse.get(d.universe) ?? [];
    list.push(d);
    byUniverse.set(d.universe, list);
  }
  for (const list of byUniverse.values()) {
    for (let i = 0; i < list.length; i++) {
      const a = deviceRange(list[i]!, profiles);
      for (let j = i + 1; j < list.length; j++) {
        const b = deviceRange(list[j]!, profiles);
        if (a.start <= b.end && b.start <= a.end) {
          collisions.add(list[i]!.id);
          collisions.add(list[j]!.id);
        }
      }
    }
  }
  return { collisions, outOfRange };
}

/**
 * Первый свободный адрес во вселенной, где помещается устройство размером size,
 * начиная поиск с fromAddress. null — свободного места нет.
 */
export function nextFreeAddress(
  project: Project,
  universe: number,
  size: number,
  fromAddress = 1,
): number | null {
  const profiles = profileMap(project);
  const occupied = new Uint8Array(DMX_UNIVERSE_SIZE + 1);
  for (const d of project.devices) {
    if (d.universe !== universe) continue;
    const r = deviceRange(d, profiles);
    for (let a = Math.max(1, r.start); a <= Math.min(DMX_UNIVERSE_SIZE, r.end); a++) occupied[a] = 1;
  }
  for (let start = Math.max(1, fromAddress); start + size - 1 <= DMX_UNIVERSE_SIZE; start++) {
    let free = true;
    for (let a = start; a < start + size; a++) {
      if (occupied[a]) {
        free = false;
        start = a; // перескок к концу занятого блока (цикл затем сделает +1)
        break;
      }
    }
    if (free) return start;
  }
  return null;
}

/** Короткий уникальный id для сущностей проекта. */
export function uid(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

/**
 * Приводит произвольный JSON к корректной структуре проекта: добавляет недостающие
 * поля, отбрасывает битые записи. Используется движком при загрузке файла и приёме
 * проекта от редактора — гарантия, что дальше по коду структура всегда валидна.
 */
export function sanitizeProject(raw: unknown): Project {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const project: Project = {
    formatVersion: 1,
    name: typeof r.name === 'string' && r.name.trim() !== '' ? r.name : 'Новый проект',
    profiles: [],
    devices: [],
    scenes: [],
    sequences: [],
  };
  if (Array.isArray(r.profiles)) {
    for (const p of r.profiles as DeviceProfile[]) {
      if (!p || typeof p.id !== 'string' || !Array.isArray(p.channels) || p.channels.length === 0) continue;
      project.profiles.push({
        id: p.id,
        name: typeof p.name === 'string' ? p.name : p.id,
        kind: (['pump', 'valve', 'lamp', 'other'] as DeviceKind[]).includes(p.kind) ? p.kind : 'other',
        channels: p.channels
          .filter((c) => c && typeof c === 'object')
          .map((c) => ({ name: typeof c.name === 'string' ? c.name : '?', role: c.role ?? 'custom' })),
        twoState: p.twoState === true || undefined,
      });
    }
  }
  const profiles = profileMap(project);
  if (Array.isArray(r.devices)) {
    for (const d of r.devices as PatchedDevice[]) {
      if (!d || typeof d.id !== 'string' || !profiles.has(d.profileId)) continue;
      project.devices.push({
        id: d.id,
        name: typeof d.name === 'string' ? d.name : d.id,
        profileId: d.profileId,
        universe: Number.isInteger(d.universe) ? d.universe : 1,
        address: Number.isInteger(d.address) ? Math.max(1, Math.min(DMX_UNIVERSE_SIZE, d.address)) : 1,
      });
    }
  }
  const deviceIds = new Set(project.devices.map((d) => d.id));
  if (Array.isArray(r.scenes)) {
    for (const s of r.scenes as Scene[]) {
      if (!s || typeof s.id !== 'string') continue;
      const values: Record<string, number[]> = {};
      if (s.values && typeof s.values === 'object') {
        for (const [devId, vals] of Object.entries(s.values)) {
          if (!deviceIds.has(devId) || !Array.isArray(vals)) continue;
          values[devId] = vals.map((v) => (Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0));
        }
      }
      project.scenes.push({ id: s.id, name: typeof s.name === 'string' ? s.name : s.id, values });
    }
  }
  const sceneIds = new Set(project.scenes.map((s) => s.id));
  if (Array.isArray(r.sequences)) {
    for (const q of r.sequences as Sequence[]) {
      if (!q || typeof q.id !== 'string') continue;
      project.sequences.push({
        id: q.id,
        name: typeof q.name === 'string' ? q.name : q.id,
        mode: q.mode === 'once' ? 'once' : 'loop',
        steps: (Array.isArray(q.steps) ? q.steps : [])
          .filter((st) => st && sceneIds.has(st.sceneId))
          .map((st) => ({
            sceneId: st.sceneId,
            holdMs: Number.isFinite(st.holdMs) ? Math.max(50, Math.round(st.holdMs)) : 1000,
            fadeMs: Number.isFinite(st.fadeMs) ? Math.max(0, Math.round(st.fadeMs)) : 0,
          })),
      });
    }
  }
  return project;
}
