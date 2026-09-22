import {
  parseWindPayload,
  type WindLimitConfig,
  type WindSensorModbus,
  type WindSensorStatus,
} from '@fountain-studio/shared';
import { eventLog } from './eventlog';
import { modbusConnectionKey, type ModbusPool } from './modbuspool';

/** Раз в секунду: ветер меняется за секунды, чаще опрашивать шину незачем. */
const POLL_MS = 1000;

/**
 * Датчик ветра: опрос анемометра по Modbus или показание из MQTT.
 *
 * Сам расчёт снижения струй живёт в движке (stepWindCorrection) и не знает,
 * откуда пришло число — отсюда оно просто передаётся в onReading. Здесь —
 * только связь с прибором и честность о ней.
 *
 * Датчик замолчал — последнее показание ДЕРЖИТСЯ (onReading больше не
 * зовётся, движок помнит прежнее), а в журнал уходит авария: она же приходит
 * в Telegram. Сбросить ветер в ноль из-за обрыва кабеля значило бы поднять
 * струи в ветер, которого мы просто перестали видеть.
 */
export class WindSensor {
  /** Новое показание: скорость, м/с, и направление, откуда дует, ° (если датчик даёт). */
  onReading: ((speedMs: number, directionDeg: number | null) => void) | null = null;
  /** Поменялся статус датчика (на связи / пропал / ошибка) — показать в редакторе. */
  onStatus: (() => void) | null = null;
  /** Поменялся топик MQTT датчика — подписаться на новый. */
  onTopicChange: (() => void) | null = null;

  private cfg: WindLimitConfig | null = null;
  private connKey: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastOkAt = 0;
  private lastSpeed: number | null = null;
  private directionDeg: number | null = null;
  private error: string | null = null;
  private lostLogged = false;
  /** Когда включили этот источник — от него считается «не ответил ни разу». */
  private configuredAt = Date.now();

  constructor(private readonly pool: ModbusPool) {}

