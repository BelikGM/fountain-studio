/**
 * Мониторинг сети Art-Net/RDM (§12 п.3: индикация «жив/потерян» + журнал).
 *
 * Контроллер периодически шлёт ArtPoll на адреса нод из конфига и собирает
 * ArtPollReply (имя, выходные вселенные); каждым вторым циклом — ArtTodRequest,
 * получая TOD (список RDM UID приборов на линии). Пропажа ответов дольше
 * порога — событие «потерян» в журнал; возвращение — «снова на связи».
 *
 * Ответы нод принимаются двумя путями: unicast на наш сокет-отправитель
 * (так отвечает большинство нод) и, если удастся занять порт 6454 (reuseAddr),
 * широковещательные ответы по спецификации. Полный опрос сенсоров E1.20
 * (ArtRdm GET SENSOR_VALUE и т.п.) — следующий шаг, когда появится железо.
 */
import dgram from 'node:dgram';
import type { NetworkEvent, NetworkState } from '@fountain-studio/shared';
import { ARTNET_PORT } from './drivers/artnet';
import { eventLog } from './eventlog';
import { buildRdmPacket, OP_RDM, parseRdmPacket, unwrapArtRdm, wrapArtRdm, type RdmResponse } from './rdm';

const OP_POLL = 0x2000;
const OP_POLL_REPLY = 0x2100;
const OP_DMX = 0x5000;
const OP_TOD_REQUEST = 0x8000;
const OP_TOD_DATA = 0x8100;

interface NodeRec {
  ip: string;
  shortName: string;
  longName: string;
  outputUniverses: number[];
  lastSeen: number;
  lost: boolean;
}

interface RdmRec {
  uid: string;
  nodeIp: string;
  universe: number;
  lastSeen: number;
  lost: boolean;
}

export interface NetMonitorOptions {
  /** Адреса, куда слать ArtPoll (ноды из конфига; '255.255.255.255' — broadcast). */
  targets: string[];
  /** Вселенные проекта (Port-Address, с 0) — для ArtTodRequest. */
  universes: number[];
  port?: number;
  pollMs?: number;
  nodeTimeoutMs?: number;
  rdmTimeoutMs?: number;
}

export class NetworkMonitor {
  /** Вызывается при каждом изменении состояния (новая нода, пропажа и т.п.). */
  onChange: (() => void) | null = null;
  /** Входящий ArtDMX с линии (внешний источник): Port-Address, кадр, IP отправителя. */
  onDmx: ((universe: number, data: Uint8Array, fromIp: string) => void) | null = null;

