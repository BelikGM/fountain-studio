import {
  sanitizeRemoteSettings,
  type MqttBinding,
  type OscBinding,
  type RemoteSettings,
  type ServerMessage,
} from '@fountain-studio/shared';
import type { Engine } from './engine';
import { eventLog } from './eventlog';
import { MqttController } from './mqttcontroller';
import { OscServer } from './oscserver';

/** То, что про MQTT хранится в файле, но в редактор не уходит. */
export interface MqttSecret {
  password?: string;
  clientId?: string;
}

/**
 * Внешние пульты — OSC и MQTT — с включением на ходу.
 *
 * Раньше приёмники создавались один раз при старте движка по app-config.json:
 * включить OSC значило поправить файл и перезапустить движок, а это остановка
 * шоу. Теперь вкладка «Внешние пульты» присылает настройки, и здесь меняется
 * только то, что поменялось: сдвинули порт OSC — MQTT не переподключается, и
 * наоборот. Воспроизведение этого не замечает вовсе — приёмники лишь зовут
 * те же действия, что клавиши.
 */
export class RemoteControl {
  /** Состояние поменялось — показать в редакторе. */
  onChange: (() => void) | null = null;

  private settings: RemoteSettings;
  private osc: OscServer | null = null;
  private mqtt: MqttController | null = null;
  /** Цепочка применений: два быстрых нажатия «Применить» не открывают порт дважды. */
  private applying: Promise<void> = Promise.resolve();

  constructor(
    private readonly engine: Engine,
    private readonly getOscBindings: () => OscBinding[],
    private readonly getMqttBindings: () => MqttBinding[],
    initial: RemoteSettings,
    private readonly secret: MqttSecret = {},
  ) {
    this.settings = sanitizeRemoteSettings(initial);
  }

  start(): void {
    this.startOsc();
    this.startMqtt();
  }

  get current(): RemoteSettings {
    return this.settings;
  }

  get hasPassword(): boolean {
    return Boolean(this.secret.password);
  }

  /** Пароль и id клиента — для записи в файл вместе с остальным. */
  get mqttSecret(): MqttSecret {
    return { ...this.secret };
  }

  /**
   * Применить новые настройки. password: undefined — пароль не трогаем,
   * пустая строка — убрать.
   */
  apply(next: RemoteSettings, password?: string): Promise<void> {
    this.applying = this.applying.then(() => this.applyNow(next, password));
    return this.applying;
  }

  private async applyNow(next: RemoteSettings, password?: string): Promise<void> {
    const s = sanitizeRemoteSettings(next);
    const prev = this.settings;
    const oscChanged = s.osc.enabled !== prev.osc.enabled || s.osc.port !== prev.osc.port;
    const passwordChanged = password !== undefined && (password || undefined) !== this.secret.password;
    const mqttChanged = JSON.stringify(s.mqtt) !== JSON.stringify(prev.mqtt) || passwordChanged;
    this.settings = s;
    if (password !== undefined) this.secret.password = password || undefined;

    if (oscChanged) {
      await this.osc?.stop();
      this.osc = null;
      eventLog.log('osc', s.osc.enabled ? `включён, порт ${s.osc.port}` : 'выключен');
      this.startOsc();
    }
    if (mqttChanged) {
      this.mqtt?.stop();
      this.mqtt = null;
      eventLog.log('mqtt', s.mqtt.enabled ? `подключаюсь к ${s.mqtt.host || '(адрес не указан)'}:${s.mqtt.port}` : 'выключен');
      this.startMqtt();
    }
    this.onChange?.();
  }

  private startOsc(): void {
    if (!this.settings.osc.enabled) return;
    const osc = new OscServer(this.engine, this.settings.osc.port, this.getOscBindings);
    osc.onChange = () => this.onChange?.();
    this.osc = osc;
    osc.start();
  }

  private startMqtt(): void {
    const m = this.settings.mqtt;
    // Без адреса брокера подключаться некуда — в статусе так и скажем.
    if (!m.enabled || !m.host) return;
    const mqtt = new MqttController(
      this.engine,
      {
        host: m.host,
        port: m.port,
        topicPrefix: m.topicPrefix,
        username: m.username || undefined,
        password: this.secret.password,
        clientId: this.secret.clientId,
      },
      this.getMqttBindings,
    );
    mqtt.onChange = () => this.onChange?.();
    mqtt.startTelemetry();
    this.mqtt = mqtt;
  }

  /** Публикация под префиксом MQTT (аварии); без подключения — молча ничего. */
  publish(topicSuffix: string, payload: string): void {
    this.mqtt?.publish(topicSuffix, payload);
  }

  status(): Extract<ServerMessage, { type: 'remoteStatus' }> {
    const s = this.settings;
    return {
      type: 'remoteStatus',
      settings: s,
      mqttHasPassword: this.hasPassword,
      osc: {
        enabled: s.osc.enabled,
        listening: this.osc?.listening ?? false,
        error: this.osc?.error ?? null,
      },
      mqtt: {
        enabled: s.mqtt.enabled,
        connected: this.mqtt?.isConnected ?? false,
        error: s.mqtt.enabled && !s.mqtt.host ? 'не указан адрес брокера' : null,
      },
    };
  }

  async stop(): Promise<void> {
    await this.osc?.stop();
    this.mqtt?.stop();
    this.osc = null;
    this.mqtt = null;
  }
}
