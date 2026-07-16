import dgram from 'node:dgram';
import { DMX_UNIVERSE_SIZE } from '@fountain-studio/shared';
import type { UniverseOutput } from './output';

export const ARTNET_PORT = 6454;
const OP_DMX = 0x5000;
const PROTOCOL_VERSION = 14;
const HEADER_SIZE = 18;

export interface ArtNetOptions {
  host: string;
  port?: number;
  /** Вселенная Art-Net (Net 7 бит << 8 | SubUni 8 бит), нумерация с 0. */
  universe: number;
  broadcast?: boolean;
}

/** Выход ArtDMX: один UDP-пакет на кадр вселенной. */
export class ArtNetOutput implements UniverseOutput {
  private readonly socket: dgram.Socket;
  private readonly port: number;
  private seq = 0;
  private ready = false;

  constructor(private readonly opts: ArtNetOptions) {
    this.port = opts.port ?? ARTNET_PORT;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', (err) => console.error(`[artnet ${opts.host}] ошибка сокета:`, err.message));
    this.socket.bind(0, () => {
      if (this.opts.broadcast) this.socket.setBroadcast(true);
      this.ready = true;
    });
  }

  send(frame: Uint8Array): void {
    if (!this.ready) return;
    const length = Math.min(frame.length, DMX_UNIVERSE_SIZE);
    const pkt = Buffer.allocUnsafe(HEADER_SIZE + length);
    pkt.write('Art-Net\0', 0, 'latin1');
    pkt.writeUInt16LE(OP_DMX, 8);
    pkt.writeUInt8(0, 10); // ProtVerHi
    pkt.writeUInt8(PROTOCOL_VERSION, 11); // ProtVerLo
    this.seq = (this.seq % 255) + 1; // 1..255, 0 означает «не использовать»
    pkt.writeUInt8(this.seq, 12);
    pkt.writeUInt8(0, 13); // Physical
    pkt.writeUInt8(this.opts.universe & 0xff, 14); // SubUni
    pkt.writeUInt8((this.opts.universe >> 8) & 0x7f, 15); // Net
    pkt.writeUInt8((length >> 8) & 0xff, 16);
    pkt.writeUInt8(length & 0xff, 17);
    pkt.set(frame.subarray(0, length), HEADER_SIZE);
    this.socket.send(pkt, this.port, this.opts.host);
  }

  describe(): string {
    return `Art-Net → ${this.opts.host}:${this.port} (universe ${this.opts.universe})`;
  }

  close(): void {
    this.socket.close();
  }
}