  private readonly opts: Required<NetMonitorOptions>;
  private socket: dgram.Socket | null = null;
  private listenSocket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pollCount = 0;
  private nodes = new Map<string, NodeRec>();
  private rdm = new Map<string, RdmRec>();
  private log: NetworkEvent[] = [];
  private rdmTransactionCounter = 0;
  private pendingRdm = new Map<number, { resolve: (r: RdmResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(opts: NetMonitorOptions) {
    this.opts = {
      port: ARTNET_PORT,
      pollMs: 3000,
      nodeTimeoutMs: 10_000,
      rdmTimeoutMs: 30_000,
      ...opts,
    };
  }

  /**
   * Открыли другой объект — у него свои ноды и вселенные. Перезапускаем
   * опрос с новыми целями и забываем прежние находки: они относились к
   * другому фонтану, и показывать их как «потерянные» нельзя.
   */
  configure(opts: Pick<NetMonitorOptions, 'targets' | 'universes'>): void {
    const wasRunning = this.socket !== null;
    if (wasRunning) this.stop();
    this.opts.targets = opts.targets;
    this.opts.universes = opts.universes;
    this.nodes.clear();
    this.rdm.clear();
    this.log = [];
    if (wasRunning && opts.targets.length > 0) this.start();
    this.onChange?.();
  }

  /**
   * Запустить опрос. Повторный вызов перезапускает, а не заводит второй сокет.
   *
   * Грабля, из-за которой так сделано (найдена 22.09.2026 сквозной
   * проверкой): при «Применить» в настройках configure() уже перезапускал
   * опрос, а следом configureNet() звал start() ещё раз. Второй сокет
   * затирал ссылку на первый, и когда первый заканчивал привязку, его
   * обработчик звал setBroadcast у ВТОРОГО, ещё не привязанного, —
   * исключение вне try, и движок падал. На объекте с Art-Net это значило:
   * нажал «Применить» посреди шоу — фонтан встал.
   *
   * Поэтому: start() сначала гасит прежний опрос, а обработчики работают
   * только со СВОИМ сокетом и молчат, если он уже не текущий.
   */
  start(): void {
    if (this.socket || this.listenSocket || this.timer) this.stopSockets();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = sock;
    sock.on('error', (e) => console.error('[net] ошибка сокета:', e.message));
    sock.on('message', (msg, rinfo) => this.parse(msg, rinfo.address));
    sock.bind(0, () => {
      if (this.socket !== sock) return; // пока привязывались, опрос перезапустили
      try {
        sock.setBroadcast(true);
      } catch (e) {
        console.error('[net] не удалось включить широковещание:', e instanceof Error ? e.message : e);
      }
      this.poll();
    });
    // Порт 6454 — для нод, отвечающих broadcast'ом; занят (например, монитором) — не страшно.
    const listen = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.listenSocket = listen;
    listen.on('error', () => {
      listen.close();
      if (this.listenSocket === listen) this.listenSocket = null;
    });
    listen.on('message', (msg, rinfo) => this.parse(msg, rinfo.address));
    listen.bind(this.opts.port);
    this.timer = setInterval(() => this.poll(), this.opts.pollMs);
  }

  /** Закрыть сокеты и таймер, не трогая ожидающие ответы RDM. */
  private stopSockets(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.socket?.close();
    } catch {
      // уже закрыт
    }
    try {
      this.listenSocket?.close();
    } catch {
      // уже закрыт
    }
    this.socket = null;
    this.listenSocket = null;
  }

  stop(): void {
    this.stopSockets();
    for (const p of this.pendingRdm.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('монитор сети остановлен'));
    }
    this.pendingRdm.clear();
  }

  /** Немедленный цикл опроса (кнопка «Обновить» в UI). */
  poll(): void {
    if (!this.socket) return;
    const poll = Buffer.alloc(14);
    poll.write('Art-Net\0', 0, 'latin1');
    poll.writeUInt16LE(OP_POLL, 8);
    poll.writeUInt8(0, 10);
    poll.writeUInt8(14, 11); // ProtVerLo
    poll.writeUInt8(0x02, 12); // TalkToMe: слать ArtPollReply при изменениях
    for (const host of this.opts.targets) {
      this.socket.send(poll, this.opts.port, host);
    }
    // TOD — каждым вторым циклом, чтобы не заваливать линию RDM-трафиком.
    if (this.pollCount % 2 === 1) this.requestTod();
    this.pollCount++;
    this.checkTimeouts();
  }

  private requestTod(): void {
    if (!this.socket) return;
    // Группируем вселенные по Net (старшие 7 бит Port-Address).
    const byNet = new Map<number, number[]>();
    for (const u of this.opts.universes) {
      const net = (u >> 8) & 0x7f;
      const list = byNet.get(net) ?? [];
      if (list.length < 32) list.push(u & 0xff);
      byNet.set(net, list);
    }
    for (const [net, addrs] of byNet) {
      const pkt = Buffer.alloc(24 + 32);
      pkt.write('Art-Net\0', 0, 'latin1');
      pkt.writeUInt16LE(OP_TOD_REQUEST, 8);
      pkt.writeUInt8(0, 10);
      pkt.writeUInt8(14, 11);
      pkt.writeUInt8(net, 21);
      pkt.writeUInt8(0, 22); // Command = TodFull
      pkt.writeUInt8(addrs.length, 23);
      addrs.forEach((a, i) => pkt.writeUInt8(a, 24 + i));
      for (const host of this.opts.targets) {
        this.socket.send(pkt, this.opts.port, host);
      }
    }
  }

