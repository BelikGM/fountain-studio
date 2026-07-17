import type { ScheduleEntry } from '@fountain-studio/shared';
import type { Engine } from './engine';

/**
 * Планировщик: проверяет расписание проекта по системным часам ПК дважды
 * в секунду и запускает действия. Время «ЧЧ:ММ» срабатывает в :00 секунд;
 * «ЧЧ:ММ:СС» — в указанную секунду. Каждая запись срабатывает не более
 * одного раза в свою минуту (защита от повторов при подряд идущих проверках).
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private fired = new Set<string>();

  constructor(
    private readonly engine: Engine,
    private readonly getSchedule: () => ScheduleEntry[],
  ) {}

  start(): void {
    this.timer = setInterval(() => this.check(new Date()), 500);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  check(now: Date): void {
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${hh}:${mm}`;
    const day = now.getDay();
    for (const e of this.getSchedule()) {
      if (!e.enabled) continue;
      if (e.days.length > 0 && !e.days.includes(day)) continue;
      const want = e.time.length === 5 ? `${hh}:${mm}` : `${hh}:${mm}:${ss}`;
      if (e.time !== want) continue;
      const key = `${e.id}@${minuteKey}`;
      if (this.fired.has(key)) continue;
      this.fired.add(key);
      this.fire(e);
    }
    // Не копим ключи бесконечно: помним только текущую минуту.
    if (this.fired.size > 200) {
      for (const key of this.fired) {
        if (!key.endsWith(minuteKey)) this.fired.delete(key);
      }
    }
  }

  private fire(e: ScheduleEntry): void {
    const label = e.name !== '' ? e.name : e.id;
    console.log(`[schedule] ${e.time} → ${e.action.type} (${label})`);
    switch (e.action.type) {
      case 'playlist':
        this.engine.playPlaylist(e.action.refId, undefined);
        break;
      case 'show':
        this.engine.playShow(e.action.refId, 0);
        break;
      case 'sequence':
        this.engine.startSequence(e.action.refId);
        break;
      case 'scene':
        this.engine.setScene(e.action.refId);
        break;
      case 'stopAll':
        this.engine.stopAllPlayback();
        break;
    }
  }
}
