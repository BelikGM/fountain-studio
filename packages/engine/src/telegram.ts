import fs from 'node:fs';
import path from 'node:path';
import { eventLog } from './eventlog';
import { substituteRdmNames, type LogEvent } from '@fountain-studio/shared';
import {
  formatAlarm,
  formatQuietOver,
  formatRecovery,
  formatReport,
  formatState,
  type SiteSnapshot,
  type TelegramKind,
} from './telegramFormat';
import {
  ackKeyboard,
  botCommands,
  handleTelegramUpdate,
  type TelegramAction,
  type TgEffect,
  type TgKeyboard,
  type TgUpdate,
} from './telegramCommands';

export type { TelegramKind } from './telegramFormat';
export type { TelegramAction } from './telegramCommands';

/**
 * Уведомления в Telegram — отчёты, аварии и состояние объекта.
 *
 * ── Почему отдельный файл секретов ────────────────────────────────────────
 * Токен бота — это пароль от него: кто им владеет, тот и бот. Класть его в
 * fountain.config.json нельзя, потому что тот файл лежит в репозитории. Здесь
 * используется fountain.secrets.json рядом с проектом, добавленный в
 * .gitignore, и токен из него никогда не попадает ни в журнал, ни в интерфейс,
 * ни в экспорт проекта — наружу уходит только «настроено / не настроено».
 *
 * ── Почему очередь, а не отправка сразу ───────────────────────────────────
 * На объекте интернета может не быть неделями: сотовый модем отвалился, шлюз
 * перезагружается, провайдер молчит. Если слать «в никуда», сообщения просто
 * пропадут — а это ровно те сообщения, ради которых всё и делалось (авария
 * случилась именно тогда, когда связь и легла). Поэтому всё складывается в
 * очередь на диске и уходит, когда связь появится. В очередь кладётся УЖЕ
 * готовый текст со снимком на момент события: авария, дошедшая через час,
 * должна показывать, что было тогда, а не что стало к отправке.
 *
 * ── Как сообщения разложены ───────────────────────────────────────────────
 * Один человек обслуживает несколько фонтанов (Саки Пруд, Севастополь Тюльпан,
 * 60 лет, Дюльбер), и каждый объект шлёт в тот же чат. Разложено двумя слоями:
 *
 *  - ПО ОБЪЕКТАМ — темами. С Bot API 9.3 темы бывают и в личном чате с ботом
 *    (включаются владельцем бота в @BotFather), с 9.4 бот сам создаёт их
 *    методом createForumTopic. Если темы доступны — у каждого объекта своя
 *    тема «🏛 Имя объекта», как отдельная папка. В группе-форуме то же самое.
 *    Не доступны — всё идёт в общий чат, и выручают метки.
 *  - ПО РАЗДЕЛАМ — метками #авария, #отчёт, #состояние, плюс метка объекта
 *    #Саки_Пруд. Нажал метку — Telegram показывает все такие сообщения по всем
 *    объектам сразу: например, все аварии за неделю.
 *
 * Если в настройках заданы номера тем по РАЗДЕЛАМ (группа-форум, где темы
 * «Аварии», «Отчёты», «Состояние» заведены вручную), они главнее: так было
 * настроено раньше, и ломать чужую раскладку нельзя.
 */

