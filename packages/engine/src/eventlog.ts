import fs from 'node:fs';
import path from 'node:path';
import type { LogEvent } from '@fountain-studio/shared';

const MAX_EVENTS = 500;
/** Сколько суток храним файлы журнала; старше — удаляем при запуске. */
const KEEP_DAYS = 60;

/**
 * Единый журнал событий движка (§27 доработки, §3 п.1): что и когда
 * срабатывало (расписание, пульты OSC/MQTT, клавиши, потеря ноды/аварии
 * ПЧ) — раньше видно было только в консоли процесса. Модульный синглтон, как
 * и существующие console.log в schedule/oscserver/mqttcontroller/netmonitor —
 * не требует протаскивать зависимость через конструкторы уже существующих
 * классов (и их фикстуры в смоук-тесте).
 *
 * Журнал ПИШЕТСЯ НА ДИСК, рядом с проектом: `logs/events-ГГГГ-ММ-ДД.jsonl`,
 * по файлу на сутки. В памяти держим только последние MAX_EVENTS — их UI
 * показывает сразу при подключении. Без диска суточный отчёт после
 * перезапуска программы видел бы события только с момента запуска, а разбор
 * «что было ночью» становился невозможен, как только движок перезапустили.
 *
 * Формат JSONL (одно событие — одна строка JSON): дописывается одной
 * операцией, не портится при обрыве питания на середине файла (теряется
 * максимум последняя строка) и читается любым текстовым редактором.
 */
class EventLogStore {
  private events: LogEvent[] = [];
  private nextId = 1;
  /** Несколько независимых подписчиков (сервер — рассылка по WS, уведомления — публикация в MQTT и т.п.). */
  private listeners = new Set<(e: LogEvent) => void>();
  private dir: string | null = null;
  /** Очередь дозаписи: пишем по одной строке, не мешая тику движка. */
  private queue: { line: string; tsMs: number }[] = [];
  private draining: Promise<void> | null = null;

  /**
   * Подключить запись на диск и поднять в память последние события прошлых
   * запусков. Вызывается один раз при старте движка; без вызова журнал
   * работает как раньше, только в памяти (так и в смоук-тесте).
   */
  attachFile(projectDir: string): void {
    const dir = path.join(projectDir, 'logs');
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.dir = dir;
      this.dropOldFiles();
      this.loadRecent();
    } catch (err) {
      this.dir = null;
      console.error('[журнал] не удалось открыть папку журнала:', err);
    }
  }

  private fileFor(tsMs: number): string {
    const d = new Date(tsMs);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return path.join(this.dir!, `events-${day}.jsonl`);
  }

  /** Читает последние файлы и берёт из них хвост в память. */
  private loadRecent(): void {
    if (!this.dir) return;
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
    const lines: string[] = [];
    // Идём с конца: хватит нескольких последних суток, чтобы набрать MAX_EVENTS.
    for (let i = files.length - 1; i >= 0 && lines.length < MAX_EVENTS; i--) {
      const text = fs.readFileSync(path.join(this.dir, files[i]!), 'utf8');
      const own = text.split('\n').filter((l) => l.trim() !== '');
      lines.unshift(...own.slice(Math.max(0, own.length - (MAX_EVENTS - lines.length))));
    }
    const restored: LogEvent[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as LogEvent;
        if (typeof e.tsMs === 'number' && typeof e.message === 'string') restored.push(e);
      } catch {
        /* битую строку (обрыв питания на записи) просто пропускаем */
      }
    }
    this.events = restored.slice(-MAX_EVENTS);
    // Продолжаем нумерацию, чтобы у восстановленных и новых событий не совпали id.
    this.nextId = this.events.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    if (this.events.length > 0) {
      console.log(`[журнал] поднято событий с диска: ${this.events.length}`);
    }
  }

  private dropOldFiles(): void {
    if (!this.dir) return;
    const edge = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(this.dir)) {
      const m = /^events-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (day < edge) {
        try {
          fs.unlinkSync(path.join(this.dir, f));
        } catch {
          /* не смогли удалить — не беда, место не критично */
        }
      }
    }
  }

  private enqueue(event: LogEvent, tsMs: number): void {
    if (!this.dir) return;
    this.queue.push({ line: JSON.stringify(event), tsMs });
    void this.kick();
  }

  /**
   * Запускает дозапись, если она не идёт, и возвращает ЕЁ обещание — чтобы
   * flush() мог дождаться уже идущей записи, а не выйти сразу (на этом я и
   * споткнулся: остановка движка возвращалась раньше, чем событие попадало
   * в файл, и последние строки терялись).
   */
  private kick(): Promise<void> {
    if (!this.dir) return Promise.resolve();
    if (!this.draining) {
      this.draining = this.drainLoop().finally(() => {
        this.draining = null;
      });
    }
    return this.draining;
  }

  private async drainLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        await fs.promises.appendFile(this.fileFor(item.tsMs), item.line + '\n', 'utf8');
      } catch (err) {
        console.error('[журнал] не удалось записать событие:', err);
        this.queue.length = 0;
        return;
      }
    }
  }

  log(source: string, message: string, level: LogEvent['level'] = 'info', kind?: LogEvent['kind']): LogEvent {
    const prefix = `[${source}]`;
    if (level === 'error') console.error(prefix, message);
    else if (level === 'warn') console.warn(prefix, message);
    else console.log(prefix, message);
    const event: LogEvent = {
      id: this.nextId++,
      tsMs: Date.now(),
      source,
      level,
      message,
      ...(kind ? { kind } : {}),
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.enqueue(event, event.tsMs);
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

  /** Куда пишем (для показа в интерфейсе); null — только в память. */
  directory(): string | null {
    return this.dir;
  }

  /** Дописать всё, что осталось в очереди, — при остановке движка. */
  async flush(): Promise<void> {
    while (this.draining || this.queue.length > 0) await this.kick();
  }
}

export const eventLog = new EventLogStore();
