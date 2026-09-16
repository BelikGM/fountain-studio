import { SerialPort } from 'serialport';
import { DMX_UNIVERSE_SIZE } from '@fountain-studio/shared';
import type { UniverseOutput } from './output';

const STX = 0x7e;
const ETX = 0xe7;
const LABEL_OUTPUT_DMX = 6; // «Output Only Send DMX Packet Request»

export interface UsbDmxOptions {
  /** COM-порт адаптера. */
  path: string;
  baudRate?: number;
}

/**
 * USB-DMX по протоколу ENTTEC DMX USB PRO API (framing STX/label/len/data/ETX
 * поверх виртуального COM-порта) — этот протокол широко клонируют дешёвые
 * FTDI-адаптеры, продающиеся как «USB-DMX»; сам виджет держит точный тайминг
 * DMX512 на выходной линии, хосту достаточно прислать кадр в этом формате.
 * Про скорость порта. Она здесь ДЕКОРАТИВНАЯ: адаптер подключается через
 * виртуальный COM-порт FTDI, и драйвер VCP настройку скорости игнорирует —
 * данные идут по USB, а 250 кбод на линии DMX512 формирует сам виджет. Поэтому
 * 57600 в конфиге ничему не мешает и менять её незачем (проверено по
 * спецификации ENTTEC DMX USB PRO API 1.44).
 *
 * Адаптер БЕЗ своего контроллера («Open DMX USB» и клоны) этот протокол не
 * понимает: там кадр строит хост. Для них отдельный драйвер — open-dmx.ts.
 */
export class UsbDmxOutput implements UniverseOutput {
  private port: SerialPort | null = null;
  private opening = false;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private ready = false;

  constructor(private readonly opts: UsbDmxOptions) {
    this.open();
  }

  private open(): void {
    if (this.closed || this.port || this.opening) return;
    this.opening = true;
    const port = new SerialPort({
      path: this.opts.path,
      baudRate: this.opts.baudRate ?? 57600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      autoOpen: false,
    });
    port.on('error', () => {
      /* обрабатывается через close — переподключение по таймеру */
    });
    port.on('close', () => {
      this.port = null;
      this.ready = false;
      if (!this.closed) this.scheduleReconnect();
    });
    port.open((err: Error | null | undefined) => {
      this.opening = false;
      if (err) {
        this.scheduleReconnect();
        return;
      }
      this.port = port;
      this.ready = true;
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, 2000);
  }

  send(frame: Uint8Array): void {
    if (!this.ready || !this.port) return;
    const length = Math.min(frame.length, DMX_UNIVERSE_SIZE);
    const dataLen = length + 1; // + стартовый код DMX (0)
    const pkt = Buffer.alloc(4 + dataLen + 1);
    pkt.writeUInt8(STX, 0);
    pkt.writeUInt8(LABEL_OUTPUT_DMX, 1);
    pkt.writeUInt16LE(dataLen, 2);
    pkt.writeUInt8(0, 4); // DMX start code
    pkt.set(frame.subarray(0, length), 5);
    pkt.writeUInt8(ETX, 4 + dataLen);
    this.port.write(pkt);
  }

  describe(): string {
    return `USB-DMX (ENTTEC PRO API) → ${this.opts.path} @ ${this.opts.baudRate ?? 57600}`;
  }

  /** Порт открыт — значит, байты уходят в адаптер (см. drivers/output.ts). */
  healthy(): boolean {
    return this.ready && !!this.port?.isOpen;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.port?.close();
    this.port = null;
  }
}
