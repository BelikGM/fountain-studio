import type { ModbusConnection, ModbusPumpConfig, ModbusState, PatchedDevice } from '@fountain-studio/shared';
import { ModbusRtuClient } from './drivers/modbus-rtu';
import { ModbusTcpClient } from './drivers/modbus-tcp';
import type { ModbusTransport } from './drivers/modbus-transport';

const WRITE_THROTTLE_MS = 200; // не чаще 5 записей/с при изменении значения канала
const KEEPALIVE_MS = 1000; // повтор даже без изменений — у многих ПЧ вотчдог связи гасит привод без свежих команд
const FAULT_POLL_MS = 3000;

interface PumpEntry {
  config: ModbusPumpConfig;
  connKey: string;
  lastValue: number; // -1 — ещё не отправляли (форсирует первую запись, в т.ч. явный «стоп» при старте)
  lastWriteAt: number;
  writing: boolean;
  lastFreqHz: number;
  faultCode: number | null;
  lastOkAt: number;
  lastError: string | null;
}

function connectionKey(c: ModbusConnection): string {
  return c.kind === 'tcp'
    ? `tcp:${c.host}:${c.port ?? 502}`
    : `rtu:${c.serialPort}:${c.baudRate ?? 9600}:${c.dataBits ?? 8}:${c.stopBits ?? 1}:${c.parity ?? 'none'}`;
}

function createTransport(c: ModbusConnection): ModbusTransport {
  return c.kind === 'tcp'
    ? new ModbusTcpClient(c.host, c.port ?? 502)
    : new ModbusRtuClient({
        path: c.serialPort,
        baudRate: c.baudRate,
        dataBits: c.dataBits,
        stopBits: c.stopBits,
        parity: c.parity,
      });
}

/**
 * Прямое управление насосами через Modbus, в обход DMX→аналог (§12 п.9). Несколько
 * насосов на одном физическом канале (мультидроп RS-485 или общий TCP-шлюз) делят
 * один транспорт по ключу подключения — так на шину не летят параллельные запросы
 * от разных клиентов. Уставка частоты и команда пуск/стоп пишутся при изменении
 * значения канала (троттлинг), плюс периодический keep-alive: см. обсуждение с
 * пользователем — без свежих команд часть ПЧ по вотчдогу связи останавливает
 * привод даже при неизменной уставке, а показ фонтана может держать насос на
 * одном значении десятки секунд.
 */
export class PumpModbusManager {
  onChange: (() => void) | null = null;

  private readonly transports = new Map<string, { transport: ModbusTransport; refCount: number }>();
  private readonly pumps = new Map<string, PumpEntry>();
  private faultTimer: NodeJS.Timeout | null = null;

  setDevices(devices: PatchedDevice[]): void {
    const wanted = new Map<string, ModbusPumpConfig>();
    for (const d of devices) if (d.modbus) wanted.set(d.id, d.modbus);

    for (const [id, entry] of this.pumps) {
      const cfg = wanted.get(id);
      const key = cfg ? connectionKey(cfg.connection) : null;
      if (!cfg || key !== entry.connKey) {
        this.releaseTransport(entry.connKey);
        this.pumps.delete(id);
      }
    }
    for (const [id, cfg] of wanted) {
      const existing = this.pumps.get(id);
      if (existing) {
        existing.config = cfg; // регистры/масштаб можно поменять без пересоздания соединения
        continue;
      }
      const connKey = connectionKey(cfg.connection);
      this.acquireTransport(connKey, cfg.connection);
      this.pumps.set(id, {
        config: cfg,
        connKey,
        lastValue: -1,
        lastWriteAt: 0,
        writing: false,
        lastFreqHz: 0,
        faultCode: null,
        lastOkAt: 0,
        lastError: null,
      });
    }
    if (this.pumps.size > 0) this.ensureFaultPolling();
    else this.stopFaultPolling();
  }

  private acquireTransport(key: string, conn: ModbusConnection): void {
    const existing = this.transports.get(key);
    if (existing) {
      existing.refCount++;
      return;
    }
    this.transports.set(key, { transport: createTransport(conn), refCount: 1 });
  }

  private releaseTransport(key: string): void {
    const entry = this.transports.get(key);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.transport.close();
      this.transports.delete(key);
    }
  }

  /** Вызывается движком каждый тик с итоговым значением канала интенсивности (0–255). */
  update(deviceId: string, value: number): void {
    const entry = this.pumps.get(deviceId);
    if (!entry || entry.writing) return;
    const now = Date.now();
    const changed = entry.lastValue !== value;
    if (!changed && now - entry.lastWriteAt < KEEPALIVE_MS) return;
    if (changed && now - entry.lastWriteAt < WRITE_THROTTLE_MS) return;
    const transport = this.transports.get(entry.connKey)?.transport;
    if (!transport) return;
    entry.lastWriteAt = now;
    entry.lastValue = value;
    void this.writeValue(entry, transport, value);
  }

  private async writeValue(entry: PumpEntry, transport: ModbusTransport, value: number): Promise<void> {
    entry.writing = true;
    try {
      const freqHz = (value / 255) * entry.config.freqScaleHz;
      const raw = Math.max(0, Math.round(freqHz * (entry.config.freqRegScale ?? 100)));
      const unitId = entry.config.unitId ?? 1;
      await transport.writeSingleRegister(unitId, entry.config.freqRegister, raw);
      if (entry.config.cmdRegister !== undefined) {
        await transport.writeSingleRegister(unitId, entry.config.cmdRegister, value > 0 ? 2 : 1);
      }
      entry.lastFreqHz = freqHz;
      entry.lastOkAt = Date.now();
      entry.lastError = null;
    } catch (err) {
      entry.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      entry.writing = false;
      this.onChange?.();
    }
  }

  private ensureFaultPolling(): void {
    if (this.faultTimer) return;
    this.faultTimer = setInterval(() => this.pollFaults(), FAULT_POLL_MS);
  }

  private stopFaultPolling(): void {
    if (this.faultTimer) {
      clearInterval(this.faultTimer);
      this.faultTimer = null;
    }
  }

  private pollFaults(): void {
    for (const entry of this.pumps.values()) {
      if (entry.config.faultRegister === undefined || entry.writing) continue;
      const transport = this.transports.get(entry.connKey)?.transport;
      if (!transport) continue;
      transport
        .readHoldingRegister(entry.config.unitId ?? 1, entry.config.faultRegister)
        .then((code) => {
          const changed = entry.faultCode !== code;
          entry.faultCode = code;
          entry.lastOkAt = Date.now();
          entry.lastError = null;
          if (changed) this.onChange?.();
        })
        .catch((err) => {
          entry.lastError = err instanceof Error ? err.message : String(err);
        });
    }
    this.onChange?.(); // возраст (ageMs) в UI обновляется даже без изменений состояния
  }

  state(): ModbusState {
    const now = Date.now();
    return {
      pumps: [...this.pumps.entries()].map(([deviceId, e]) => ({
        deviceId,
        connected: this.transports.get(e.connKey)?.transport.isConnected ?? false,
        lastFreqHz: e.lastFreqHz,
        faultCode: e.config.faultRegister === undefined ? null : e.faultCode,
        ageMs: e.lastOkAt === 0 ? -1 : now - e.lastOkAt,
        lastError: e.lastError,
      })),
    };
  }

  stop(): void {
    this.stopFaultPolling();
    for (const { transport } of this.transports.values()) transport.close();
    this.transports.clear();
    this.pumps.clear();
  }
}
