import type { ModbusConnection } from '@fountain-studio/shared';
import { ModbusRtuClient } from './drivers/modbus-rtu';
import { ModbusTcpClient } from './drivers/modbus-tcp';
import type { ModbusTransport } from './drivers/modbus-transport';

/** Одна физическая линия — один ключ: TCP-шлюз по адресу, RS-485 по порту и его параметрам. */
export function modbusConnectionKey(c: ModbusConnection): string {
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
 * Общие подключения Modbus для всего движка.
 *
 * Раньше пул жил внутри управления насосами. Датчик ветра на объекте чаще
 * всего сидит на ТОЙ ЖЕ линии RS-485, что и частотники (другой адрес на
 * шине), а два клиента на одном COM-порту — это два открытия одного порта:
 * второе падает, либо запросы сталкиваются на шине. Один транспорт на линию
 * ставит запросы насосов и датчика в одну очередь.
 */
export class ModbusPool {
  private readonly transports = new Map<string, { transport: ModbusTransport; refCount: number }>();

  /** Взять подключение (создаётся при первом обращении). Вернуть — release(key). */
  acquire(conn: ModbusConnection): string {
    const key = modbusConnectionKey(conn);
    const existing = this.transports.get(key);
    if (existing) existing.refCount++;
    else this.transports.set(key, { transport: createTransport(conn), refCount: 1 });
    return key;
  }

  release(key: string): void {
    const entry = this.transports.get(key);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.transport.close();
      this.transports.delete(key);
    }
  }

  get(key: string): ModbusTransport | undefined {
    return this.transports.get(key)?.transport;
  }

  closeAll(): void {
    for (const { transport } of this.transports.values()) transport.close();
    this.transports.clear();
  }
}
