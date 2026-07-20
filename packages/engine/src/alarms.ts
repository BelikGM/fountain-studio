import { eventLog } from './eventlog';
import type { MqttController } from './mqttcontroller';

/**
 * Уведомления об авариях (§27 доработки, §3 п.4) — публикует то же самое, что
 * уже попадает в общий журнал (eventLog) на уровне warn/error (аварии ПЧ,
 * потери нод/RDM-приборов и т.п.), в MQTT-топик `<prefix>/alarms`. Отдельная
 * функция, а не код прямо в index.ts — чтобы смоук-тест проверял ровно то,
 * что реально включается в проде, а не переписанную копию.
 */
export function wireAlarmNotifications(mqtt: MqttController): () => void {
  return eventLog.subscribe((event) => {
    if (event.level === 'info') return;
    mqtt.publish(
      'alarms',
      JSON.stringify({ atMs: event.tsMs, source: event.source, level: event.level, message: event.message }),
    );
  });
}
