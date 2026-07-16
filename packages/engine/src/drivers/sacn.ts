import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { DMX_UNIVERSE_SIZE } from '@fountain-studio/shared';
import type { UniverseOutput } from './output';

export const SACN_PORT = 5568;
const ACN_ID = Buffer.from('ASC-E1.17\0\0\0', 'latin1'); // 12 байт
const SOURCE_NAME = 'Fountain Studio';

/** CID один на процесс движка — так требует E1.31 (один источник = один CID). */
const PROCESS_CID = crypto.randomBytes(16);

export interface SacnOptions {
  /** Вселенная sACN, нумерация с 1 (1..63999). */
  universe: number;
  /** Приоритет источника 0..200, по умолчанию 100. */
  priority?: number;
  /** Если задан — unicast на этот адрес вместо стандартного multicast. */
  host?: string;
  port?: number;
}

/** Выход sACN (ANSI E1.31): пакет DMP с start code 0 + 512 байт данных. */
export class SacnOutput implements UniverseOutput {
  private readonly socket: dgram.Socket;
  private readonly dest: string;
  private readonly port: number;
  private seq = 0;

  constructor(private readonly opts: SacnOptions) {
    if (opts.universe < 1 || opts.universe > 63999) {
      throw new Error(`sACN: вселенная ${opts.universe} вне диапазона 1..63999`);
    }
    this.port = opts.port ?? SACN_PORT;
    this.dest = opts.host ?? `239.255.${(opts.universe >> 8) & 0xff}.${opts.universe & 0xff}`;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', (err) => console.error(`[sacn u${opts.universe}] ошибка сокета:`, err.message));
    this.socket.bind(0, () => this.socket.setMulticastTTL(16));
  }

  send(frame: Uint8Array): void {
    const data = frame.subarray(0, DMX_UNIVERSE_SIZE);
    const propCount = 1 + data.length; // start code + данные
    const total = 126 + data.length;
    const pkt = Buffer.alloc(total);

    // Root layer
    pkt.writeUInt16BE(0x0010, 0); // Preamble Size
    pkt.writeUInt16BE(0x0000, 2); // Post-amble Size
    ACN_ID.copy(pkt, 4);
    pkt.writeUInt16BE(0x7000 | (total - 16), 16); // Flags + Length
    pkt.writeUInt32BE(0x00000004, 18); // Vector: E1.31 Data
    PROCESS_CID.copy(pkt, 22);

    // Framing layer
    pkt.writeUInt16BE(0x7000 | (total - 38), 38);
    pkt.writeUInt32BE(0x00000002, 40); // Vector: DMX Data Packet
    pkt.write(SOURCE_NAME, 44, 63, 'utf8'); // 64 байта, оставшееся — нули
    pkt.writeUInt8(this.opts.priority ?? 100, 108);
    pkt.writeUInt16BE(0, 109); // Synchronization Address
    this.seq = (this.seq + 1) & 0xff;
    pkt.writeUInt8(this.seq, 111);
    pkt.writeUInt8(0, 112); // Options
    pkt.writeUInt16BE(this.opts.universe, 113);

    // DMP layer
    pkt.writeUInt16BE(0x7000 | (total - 115), 115);
    pkt.writeUInt8(0x02, 117); // Vector: Set Property
    pkt.writeUInt8(0xa1, 118); // Address & data type
    pkt.writeUInt16BE(0x0000, 119); // First property address
    pkt.writeUInt16BE(0x0001, 121); // Address increment
    pkt.writeUInt16BE(propCount, 123);
    pkt.writeUInt8(0x00, 125); // DMX start code
    pkt.set(data, 126);

    this.socket.send(pkt, this.port, this.dest);
  }

  describe(): string {
    return `sACN → ${this.dest}:${this.port} (universe ${this.opts.universe}, prio ${this.opts.priority ?? 100})`;
  }

  close(): void {
    this.socket.close();
  }
}
