import { SerialPort } from 'serialport';
import type { UniverseOutput } from './output';
import { loadD2xx, d2xxError, d2xxProblem, ftStatusText, type D2xx } from './ftd2xx';
import { encodeFrame, outCommand } from './musidora-proto';

/**
 * Выход на USB-DMX интерфейс из комплекта FontanPlay (USB1DMX / USB2DMX / USB3DMX).
 *
 * Формат кадра и порядок открытия сняты с рабочей программы FontanPlay —
 * подробности в musidora-proto.ts. Здесь транспорт: один интерфейс может нести
 * до трёх линий DMX (у USB2DMX — две), а у нас каждая линия — отдельная
 * вселенная со своим выходом. Поэтому устройство открывается один раз на всех
 * (интерфейс, класс MusidoraLink), а выходы вселенных только отдают ему кадры.
 *
 * Как выбирается устройство (поле path):
 *  · пусто — как FontanPlay: первое FTDI-устройство, которое не занято;
 *  · «COM5» — через виртуальный COM-порт (так шлёт вспомогательная FPCOM.exe);
 *  · иначе — серийный номер FTDI (виден в настройках после поиска).
 */
export interface MusidoraOptions {
  /** '' — автопоиск, «COMn» — COM-порт, иначе серийный номер FTDI. */
  path?: string;
  /** Выход интерфейса 1…3 (разъём DMX). */
  out?: number;
}

export interface MusidoraLinkState {
  /** Как выбрано устройство: «авто», серийный номер или COM-порт. */
  target: string;
  phase: 'loading' | 'searching' | 'open' | 'error';
  /** Человеческое пояснение состояния. */
  text: string;
  serial: string;
  description: string;
  /** Выходы интерфейса, на которые сейчас пишем. */
  outs: number[];
  framesOk: number;
  framesFailed: number;
  lastOkMs: number;
}

const RECONNECT_MS = 2000;
/** Дольше этого без успешного кадра — считаем, что доставки нет (см. healthy). */
const MUSIDORA_STALE_MS = 3000;
/** Сколько ждать после закрытия последнего выхода, прежде чем отпустить устройство. */
const RELEASE_MS = 400;

interface Transport {
  write(data: Buffer): Promise<string | null>;
  close(): void;
}

class MusidoraLink {
  refs = 0;
  private transport: Transport | null = null;
  private opening = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private releaseTimer: NodeJS.Timeout | null = null;
  /** Последний кадр каждого выхода, ещё не ушедший в устройство (ключ — команда выхода). */
  private readonly pending = new Map<number, Buffer>();
  private writing = false;
  private disposed = false;
  readonly state: MusidoraLinkState;

  constructor(
    readonly key: string,
    private readonly path: string,
  ) {
    this.state = {
      target: path || 'авто',
      phase: 'loading',
      text: 'подключение…',
      serial: '',
      description: '',
      outs: [],
      framesOk: 0,
      framesFailed: 0,
      lastOkMs: 0,
    };
  }

  acquire(): void {
    this.refs++;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.open();
  }

