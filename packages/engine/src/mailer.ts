/**
 * Уведомления на почту — свой SMTP-клиент, без сторонних библиотек.
 *
 * Зачем вообще: Telegram есть не у всех, а на объектах с охраной и
 * эксплуатирующей организацией переписка часто идёт по почте. Заказчик просил
 * дублировать туда то же, что уходит боту.
 *
 * Почему свой, а не библиотека: нам нужно ровно пять команд протокола
 * (EHLO, STARTTLS, AUTH, MAIL/RCPT/DATA, QUIT), а лишняя зависимость в
 * движке, который крутится на объекте без присмотра, — это лишний риск
 * обновлений и уязвимостей. Протокол SMTP описан в RFC 5321 и за тридцать лет
 * не менялся.
 *
 * Пароль сюда приходит из `fountain.secrets.json` и наружу (в интерфейс,
 * журнал, экспорт) не уходит НИКОГДА — как токен бота.
 */
import net from 'node:net';
import tls from 'node:tls';

export type MailSecurity = 'none' | 'starttls' | 'tls';

export interface MailConfig {
  enabled: boolean;
  host: string;
  port: number;
  security: MailSecurity;
  /** Логин на сервере (обычно тот же адрес). Пусто — без авторизации. */
  user: string;
  password: string;
  /** От кого. Пусто — берём `user`. */
  from: string;
  /** Кому: несколько адресов через запятую, точку с запятой или пробел. */
  to: string;
  /** Что слать: те же разделы, что и боту. */
  alarms: boolean;
  reports: boolean;
  state: boolean;
}

export function defaultMailConfig(): MailConfig {
  return {
    enabled: false,
    host: '',
    port: 587,
    security: 'starttls',
    user: '',
    password: '',
    from: '',
    to: '',
    alarms: true,
    reports: true,
    state: false,
  };
}

/** Адреса из строки: через запятую, точку с запятой или пробел. */
export function mailRecipients(to: string): string[] {
  return to
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes('@'));
}

/**
 * Тема письма без переводов строк и с русскими буквами.
 *
 * Заголовки писем — только ASCII (RFC 5322), поэтому кириллица кодируется в
 * base64 по RFC 2047. Без этого Outlook показывал тему кракозябрами.
 */
function encodeSubject(subject: string): string {
  const clean = subject.replace(/[\r\n]+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/** Тело письма: base64 по 76 символов — как требует MIME. */
function encodeBody(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n');
}

interface Conn {
  write(line: string): void;
  read(): Promise<{ code: number; text: string }>;
  upgrade(host: string): Promise<void>;
  end(): void;
}

/** Обёртка над сокетом: строки протокола туда, ответы с кодом обратно. */
function wrap(socket: net.Socket | tls.TLSSocket, timeoutMs: number): Conn {
  let buffer = '';
  const waiters: ((r: { code: number; text: string }) => void)[] = [];
  let current: net.Socket | tls.TLSSocket = socket;

  const attach = (s: net.Socket | tls.TLSSocket): void => {
    s.setEncoding('utf8');
    s.on('data', (chunk: string) => {
      buffer += chunk;
      // Ответ может быть многострочным: «250-...» продолжение, «250 ...» конец.
      for (;;) {
        const m = /^(?:\d{3}-[^\r\n]*\r?\n)*(\d{3}) ([^\r\n]*)\r?\n/.exec(buffer);
        if (!m) break;
        const full = buffer.slice(0, m[0].length);
        buffer = buffer.slice(m[0].length);
        const w = waiters.shift();
        w?.({ code: Number(m[1]), text: full });
      }
    });
  };
  attach(socket);

  return {
    write(line: string): void {
      current.write(line + '\r\n');
    },
    read(): Promise<{ code: number; text: string }> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('сервер не ответил вовремя')), timeoutMs);
        waiters.push((r) => {
          clearTimeout(timer);
          resolve(r);
        });
      });
    },
    async upgrade(host: string): Promise<void> {
      const plain = current;
      plain.removeAllListeners('data');
      current = tls.connect({ socket: plain as net.Socket, servername: host });
      await new Promise<void>((resolve, reject) => {
        current.once('secureConnect', () => resolve());
        current.once('error', reject);
      });
      buffer = '';
      attach(current);
    },
    end(): void {
      try {
        current.end();
      } catch {
        /* уже закрыт */
      }
    },
  };
}

