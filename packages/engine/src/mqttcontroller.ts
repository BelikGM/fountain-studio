import type { MqttBinding } from '@fountain-studio/shared';
import { eventLog } from './eventlog';
import type { Engine } from './engine';
import { MqttClient } from './mqttclient';
import { fireRemoteAction } from './remotedispatch';

export interface MqttControllerOptions {
  host: string;
  port?: number;
  clientId?: string;
  username?: string;
  password?: string;
  topicPrefix?: string;
  /**
   * Топики сверх команд — например, показание датчика ветра. Подписываемся
   * при каждом подключении; сообщения из них уходят в onOther.
   */
  extraTopics?: () => string[];
  onOther?: (topic: string, payload: string) => void;
}

/**
 * Телеметрия/удалённые команды по MQTT (§1 доработки). Одна подписка на
 * `${prefix}/cmd/#` покрывает все текущие и будущие привязки сразу — сверка
 * с project.mqttBindings идёт по суффиксу топика при получении, без
 * пересборки подписок на каждое изменение проекта. Статус (раз в 5 с) —
 * `${prefix}/status`, JSON со статистикой тика и состоянием воспроизведения.
 */
export class MqttController {
  /** Вызывается при смене статуса связи с брокером. */
  onChange: (() => void) | null = null;

  private readonly client: MqttClient;
  private readonly topicPrefix: string;
  private connected = false;
  private statusTimer: NodeJS.Timeout | null = null;
  private readonly extraTopics: () => string[];
  private readonly onOther: ((topic: string, payload: string) => void) | undefined;

  constructor(
    private readonly engine: Engine,
    opts: MqttControllerOptions,
    private readonly getBindings: () => MqttBinding[],
  ) {
    this.topicPrefix = opts.topicPrefix ?? 'fountain-studio';
    this.extraTopics = opts.extraTopics ?? (() => []);
    this.onOther = opts.onOther;
    this.client = new MqttClient({
      host: opts.host,
      port: opts.port,
      clientId: opts.clientId ?? `fountain-studio-${Math.random().toString(36).slice(2, 8)}`,
      username: opts.username,
      password: opts.password,
    });
    this.client.onStatus = (connected) => {
      this.connected = connected;
      if (connected) {
        this.client.subscribe(`${this.topicPrefix}/cmd/#`);
        for (const t of this.extraTopics()) this.client.subscribe(t);
      }
      this.onChange?.();
    };
    this.client.onMessage = (topic, payload) => {
      this.handleMessage(topic);
      this.onOther?.(topic, payload.toString('utf8'));
    };
  }

  private handleMessage(topic: string): void {
    const prefix = `${this.topicPrefix}/cmd/`;
    if (!topic.startsWith(prefix)) return;
    const suffix = topic.slice(prefix.length);
    const binding = this.getBindings().find((b) => b.topic === suffix);
    if (!binding) return;
    eventLog.log('mqtt', `${topic} → ${binding.action.type}`);
    fireRemoteAction(this.engine, binding.action);
  }

  /** Подписаться на дополнительные топики заново — поменялся топик датчика. */
  resubscribe(): void {
    if (!this.connected) return;
    for (const t of this.extraTopics()) this.client.subscribe(t);
  }

  /** Публикация в произвольный топик под тем же префиксом — уведомления об авариях (§27 доработки, §3 п.4). */
  publish(topicSuffix: string, payload: string): void {
    if (!this.connected) return;
    this.client.publish(`${this.topicPrefix}/${topicSuffix}`, payload);
  }

  startTelemetry(intervalMs = 5000): void {
    this.statusTimer = setInterval(() => {
      if (!this.connected) return;
      this.client.publish(
        `${this.topicPrefix}/status`,
        JSON.stringify({ atMs: Date.now(), stats: this.engine.stats(), playback: this.engine.playbackState() }),
      );
    }, intervalMs);
    this.statusTimer.unref?.();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  stop(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.client.close();
  }
}
