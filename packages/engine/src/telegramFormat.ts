/**
 * Тексты сообщений в Telegram — отдельно от отправки.
 *
 * Сообщение читают с телефона, на ходу, часто по пути на объект. Поэтому
 * порядок всегда один: сначала объект и общий итог цветом (🟢 всё хорошо,
 * 🟠 есть на что посмотреть, 🔴 авария), потом суть по разделам, внизу —
 * метки для поиска. Никаких «состояние: ok» и простыней из журнала: только
 * то, по чему можно понять, ехать или нет и что взять с собой.
 *
 * Разметка — HTML (жирный заголовок раздела, курсив для времени). Markdown у
 * Telegram капризный к точкам и скобкам в именах шоу и приборов, а в HTML
 * достаточно экранировать три символа.
 */

export type TelegramKind = 'alarm' | 'report' | 'state';

/** Снимок объекта на момент сообщения — всё, что нужно для текста. */
export interface SiteSnapshot {
  /** Имя объекта — «Саки Пруд», «Севастополь Тюльпан»… */
  site: string;
  atMs: number;
  playback: {
    /** Что сейчас идёт — уже словами: «шоу «Вечернее»», «плейлист «Лето»»… */
    now: string | null;
    /** Где внутри: «04:12 из 18:30», «шоу 2 из 5». */
    detail: string | null;
    /** Всё поставлено на паузу кнопкой «Пауза всего». */
    pausedAll: boolean;
  };
  /** Ближайшая запись расписания: «сегодня 21:00 — плейлист «Ночь»». */
  nextSchedule: string | null;
  dmx: { universes: number; avgJitterMs: number; maxJitterMs: number };
  artnet: { online: number; total: number; lost: string[] } | null;
  rdm: { total: number; lost: string[] } | null;
  pumps: {
    total: number;
    online: number;
    /** ПЧ с кодом аварии: имя и код. */
    faults: { name: string; code: number }[];
    /** ПЧ без связи. */
    offline: string[];
    /** Самый горячий, если датчик есть. */
    hottest: { name: string; tempC: number } | null;
  } | null;
  wind: { speedMs: number | null; limitPercent: number; enabled: boolean };
  uptimeSec: number;
  lastBackupAgoMin: number | null;
  /** События журнала уровня warn/error, сгруппированные по тексту. */
  events: { level: 'warn' | 'error'; source: string; message: string; count: number; lastMs: number }[];
  /** С какого момента есть журнал — у движка он в памяти и живёт с запуска. */
  eventsSinceMs: number;
}

const KIND_TAG: Record<TelegramKind, string> = {
  alarm: '#авария',
  report: '#отчёт',
  state: '#состояние',
};

/** Экранирование для parse_mode=HTML: только эти три символа. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Имя объекта в метку: всё, кроме букв и цифр, — в подчёркивание. */
export function siteTag(name: string): string {
  const clean = name
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return clean === '' ? '#объект' : '#' + clean;
}

export function tagsLine(site: string, kind: TelegramKind): string {
  return `${siteTag(site)} ${KIND_TAG[kind]}`;
}

