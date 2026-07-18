import type { FountainLayout } from './layout';
import type { DeviceProfile, PatchedDevice, Scene } from './project';
import { uid } from './project';

/**
 * Генераторы сцен (§17 п.2–3: вариации от существующих сцен, раскладка по фигуре
 * фонтана). Чистые детерминированные функции над геометрией патча — без ИИ,
 * без обучения на видео (то отдельный исследовательский спайк, не здесь).
 * Каждая функция даёт черновик сцены(-цен), который пользователь дорабатывает
 * как обычную сцену — ничего не «зашивается» на лету в движок.
 */

/** Устройство с координатами на схеме (форсунка/прожектор из project.layout). */
export interface GeoActor {
  deviceId: string;
  x: number;
  y: number;
}

export type ActorRole = 'pump' | 'valve' | 'light';

/** Собирает устройства-«актёры» с позициями по роли: насосы/клапаны — с форсунок, свет — с прожекторов схемы. */
export function layoutActors(layout: FountainLayout, role: ActorRole): GeoActor[] {
  const out: GeoActor[] = [];
  const seen = new Set<string>();
  if (role === 'light') {
    for (const l of layout.lights) {
      if (l.deviceId && !seen.has(l.deviceId)) {
        seen.add(l.deviceId);
        out.push({ deviceId: l.deviceId, x: l.x, y: l.y });
      }
    }
    return out;
  }
  const key = role === 'pump' ? 'pumpDeviceId' : 'valveDeviceId';
  for (const n of layout.nozzles) {
    const id = n[key];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({ deviceId: id, x: n.x, y: n.y });
    }
  }
  return out;
}

/** Инверсия: каждый канал 255-v (для клапана — переворачивает открыт/закрыт, для RGB — цветовой негатив). */
export function invertScene(scene: Scene): Scene {
  const values: Record<string, number[]> = {};
  for (const [deviceId, vals] of Object.entries(scene.values)) {
    values[deviceId] = vals.map((v) => 255 - Math.max(0, Math.min(255, Math.round(v))));
  }
  return { id: uid(), name: `${scene.name} (инверсия)`, values };
}

/**
 * Зеркало по оси X или Y: каждому устройству присваивается значение его
 * геометрически ближайшего «зеркального» соседа относительно центра масс
 * актёров этой роли. Устройства без позиции в схеме (не в actors) остаются
 * как в исходной сцене — зеркалить их не от чего.
 */
export function mirrorScene(scene: Scene, actors: GeoActor[], axis: 'x' | 'y'): Scene {
  const values: Record<string, number[]> = { ...scene.values };
  if (actors.length === 0) return { id: uid(), name: `${scene.name} (зеркало)`, values };
  const center =
    axis === 'x'
      ? actors.reduce((s, a) => s + a.x, 0) / actors.length
      : actors.reduce((s, a) => s + a.y, 0) / actors.length;
  for (const a of actors) {
    const targetCoord = 2 * center - (axis === 'x' ? a.x : a.y);
    const fixedCoord = axis === 'x' ? a.y : a.x;
    let best: GeoActor | null = null;
    let bestDist = Infinity;
    for (const b of actors) {
      const bCoord = axis === 'x' ? b.x : b.y;
      const bFixed = axis === 'x' ? b.y : b.x;
      const dist = Math.hypot(bCoord - targetCoord, bFixed - fixedCoord);
      if (dist < bestDist) {
        bestDist = dist;
        best = b;
      }
    }
    if (best && scene.values[best.deviceId]) values[a.deviceId] = [...scene.values[best.deviceId]!];
  }
  return { id: uid(), name: `${scene.name} (зеркало)`, values };
}

export interface WaveSceneOptions {
  centerX?: number;
  centerY?: number;
  /** Сколько волн укладывается по кругу (1 — одна волна, 2 — «бабочка» и т.п.). */
  cycles?: number;
  min?: number;
  max?: number;
  /** Фазовый сдвиг, градусы — набор сцен с разным сдвигом даёт бегущую волну в секвенсоре. */
  phaseDeg?: number;
}

/**
 * Волна по кругу от геометрии: значение устройства зависит от угла его форсунки/
 * прожектора относительно центра. Работает только с устройствами в один канал
 * (насос/клапан/диммер) — многоканальные (RGB и т.п.) генератор не трогает,
 * чтобы не гадать, как раскладывать волну по цвету.
 */
export function radialWaveScene(
  actors: GeoActor[],
  devices: PatchedDevice[],
  profiles: Map<string, DeviceProfile>,
  opts: WaveSceneOptions = {},
): Scene {
  const centerX = opts.centerX ?? actors.reduce((s, a) => s + a.x, 0) / (actors.length || 1);
  const centerY = opts.centerY ?? actors.reduce((s, a) => s + a.y, 0) / (actors.length || 1);
  const cycles = opts.cycles ?? 1;
  const min = Math.max(0, Math.min(255, opts.min ?? 0));
  const max = Math.max(min, Math.min(255, opts.max ?? 255));
  const phase = ((opts.phaseDeg ?? 0) * Math.PI) / 180;
  const byId = new Map(devices.map((d) => [d.id, d]));
  const values: Record<string, number[]> = {};
  for (const a of actors) {
    const device = byId.get(a.deviceId);
    const profile = device ? profiles.get(device.profileId) : undefined;
    if (!profile || profile.channels.length !== 1) continue;
    const angle = Math.atan2(a.y - centerY, a.x - centerX);
    const wave = (Math.sin(angle * cycles + phase) + 1) / 2; // 0..1
    const raw = Math.round(min + wave * (max - min));
    values[a.deviceId] = [profile.twoState ? (raw >= 128 ? 255 : 0) : raw];
  }
  return { id: uid(), name: 'Волна по кольцу', values };
}

/** Набор сцен с равномерным сдвигом фазы — добавить как шаги в секвенсор («по кругу») даёт бегущую волну/погоню. */
export function radialWaveSequenceScenes(
  actors: GeoActor[],
  devices: PatchedDevice[],
  profiles: Map<string, DeviceProfile>,
  steps: number,
  opts: Omit<WaveSceneOptions, 'phaseDeg'> = {},
): Scene[] {
  const out: Scene[] = [];
  const n = Math.max(1, Math.round(steps));
  for (let i = 0; i < n; i++) {
    const scene = radialWaveScene(actors, devices, profiles, { ...opts, phaseDeg: (360 * i) / n });
    out.push({ ...scene, name: `Волна ${i + 1}/${n}` });
  }
  return out;
}
