import { SerialPort } from 'serialport';
import {
  FC_READ_HOLDING_REGISTERS,
  FC_READ_INPUT_REGISTERS,
  FC_WRITE_SINGLE_REGISTER,
  checkException,
  crc16Modbus,
  parseHoldingRegisters,
  parseInputRegisters,
  pduReadHoldingRegisters,
  pduReadInputRegisters,
  pduWriteSingleRegister,
} from './modbus-pdu';
import type { ModbusTransport } from './modbus-transport';

export interface ModbusRtuOptions {
  /** Путь COM-порта USB-RS485-адаптера, напр. "COM5". */
  path: string;
  baudRate?: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd';
  timeoutMs?: number;
}

/**
 * Клиент Modbus RTU по RS-485 напрямую (без TCP-шлюза, §12 п.9) — как в отдельном
 * проекте-конфигураторе ПЧ (github.com/BelikGM/Modbus): USB-RS485-адаптер, порт
 * открывается через serialport. Кадр: адрес(1) + PDU + CRC16(2, little-endian).
 * Один физический порт часто обслуживает несколько ПЧ на разных slaveId
 * (мультидроп RS-485) — клиент делится между такими насосами по пути порта,
 * см. PumpModbusManager. Запросы сериализуются (один в полёте) — шина
 * полудуплексная, иначе ответы разных приборов пришли бы вперемешку.
 */
export class ModbusRtuClient implements ModbusTransport {
  private port: SerialPort | null = null;
  private opening = false;
  private recvBuf = Buffer.alloc(0);
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly timeoutMs: number;

  private readonly queue: Array<{ pdu: Buffer; resolve: (d: Buffer) => void; reject: (e: Error) => void }> = [];
  private inFlight: { resolve: (d: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;

  constructor(private readonly opts: ModbusRtuOptions) {
    this.timeoutMs = opts.timeoutMs ?? 1000;
    this.open();
  }

  private open(): void {
    if (this.closed || this.port || this.opening) return;
    this.opening = true;
    const port = new SerialPort({
      path: this.opts.path,
      baudRate: this.opts.baudRate ?? 9600,
      dataBits: this.opts.dataBits ?? 8,
      stopBits: this.opts.stopBits ?? 1,
      parity: this.opts.parity ?? 'none',
      autoOpen: false,
    });
    port.on('data', (chunk: Buffer) => this.onData(chunk));
    port.on('error', () => {
      /* обрабатывается через close — переподключение по таймеру */
    });
    port.on('close', () => {
      this.port = null;
      this.recvBuf = Buffer.alloc(0);
      if (this.inFlight) {
        clearTimeout(this.inFlight.timer);
        this.inFlight.reject(new Error('порт закрыт'));
        this.inFlight = null;
      }
      if (!this.closed) this.scheduleReconnect();
    });
    port.open((err: Error | null | undefined) => {
      this.opening = false;
      if (err) {
        this.scheduleReconnect();
        return;
      }
      this.port = port;
      this.pump();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, 2000);
  }

  /** Длина всего RTU-кадра (адрес+PDU+CRC16) по коду функции ответа. */
  private expectedFrameLength(buf: Buffer): number | null {
    if (buf.length < 3) return null;
    const fc = buf.readUInt8(1);
    if ((fc & 0x80) !== 0) return 5; // адрес + fc-с-флагом + код исключения + CRC16
    if (fc === FC_WRITE_SINGLE_REGISTER) return 8; // адрес + fc + адрес(2) + значение(2) + CRC16
    if (fc === FC_READ_HOLDING_REGISTERS || fc === FC_READ_INPUT_REGISTERS) return 5 + buf.readUInt8(2); // + данные
    return null; // код функции, который мы не запрашивали — считаем кадр непонятным
  }

  private onData(chunk: Buffer): void {
    if (!this.inFlight) {
      // Ответа не ждём — это шум с шины (например, эхо чужого запроса при коллизии); не копим.
      return;
    }
    this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
    const total = this.expectedFrameLength(this.recvBuf);
    if (total === null || this.recvBuf.length < total) return;
    const frame = this.recvBuf.subarray(0, total);
    this.recvBuf = Buffer.alloc(0);
    const crcGot = frame.readUInt16LE(total - 2);
    if (crc16Modbus(frame.subarray(0, total - 2)) !== crcGot) {
      return; // битый кадр (коллизия на шине и т.п.) — ждём таймаут текущего запроса
    }
    const { resolve, timer } = this.inFlight;
    clearTimeout(timer);
    this.inFlight = null;
    resolve(frame.subarray(1, total - 2)); // PDU без адреса и CRC
    this.pump();
  }

  private request(unitId: number, pdu: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.queue.push({ pdu: Buffer.concat([Buffer.from([unitId]), pdu]), resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.inFlight) return;
    const item = this.queue.shift();
    if (!item) return;
    if (!this.port || !this.port.isOpen) {
      this.open();
      item.reject(new Error('нет соединения с портом'));
      this.queue.length = 0; // без порта остаток очереди ждёт следующего вызова
      return;
    }
    const crcBuf = Buffer.alloc(2);
    crcBuf.writeUInt16LE(crc16Modbus(item.pdu), 0);
    this.recvBuf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      this.inFlight = null;
      item.reject(new Error('таймаут ответа прибора'));
      this.pump();
    }, this.timeoutMs);
    this.inFlight = { resolve: item.resolve, reject: item.reject, timer };
    this.port.write(Buffer.concat([item.pdu, crcBuf]));
  }

  async writeSingleRegister(unitId: number, address: number, value: number): Promise<void> {
    checkException(await this.request(unitId, pduWriteSingleRegister(address, value)), FC_WRITE_SINGLE_REGISTER);
  }

  async readHoldingRegister(unitId: number, address: number): Promise<number> {
    const values = parseHoldingRegisters(await this.request(unitId, pduReadHoldingRegisters(address, 1)));
    return values[0] ?? 0;
  }

  async readInputRegister(unitId: number, address: number): Promise<number> {
    const values = parseInputRegisters(await this.request(unitId, pduReadInputRegisters(address, 1)));
    return values[0] ?? 0;
  }

  get isConnected(): boolean {
    return this.port !== null && this.port.isOpen;
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
    this.port?.close();
    this.port = null;
  }
}