function when(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function duration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} д ${h} ч`;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

function ago(min: number): string {
  if (min < 1) return 'только что';
  if (min < 60) return `${Math.round(min)} мин назад`;
  if (min < 48 * 60) return `${Math.round(min / 60)} ч назад`;
  return `${Math.round(min / 1440)} д назад`;
}

/** Строка с отметкой: ✅ в порядке, ⚠️ есть вопрос, ❌ плохо. */
type Line = { mark: '✅' | '⚠️' | '❌' | '•'; text: string };

/** Общий итог объекта по его снимку. */
export function verdict(s: SiteSnapshot): '🟢' | '🟠' | '🔴' {
  const red =
    (s.pumps && (s.pumps.faults.length > 0 || s.pumps.offline.length > 0)) ||
    (s.artnet && s.artnet.total > 0 && s.artnet.online === 0) ||
    s.events.some((e) => e.level === 'error' && s.atMs - e.lastMs < 3600_000);
  if (red) return '🔴';
  const orange =
    (s.artnet && s.artnet.lost.length > 0) ||
    (s.rdm && s.rdm.lost.length > 0) ||
    (s.wind.enabled && s.wind.limitPercent < 100) ||
    s.dmx.maxJitterMs > 20 ||
    (s.lastBackupAgoMin !== null && s.lastBackupAgoMin > 48 * 60);
  return orange ? '🟠' : '🟢';
}

function listShort(names: string[], max = 4): string {
  const shown = names.slice(0, max).map((n) => `«${esc(n)}»`);
  return names.length > max ? `${shown.join(', ')} и ещё ${names.length - max}` : shown.join(', ');
}

function workLines(s: SiteSnapshot): Line[] {
  const out: Line[] = [];
  if (s.playback.pausedAll) out.push({ mark: '⚠️', text: 'Всё на паузе — нажата «Пауза всего»' });
  if (s.playback.now) {
    out.push({ mark: '•', text: `Идёт ${esc(s.playback.now)}${s.playback.detail ? ` — ${esc(s.playback.detail)}` : ''}` });
  } else {
    out.push({ mark: '•', text: 'Сейчас ничего не воспроизводится' });
  }
  out.push({ mark: '•', text: s.nextSchedule ? `Далее по расписанию: ${esc(s.nextSchedule)}` : 'В расписании ничего не запланировано' });
  return out;
}

function equipmentLines(s: SiteSnapshot): Line[] {
  const out: Line[] = [];
  const jitterBad = s.dmx.maxJitterMs > 20;
  out.push({
    mark: jitterBad ? '⚠️' : '✅',
    text: `DMX: ${s.dmx.universes} ${plural(s.dmx.universes, 'вселенная', 'вселенные', 'вселенных')}, задержка кадра в среднем ${fmt(s.dmx.avgJitterMs)} мс, максимум ${fmt(s.dmx.maxJitterMs)} мс${jitterBad ? ' — компьютер не успевает, возможны рывки' : ''}`,
  });
  if (s.artnet) {
    out.push(
      s.artnet.lost.length === 0
        ? { mark: '✅', text: `Узлы Art-Net: ${s.artnet.online} из ${s.artnet.total} на связи` }
        : {
            mark: s.artnet.online === 0 ? '❌' : '⚠️',
            text: `Узлы Art-Net: ${s.artnet.online} из ${s.artnet.total}, пропали ${listShort(s.artnet.lost)}`,
          },
    );
  }
  if (s.rdm && s.rdm.total > 0) {
    out.push(
      s.rdm.lost.length === 0
        ? { mark: '✅', text: `RDM: ${s.rdm.total} ${plural(s.rdm.total, 'прибор', 'прибора', 'приборов')} на линии` }
        : { mark: '⚠️', text: `RDM: пропали ${s.rdm.lost.length} из ${s.rdm.total} — ${listShort(s.rdm.lost)}` },
    );
  }
  if (s.pumps && s.pumps.total > 0) {
    const p = s.pumps;
    if (p.faults.length === 0 && p.offline.length === 0) {
      out.push({
        mark: '✅',
        text: `Частотники насосов: ${p.online} из ${p.total} на связи, аварий нет${p.hottest ? `; самый тёплый «${esc(p.hottest.name)}» ${Math.round(p.hottest.tempC)} °C` : ''}`,
      });
    } else {
      for (const f of p.faults) out.push({ mark: '❌', text: `ПЧ «${esc(f.name)}»: авария, код ${f.code}` });
      if (p.offline.length > 0) out.push({ mark: '❌', text: `Нет связи с ПЧ: ${listShort(p.offline)}` });
    }
  }
  return out;
}

function conditionLines(s: SiteSnapshot): Line[] {
  const out: Line[] = [];
  if (s.wind.speedMs === null) {
    out.push({ mark: '•', text: s.wind.enabled ? 'Ветер: нет показаний датчика' : 'Ветер: ограничение струй выключено' });
  } else {
    out.push(
      s.wind.limitPercent < 100
        ? { mark: '⚠️', text: `Ветер ${fmt(s.wind.speedMs)} м/с — насосы ограничены до ${s.wind.limitPercent} %` }
        : { mark: '✅', text: `Ветер ${fmt(s.wind.speedMs)} м/с — струи на полной высоте` },
    );
  }
  return out;
}

function serviceLines(s: SiteSnapshot): Line[] {
  return [
    { mark: '•', text: `Работает без перезапуска ${duration(s.uptimeSec)}` },
    s.lastBackupAgoMin === null
      ? { mark: '⚠️', text: 'Резервных копий проекта ещё нет' }
      : {
          mark: s.lastBackupAgoMin > 48 * 60 ? '⚠️' : '✅',
          text: `Резервная копия проекта: ${ago(s.lastBackupAgoMin)}`,
        },
  ];
}

function block(title: string, lines: Line[]): string {
  if (lines.length === 0) return '';
  return `<b>${title}</b>\n` + lines.map((l) => `${l.mark} ${l.text}`).join('\n');
}

function fmt(n: number): string {
  return (Math.round(n * 10) / 10).toString().replace('.', ',');
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Сводка состояния — по запросу и при проверке связи. */
export function formatState(s: SiteSnapshot, note?: string): string {
  const v = verdict(s);
  const head = `${v} <b>${esc(s.site)}</b> — состояние\n<i>${when(s.atMs)}</i>`;
  const parts = [
    head,
    note ? esc(note) : '',
    block('▶️ Работа', workLines(s)),
    block('🔌 Оборудование', equipmentLines(s)),
    block('🌬 Условия', conditionLines(s)),
    block('🗂 Сервис', serviceLines(s)),
    tagsLine(s.site, 'state'),
  ];
  return parts.filter((p) => p !== '').join('\n\n');
}

/** Ежедневный отчёт: итог суток, события сгруппированно, оборудование сейчас. */
export function formatReport(s: SiteSnapshot, note?: string): string {
  const v = verdict(s);
  const errors = s.events.filter((e) => e.level === 'error');
  const warns = s.events.filter((e) => e.level === 'warn');
  const errCount = errors.reduce((a, e) => a + e.count, 0);
  const warnCount = warns.reduce((a, e) => a + e.count, 0);
  const since = Math.max(s.eventsSinceMs, s.atMs - 24 * 3600_000);
  const summary =
    errCount === 0 && warnCount === 0
      ? '🟢 Сутки без аварий и предупреждений'
      : `${errCount > 0 ? '🔴' : '🟠'} Аварий: ${errCount}, предупреждений: ${warnCount}`;
  const eventLines: Line[] = [...errors, ...warns]
    .sort((a, b) => (a.level === b.level ? b.count - a.count : a.level === 'error' ? -1 : 1))
    .slice(0, 6)
    .map((e) => ({
      mark: e.level === 'error' ? '❌' : '⚠️',
      text: `${esc(e.message)}${e.count > 1 ? ` — ${e.count} ${plural(e.count, 'раз', 'раза', 'раз')}, последний в ${clock(e.lastMs)}` : ` — в ${clock(e.lastMs)}`}`,
    }));
  const head =
    `📋 <b>${esc(s.site)}</b> — отчёт за сутки\n` +
    `<i>${when(since)} — ${when(s.atMs)}</i>`;
  const parts = [
    head,
    note ? esc(note) : '',
    `<b>Итог:</b> ${summary}. Сейчас ${v === '🟢' ? '🟢 всё в порядке' : v === '🟠' ? '🟠 есть на что посмотреть' : '🔴 требуется выезд'}.`,
    block('⚠️ События', eventLines),
    block('▶️ Работа', workLines(s)),
    block('🔌 Оборудование сейчас', equipmentLines(s)),
    block('🌬 Условия', conditionLines(s)),
    block('🗂 Сервис', serviceLines(s)),
    tagsLine(s.site, 'report'),
  ];
  return parts.filter((p) => p !== '').join('\n\n');
}

/**
 * Что проверить на месте — по источнику события. Короткий список самого
 * частого: чтобы в дорогу взять нужное, а не гадать по тексту ошибки.
 */
function checklist(source: string, message: string): string | null {
  const m = message.toLowerCase();
  if (source === 'modbus' || m.includes('пч') || m.includes('частот')) {
    return 'питание и автомат ПЧ, линию RS-485 (разъём, терминатор), код аварии по паспорту привода';
  }
  if (source === 'net' && m.includes('rdm')) return 'питание прибора, DMX-кабель и разъёмы на участке, адрес прибора';
  if (source === 'net') return 'питание узла Art-Net, сетевой кабель и коммутатор, IP-адрес узла';
  if (source === 'wind') return 'датчик ветра и его кабель; при сильном ветре ограничение струй — штатная работа';
  if (source === 'license') return 'файл лицензии в папке программы';
  if (source === 'engine' || source === 'server') return 'компьютер управления: нагрузка, свободное место, перезапуск программы';
  return null;
}

const SOURCE_NAME: Record<string, string> = {
  modbus: 'Насосы (Modbus)',
  net: 'Сеть DMX / Art-Net',
  schedule: 'Расписание',
  engine: 'Движок',
  server: 'Сервер',
  wind: 'Ветер',
  osc: 'OSC-пульт',
  mqtt: 'MQTT',
  license: 'Лицензия',
};

/** Авария или предупреждение — сразу, как случилось. */
/** Тихий режим кончился: сколько аварий за это время смолчали. */
export function formatQuietOver(site: string, missed: number): string {
  const tail =
    missed > 0
      ? `За это время смолчали аварий: ${missed}. Что именно было — в журнале событий на вкладке «Поток».`
      : 'Аварий за это время не было.';
  return [
    `🔔 <b>Тихий режим окончен</b> · <b>${esc(site)}</b>\n<i>${when(Date.now())}</i>`,
    esc(tail),
    tagsLine(site, 'alarm'),
  ].join('\n\n');
}

/**
 * «Восстановлено»: узел, прибор или насос вернулся в строй. Отдельное
 * короткое сообщение — без «что проверить», потому что проверять уже
 * нечего; главное, чтобы дежурный увидел, что тревога закрыта.
 */
export function formatRecovery(
  site: string,
  e: { source: string; message: string; tsMs: number },
): string {
  return [
    `✅ <b>Восстановлено</b> · <b>${esc(site)}</b>\n<i>${when(e.tsMs)}</i>`,
    `<b>${esc(SOURCE_NAME[e.source] ?? e.source)}:</b> ${esc(e.message)}`,
    tagsLine(site, 'alarm'),
  ].join('\n\n');
}

export function formatAlarm(
  site: string,
  e: { level: 'warn' | 'error'; source: string; message: string; tsMs: number },
  repeats = 0,
  note?: string,
): string {
  const title = e.level === 'error' ? '🔴 <b>АВАРИЯ</b>' : '🟠 <b>Предупреждение</b>';
  const check = checklist(e.source, e.message);
  const parts = [
    `${title} · <b>${esc(site)}</b>\n<i>${when(e.tsMs)}</i>`,
    note ? esc(note) : '',
    `<b>${esc(SOURCE_NAME[e.source] ?? e.source)}:</b> ${esc(e.message)}` +
      (repeats > 0 ? `\n<i>Повторялось ещё ${repeats} ${plural(repeats, 'раз', 'раза', 'раз')} — отдельными сообщениями не слали.</i>` : ''),
    check ? `<b>Что проверить:</b> ${esc(check)}` : '',
    tagsLine(site, 'alarm'),
  ];
  return parts.filter((p) => p !== '').join('\n\n');
}
