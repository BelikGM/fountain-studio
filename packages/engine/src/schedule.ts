import {
  activeScheduleEntries,
  lastDueScheduleEntry,
  scheduleSecondOfDay,
  type Schedule,
  type ScheduleAction,
  type ScheduleEntry,
} from '@fountain-studio/shared';
import { eventLog } from './eventlog';
import type { Engine } from './engine';

/** Что сказать в журнале про действие. */
function actionWord(a: ScheduleAction): string {
  switch (a.type) {
    case 'playlist':
      return 'плейлист';
    case 'show':
      return 'шоу';
    case 'sequence':
      return 'секвенсор';
    case 'sequenceGroup':
      return 'группа секвенсоров';
    case 'scene':
      return 'сцена';
    case 'pause':
      return 'пауза';
    case 'stopAll':
      return 'стоп';
    case 'off':
      return 'выключить';
  }
}

/**
 * Планировщик: проверяет расписания объекта по системным часам ПК дважды в
 * секунду. Время «ЧЧ:ММ» срабатывает в :00 секунд, «ЧЧ:ММ:СС» — в указанную
 * секунду; каждая запись — не более раза в свою минуту.
 *
 * Запись — ПЕРЕХОД (см. ScheduleAction в shared/playlist.ts): прежнее
 * останавливается, ручные правки сбрасываются, начинается новое. С гашением —
 * сначала всё в 0 на заданные секунды, потом запуск.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private fired = new Set<string>();
  /** Запуск после гашения, который ещё не наступил. Новая запись его отменяет. */
  private pending: NodeJS.Timeout | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly getSchedules: () => Schedule[],
  ) {}

  start(): void {
    this.timer = setInterval(() => this.check(new Date()), 500);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.cancelPending();
  }

  check(now: Date): void {
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${hh}:${mm}`;
    const day = now.getDay();
    const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const due: { entry: ScheduleEntry; schedule: Schedule }[] = [];
    for (const item of activeScheduleEntries(this.getSchedules())) {
      const e = item.entry;
      if (e.days.length > 0 && !e.days.includes(day)) continue;
      if (scheduleSecondOfDay(e.time) !== nowSec) continue;
      const key = `${e.id}@${minuteKey}`;
      if (this.fired.has(key)) continue;
      this.fired.add(key);
      due.push(item);
    }
    if (due.length > 0) {
      // Коллизия: две записи в одну секунду. Исполняем первую по порядку, о
      // других говорим прямо — в интерфейсе такие строки красные.
      const [first, ...rest] = due;
      for (const r of rest) {
        eventLog.log(
          'schedule',
          `${r.entry.time}: одновременно с «${first!.entry.name || actionWord(first!.entry.action)}» — запись «${r.entry.name || actionWord(r.entry.action)}» (${r.schedule.name}) не исполнена`,
          'warn',
        );
      }
      this.fire(first!.entry, first!.schedule);
    }
    // Не копим ключи бесконечно: помним только текущую минуту.
    if (this.fired.size > 200) {
      for (const key of this.fired) {
        if (!key.endsWith(minuteKey)) this.fired.delete(key);
      }
    }
  }

  /**
   * После запуска движка: включить то, что по расписанию должно идти сейчас.
   * Без этого сбой питания в 14:00 оставлял фонтан тёмным до следующей записи
   * — до вечера или до завтрашнего утра. Одиночное шоу не повторяем: оно,
   * скорее всего, давно кончилось, и играть его заново посреди дня — не то,
   * что было задумано.
   */
  catchUp(now: Date): void {
    const last = lastDueScheduleEntry(this.getSchedules(), now);
    if (!last) return;
    const a = last.entry.action;
    if (a.type === 'show' || a.type === 'pause') return;
    const hm = last.entry.time.slice(0, 5);
    eventLog.log(
      'schedule',
      `после запуска движка — по расписанию «${last.schedule.name}» с ${hm} должно идти: ${actionWord(a)}${last.entry.name ? ` («${last.entry.name}»)` : ''}`,
    );
    // Гашение перехода при восстановлении не нужно: до этого ничего не играло.
    this.fire({ ...last.entry, blackoutSec: 0 }, last.schedule, true);
  }

  private cancelPending(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
  }

  private fire(e: ScheduleEntry, s: Schedule, quiet = false): void {
    const label = e.name !== '' ? e.name : actionWord(e.action);
    if (!quiet) {
      eventLog.log(
        'schedule',
        `${e.time} → ${actionWord(e.action)} («${label}», ${s.name})${e.blackoutSec > 0 ? `, сначала гашение ${e.blackoutSec} с` : ''}`,
      );
    }
    this.cancelPending();
    const a = e.action;
    if (a.type === 'pause') {
      // Пауза — замереть как есть: ничего не останавливаем и не гасим.
      this.engine.pauseAll();
      return;
    }
    this.engine.takeOverForSchedule();
    if (a.type === 'stopAll') return;
    if (a.type === 'off') {
      this.engine.setDark('off');
      return;
    }
    if (e.blackoutSec > 0) {
      this.engine.setDark('transition');
      this.pending = setTimeout(() => {
        this.pending = null;
        this.engine.setDark(null);
        this.launch(a);
      }, e.blackoutSec * 1000);
      this.pending.unref?.();
      return;
    }
    this.launch(a);
  }

  private launch(a: Extract<ScheduleAction, { refId: string }>): void {
    switch (a.type) {
      case 'playlist':
        this.engine.playPlaylist(a.refId, undefined);
        break;
      case 'show':
        this.engine.playShow(a.refId, 0);
        break;
      case 'sequence':
        this.engine.startSequence(a.refId);
        break;
      case 'sequenceGroup':
        this.engine.startSequenceGroup(a.refId);
        break;
      case 'scene':
        this.engine.setScene(a.refId);
        break;
    }
  }
}
