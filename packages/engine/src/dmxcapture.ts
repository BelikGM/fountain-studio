import { measureCyclePeriodMs, type CapturedFrame, type CycleMeasurement } from '@fountain-studio/shared';

const MAX_FRAMES = 2400; // ~2 мин при 20 кадрах/с

interface UniverseCapture {
  frames: CapturedFrame[];
  lastFromIp: string;
}

/**
 * Захват входящего ArtDMX с линии (§17 п.1: снятие готовых сцен с внешнего
 * источника — например, старый контроллер вещает Art-Net, или его софт
 * направлен на IP этого ПК). Кольцевой буфер кадров на вселенную (Port-Address,
 * нумерация Art-Net с 0); по нему — мгновенный снимок значений в сцену и
 * измерение периода цикла T. Собственный выход движка сюда не попадает:
 * движок шлёт на ноды, а не себе (кроме конфигурации на 127.0.0.1 — тогда
 * захват честно показывает свой же поток, что удобно для проверки).
 */
export class DmxCapture {
  private universes = new Map<number, UniverseCapture>();

  handle(universe: number, data: Uint8Array, fromIp: string): void {
    let u = this.universes.get(universe);
    if (!u) {
      u = { frames: [], lastFromIp: fromIp };
      this.universes.set(universe, u);
    }
    u.lastFromIp = fromIp;
    u.frames.push({ atMs: Date.now(), data });
    if (u.frames.length > MAX_FRAMES) u.frames.splice(0, u.frames.length - MAX_FRAMES);
  }

  /** Последний кадр вселенной (Port-Address) или null. */
  snapshot(universe: number): { data: Uint8Array; ageMs: number; fromIp: string; frames: number } | null {
    const u = this.universes.get(universe);
    const last = u?.frames[u.frames.length - 1];
    if (!u || !last) return null;
    return { data: last.data, ageMs: Date.now() - last.atMs, fromIp: u.lastFromIp, frames: u.frames.length };
  }

  measureCycle(universe: number): CycleMeasurement {
    const u = this.universes.get(universe);
    return measureCyclePeriodMs(u?.frames ?? []);
  }
}
