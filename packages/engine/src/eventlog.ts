import type { LogEvent } from '@fountain-studio/shared';

const MAX_EVENTS = 500;

/**
 * Единый журнал событий движка (§27 доработки, §3 п.1): что и когда
 * срабатывало (расписание, пульты OSC/MQTT, клавиши, потеря ноды/аварии
 * ПЧ) — раньше видно было только в консоли процесса. Модульный синглтон, как
 * и существующие console.log в schedule/oscserver/mqttcontroller/netmonitor —
 * не требует протаскивать зависимость через конструкторы уже существующих
 * классов (и их фикстуры в смоук-тесте).
 */
class EventLogStore {
  private events: LogEvent[] = [];
  private nextId = 1;
  /** Несколько независимых подписчиков (сервер — рассылка по WS, уведомления — публикация в MQTT и т.п.). */
  private listeners = new Set<(e: LogEvent) => void>();

  log(source: string, message: string, level: LogEvent['level'] = 'info'): LogEvent {
    const prefix = `[${source}]`;
    if (level === 'error') console.error(prefix, message);
    else if (level === 'warn') console.warn(prefix, message);
    else console.log(prefix, message);
    const event: LogEvent = { id: this.nextId++, tsMs: Date.now(), source, level, message };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /** Возвращает функцию отписки. */
  subscribe(listener: (e: LogEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): LogEvent[] {
    return this.events;
  }
}

export const eventLog = new EventLogStore();
