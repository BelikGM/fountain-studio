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
  private socket: dgram.Socket | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly port: number,
    private readonly getBindings: () => OscBinding[],
  ) {}

  start(): void {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (msg) => this.handle(msg));
    this.socket.on('error', (e) => eventLog.log('osc', `ошибка сокета: ${e.message}`, 'error'));
    this.socket.bind(this.port, () => eventLog.log('osc', `слушаю UDP ${this.port}`));
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

  stop(): void {
    this.socket?.close();
    this.socket = null;
  }
}
