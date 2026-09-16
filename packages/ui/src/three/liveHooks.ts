import {
  nozzlePump2Ids,
  nozzlePumpIds,
  nozzleValveIds,
  profileMap,
  type ChannelRole,
  type Project,
} from '@fountain-studio/shared';
import type { SceneHooks } from './FountainScene';

export interface DeviceIndexEntry {
  universe: number;
  address: number;
  roles: ChannelRole[];
}

/** Адрес и роли каналов каждого устройства патча — вход для createLiveHooks. */
export function buildDeviceIndex(project: Project): Map<string, DeviceIndexEntry> {
  const map = new Map<string, DeviceIndexEntry>();
  const profiles = profileMap(project);
  for (const d of project.devices) {
    const p = profiles.get(d.profileId);
    if (p) map.set(d.id, { universe: d.universe, address: d.address, roles: p.channels.map((c) => c.role) });
  }
  return map;
}

/**
 * Живые хуки FountainScene (струя/цвет прожектора) поверх текущего кадра DMX —
 * общая логика вкладки «3D» (LayoutView) и рендера шоу в видео (ShowVideoRender),
 * читает через ref, чтобы rAF-цикл сцены видел свежие кадры без пересоздания.
 */
export function createLiveHooks(
  deviceIndexRef: { current: Map<string, DeviceIndexEntry> },
  framesRef: { current: Record<number, Uint8Array> },
): SceneHooks['live'] {
  const chan = (idx: DeviceIndexEntry, offset: number): number =>
    framesRef.current[idx.universe]?.[idx.address - 1 + offset] ?? 0;
  return {
    nozzleFlow: (n) => {
      const map = deviceIndexRef.current;
      let flow = 0;
      let cut = false;
      let bound = false;
      // Насосов у форсунки может быть несколько (питание в две линии). Берём
      // максимум: струю определяет тот, кто сейчас даёт больший напор, а не
      // сумма — параллельные насосы не складывают высоту струи.
      for (const id of nozzlePumpIds(n)) {
        const pump = map.get(id);
        if (!pump) continue;
        bound = true;
        const ci = Math.max(0, pump.roles.indexOf('intensity'));
        flow = Math.max(flow, chan(pump, ci) / 255);
      }
      // Клапанов тоже может быть несколько. Вода идёт, если открыт хотя бы
      // один: это параллельные подводы, а не последовательные отсечки.
      const valveIds = nozzleValveIds(n);
      let anyValve = false;
      let anyOpen = false;
      for (const id of valveIds) {
        const valve = map.get(id);
        if (!valve) continue;
        anyValve = true;
        const ci = Math.max(0, valve.roles.indexOf('open'));
        if (chan(valve, ci) >= 128) anyOpen = true;
      }
      if (anyValve) {
        if (!bound) flow = anyOpen ? 1 : 0;
        else if (!anyOpen) flow = 0;
        if (!anyOpen) cut = true;
        bound = true;
      }
      return { flow: bound ? flow : 0, cut };
    },
    pump2Level: (n) => {
      const map = deviceIndexRef.current;
      // Насосов раскрытия тоже может быть несколько — берём максимум, как и у
      // насосов подачи: конус раскрывает тот, кто сейчас даёт больший напор.
      let level = 0;
      for (const id of nozzlePump2Ids(n)) {
        const pump2 = map.get(id);
        if (!pump2) continue;
        const ci = Math.max(0, pump2.roles.indexOf('intensity'));
        level = Math.max(level, chan(pump2, ci) / 255);
      }
      return level;
    },
    lightColor: (deviceId) => {
      if (!deviceId) return null;
      const d = deviceIndexRef.current.get(deviceId);
      if (!d) return null;
      const ri = d.roles.indexOf('red');
      const gi = d.roles.indexOf('green');
      const bi = d.roles.indexOf('blue');
      const wi = d.roles.indexOf('white');
      if (ri >= 0 && gi >= 0 && bi >= 0) {
        const w = wi >= 0 ? (chan(d, wi) / 255) * 0.9 : 0;
        return [
          Math.min(1, chan(d, ri) / 255 + w),
          Math.min(1, chan(d, gi) / 255 + w),
          Math.min(1, chan(d, bi) / 255 + w),
        ];
      }
      const v = chan(d, Math.max(0, d.roles.indexOf('intensity'))) / 255;
      return [v, v, v * 0.95];
    },
  };
}