/**
 * Отправить одно письмо. Возвращает ошибку текстом, а не бросает: уведомления
 * не должны ронять движок, что бы ни ответил почтовый сервер.
 */
export async function sendMail(
  cfg: MailConfig,
  msg: { subject: string; text: string },
  timeoutMs = 20000,
): Promise<{ ok: boolean; error: string }> {
  const to = mailRecipients(cfg.to);
  if (cfg.host.trim() === '') return { ok: false, error: 'не указан адрес сервера' };
  if (to.length === 0) return { ok: false, error: 'не указан ни один получатель' };
  const from = (cfg.from.trim() || cfg.user.trim()).trim();
  if (from === '') return { ok: false, error: 'не указано, от кого письмо' };
  /*
   * Ящик указан, а пароля нет — это почти всегда «забыли нажать «Сохранить
   * пароль»». Раньше клиент честно начинал вход, отправлял пустой пароль и
   * ждал ответа до таймаута: человек видел «нет связи» и искал беду в сети.
   */
  if (cfg.user.trim() !== '' && cfg.password === '') {
    return { ok: false, error: 'не задан пароль ящика — введите его и нажмите «Сохранить пароль»' };
  }

  let conn: Conn | null = null;
  try {
    const socket: net.Socket | tls.TLSSocket =
      cfg.security === 'tls'
        ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
        : net.connect({ host: cfg.host, port: cfg.port });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('не удалось подключиться к серверу')), timeoutMs);
      socket.once(cfg.security === 'tls' ? 'secureConnect' : 'connect', () => {
        clearTimeout(t);
        resolve();
      });
      socket.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    conn = wrap(socket, timeoutMs);

    const expect = async (ok: number[], what: string): Promise<{ code: number; text: string }> => {
      const r = await conn!.read();
      if (!ok.includes(r.code)) throw new Error(`${what}: сервер ответил «${r.text.trim()}»`);
      return r;
    };

    await expect([220], 'приветствие');
    conn.write('EHLO fountain-studio');
    let hello = await expect([250], 'EHLO');

    if (cfg.security === 'starttls') {
      conn.write('STARTTLS');
      await expect([220], 'STARTTLS');
      await conn.upgrade(cfg.host);
      // После шифрования знакомимся заново — так требует протокол.
      conn.write('EHLO fountain-studio');
      hello = await expect([250], 'EHLO после STARTTLS');
    }

    if (cfg.user.trim() !== '') {
      // AUTH LOGIN понимают все; PLAIN оставляем как запасной.
      if (/AUTH[^\r\n]*LOGIN/i.test(hello.text)) {
        conn.write('AUTH LOGIN');
        await expect([334], 'AUTH LOGIN');
        conn.write(Buffer.from(cfg.user, 'utf8').toString('base64'));
        await expect([334], 'логин');
        conn.write(Buffer.from(cfg.password, 'utf8').toString('base64'));
        await expect([235], 'пароль');
      } else {
        const token = Buffer.from(`\0${cfg.user}\0${cfg.password}`, 'utf8').toString('base64');
        conn.write(`AUTH PLAIN ${token}`);
        await expect([235], 'вход');
      }
    }

    conn.write(`MAIL FROM:<${from}>`);
    await expect([250], 'отправитель');
    for (const addr of to) {
      conn.write(`RCPT TO:<${addr}>`);
      await expect([250, 251], `получатель ${addr}`);
    }
    conn.write('DATA');
    await expect([354], 'начало письма');

    const headers = [
      `From: ${from}`,
      `To: ${to.join(', ')}`,
      `Subject: ${encodeSubject(msg.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ].join('\r\n');
    conn.write(`${headers}\r\n\r\n${encodeBody(msg.text)}\r\n.`);
    await expect([250], 'отправка');
    conn.write('QUIT');
    // Ждём ответ на прощание, но недолго: письмо уже принято (250), и если
    // сервер закроет соединение молча — это не повод считать отправку неудачной.
    await conn.read().catch(() => undefined);
    conn.end();
    return { ok: true, error: '' };
  } catch (err) {
    conn?.end();
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** HTML уведомления → текст письма: у почты своё оформление ни к чему. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