  private parse(msg: Buffer, fromIp: string): void {
    if (msg.length < 12 || msg.toString('latin1', 0, 8) !== 'Art-Net\0') return;
    const op = msg.readUInt16LE(8);
    if (op === OP_POLL_REPLY) this.parsePollReply(msg, fromIp);
    else if (op === OP_TOD_DATA) this.parseTodData(msg, fromIp);
    else if (op === OP_DMX) this.parseDmx(msg, fromIp);
    else if (op === OP_RDM) this.parseRdmReply(msg);
  }

  private parseRdmReply(msg: Buffer): void {
    const rdmPkt = unwrapArtRdm(msg);
    if (!rdmPkt) return;
    const resp = parseRdmPacket(rdmPkt);
    if (!resp) return;
    const pending = this.pendingRdm.get(resp.transactionNum);
    if (!pending) return; // ответ на неизвестную/устаревшую транзакцию — молча отбрасываем
    this.pendingRdm.delete(resp.transactionNum);
    clearTimeout(pending.timer);
    pending.resolve(resp);
  }

  /**
   * GET/SET конкретного параметра (PID) у прибора, уже обнаруженного через TOD
   * (§16, §22: identify/чтение и перестановка DMX-адреса удалённо). Rejects по
   * таймауту или если прибор/его нода сейчас не значатся в TOD/ArtPoll.
   */
  rdmRequest(targetUid: string, cc: number, pid: number, paramData: Buffer = Buffer.alloc(0), timeoutMs = 1000): Promise<RdmResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('монитор сети не запущен'));
        return;
      }
      const device = this.rdm.get(targetUid);
      if (!device) {
        reject(new Error(`RDM-прибор ${targetUid} сейчас не найден среди приборов, о которых сообщил узел`));
        return;
      }
      const txNum = (this.rdmTransactionCounter = (this.rdmTransactionCounter + 1) & 0xff);
      const rdmPkt = buildRdmPacket(targetUid, cc, pid, txNum, paramData);
      const net = (device.universe >> 8) & 0x7f;
      const artRdmPkt = wrapArtRdm(rdmPkt, net);
      const timer = setTimeout(() => {
        this.pendingRdm.delete(txNum);
        reject(new Error('таймаут ответа RDM'));
      }, timeoutMs);
      this.pendingRdm.set(txNum, { resolve, reject, timer });
      this.socket!.send(artRdmPkt, this.opts.port, device.nodeIp);
    });
  }

  private parseDmx(msg: Buffer, fromIp: string): void {
    if (!this.onDmx || msg.length < 18) return;
    const universe = msg.readUInt8(14) | ((msg.readUInt8(15) & 0x7f) << 8);
    const length = Math.min((msg.readUInt8(16) << 8) | msg.readUInt8(17), msg.length - 18);
    if (length <= 0) return;
    this.onDmx(universe, new Uint8Array(msg.subarray(18, 18 + length)), fromIp);
  }

  private parsePollReply(msg: Buffer, fromIp: string): void {
    if (msg.length < 194) return;
    const str = (start: number, len: number): string => {
      const raw = msg.toString('latin1', start, start + len);
      const nul = raw.indexOf('\0');
      return (nul >= 0 ? raw.slice(0, nul) : raw).trim();
    };
    const net = msg.readUInt8(18) & 0x7f;
    const sub = msg.readUInt8(19) & 0x0f;
    const numPorts = Math.min(4, msg.readUInt8(173));
    const outputUniverses: number[] = [];
    for (let i = 0; i < numPorts; i++) {
      const portType = msg.readUInt8(174 + i);
      if ((portType & 0x80) !== 0) {
        const swOut = msg.readUInt8(190 + i) & 0x0f;
        outputUniverses.push((net << 8) | (sub << 4) | swOut);
      }
    }
    const now = Date.now();
    const prev = this.nodes.get(fromIp);
    const rec: NodeRec = {
      ip: fromIp,
      shortName: str(26, 18) || fromIp,
      longName: str(44, 64),
      outputUniverses,
      lastSeen: now,
      lost: false,
    };
    this.nodes.set(fromIp, rec);
    if (!prev) this.event(`Art-Net нода «${rec.shortName}» (${fromIp}) на связи, вселенных: ${outputUniverses.length}`);
    else if (prev.lost) this.event(`Art-Net нода «${rec.shortName}» (${fromIp}) снова на связи`);
  }

  private parseTodData(msg: Buffer, fromIp: string): void {
    if (msg.length < 28) return;
    const net = msg.readUInt8(21) & 0x7f;
    const address = msg.readUInt8(23);
    const universe = (net << 8) | address;
    const uidCount = msg.readUInt8(27);
    const now = Date.now();
    for (let i = 0; i < uidCount; i++) {
      const off = 28 + i * 6;
      if (off + 6 > msg.length) break;
      const man = msg.readUInt16BE(off).toString(16).padStart(4, '0');
      const dev = msg.readUInt32BE(off + 2).toString(16).padStart(8, '0');
      const uid = `${man}:${dev}`;
      const prev = this.rdm.get(uid);
      this.rdm.set(uid, { uid, nodeIp: fromIp, universe, lastSeen: now, lost: false });
      if (!prev) this.event(`RDM-прибор ${uid} обнаружен (вселенная ${universe}, Art-Net нода ${fromIp})`);
      else if (prev.lost) this.event(`RDM-прибор ${uid} снова на связи`);
    }
  }

  private checkTimeouts(): void {
    const now = Date.now();
    for (const n of this.nodes.values()) {
      if (!n.lost && now - n.lastSeen > this.opts.nodeTimeoutMs) {
        n.lost = true;
        this.event(`Art-Net нода «${n.shortName}» (${n.ip}) ПОТЕРЯНА — нет ответа ${Math.round((now - n.lastSeen) / 1000)} с`);
      }
    }
    for (const d of this.rdm.values()) {
      if (!d.lost && now - d.lastSeen > this.opts.rdmTimeoutMs) {
        d.lost = true;
        this.event(`RDM-прибор ${d.uid} ПРОПАЛ (вселенная ${d.universe})`);
      }
    }
  }

  private event(text: string): void {
    this.log.push({ atMs: Date.now(), text });
    if (this.log.length > 100) this.log.splice(0, this.log.length - 100);
    const lost = text.includes('ПОТЕРЯН') || text.includes('ПРОПАЛ');
    // «Снова на связи» помечаем явно — по этой пометке уведомления шлют
    // «✅ Восстановлено» (см. shared LogEvent.kind).
    const back = text.includes('снова на связи');
    eventLog.log('net', text, lost ? 'warn' : 'info', back ? 'recovery' : undefined);
    this.onChange?.();
  }

  state(): NetworkState {
    const now = Date.now();
    return {
      enabled: true,
      nodes: [...this.nodes.values()]
        .sort((a, b) => a.ip.localeCompare(b.ip))
        .map((n) => ({
          ip: n.ip,
          shortName: n.shortName,
          longName: n.longName,
          outputUniverses: n.outputUniverses,
          ageMs: now - n.lastSeen,
          lost: n.lost,
        })),
      rdmDevices: [...this.rdm.values()]
        .sort((a, b) => a.uid.localeCompare(b.uid))
        .map((d) => ({
          uid: d.uid,
          nodeIp: d.nodeIp,
          universe: d.universe,
          ageMs: now - d.lastSeen,
          lost: d.lost,
        })),
      log: [...this.log].reverse(),
    };
  }
}
