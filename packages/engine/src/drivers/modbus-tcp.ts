import net from 'node:net';
import { checkException, parseHoldingRegisters, pduReadHoldingRegisters, pduWriteSingleRegister } from './modbus-pdu';
import type { ModbusTransport } from './modbus-transport';

/**
 * Клиент Modbus TCP (MBAP + PDU) для ПЧ за RTU↔TCP-шлюзом (§12 п.9), без сторонних
 * зависимостей — тот же принцип, что у Art-Net/sACN (drivers/artnet.ts, sacn.ts):
 * протокол собирается вручную поверх node:net. Держит одно TCP-соединение с авто-
 * переподключением; запросы сериализуются в очередь (один в полёте за раз) — многие
 * простые ПЧ-слейвы за шлюзом не поддерживают конвейеризацию запросов.
 */
export class ModbusTcpClient implements ModbusTransport {
  private socket: net.Socket | null = null;
  private txCounter = 0;
  private recvBuf = Buffer.alloc(0);
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  private readonly queue: Array<{ unitId: number; pdu: Buffer; resolve: (d: Buffer) => void; reject: (e: Error) => void }> = [];
  private inFlight: { txId: number; resolve: (d: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 1000,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.closed || this.socket) return;
    const socket = net.createConnection({ host: this.host, port: this.port });
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => {
      /* обрабатывается через close — переподключение по таймеру */
    });
    socket.on('close', () => {
      this.socket = null;
      this.recvBuf = Buffer.alloc(0);
      if (this.inFlight) {
        clearTimeout(this.inFlight.timer);
        this.inFlight.reject(new Error('соединение закрыто'));
        this.inFlight = null;
      }
      if (!this.closed) this.scheduleReconnect();
    });
    this.socket = socket;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  private onData(chunk: Buffer): void {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
    for (;;) {
      if (this.recvBuf.length < 8) return; // MBAP (7 байт) + минимум 1 байт PDU
      const length = this.recvBuf.readUInt16BE(4);
      const total = 6 + length;
      if (this.recvBuf.length < total) return;
      const frame = this.recvBuf.subarray(0, total);
      this.recvBuf = this.recvBuf.subarray(total);
      const txId = frame.readUInt16BE(0);
      if (this.inFlight && this.inFlight.txId === txId) {
        clearTimeout(this.inFlight.timer);
        const { resolve } = this.inFlight;
        this.inFlight = null;
        resolve(frame.subarray(7)); // PDU: код функции + данные
        this.pump();
      }
      // Ответ на устаревшую/неизвестную транзакцию — молча отбрасывается.
    }
  }

  private request(unitId: number, pdu: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.queue.push({ unitId, pdu, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.inFlight) return;
    const item = this.queue.shift();
    if (!item) return;
    if (!this.socket || this.socket.connecting) {
      this.connect();
      item.reject(new Error('нет соединения с ПЧ'));
      this.queue.length = 0; // без соединения остаток очереди ждёт следующего вызова
      return;
    }
    const txId = (this.txCounter = (this.txCounter + 1) & 0xffff);
    const header = Buffer.alloc(7);
    header.writeUInt16BE(txId, 0);
    header.writeUInt16BE(0, 2); // Protocol ID (0 = Modbus)
    header.writeUInt16BE(item.pdu.length + 1, 4);
    header.writeUInt8(item.unitId, 6);
    const timer = setTimeout(() => {
      this.inFlight = null;
      item.reject(new Error('таймаут ответа ПЧ'));
      this.pump();
    }, this.timeoutMs);
    this.inFlight = { txId, resolve: item.resolve, reject: item.reject, timer };
    this.socket.write(Buffer.concat([header, item.pdu]));
  }

  async writeSingleRegister(unitId: number, address: number, value: number): Promise<void> {
    checkException(await this.request(unitId, pduWriteSingleRegister(address, value)), 0x06);
  }

  async readHoldingRegister(unitId: number, address: number): Promise<number> {
    const values = parseHoldingRegisters(await this.request(unitId, pduReadHoldingRegisters(address, 1)));
    return values[0] ?? 0;
  }

  get isConnected(): boolean {
    return this.socket !== null && !this.socket.connecting;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.inFlight) {
      clearTimeout(this.inFlight.timer);
      this.inFlight.reject(new Error('клиент остановлен'));
      this.inFlight = null;
    }
    for (const item of this.queue.splice(0)) item.reject(new Error('клиент остановлен'));
    this.socket?.destroy();
    this.socket = null;
  }
}