export interface TelegramConfig {
  /** Токен от @BotFather. Пусто — уведомления выключены. */
  token: string;
  /** Кому слать. Пусто — определим сами из getUpdates, когда напишут боту. */
  chatId: string;
  enabled: boolean;
  /** Слать ежедневный отчёт в этот час по местному времени (0–23). */
  dailyHour: number;
  /** Слать ли аварии сразу. */
  alarms: boolean;
  /**
   * Принимать ли команды и нажатия кнопок из чата.
   *
   * Отдельной галочкой, потому что это единственная дорога СНАРУЖИ ВНУТРЬ:
   * всё остальное бот только рассказывает. Команды принимаются лишь из чата,
   * заданного в `chatId`, а «стоп» и «погасить» ещё и спрашивают
   * подтверждение — но выключить целиком всё равно должно быть можно.
   */
  commands: boolean;
  /**
   * Номера тем форума по разделам — если чат сделан группой-форумом и темы
   * заведены вручную. 0 — раздел не привязан к теме.
   */
  topicAlarm: number;
  topicReport: number;
  topicState: number;
  /** Раскладывать по объектам темами, когда темы доступны. */
  topicsBySite: boolean;
  /** Созданные темы объектов: имя объекта → номер темы. */
  siteTopics: Record<string, number>;
  /**
   * Тихий режим: до этого момента (unix, мс) аварии не отправляем — на
   * время работ на объекте, когда всё и так «мигает». Отчёты и состояние
   * ходят как обычно. Сколько аварий смолчали, скажем одним сообщением,
   * когда тишина кончится.
   */
  quietUntilMs: number;
}

export function defaultTelegramConfig(): TelegramConfig {
  return {
    token: '',
    chatId: '',
    enabled: false,
    dailyHour: 9,
    alarms: true,
    commands: true,
    topicAlarm: 0,
    topicReport: 0,
    topicState: 0,
    topicsBySite: true,
    siteTopics: {},
    quietUntilMs: 0,
  };
}

interface Queued {
  kind: TelegramKind;
  /** Готовый HTML. */
  html: string;
  /** Объект — по нему выбирается тема. */
  site: string;
  atMs: number;
  /** Кнопки под сообщением: у аварий — «Принято». */
  keyboard?: TgKeyboard;
}

const MAX_QUEUE = 500;
/**
 * Одинаковое событие чаще этого отдельными сообщениями не шлём. Пропавший
 * RDM-прибор может «мигать» на линии каждые полминуты, и без этого за ночь
 * набегает сотня одинаковых сообщений, среди которых теряется настоящая авария.
 */
const REPEAT_WINDOW_MS = 15 * 60_000;

export class TelegramNotifier {
  private cfg: TelegramConfig = defaultTelegramConfig();
  private queue: Queued[] = [];
  private timer: NodeJS.Timeout | undefined;
  private sending = false;
  private lastDailyDay = -1;
  /**
   * Имя бота из getMe — чтобы интерфейс мог сказать, КУДА писать /start.
   * Бот не может написать человеку первым: пока человек сам не начал с ним
   * разговор, Telegram не выдаёт chat id, и отправлять просто некуда.
   */
  private botName = '';
  /** Темы в личных чатах включены у бота (getMe.has_topics_enabled); null — не спрашивали. */
  private botTopics: boolean | null = null;
  /** Когда последний раз спрашивали getMe, мс — темы перепроверяем раз в 5 минут. */
  private botCheckedMs = 0;
  /**
   * Сообщить наружу, что состояние поменялось само (включили темы у бота,
   * нашёлся получатель) — чтобы строка в Настройках обновилась без перезапуска.
   */
  onStatusChange: (() => void) | null = null;
  /** Чат — группа-форум (getChat.is_forum); null — не спрашивали. */
  private chatForum: boolean | null = null;
  private readonly recent = new Map<string, { atMs: number; suppressed: number }>();
  /** Сколько аварий смолчали в тихом режиме — скажем одним сообщением, когда он кончится. */
  private quietSuppressed = 0;
  /**
   * Токен живёт в папке ПРОГРАММЫ, а не объекта: папку проекта отдают
   * коллеге, и свой токен бота отдавать вместе с ней нельзя.
   */
  private readonly secretsFile: string;
  /** Неотправленные сообщения — у объекта: это его события, а не программы. */
  private queueFile: string;
  private unsubscribe: (() => void) | null = null;
  /**
   * Что делать по команде из чата. Ставится снаружи (index.ts), потому что
   * движок отправщику уведомлений знать незачем: здесь чат, там объект.
   */
  onAction: ((action: TelegramAction) => void) | null = null;
  /** Следующий номер обновления для getUpdates — Telegram отдаёт их по одному разу. */
  private updateOffset = 0;
  /** Идёт ли длинный опрос: два одновременно Telegram не разрешает. */
  private polling = false;
  /** Совсем остановлены (закрытие программы) — цикл опроса не перезапускаем. */
  private stopped = false;
  /**
   * Чат, который сам написал боту, пока получатель не задан. Длинный опрос
   * съедает обновления, и прежний способ (перечитать getUpdates в
   * discoverChatId) после его включения находил бы пустоту.
   */
  private lastCandidateChatId = '';
  /** Меню команд у бота уже выставлено — второй раз незачем. */
  private menuSet = false;
  /** О чужом чате пишем в журнал не чаще раза в час: иначе завалит. */
  private lastRejectLogMs = 0;

