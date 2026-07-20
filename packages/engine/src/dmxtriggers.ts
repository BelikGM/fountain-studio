import type { DmxTrigger } from '@fountain-studio/shared';
import { eventLog } from './eventlog';
import type { Engine } from './engine';
import { fireRemoteAction } from './remotedispatch';

/**
 * Триггеры по входящему DMX (§27 доработки, §4 п.4) — внешний пульт/консоль
 * шлёт Art-Net на этот ПК (тот же захват, что getDmxCapture/measureDmxCycle),
 * значение канала в диапазоне запускает действие. Логический universe в
 * триггере — id вселенной проекта (как у устройств патча), переводим в
 * реальный Art-Net Port-Address тем же способом, что и getDmxCapture в
 * server.ts — сверяем именно то, что реально пришло с линии.
 *
 * Срабатывает по фронту (переход снаружи диапазона внутрь), не на каждый
 * кадр (~40 Гц) — иначе держащийся на значении фейдер/кнопка спамил бы
 * действие непрерывно. Тот же принцип, что у OSC-биндингов (там отдельно
 * игнорируется «отпускание»).
 */
export class DmxTriggerWatcher {
  private inRange = new Map<string, boolean>();

  handle(engine: Engine, triggers: DmxTrigger[], protoUniverse: number, data: Uint8Array): void {
    for (const t of triggers) {
      const wantProto = engine.config.universes
        .find((u) => u.id === t.universe)
        ?.outputs.find((o) => o.type === 'artnet')?.universe;
      if (wantProto !== protoUniverse) continue;
      const value = data[t.address - 1] ?? 0;
      const inside = value >= t.valueMin && value <= t.valueMax;
      const was = this.inRange.get(t.id) ?? false;
      this.inRange.set(t.id, inside);
      if (inside && !was) {
        eventLog.log('dmx-in', `U${t.universe}:${t.address}=${value} → ${t.action.type}`);
        fireRemoteAction(engine, t.action);
      }
    }
  }
}