  release(onGone: () => void): void {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0 || this.releaseTimer) return;
    // Небольшая пауза: при «Применить» выходы пересоздаются, и устройство
    // не надо закрывать и тут же открывать заново.
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (this.refs > 0) return;
      this.disposed = true;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.pending.clear();
      const t = this.transport;
      this.transport = null;
      // Идущая запись завершится сама; закрываем после неё.
      if (t) void this.whenIdle().then(() => t.close());
      onGone();
    }, RELEASE_MS);
  }

  private async whenIdle(): Promise<void> {
    for (let i = 0; i < 20 && this.writing; i++) await new Promise((r) => setTimeout(r, 50));
  }

  private setError(text: string): void {
    this.state.phase = 'error';
    this.state.text = text;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, RECONNECT_MS);
  }

  private open(): void {
    if (this.disposed || this.transport || this.opening) return;
    this.opening = true;
    const done = (t: Transport | null): void => {
      this.opening = false;
      if (this.disposed) {
        t?.close();
        return;
      }
      if (!t) {
        this.scheduleReconnect();
        return;
      }
      this.transport = t;
      this.state.phase = 'open';
      this.state.text = 'интерфейс открыт';
      this.pump();
    };
    if (/^COM\d+$/i.test(this.path)) this.openSerial(this.path.toUpperCase()).then(done, () => done(null));
    else this.openD2xx().then(done, () => done(null));
  }

  private async openD2xx(): Promise<Transport | null> {
    const d2 = await loadD2xx();
    if (!d2) {
      // Коротко и по делу; подробности — в строке «Драйвер FTDI» настроек.
      if (/koffi/.test(d2xxError())) this.setError('не загрузился модуль вызова драйвера (koffi)');
      else {
        const p = d2xxProblem();
        this.setError(
          p === 'no-device'
            ? 'интерфейс не подключён к этому ПК'
            : p === 'no-driver'
              ? 'на этом ПК не установлен драйвер FTDI'
              : p === 'wrong-bitness'
                ? 'нужен 64-разрядный драйвер FTDI'
                : 'драйвер FTDI недоступен',
        );
      }
      return null;
    }
    const devices = d2.list();
    let target: { serial?: string; index?: number };
    if (this.path) {
      const dev = devices.find((d) => d.serial === this.path);
      if (!dev) {
        this.setError(
          devices.length
            ? `интерфейс с серийным номером ${this.path} не подключён (найдено FTDI: ${devices.map((d) => d.serial || '—').join(', ')})`
            : `интерфейс с серийным номером ${this.path} не подключён — FTDI-устройств не найдено`,
        );
        return null;
      }
      if (dev.opened) {
        this.setError(`интерфейс ${dev.serial} занят другой программой — закройте FontanPlay`);
        return null;
      }
      target = { serial: dev.serial };
      this.state.serial = dev.serial;
      this.state.description = dev.description;
    } else {
      if (devices.length === 0) {
        this.state.phase = 'searching';
        this.state.text = 'интерфейс не найден: проверьте кабель USB и драйвер FTDI (в Диспетчере устройств — «USB Serial Converter»)';
        return null;
      }
      const free = devices.find((d) => !d.opened);
      if (!free) {
        this.setError('интерфейс занят другой программой — закройте FontanPlay');
        return null;
      }
      target = free.serial ? { serial: free.serial } : { index: free.index };
      this.state.serial = free.serial;
      this.state.description = free.description;
    }
    const r = d2.open(target);
    if ('error' in r) {
      this.setError(`не открылся: ${r.error}`);
      return null;
    }
    const prep = d2.prepare(r.handle);
    if (prep) {
      d2.close(r.handle);
      this.setError(prep);
      return null;
    }
    return d2Transport(d2, r.handle);
  }

  private openSerial(path: string): Promise<Transport | null> {
    return new Promise((resolve) => {
      // У FT245R скорость порта ни на что не влияет (это FIFO, а не UART);
      // DMX-скорость на линии строит микроконтроллер интерфейса.
      const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
      port.on('error', () => undefined);
      port.on('close', () => {
        if (this.transport === t) {
          this.transport = null;
          this.setError(`${path} закрылся (кабель вынут?)`);
          this.scheduleReconnect();
        }
      });
      const t: Transport = {
        write: (data) =>
          new Promise((res) => {
            port.write(data, (e) => {
              if (e) return res(e.message);
              port.drain((e2) => res(e2 ? e2.message : null));
            });
          }),
        close: () => {
          if (port.isOpen) port.close(() => undefined);
        },
      };
      port.open((err) => {
        if (err) {
          this.setError(`${path}: ${err.message}`);
          resolve(null);
          return;
        }
        this.state.serial = '';
        this.state.description = path;
        resolve(t);
      });
    });
  }

  submit(cmd: number, frame: Buffer): void {
    this.pending.set(cmd, frame);
    this.pump();
  }

  /** Отправка по очереди: один FT_Write за раз, у каждого выхода — только свежий кадр. */
  private pump(): void {
    if (this.writing || !this.transport || this.pending.size === 0) return;
    const first = this.pending.entries().next().value;
    if (!first) return;
    const [cmd, frame] = first;
    this.pending.delete(cmd);
    const t = this.transport;
    this.writing = true;
    void t.write(frame).then((err) => {
      this.writing = false;
      if (err) {
        this.state.framesFailed++;
        if (this.transport === t) {
          this.transport = null;
          t.close();
          this.setError(`запись не прошла: ${err} — переподключение`);
          this.scheduleReconnect();
        }
        return;
      }
      this.state.framesOk++;
      this.state.lastOkMs = Date.now();
      if (this.state.phase !== 'open') {
        this.state.phase = 'open';
        this.state.text = 'интерфейс открыт';
      }
      this.pump();
    });
  }
}

function d2Transport(d2: D2xx, handle: unknown): Transport {
  let closed = false;
  return {
    async write(data) {
      if (closed) return 'устройство закрыто';
      const r = await d2.write(handle, data);
      if (r.status !== 0) return ftStatusText(r.status);
      if (r.written !== data.length) return `записано ${r.written} из ${data.length} байт`;
      return null;
    },
    close() {
      if (closed) return;
      closed = true;
      d2.close(handle);
    },
  };
}

const links = new Map<string, MusidoraLink>();

function linkFor(path: string): MusidoraLink {
  const key = /^COM\d+$/i.test(path) ? path.toUpperCase() : path;
  let link = links.get(key);
  if (!link) {
    link = new MusidoraLink(key, key);
    links.set(key, link);
  }
  return link;
}

/** Состояние всех открытых интерфейсов — для вкладки «Настройки». */
export function musidoraLinkStates(): MusidoraLinkState[] {
  return [...links.values()].map((l) => ({ ...l.state, outs: [...l.state.outs] }));
}

export class MusidoraOutput implements UniverseOutput {
  private readonly link: MusidoraLink;
  private readonly out: number;
  private readonly cmd: number;
  private closed = false;

  constructor(opts: MusidoraOptions) {
    this.out = Math.min(3, Math.max(1, Math.round(opts.out ?? 1) || 1));
    this.cmd = outCommand(this.out);
    this.link = linkFor((opts.path ?? '').trim());
    this.link.acquire();
    if (!this.link.state.outs.includes(this.out)) this.link.state.outs.push(this.out);
    this.link.state.outs.sort();
  }

  send(frame: Uint8Array): void {
    if (this.closed) return;
    this.link.submit(this.cmd, encodeFrame(this.out, frame));
  }

  describe(): string {
    return `USB-DMX FountanPlay, выход ${this.out} → ${this.link.state.target}`;
  }

  /**
   * Кадры доходят, если интерфейс открыт и последняя запись прошла недавно.
   * Пока выход только что создан и первый кадр ещё не ушёл, считаем, что всё
   * в порядке: иначе аварийное отключение срабатывало бы на каждом
   * «Применить» в настройках.
   */
  healthy(): boolean {
    if (this.link.state.phase !== 'open') return false;
    if (this.link.state.lastOkMs === 0) return true;
    return Date.now() - this.link.state.lastOkMs < MUSIDORA_STALE_MS;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const link = this.link;
    link.state.outs = link.state.outs.filter((o) => o !== this.out);
    link.release(() => {
      if (links.get(link.key) === link) links.delete(link.key);
    });
  }
}