  constructor(
    files: { secretsFile: string; queueFile: string },
    /** Имя объекта — им подписывается каждое сообщение и называется его тема. */
    private getSiteName: () => string,
    /** Живой снимок объекта для отчётов и сводок. */
    private getSnapshot: () => SiteSnapshot,
    /** Имена приборов по RDM-UID из патча — чтобы в сообщениях не было голых UID. */
    private getRdmNames: () => Map<string, string> = () => new Map(),
  ) {
    this.secretsFile = files.secretsFile;
    this.queueFile = files.queueFile;
    this.loadSecrets();
    this.loadQueue();
  }

  /**
   * Открыли другой объект: настройки бота общие для программы и остаются,
   * а неотправленные сообщения — свои у каждого объекта. Прежнюю очередь
   * дописываем на диск, чтобы ничего не потерять.
   */
  rebind(queueFile: string): void {
    this.saveQueue();
    this.queue = [];
    this.queueFile = queueFile;
    this.loadQueue();
    this.restart();
  }

  private loadSecrets(): void {
    try {
      if (fs.existsSync(this.secretsFile)) {
        const raw = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8')) as { telegram?: Partial<TelegramConfig> };
        this.cfg = { ...defaultTelegramConfig(), ...(raw.telegram ?? {}) };
        if (!this.cfg.siteTopics || typeof this.cfg.siteTopics !== 'object') this.cfg.siteTopics = {};
      }
    } catch (err) {
      console.error('[telegram] не удалось прочитать настройки:', err);
    }
  }

  private loadQueue(): void {
    try {
      if (fs.existsSync(this.queueFile)) {
        const raw = JSON.parse(fs.readFileSync(this.queueFile, 'utf8')) as Partial<Queued & { text: string }>[];
        if (Array.isArray(raw)) {
          // Очередь от прежней версии хранила голый текст — доводим до нового вида.
          this.queue = raw.slice(-MAX_QUEUE).map((q) => ({
            kind: q.kind ?? 'state',
            html: q.html ?? escapeHtml(q.text ?? ''),
            site: q.site ?? this.getSiteName(),
            atMs: q.atMs ?? Date.now(),
          }));
        }
      }
    } catch (err) {
      console.error('[telegram] не удалось прочитать настройки:', err);
    }
  }

  private saveSecrets(): void {
    try {
      let all: Record<string, unknown> = {};
      if (fs.existsSync(this.secretsFile)) {
        all = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8')) as Record<string, unknown>;
      }
      all.telegram = this.cfg;
      fs.writeFileSync(this.secretsFile, JSON.stringify(all, null, 2), 'utf8');
    } catch (err) {
      console.error('[telegram] не удалось сохранить настройки:', err);
    }
  }

  private saveQueue(): void {
    try {
      fs.writeFileSync(this.queueFile, JSON.stringify(this.queue.slice(-MAX_QUEUE)), 'utf8');
    } catch {
      // очередь — не критичные данные; при сбое записи просто продолжаем
    }
  }

