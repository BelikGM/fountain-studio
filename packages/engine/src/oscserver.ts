import dgram from 'node:dgram';
import { parseOscMessage, type OscBinding } from '@fountain-studio/shared';
import { eventLog } from './eventlog';
import type { Engine } from './engine';
import { fireRemoteAction } from './remotedispatch';

/**
 * Приём OSC-команд (пульты вроде TouchOSC, §1 доработки: «точного 1 ответа
 * нет» для сети управления — этот путь работает независимо от Art-Net/Modbus).
 * Слушает UDP-порт, разбирает OSC-сообщение, сверяет адрес с project.oscBindings
 * (точное совпадение) и исполняет действие. Для «кнопочных» сообщений
 * (аргумент 0 = float/int 0) не срабатывает — так типичный TouchOSC-тумблер
 * шлёт и нажатие (1), и отпускание (0), а нам нужно только нажатие.
 */
export class OscServer {
  /** Порт открылся или не открылся — чтобы вкладка «Внешние пульты» сказала это прямо. */
  onChange: (() => void) | null = null;
  /** Порт открыт и команды принимаются. */
  listening = false;
  /** Почему порт не открылся; null — всё в порядке. */
  error: string | null = null;

  private socket: dgram.Socket | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly port: number,
    private readonly getBindings: () => OscBinding[],
  ) {}

  start(): void {
    const socket = dgram.createSocket('udp4');
    this.socket = socket;
    socket.on('message', (msg) => this.handle(msg));
    socket.on('error', (e: NodeJS.ErrnoException) => {
      // Самая частая причина на объекте — порт уже держит другая программа
      // (второй экземпляр, другой OSC-приёмник). Говорим это словами, а не кодом.
      this.error = e.code === 'EADDRINUSE' ? `порт ${this.port} занят другой программой` : e.message;
      this.listening = false;
      eventLog.log('osc', `не удалось открыть порт ${this.port}: ${this.error}`, 'error');
      if (this.socket === socket) {
        this.socket = null;
        try {
          socket.close();
        } catch {
          /* уже закрыт */
        }
      }
      this.onChange?.();
    });
    socket.bind(this.port, () => {
      this.listening = true;
      this.error = null;
      eventLog.log('osc', `слушаю UDP ${this.port}`);
      this.onChange?.();
    });
  }

  private handle(msg: Buffer): void {
    const parsed = parseOscMessage(msg);
    if (!parsed) return;
    if (parsed.args.length > 0 && parsed.args[0] === 0) return; // отпускание кнопки — игнор
    const binding = this.getBindings().find((b) => b.address === parsed.address);
    if (!binding) return;
    eventLog.log('osc', `${parsed.address} → ${binding.action.type}`);
    fireRemoteAction(this.engine, binding.action);
  }

  /**
   * Закрыть порт. Обещание — чтобы при смене настроек новый приёмник открывался
   * ПОСЛЕ того, как старый порт реально отпущен, иначе тот же порт «занят».
   */
  stop(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.listening = false;
    if (!socket) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  get portNumber(): number {
    return this.port;
  }
}
