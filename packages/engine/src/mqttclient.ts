import net from 'node:net';

/**
 * Минимальный клиент MQTT 3.1.1 поверх node:net — тот же приём, что Art-Net/
 * sACN/Modbus в этом движке: протокол собран вручную, без сторонних библиотек.
 * QoS 0 только (публикация телеметрии и приём команд не требуют подтверждений
 * доставки — статус шлётся периодически, команда потерялась — придёт следующая),
 * TLS не реализован (для локального брокера на объекте обычно не нужен).
 */

const PKT_CONNACK = 2;
const PKT_PUBLISH = 3;
const PKT_PINGRESP = 13;

function encodeRemainingLength(len: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) byte |= 0x80;
    bytes.push(byte);
  } while (len > 0);
  return Buffer.from(bytes);
}

function encodeUtf8String(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length, 0);
  return Buffer.concat([len, body]);
}

export interface MqttOptions {
  host: string;
  port?: number;
  clientId: string;
  username?: string;
  password?: string;
  keepAliveSec?: number;
}

export class MqttClient {
  onMessage: ((topic: string, payload: Buffer) => void) | null = null;
  onStatus: ((connected: boolean) => void) | null = null;

  private socket: net.Socket | null = null;
  private connected = false;
  private recvBuf = Buffer.alloc(0);
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private pendingSubs: string[] = [];
  private packetIdCounter = 1;

  constructor(private readonly opts: MqttOptions) {
    this.connect();
  }

  private connect(): void {
    if (this.closed || this.socket) return;
    const socket = net.createConnection({ host: this.opts.host, port: this.opts.port ?? 1883 });
    socket.on('connect', () => this.sendConnect());
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => {
      /* обрабатывается через close — переподключение по таймеру */
    });
    socket.on('close', () => {
      this.socket = null;
      this.connected = false;
      this.recvBuf = Buffer.alloc(0);
      if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
      this.onStatus?.(false);
      if (!this.closed) this.scheduleReconnect();
    });
    this.socket = socket;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  private sendConnect(): void {
    if (!this.socket) return;
    const keepAlive = this.opts.keepAliveSec ?? 30;
    const protoName = encodeUtf8String('MQTT');
    const protoLevel = Buffer.from([4]); // MQTT 3.1.1
    let flags = 0x02; // clean session
    const idAndCreds: Buffer[] = [encodeUtf8String(this.opts.clientId)];
    if (this.opts.username) {
      flags |= 0x80;
      idAndCreds.push(encodeUtf8String(this.opts.username));
    }
    if (this.opts.password) {
      flags |= 0x40;
      idAndCreds.push(encodeUtf8String(this.opts.password));
    }
    const keepAliveBuf = Buffer.alloc(2);
    keepAliveBuf.writeUInt16BE(keepAlive, 0);
    const variableAndPayload = Buffer.concat([protoName, protoLevel, Buffer.from([flags]), keepAliveBuf, ...idAndCreds]);
    const header = Buffer.concat([Buffer.from([0x10]), encodeRemainingLength(variableAndPayload.length)]);
    this.socket.write(Buffer.concat([header, variableAndPayload]));
  }

  private onData(chunk: Buffer): void {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
    for (;;) {
      if (this.recvBuf.length < 2) return;
      const type = this.recvBuf[0]! >> 4;
      let multiplier = 1;
      let remLen = 0;
      let idx = 1;
      let byte: number;
      do {
        if (idx >= this.recvBuf.length) return; // заголовок длины ещё не пришёл целиком
        byte = this.recvBuf[idx]!;
        remLen += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        idx++;
      } while ((byte & 0x80) !== 0);
      const total = idx + remLen;
      if (this.recvBuf.length < total) return;
      const body = this.recvBuf.subarray(idx, total);
      this.recvBuf = this.recvBuf.subarray(total);
      this.handlePacket(type, body);
    }
  }

  private handlePacket(type: number, body: Buffer): void {
    if (type === PKT_CONNACK) {
      this.connected = true;
      this.onStatus?.(true);
      const keepAlive = this.opts.keepAliveSec ?? 30;
      if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = setInterval(() => this.ping(), keepAlive * 1000 * 0.8);
      this.keepAliveTimer.unref?.();
      for (const t of this.pendingSubs) this.sendSubscribe(t);
      this.pendingSubs = [];
    } else if (type === PKT_PUBLISH) {
      if (body.length < 2) return;
      const topicLen = body.readUInt16BE(0);
      const topic = body.toString('utf8', 2, 2 + topicLen);
      // QoS0 — между топиком и данными нет packet id.
      const payload = body.subarray(2 + topicLen);
      this.onMessage?.(topic, payload);
    } else if (type === PKT_PINGRESP) {
      // ничего не делаем — сам факт ответа поддерживает соединение
    }
  }

  private ping(): void {
    if (!this.socket || !this.connected) return;
    this.socket.write(Buffer.from([0xc0, 0x00]));
  }

  subscribe(topicFilter: string): void {
    if (!this.connected) {
      this.pendingSubs.push(topicFilter);
      return;
    }
    this.sendSubscribe(topicFilter);
  }

  private sendSubscribe(topicFilter: string): void {
    if (!this.socket) return;
    const packetId = Buffer.alloc(2);
    packetId.writeUInt16BE(this.packetIdCounter, 0);
    this.packetIdCounter = (this.packetIdCounter % 0xffff) + 1;
    const topic = Buffer.concat([encodeUtf8String(topicFilter), Buffer.from([0])]); // QoS0
    const variableAndPayload = Buffer.concat([packetId, topic]);
    const header = Buffer.concat([Buffer.from([0x82]), encodeRemainingLength(variableAndPayload.length)]);
    this.socket.write(Buffer.concat([header, variableAndPayload]));
  }

  publish(topic: string, payload: string): void {
    if (!this.socket || !this.connected) return;
    const variableAndPayload = Buffer.concat([encodeUtf8String(topic), Buffer.from(payload, 'utf8')]);
    const header = Buffer.concat([Buffer.from([0x30]), encodeRemainingLength(variableAndPayload.length)]); // QoS0, без retain
    this.socket.write(Buffer.concat([header, variableAndPayload]));
  }

  get isConnected(): boolean {
    return this.connected;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.socket && this.connected) {
      try {
        this.socket.write(Buffer.from([0xe0, 0x00])); // DISCONNECT
      } catch {
        /* сокет уже мог отвалиться — не страшно, ниже destroy() */
      }
    }
    this.socket?.destroy();
    this.socket = null;
  }
}