  /** Что можно показать в интерфейсе — БЕЗ токена. */
  status(): {
    enabled: boolean;
    hasToken: boolean;
    chatId: string;
    queued: number;
    dailyHour: number;
    alarms: boolean;
    commands: boolean;
    botName: string;
    topicAlarm: number;
    topicReport: number;
    topicState: number;
    topicsBySite: boolean;
    topicsAvailable: boolean | null;
    siteTopicCount: number;
    quietUntilMs: number;
  } {
    return {
      enabled: this.cfg.enabled,
      hasToken: this.cfg.token.trim() !== '',
      chatId: this.cfg.chatId,
      queued: this.queue.length,
      dailyHour: this.cfg.dailyHour,
      alarms: this.cfg.alarms,
      commands: this.cfg.commands,
      botName: this.botName,
      topicAlarm: this.cfg.topicAlarm,
      topicReport: this.cfg.topicReport,
      topicState: this.cfg.topicState,
      topicsBySite: this.cfg.topicsBySite,
      topicsAvailable: this.topicsKnown(),
      siteTopicCount: Object.keys(this.cfg.siteTopics).length,
      quietUntilMs: this.cfg.quietUntilMs,
    };
  }

  setConfig(patch: Partial<TelegramConfig>): void {
    const tokenChanged = patch.token !== undefined && patch.token !== this.cfg.token;
    this.cfg = { ...this.cfg, ...patch };
    if (tokenChanged) {
      // Другой бот — другие темы и, возможно, другой чат: старые номера не годятся.
      this.cfg.siteTopics = {};
      this.botTopics = null;
      this.chatForum = null;
    }
    if (patch.chatId !== undefined) {
      this.cfg.siteTopics = {};
      this.chatForum = null;
    }
    this.saveSecrets();
    this.restart();
  }

  private restart(): void {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (!this.cfg.enabled || this.cfg.token.trim() === '') return;
    // Аварии подхватываем из общего журнала: то же, что видно в интерфейсе.
    if (this.cfg.alarms) {
      this.unsubscribe = eventLog.subscribe((e: LogEvent) => this.onEvent(e));
    }
    // Одна минута — достаточно частый ритм и для разбора очереди, и для
    // ежедневного отчёта; чаще незачем, интернет появляется не мгновенно.
    void this.whoAmI();
    this.timer = setInterval(() => void this.tick(), 60_000);
    void this.tick();
    void this.startPolling();
  }

