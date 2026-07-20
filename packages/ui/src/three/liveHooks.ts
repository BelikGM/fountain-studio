import { profileMap, type ChannelRole, type Project } from '@fountain-studio/shared';
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
      const pump = n.pumpDeviceId ? map.get(n.pumpDeviceId) : undefined;
      if (pump) {
        bound = true;
        const ci = Math.max(0, pump.roles.indexOf('intensity'));
        flow = chan(pump, ci) / 255;
      }
      const valve = n.valveDeviceId ? map.get(n.valveDeviceId) : undefined;
      if (valve) {
        const ci = Math.max(0, valve.roles.indexOf('open'));
        const open = chan(valve, ci) >= 128;
        if (!bound) flow = open ? 1 : 0;
        else if (!open) flow = 0;
        if (!open) cut = true;
        bound = true;
      }
      return { flow: bound ? flow : 0, cut };
    },
    pump2Level: (n) => {
      const map = deviceIndexRef.current;
      const pump2 = n.pump2DeviceId ? map.get(n.pump2DeviceId) : undefined;
      if (!pump2) return 0;
      const ci = Math.max(0, pump2.roles.indexOf('intensity'));
      return chan(pump2, ci) / 255;
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
