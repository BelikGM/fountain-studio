import { SerialPort } from 'serialport';
import { DMX_UNIVERSE_SIZE } from '@fountain-studio/shared';
import type { UniverseOutput } from './output';

/**
 * «Открытый» USB-DMX: адаптер без своего контроллера, кадр формирует хост.
 *
 * Зачем он нужен отдельно от usb-dmx.ts. Тот драйвер говорит по протоколу
 * ENTTEC DMX USB PRO: хост шлёт пакет в обёртке, а тайминг DMX512 на линии
 * держит сам виджет. Но на объектах, особенно старых, гораздо чаще стоит
 * дешёвая «свисток»-переходка на FTDI (Open DMX USB и её бесчисленные клоны).
 * У неё внутри нет ничего, кроме USB-UART и драйвера RS-485: она отдаёт в
 * линию ровно те байты, что пришли, и весь кадр DMX512 обязан построить хост.
 *
 * Как устроен кадр DMX512 (ANSI E1.11):
 *  · скорость 250 000 бод, 8 бит, без чётности, ДВА стоп-бита (8N2);
 *  · BREAK — линия в нуле не меньше 88 мкс (обычно 100);
 *  · MAB (Mark After Break) — единица не меньше 8 мкс (обычно 12);
 *  · стартовый байт 0x00, затем до 512 байт данных.
 *
 * Про точность времени. Node не умеет выдерживать микросекунды, поэтому BREAK
 * и MAB здесь получаются длиннее положенного — единицы миллисекунд. Стандарт
 * это допускает: у BREAK и MAB ограничен только МИНИМУМ, а сверху они могут
 * тянуться до секунды. Приёмник просто ждёт дольше; частота обновления при
 * этом остаётся в норме для фонтана (20 Гц против допустимых 44).
 */
export interface OpenDmxOptions {
  /** COM-порт адаптера, напр. "COM5". */
  path: string;
  /** Скорость линии DMX512. Менять незачем — 250000 задано стандартом. */
  baudRate?: number;
}

export class OpenDmxOutput implements UniverseOutput {
  private port: SerialPort | null = null;
  private opening = false;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Кадр целиком: стартовый байт + 512 слотов. */
  private readonly buf = Buffer.alloc(DMX_UNIVERSE_SIZE + 1);
  /** Идёт отправка предыдущего кадра — новый пропускаем, чтобы не копить очередь. */
  private busy = false;

  constructor(private readonly opts: OpenDmxOptions) {
    this.open();
  }

  private open(): void {
    if (this.closed || this.port || this.opening) return;
    this.opening = true;
    const port = new SerialPort({
      path: this.opts.path,
      baudRate: this.opts.baudRate ?? 250000,
      dataBits: 8,
      stopBits: 2,
      parity: 'none',
      autoOpen: false,
    });
    port.on('error', () => {
      /* разбираем через close — переподключение по таймеру */
    });
    port.on('close', () => {
      this.port = null;
      this.busy = false;
      if (!this.closed) this.scheduleReconnect();
    });
    port.open((err: Error | null | undefined) => {
      this.opening = false;
      if (err) {
        this.scheduleReconnect();
        return;
      }
      this.port = port;
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, 2000);
  }

  send(frame: Uint8Array): void {
    const port = this.port;
    if (!port || !port.isOpen || this.busy) return;
    this.buf[0] = 0; // стартовый байт: 0x00 — обычные данные освещения
    this.buf.set(frame.subarray(0, DMX_UNIVERSE_SIZE), 1);
    this.busy = true;
    /**
     * BREAK → MAB → данные. Каждый шаг ждёт подтверждения предыдущего: без
     * этого драйвер порта может переставить их местами, и приёмник увидит
     * мусор вместо кадра.
     */
    port.set({ brk: true, rts: false }, (e1) => {
      if (e1) {
        this.busy = false;
        return;
      }
      setTimeout(() => {
        port.set({ brk: false, rts: false }, (e2) => {
          if (e2) {
            this.busy = false;
            return;
          }
          setTimeout(() => {
            port.write(this.buf, (e3) => {
              if (e3) {
                this.busy = false;
                return;
              }
              port.drain(() => {
                this.busy = false;
              });
            });
          }, 1);
        });
      }, 1);
    });
  }

  describe(): string {
    return `open-dmx ${this.opts.path} @${this.opts.baudRate ?? 250000} 8N2`;
  }

  /** Порт открыт — значит, байты уходят в адаптер (см. drivers/output.ts). */
  healthy(): boolean {
    return !!this.port?.isOpen;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const port = this.port;
    this.port = null;
    if (port?.isOpen) port.close(() => undefined);
  }
}