  /**
   * Длинный опрос обновлений — команды и нажатия кнопок.
   *
   * Почему длинный опрос, а не раз в минуту вместе с очередью: человек нажал
   * «Состояние» и ждёт ответа сейчас, а не через минуту. Telegram сам держит
   * запрос до 25 секунд и отвечает сразу, как появится сообщение, — это и
   * дешевле по трафику, чем частые пустые опросы.
   *
   * Почему не webhook: на объекте нет внешнего адреса и сертификата, а часто
   * нет и интернета. Опрос работает через любой NAT и сам возобновляется,
   * когда связь вернётся.
   */
  private async startPolling(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      while (!this.stopped && this.cfg.enabled && this.cfg.commands && this.cfg.token.trim() !== '') {
        // Приоритет — не потерять обновления: offset двигаем только после
        // разбора, иначе упавший разбор проглотил бы команду молча.
        const list = await this.api<TgUpdate[]>('getUpdates', { offset: this.updateOffset, timeout: 25, limit: 20 }, 40_000);
        if (list === null) {
          // Связи нет или Telegram отказал — подождём и попробуем снова.
          // Без паузы при отсутствии интернета получился бы цикл впустую.
          await sleep(10_000);
          continue;
        }
        for (const u of list) {
          if (typeof u.update_id === 'number') this.updateOffset = Math.max(this.updateOffset, u.update_id + 1);
          this.rememberChatCandidate(u);
          try {
            await this.applyEffects(handleTelegramUpdate(u, this.getSiteName(), this.commandContext()), topicOf(u));
          } catch (err) {
            console.error('[telegram] не смог обработать команду:', err);
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private commandContext(): Parameters<typeof handleTelegramUpdate>[2] {
    const leftMs = this.cfg.quietUntilMs - Date.now();
    return {
      chatId: this.cfg.chatId.trim(),
      botName: this.botName,
      commands: this.cfg.commands,
      quietHoursLeft: leftMs > 0 ? Math.ceil(leftMs / 3600_000) : 0,
    };
  }

  /**
   * Пока получатель не задан, запоминаем, кто написал боту /start в личку или
   * куда его добавили. Те же два случая, что и в discoverChatId: в Guest Chat
   * Mode боту пишут из чужих чатов, и посторонний не должен стать получателем
   * аварий объекта.
   */
  private rememberChatCandidate(u: TgUpdate): void {
    if (this.cfg.chatId.trim() !== '') return;
    const privateStart = u.message?.chat?.type === 'private' && (u.message.text ?? '').startsWith('/start');
    const added = u.my_chat_member?.chat && u.my_chat_member.chat.type !== 'private';
    const id = privateStart ? u.message?.chat?.id : added ? u.my_chat_member?.chat?.id : undefined;
    if (typeof id === 'number') this.lastCandidateChatId = String(id);
  }

  /** Выполнить решения разбора по порядку. */
  private async applyEffects(effects: TgEffect[], topicId: number): Promise<void> {
    for (const e of effects) {
      switch (e.kind) {
        case 'skip':
          // Чужой чат — след в журнале нужен (это попытка управлять объектом),
          // но не чаще раза в час, иначе бот в открытой группе завалит журнал.
          if (e.why.startsWith('чужой чат') || e.why.startsWith('нажатие из чужого')) {
            if (Date.now() - this.lastRejectLogMs > 3600_000) {
              this.lastRejectLogMs = Date.now();
              eventLog.log('telegram', `команда из постороннего чата отклонена (${e.why})`, 'warn');
            }
          }
          break;
        case 'reply':
          await this.send(e.html, topicId > 0 ? topicId : await this.siteTopic(this.getSiteName()), e.keyboard);
          break;
        case 'toast':
          await this.api('answerCallbackQuery', { callback_query_id: e.callbackId, text: e.text });
          break;
        case 'setButtons':
          await this.api('editMessageReplyMarkup', {
            chat_id: this.cfg.chatId,
            message_id: e.messageId,
            reply_markup: { inline_keyboard: toInline(e.keyboard) },
          });
          break;
        case 'do':
          await this.runAction(e.action, topicId);
          break;
      }
    }
  }

  /**
   * Действие по команде. «Состояние» и «отчёт» отвечаем СРАЗУ, минуя очередь:
   * очередь существует, чтобы авария дошла через час, когда появится связь, а
   * ответ на вопрос через час не нужен никому.
   */
  private async runAction(action: TelegramAction, topicId: number): Promise<void> {
    switch (action.type) {
      case 'state': {
        const snap = this.getSnapshot();
        await this.send(formatState(snap), topicId > 0 ? topicId : await this.siteTopic(snap.site));
        return;
      }
      case 'report': {
        const snap = this.getSnapshot();
        await this.send(formatReport(snap), topicId > 0 ? topicId : await this.siteTopic(snap.site));
        return;
      }
      case 'quiet':
        this.setQuiet(action.hours);
        return;
      case 'stopAll':
      case 'blackout':
        if (!this.onAction) {
          eventLog.log('telegram', `команда «${action.type}» пришла, но выполнять её некому`, 'warn');
          return;
        }
        eventLog.log('telegram', action.type === 'stopAll' ? 'остановка воспроизведения по команде из Telegram' : 'гашение по команде из Telegram', 'warn');
        this.onAction(action);
        return;
    }
  }

  /** Событие журнала → авария в очередь, одинаковые подряд — одним сообщением. */
  private onEvent(e: LogEvent): void {
    // Возврат в строй — отдельное короткое «Восстановлено»; тихий режим его
    // не глушит: это хорошая новость и закрывает тревогу.
    if (e.kind === 'recovery') {
      const siteBack = this.getSiteName();
      this.enqueue(
        'alarm',
        formatRecovery(siteBack, { source: e.source, message: this.withNames(e.message), tsMs: e.tsMs }),
        siteBack,
      );
      return;
    }
    if (e.level === 'info') return;
    if (Date.now() < this.cfg.quietUntilMs) {
      this.quietSuppressed++;
      return;
    }
    const key = `${e.level}|${e.source}|${e.message}`;
    const seen = this.recent.get(key);
    if (seen && e.tsMs - seen.atMs < REPEAT_WINDOW_MS) {
      seen.suppressed++;
      return;
    }
    const repeats = seen?.suppressed ?? 0;
    this.recent.set(key, { atMs: e.tsMs, suppressed: 0 });
    if (this.recent.size > 300) {
      for (const [k, v] of this.recent) if (e.tsMs - v.atMs > REPEAT_WINDOW_MS) this.recent.delete(k);
    }
    const site = this.getSiteName();
    this.enqueue(
      'alarm',
      formatAlarm(site, { level: e.level, source: e.source, message: this.withNames(e.message), tsMs: e.tsMs }, repeats),
      site,
      // Кнопка «Принято» — чтобы по чату было видно, кто взял аварию в работу,
      // и двое не поехали на объект одновременно. Только когда команды
      // включены: иначе нажатие никто не обработает и часики будут крутиться.
      this.cfg.commands ? ackKeyboard() : undefined,
    );
  }

  /**
   * Тихий режим на указанное число часов (0 — снять). Аварии в это время
   * не отправляются, но в журнал пишутся как обычно; когда тишина кончится,
   * уйдёт одна строка с тем, сколько их было.
   */
  setQuiet(hours: number): void {
    const h = Math.max(0, Math.min(24, hours));
    this.cfg.quietUntilMs = h > 0 ? Date.now() + h * 3600_000 : 0;
    if (h === 0) this.quietSuppressed = 0;
    this.saveSecrets();
    eventLog.log(
      'telegram',
      h > 0 ? `тихий режим включён на ${h} ч` : 'тихий режим снят',
    );
    this.onStatusChange?.();
  }

  /** Голые RDM-UID в тексте — на имена приборов из патча (если привязаны). */
  private withNames(text: string): string {
    try {
      return substituteRdmNames(text, this.getRdmNames());
    } catch {
      return text;
    }
  }

  enqueue(kind: TelegramKind, html: string, site = this.getSiteName(), keyboard?: TgKeyboard): void {
    this.queue.push({ kind, html, site, atMs: Date.now(), keyboard });
    if (this.queue.length > MAX_QUEUE) this.queue = this.queue.slice(-MAX_QUEUE);
    this.saveQueue();
  }

  private async tick(): Promise<void> {
    if (this.sending) return;
    // Тишина кончилась — одной строкой сообщаем, сколько аварий смолчали.
    if (this.cfg.quietUntilMs > 0 && Date.now() >= this.cfg.quietUntilMs) {
      const missed = this.quietSuppressed;
      this.cfg.quietUntilMs = 0;
      this.quietSuppressed = 0;
      this.saveSecrets();
      const site = this.getSiteName();
      this.enqueue('alarm', formatQuietOver(site, missed), site);
      this.onStatusChange?.();
    }
    // Ежедневный отчёт — раз в сутки, в заданный час.
    const now = new Date();
    if (now.getHours() === this.cfg.dailyHour && this.lastDailyDay !== now.getDate()) {
      this.lastDailyDay = now.getDate();
      this.enqueue('report', formatReport(this.getSnapshot()));
    }
    // Темы у бота включают в @BotFather в любой момент. Пока они не включены,
    // раз в 5 минут переспрашиваем — чтобы раскладка по объектам заработала
    // сама, без перезапуска программы.
    if (this.botTopics !== true && Date.now() - this.botCheckedMs > 5 * 60_000) {
      const was = this.botTopics;
      await this.whoAmI();
      if (was !== this.botTopics) this.onStatusChange?.();
    }
    if (this.queue.length === 0) return;
    this.sending = true;
    try {
      if (!(await this.ensureChat())) return;
      while (this.queue.length > 0) {
        const item = this.queue[0];
        if (!item) break;
        const ok = await this.deliver(item.kind, item.site, item.html, item.keyboard);
        if (!ok) break; // связи нет — оставляем в очереди, попробуем позже
        this.queue.shift();
        this.saveQueue();
      }
    } finally {
      this.sending = false;
    }
  }

  /** Кому слать: если не задано — узнаём из того, кто написал боту. */
  private async ensureChat(): Promise<boolean> {
    if (this.cfg.chatId.trim() !== '') return true;
    // Сначала то, что уже видел цикл опроса: он забирает обновления себе, и
    // повторный getUpdates в discoverChatId нашёл бы пустоту.
    const found = this.lastCandidateChatId !== '' ? this.lastCandidateChatId : await this.discoverChatId();
    if (!found) return false;
    this.cfg.chatId = found;
    this.saveSecrets();
    this.onStatusChange?.();
    return true;
  }

  /** Номер темы для раздела ВРУЧНУЮ (форум с темами-разделами); 0 — не задан. */
  private manualTopic(kind: TelegramKind): number {
    return kind === 'alarm' ? this.cfg.topicAlarm : kind === 'report' ? this.cfg.topicReport : this.cfg.topicState;
  }

  /** Известно ли уже, доступны ли темы в этом чате. */
  private topicsKnown(): boolean | null {
    const id = this.cfg.chatId.trim();
    if (id === '') return null;
    return id.startsWith('-') ? this.chatForum : this.botTopics;
  }

  /** Доступны ли темы: личный чат — у бота включены темы, группа — форум. */
  private async topicsAvailable(): Promise<boolean> {
    const id = this.cfg.chatId.trim();
    if (id === '') return false;
    if (id.startsWith('-')) {
      if (this.chatForum === null) {
        const j = await this.api<{ is_forum?: boolean }>('getChat', { chat_id: id });
        if (j) this.chatForum = j.is_forum === true;
      }
      return this.chatForum === true;
    }
    if (this.botTopics === null) await this.whoAmI();
    return this.botTopics === true;
  }

  /** Тема объекта: берём созданную или создаём, если темы доступны; 0 — общий чат. */
  private async siteTopic(site: string): Promise<number> {
    if (!this.cfg.topicsBySite) return 0;
    const known = this.cfg.siteTopics[site];
    if (known) return known;
    if (!(await this.topicsAvailable())) return 0;
    const created = await this.api<{ message_thread_id?: number }>('createForumTopic', {
      chat_id: this.cfg.chatId,
      name: `🏛 ${site}`.slice(0, 128),
      // Голубой из стандартной палитры тем — чтобы темы объектов узнавались в списке.
      icon_color: 0x6fb9f0,
    });
    const id = created?.message_thread_id ?? 0;
    if (id > 0) {
      this.cfg.siteTopics[site] = id;
      this.saveSecrets();
    }
    return id;
  }

  /** Отправить в нужное место; тему, которую удалили руками, заводим заново. */
  private async deliver(kind: TelegramKind, site: string, html: string, keyboard?: TgKeyboard): Promise<boolean> {
    const manual = this.manualTopic(kind);
    const topic = manual > 0 ? manual : await this.siteTopic(site);
    const r = await this.send(html, topic, keyboard);
    if (r.ok) return true;
    if (topic > 0 && manual === 0 && /thread|topic/i.test(r.description)) {
      delete this.cfg.siteTopics[site];
      this.saveSecrets();
      const again = await this.siteTopic(site);
      return (await this.send(html, again, keyboard)).ok;
    }
    if (r.description !== '') console.error('[telegram] не отправлено:', r.description);
    return false;
  }

  /** Имя бота и доступность тем в личных чатах — из getMe. */
  private async whoAmI(): Promise<void> {
    const j = await this.api<{ username?: string; has_topics_enabled?: boolean }>('getMe', {});
    this.botCheckedMs = Date.now();
    if (!j) return;
    if (j.username) this.botName = '@' + j.username;
    this.botTopics = j.has_topics_enabled === true;
    // Меню команд — чтобы в Telegram они были видны списком и нажимались, а
    // не набирались по памяти. Выставляем один раз за запуск: список меняется
    // только с версией программы.
    if (!this.menuSet && this.cfg.commands) {
      this.menuSet = (await this.api('setMyCommands', { commands: botCommands() })) !== null;
    }
  }

  /**
   * Кому слать, если получатель не задан: кто написал боту /start в ЛИЧКУ,
   * или группа, куда бота добавили.
   *
   * Берём только эти два случая. В режиме Guest Chat Mode боту пишут и
   * упоминанием из чужих чатов — такое сообщение не должно превратить
   * постороннего в получателя аварий объекта.
   */
  private async discoverChatId(): Promise<string | null> {
    type Chat = { id?: number; type?: string };
    const list = await this.api<{ message?: { chat?: Chat; text?: string }; my_chat_member?: { chat?: Chat } }[]>(
      'getUpdates',
      { limit: 50 },
    );
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const u = list[i];
      const privateStart = u?.message?.chat?.type === 'private' && (u.message.text ?? '').startsWith('/start');
      const addedToGroup = u?.my_chat_member?.chat && u.my_chat_member.chat.type !== 'private';
      const id = privateStart ? u?.message?.chat?.id : addedToGroup ? u?.my_chat_member?.chat?.id : undefined;
      if (typeof id === 'number') return String(id);
    }
    return null;
  }

  /**
   * Вызов Bot API: результат или null (нет связи, отказ).
   *
   * Свой таймаут обязателен: у длинного опроса запрос висит 25 секунд штатно,
   * а на подвисшем модеме fetch без ограничения не вернётся никогда — цикл
   * опроса встанет намертво и команды перестанут приходить совсем.
   */
  private async api<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T | null> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const r = await fetch(`https://api.telegram.org/bot${this.cfg.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      const j = (await r.json()) as { ok: boolean; result?: T };
      return j.ok && j.result !== undefined ? j.result : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async send(html: string, topicId = 0, keyboard?: TgKeyboard): Promise<{ ok: boolean; description: string }> {
    try {
      const body: Record<string, unknown> = {
        chat_id: this.cfg.chatId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      };
      if (topicId > 0) body.message_thread_id = topicId;
      if (keyboard && keyboard.length > 0) body.reply_markup = { inline_keyboard: toInline(keyboard) };
      const r = await fetch(`https://api.telegram.org/bot${this.cfg.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as { ok: boolean; description?: string };
      return { ok: j.ok === true, description: j.description ?? '' };
    } catch {
      return { ok: false, description: '' };
    }
  }

  /**
   * Разовая проверка из интерфейса: по одному сообщению КАЖДОГО раздела с
   * настоящими данными объекта. Так сразу видно и что связь есть, и как будут
   * выглядеть аварии, отчёты и состояние, и куда они ложатся.
   */
  async testNow(): Promise<{ ok: boolean; error?: string }> {
    if (this.cfg.token.trim() === '') return { ok: false, error: 'не задан токен бота' };
    await this.whoAmI();
    if (!(await this.ensureChat())) {
      return {
        ok: false,
        error: `откройте ${this.botName || 'своего бота'} в Telegram и нажмите «Start» — пока вы не начали разговор, бот не может написать первым, это правило Telegram`,
      };
    }
    const snap = this.getSnapshot();
    const site = snap.site;
    const note = 'Проверка связи из программы.';
    const messages: [TelegramKind, string][] = [
      ['state', formatState(snap, note)],
      ['report', formatReport(snap, note)],
      [
        'alarm',
        formatAlarm(
          site,
          { level: 'error', source: 'modbus', message: 'Пример: ПЧ «Насос 1» вернул код 12, привод остановлен', tsMs: Date.now() },
          0,
          'Это пример оформления — настоящей аварии нет.',
        ),
      ],
    ];
    for (const [kind, html] of messages) {
      if (!(await this.deliver(kind, site, html))) {
        return { ok: false, error: 'Telegram не принял сообщение — проверьте токен и интернет' };
      }
    }
    return { ok: true };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Кнопки в вид, который понимает Bot API. */
function toInline(keyboard: TgKeyboard): { text: string; callback_data: string }[][] {
  return keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data })));
}

/** Тема, из которой пришла команда: отвечать надо туда же, где спросили. */
function topicOf(u: TgUpdate): number {
  return u.message?.message_thread_id ?? u.callback_query?.message?.message_thread_id ?? 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
