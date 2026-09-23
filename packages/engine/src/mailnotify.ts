/**
 * Уведомления на почту: те же сообщения, что уходят в Telegram.
 *
 * Отдельный слой поверх `mailer.ts`: хранит настройки (пароль — только в
 * `fountain.secrets.json`), фильтрует по разделам и складывает неотправленное
 * в очередь — на объекте интернет пропадает, и авария должна дойти позже, а
 * не потеряться.
 *
 * Почему это зеркало Telegram, а не своя подписка на журнал: правила «что
 * считать аварией», тихий режим и время суточного отчёта живут в одном месте
 * (telegram.ts). Две независимые подписки неизбежно разошлись бы.
 */
import fs from 'node:fs';
import { eventLog } from './eventlog';
import { defaultMailConfig, mailRecipients, sendMail, htmlToText, type MailConfig } from './mailer';

/** Что видит интерфейс — БЕЗ пароля. */
export interface MailStatus {
  enabled: boolean;
  host: string;
  port: number;
  security: MailConfig['security'];
  user: string;
  from: string;
  to: string;
  alarms: boolean;
  reports: boolean;
  state: boolean;
  hasPassword: boolean;
  /** Сколько писем ждёт связи. */
  queued: number;
  /** Когда последний раз письмо ушло (unix, мс); 0 — ещё ни разу. */
  lastOkMs: number;
  /** Последняя ошибка отправки; пусто — всё в порядке. */
  lastError: string;
}

interface Queued {
  subject: string;
  text: string;
  atMs: number;
}

const MAX_QUEUE = 100;

export class MailNotifier {
  private cfg: MailConfig = defaultMailConfig();
  private queue: Queued[] = [];
  private timer: NodeJS.Timeout | undefined;
  private sending = false;
  private lastOkMs = 0;
  private lastError = '';
  onStatusChange: (() => void) | null = null;

  constructor(private readonly secretsFile: string) {
    this.load();
    // Раз в минуту разгребаем очередь — тем же ритмом, что и бот.
    this.timer = setInterval(() => void this.drain(), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.secretsFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8')) as { mail?: Partial<MailConfig> };
      this.cfg = { ...defaultMailConfig(), ...(raw.mail ?? {}) };
    } catch (err) {
      console.error('[почта] не удалось прочитать настройки:', err);
    }
  }

  private save(): void {
    try {
      let all: Record<string, unknown> = {};
      if (fs.existsSync(this.secretsFile)) {
        all = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8')) as Record<string, unknown>;
      }
      all.mail = this.cfg;
      fs.writeFileSync(this.secretsFile, JSON.stringify(all, null, 2), 'utf8');
    } catch (err) {
      console.error('[почта] не удалось сохранить настройки:', err);
    }
  }

  status(): MailStatus {
    return {
      enabled: this.cfg.enabled,
      host: this.cfg.host,
      port: this.cfg.port,
      security: this.cfg.security,
      user: this.cfg.user,
      from: this.cfg.from,
      to: this.cfg.to,
      alarms: this.cfg.alarms,
      reports: this.cfg.reports,
      state: this.cfg.state,
      hasPassword: this.cfg.password !== '',
      queued: this.queue.length,
      lastOkMs: this.lastOkMs,
      lastError: this.lastError,
    };
  }

  /** Пароль приходит отдельно и наружу не возвращается никогда. */
  setConfig(patch: Partial<MailConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.save();
    this.onStatusChange?.();
  }

  /** Настроена ли почта настолько, чтобы вообще пытаться слать. */
  ready(): boolean {
    return this.cfg.enabled && this.cfg.host.trim() !== '' && mailRecipients(this.cfg.to).length > 0;
  }

  /**
   * Уведомление из общего потока (зеркало Telegram). Разделы — свои: дежурному
   * на почту могут быть нужны только аварии.
   */
  notify(kind: 'alarm' | 'report' | 'state', html: string, site: string): void {
    if (!this.ready()) return;
    const want = kind === 'alarm' ? this.cfg.alarms : kind === 'report' ? this.cfg.reports : this.cfg.state;
    if (!want) return;
    const word = kind === 'alarm' ? 'Авария' : kind === 'report' ? 'Отчёт за сутки' : 'Состояние';
    this.queue.push({ subject: `[${site}] ${word}`, text: htmlToText(html), atMs: Date.now() });
    if (this.queue.length > MAX_QUEUE) this.queue = this.queue.slice(-MAX_QUEUE);
    void this.drain();
  }

  /** Разовая проверка из интерфейса — письмо уходит сразу, мимо очереди. */
  async testNow(site: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.cfg.enabled) return { ok: false, error: 'уведомления на почту выключены' };
    const r = await sendMail(this.cfg, {
      subject: `[${site}] Проверка связи`,
      text:
        'Это проверочное письмо от программы Fountain Studio.\n' +
        `Объект: ${site}.\n` +
        'Если вы его получили — уведомления на почту настроены верно.',
    });
    if (r.ok) {
      this.lastOkMs = Date.now();
      this.lastError = '';
    } else {
      this.lastError = r.error;
    }
    this.onStatusChange?.();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  private async drain(): Promise<void> {
    if (this.sending || this.queue.length === 0 || !this.ready()) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0]!;
        const r = await sendMail(this.cfg, { subject: item.subject, text: item.text });
        if (!r.ok) {
          // Связи нет или сервер отказал — оставляем в очереди и говорим один
          // раз в час, чтобы не забить журнал при долгом обрыве.
          if (this.lastError !== r.error) {
            this.lastError = r.error;
            eventLog.log('почта', `письмо не уходит: ${r.error}`, 'warn');
            this.onStatusChange?.();
          }
          break;
        }
        this.queue.shift();
        this.lastOkMs = Date.now();
        if (this.lastError !== '') {
          this.lastError = '';
          eventLog.log('почта', 'связь с почтовым сервером восстановлена', 'info', 'recovery');
        }
        this.onStatusChange?.();
      }
    } finally {
      this.sending = false;
    }
  }
}
