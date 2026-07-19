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
  /** Сколько волн укладывается по фигуре (1 — одна волна, 2 — «бабочка» и т.п.). */
  cycles?: number;
  min?: number;
  max?: number;
  /** Фазовый сдвиг, градусы — набор сцен с разным сдвигом даёт бегущую волну в секвенсоре. */
  phaseDeg?: number;
  /**
   * Как считать фазу устройства по геометрии (§17 п.3: раскладка по реальной
   * фигуре фонтана — круг, квадрат, ромб, звезда, линия):
   * - 'angle' — угол вокруг центра (классика для круга);
   * - 'path'  — доля длины обхода контура (звезда/ромб/прямоугольник:
   *             волна бежит равномерно вдоль фигуры, а не по углу);
   * - 'line'  — проекция на главную ось разброса (линейный фонтан).
   */
  mode?: 'angle' | 'path' | 'line';
}

/** Фаза 0..1 каждого актёра по выбранной параметризации фигуры. */
export function actorPhases(actors: GeoActor[], mode: 'angle' | 'path' | 'line', centerX?: number, centerY?: number): Map<string, number> {
  const phases = new Map<string, number>();
  if (actors.length === 0) return phases;
  const cx = centerX ?? actors.reduce((s, a) => s + a.x, 0) / actors.length;
  const cy = centerY ?? actors.reduce((s, a) => s + a.y, 0) / actors.length;

  if (mode === 'angle') {
    for (const a of actors) {
      const angle = Math.atan2(a.y - cy, a.x - cx); // −π..π
      // p = angle/2π (mod 1): sin(2πp) ≡ sin(angle) — максимум волны на 90°.
      phases.set(a.deviceId, (angle < 0 ? angle + 2 * Math.PI : angle) / (2 * Math.PI));
    }
    return phases;
  }

  if (mode === 'line') {
    // Главная ось разброса (ковариация 2×2): волна бежит вдоль линии фонтана.
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const a of actors) {
      const dx = a.x - cx;
      const dy = a.y - cy;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(theta);
    const uy = Math.sin(theta);
    let minT = Infinity;
    let maxT = -Infinity;
    const ts = actors.map((a) => {
      const t = (a.x - cx) * ux + (a.y - cy) * uy;
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
      return t;
    });
    const span = maxT - minT || 1;
    actors.forEach((a, i) => phases.set(a.deviceId, (ts[i]! - minT) / span));
    return phases;
  }

  // 'path': обход по углу вокруг центра, фаза — накопленная длина хорд между
  // соседями по обходу, нормированная на периметр. Для круга совпадает с углом,
  // для вытянутых фигур (ромб/звезда/прямоугольник) волна бежит равномерно
  // по контуру, не сжимаясь на «дальних» участках.
  const ordered = [...actors].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  const dist = (p: GeoActor, q: GeoActor): number => Math.hypot(q.x - p.x, q.y - p.y);
  let perimeter = 0;
  const cumulative: number[] = [0];
  for (let i = 1; i < ordered.length; i++) {
    perimeter += dist(ordered[i - 1]!, ordered[i]!);
    cumulative.push(perimeter);
  }
  perimeter += dist(ordered[ordered.length - 1]!, ordered[0]!); // замыкание
  if (perimeter <= 0) perimeter = 1;
  ordered.forEach((a, i) => phases.set(a.deviceId, cumulative[i]! / perimeter));
  return phases;
}

/**
 * Волна по фигуре фонтана: значение устройства — от его фазы в выбранной
 * параметризации (угол/контур/линия). Работает только с устройствами в один
 * канал (насос/клапан/диммер) — многоканальные (RGB и т.п.) генератор не
 * трогает, чтобы не гадать, как раскладывать волну по цвету.
 */
export function radialWaveScene(
  actors: GeoActor[],
  devices: PatchedDevice[],
  profiles: Map<string, DeviceProfile>,
  opts: WaveSceneOptions = {},
): Scene {
  const cycles = opts.cycles ?? 1;
  const min = Math.max(0, Math.min(255, opts.min ?? 0));
  const max = Math.max(min, Math.min(255, opts.max ?? 255));
  const phaseShift = ((opts.phaseDeg ?? 0) * Math.PI) / 180;
  const mode = opts.mode ?? 'angle';
  const phases = actorPhases(actors, mode, opts.centerX, opts.centerY);
  const byId = new Map(devices.map((d) => [d.id, d]));
  const values: Record<string, number[]> = {};
  for (const a of actors) {
    const device = byId.get(a.deviceId);
    const profile = device ? profiles.get(device.profileId) : undefined;
    if (!profile || profile.channels.length !== 1) continue;
    const p = phases.get(a.deviceId) ?? 0;
    const wave = (Math.sin(2 * Math.PI * p * cycles + phaseShift) + 1) / 2; // 0..1
    const raw = Math.round(min + wave * (max - min));
    values[a.deviceId] = [profile.twoState ? (raw >= 128 ? 255 : 0) : raw];
  }
  const modeName = mode === 'line' ? 'вдоль линии' : mode === 'path' ? 'по контуру' : 'по кольцу';
  return { id: uid(), name: `Волна ${modeName}`, values };
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