  /** Новые настройки ветра объекта. Меняет подключение, только если оно поменялось. */
  configure(cfg: WindLimitConfig): void {
    const prev = this.cfg;
    const prevTopic = this.mqttTopic;
    this.cfg = cfg;
    const active = cfg.enabled && (cfg.source === 'modbus' || cfg.source === 'mqtt');
    const wantKey = cfg.enabled && cfg.source === 'modbus' && connectionReady(cfg.modbus) ? modbusConnectionKey(cfg.modbus.connection) : null;
    if (wantKey !== this.connKey) {
      if (this.connKey) this.pool.release(this.connKey);
      this.connKey = wantKey ? this.pool.acquire(cfg.modbus.connection) : null;
    }
    const sourceChanged =
      !prev || prev.enabled !== cfg.enabled || prev.source !== cfg.source || JSON.stringify(prev.modbus) !== JSON.stringify(cfg.modbus) || prev.mqtt.topic !== cfg.mqtt.topic;
    if (sourceChanged) {
      // Другой датчик — прежние показания и тревоги к нему не относятся.
      this.lastOkAt = 0;
      this.lastSpeed = null;
      this.directionDeg = null;
      this.lostLogged = false;
      this.error = null;
      this.configuredAt = Date.now();
    }
    if (active && !this.timer) {
      this.timer = setInterval(() => void this.tick(), POLL_MS);
      this.timer.unref?.();
    } else if (!active && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (sourceChanged) this.onStatus?.();
    if (this.mqttTopic !== prevTopic) this.onTopicChange?.();
  }

  /** Полный топик, который нужно слушать в MQTT; null — MQTT для ветра не используется. */
  get mqttTopic(): string | null {
    const c = this.cfg;
    return c && c.enabled && c.source === 'mqtt' && c.mqtt.topic !== '' ? c.mqtt.topic : null;
  }

  /** Сообщение из MQTT — зовётся для любого топика, свой отбираем здесь. */
  handleMqtt(topic: string, payload: string): void {
    if (topic !== this.mqttTopic) return;
    const r = parseWindPayload(payload);
    if (!r) {
      this.fail(`в сообщении нет скорости: «${payload.slice(0, 40)}»`);
      return;
    }
    this.accept(r.speedMs, r.directionDeg);
  }

  private async tick(): Promise<void> {
    const c = this.cfg;
    if (!c || !c.enabled) return;
    if (c.source === 'modbus') await this.pollModbus(c.modbus, c.maxPlausibleSpeed);
    else if (c.source === 'mqtt' && c.mqtt.topic === '') this.fail('не указан топик датчика');
    this.checkLost();
  }

  private async pollModbus(m: WindSensorModbus, maxPlausible: number): Promise<void> {
    if (!connectionReady(m)) {
      this.fail(m.connection.kind === 'tcp' ? 'не указан IP-адрес шлюза' : 'не указан COM-порт');
      return;
    }
    const transport = this.connKey ? this.pool.get(this.connKey) : undefined;
    if (!transport || this.polling) return;
    this.polling = true;
    try {
      const raw =
        m.registerKind === 'input'
          ? await transport.readInputRegister(m.unitId, m.register)
          : await transport.readHoldingRegister(m.unitId, m.register);
      let dir: number | null = null;
      if (m.directionRegister !== null) {
        const d =
          m.registerKind === 'input'
            ? await transport.readInputRegister(m.unitId, m.directionRegister)
            : await transport.readHoldingRegister(m.unitId, m.directionRegister);
        dir = ((d / m.directionUnitsPerDeg) % 360 + 360) % 360;
      }
      // «Живой ноль» 4–20 мА: обрыв линии даёт сигнал заметно НИЖЕ нуля шкалы.
      // Это неисправность датчика, а не штиль — принять за 0 м/с значило бы
      // поднять струи в ветер, которого мы просто перестали видеть.
      if (m.zeroRaw > 0 && raw < m.zeroRaw * 0.9) {
        this.fail('сигнал ниже нуля шкалы — обрыв линии датчика 4–20 мА?');
        return;
      }
      const speed = Math.max(0, (raw - m.zeroRaw) / m.unitsPerMs);
      if (speed > maxPlausible) {
        this.fail(`показание ${speed.toFixed(1)} м/с — больше разумного, проверьте масштаб`);
        return;
      }
      this.accept(speed, dir);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.polling = false;
    }
  }

  private accept(speedMs: number, directionDeg: number | null): void {
    if (!Number.isFinite(speedMs) || speedMs < 0) {
      this.fail(`показание не число: ${speedMs}`);
      return;
    }
    const wasOnline = this.online;
    const wasLost = this.lostLogged;
    this.lastOkAt = Date.now();
    this.lastSpeed = speedMs;
    this.directionDeg = directionDeg;
    this.error = null;
    this.lostLogged = false;
    if (wasLost) eventLog.log('wind', `датчик ветра снова на связи: ${speedMs.toFixed(1)} м/с`);
    this.onReading?.(speedMs, directionDeg);
    this.onStatus?.();
    if (!wasOnline && !wasLost) eventLog.log('wind', `датчик ветра на связи: ${speedMs.toFixed(1)} м/с`);
  }

  private fail(message: string): void {
    const changed = this.error !== message;
    this.error = message;
    this.checkLost();
    if (changed) this.onStatus?.();
  }

  /** Замолчал дольше допустимого — одна авария, а не строка в журнал каждую секунду. */
  private checkLost(): void {
    const c = this.cfg;
    if (!c || this.lostLogged || this.online) return;
    // Первое подключение: ждём тот же срок с момента включения, иначе авария
    // летела бы в Telegram каждый раз, пока датчик просто не успел ответить.
    const since = this.lastOkAt || this.configuredAt;
    if (Date.now() - since < c.sensorLostSec * 1000) return;
    this.lostLogged = true;
    const why = this.error ? ` (${this.error})` : '';
    eventLog.log(
      'wind',
      this.lastSpeed === null
        ? `датчик ветра не отвечает${why} — показаний ещё не было, ветер не учитывается`
        : `датчик ветра не отвечает ${Math.round((Date.now() - this.lastOkAt) / 1000)} с${why} — держим последнее показание ${this.lastSpeed.toFixed(1)} м/с`,
      'warn',
    );
    this.onStatus?.();
  }

  private get online(): boolean {
    const c = this.cfg;
    return !!c && this.lastOkAt > 0 && Date.now() - this.lastOkAt < c.sensorLostSec * 1000;
  }

  status(): WindSensorStatus | null {
    const c = this.cfg;
    if (!c || !c.enabled || c.source === 'manual') return null;
    return {
      online: this.online,
      lastOkAgoSec: this.lastOkAt > 0 ? Math.round((Date.now() - this.lastOkAt) / 1000) : null,
      error: this.online ? null : this.error,
      holding: !this.online && this.lastSpeed !== null,
      directionDeg: this.directionDeg,
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.connKey) this.pool.release(this.connKey);
    this.connKey = null;
  }
}

function connectionReady(m: WindSensorModbus): boolean {
  return m.connection.kind === 'tcp' ? m.connection.host !== '' : m.connection.serialPort !== '';
}
