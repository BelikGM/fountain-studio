import {
  activeScheduleEntries,
  lastDueScheduleEntry,
  scheduleEntriesInWindow,
  scheduleSecondOfDay,
  type Schedule,
  type ScheduleAction,
  type ScheduleEntry,
} from '@fountain-studio/shared';
import { eventLog } from './eventlog';
import type { Engine } from './engine';

/**
 * Больше этого промежутка между сверками часов — значит, часы прыгнули (или
 * компьютер спал), а не просто подзадержались: сверяемся дважды в секунду.
 */
const JUMP_MS = 2000;

/** Прыжок больше получаса считаем «долго не работали» — одиночное шоу не поднимаем. */
const BIG_JUMP_MS = 30 * 60_000;

/** Ключ «эта запись в эту минуту» — тот же, что в check(). */
function minuteKeyOf(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${hh}:${mm}`;
}

/** «2 ч 5 мин», «45 с» — для журнала, где это читает человек. */
function humanGap(sec: number): string {
  if (sec < 90) return `${sec} с`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}

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
    case 'stopAll':
      return 'стоп — погасить всё';
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
  /** Когда сверялись с часами в прошлый раз — чтобы заметить прыжок времени. */
  private lastCheckAt: Date | null = null;
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
    this.checkClockJump(now);
    const minuteKey = minuteKeyOf(now);
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
   * Часы прыгнули — догнать расписание.
   *
   * Планировщик ждёт ТОЧНОГО совпадения секунды, а при прыжке этой секунды не
   * бывает: перевод часов (в РФ его нет, но программа поедет и туда, где
   * есть), сверка времени по интернету, выход из сна, ожившее после простоя
   * железо. Вечерняя запись «21:00» при прыжке 20:59:58 → 21:00:07 не
   * срабатывала вовсе — фонтан оставался тёмным до следующей записи.
   *
   * Что делаем:
   * · вперёд — исполняем ПОСЛЕДНЮЮ пропущенную запись (записи — переходы, и
   *   гнать их подряд бессмысленно: осталась бы всё равно последняя). Большой
   *   прыжок считаем тем же, что и запуск движка: одиночное шоу заново не
   *   поднимаем, оно давно кончилось;
   * · назад — записи этого промежутка уже отработали, второй раз их не
   *   запускаем (иначе перевод часов осенью включил бы вечернюю программу
   *   дважды); в журнал пишем прямо, что пропустили и почему.
   */
  private checkClockJump(now: Date): void {
    const prev = this.lastCheckAt;
    this.lastCheckAt = now;
    if (!prev) return;
    const diff = now.getTime() - prev.getTime();
    if (diff >= 0 && diff <= JUMP_MS) return;

    if (diff < 0) {
      const back = Math.round(-diff / 1000);
      const skipped = scheduleEntriesInWindow(this.getSchedules(), now, prev);
      for (const s of skipped) this.fired.add(`${s.entry.id}@${minuteKeyOf(s.at)}`);
      eventLog.log(
        'schedule',
        `часы перевели назад на ${humanGap(back)}` +
          (skipped.length > 0
            ? ` — записи ${skipped.map((s) => s.entry.time.slice(0, 5)).join(', ')} сегодня уже отрабатывали, повторно не запускаем`
            : ' — пропущенных записей нет'),
        'warn',
      );
      return;
    }

    // Записи, которые сегодня уже отработали (в том числе погашенные переводом
    // часов назад), догонять не надо — иначе перевод назад и обратно включил
    // бы вечернюю программу второй раз.
    const missed = scheduleEntriesInWindow(this.getSchedules(), prev, now).filter(
      (m) => !this.fired.has(`${m.entry.id}@${minuteKeyOf(m.at)}`),
    );
    const gapSec = Math.round(diff / 1000);
    if (missed.length === 0) {
      // Молчим про мелкие заминки: две секунды задержки — обычное дело на
      // занятом ПК, и в журнале от таких строк был бы шум.
      if (diff > 60_000) eventLog.log('schedule', `часы ушли вперёд на ${humanGap(gapSec)} — пропущенных записей нет`);
      return;
    }
    const last = missed[missed.length - 1]!;
    const a = last.entry.action;
    const word = `${actionWord(a)}${last.entry.name ? ` («${last.entry.name}»)` : ''}`;
    if (a.type === 'show' && diff > BIG_JUMP_MS) {
      eventLog.log(
        'schedule',
        `часы ушли вперёд на ${humanGap(gapSec)} — запись ${last.entry.time.slice(0, 5)} (${word}) пропущена: шоу заново не запускаем`,
        'warn',
      );
      return;
    }
    eventLog.log(
      'schedule',
      `часы ушли вперёд на ${humanGap(gapSec)} — догоняем расписание «${last.schedule.name}»: ${last.entry.time.slice(0, 5)} ${word}`,
      'warn',
    );
    this.fired.add(`${last.entry.id}@${minuteKeyOf(last.at)}`);
    // Гашение перехода при догоне не нужно: время его уже прошло.
    this.fire({ ...last.entry, blackoutSec: 0 }, last.schedule, true);
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
    if (a.type === 'show') return;
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
    this.engine.takeOverForSchedule();
    if (a.type === 'stopAll') {
      // Стоп гасит всё — и сцену покоя, и служебный свет — до следующего запуска.
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
