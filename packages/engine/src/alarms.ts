import { eventLog } from './eventlog';

/**
 * Уведомления об авариях (§27 доработки, §3 п.4) — публикует то же самое, что
 * уже попадает в общий журнал (eventLog) на уровне warn/error (аварии ПЧ,
 * потери нод/RDM-приборов и т.п.), в MQTT-топик `<prefix>/alarms`. Отдельная
 * функция, а не код прямо в index.ts — чтобы смоук-тест проверял ровно то,
 * что реально включается в проде, а не переписанную копию.
 */
/**
 * Кто умеет публиковать: сам MqttController или RemoteControl, у которого
 * MQTT включается на ходу и может в данный момент отсутствовать.
 */
export interface AlarmPublisher {
  publish(topicSuffix: string, payload: string): void;
}

export function wireAlarmNotifications(mqtt: AlarmPublisher): () => void {
  return eventLog.subscribe((event) => {
    if (event.level === 'info') return;
    mqtt.publish(
      'alarms',
      JSON.stringify({ atMs: event.tsMs, source: event.source, level: event.level, message: event.message }),
    );
  });
}
