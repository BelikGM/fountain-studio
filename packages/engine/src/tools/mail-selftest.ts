/**
 * Самопроверка отправки уведомлений на почту (mailer.ts).
 *
 * Настоящий почтовый сервер для этого не нужен и не годится: он потребовал бы
 * чужого ящика и интернета, а проверять надо НАШ разговор по протоколу.
 * Поэтому поднимаем свой маленький SMTP-сервер и смотрим, что именно мы ему
 * сказали: поздоровались, вошли, назвали всех получателей, отдали письмо с
 * правильной темой и русским текстом, попрощались.
 *
 * Чего этот тест НЕ проверяет (и это честно написано в отчёте): работу с
 * настоящими провайдерами — Яндекс, Mail.ru, Gmail с паролем приложения.
 * Это проверяется только на живом ящике.
 *
 * Запуск: npm -w @fountain-studio/engine run mail-test
 */
import net from 'node:net';
import { defaultMailConfig, htmlToText, mailRecipients, sendMail } from '../mailer';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean | undefined, detail = ''): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

interface Talk {
  lines: string[];
  data: string;
}

/** Маленький SMTP-сервер: отвечает как настоящий и запоминает разговор. */
function fakeServer(port: number, opts: { failAt?: string } = {}): Promise<{ talk: Talk; close: () => void }> {
  const talk: Talk = { lines: [], data: '' };
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let inData = false;
      let body = '';
      socket.setEncoding('utf8');
      socket.write('220 fake ESMTP\r\n');
      socket.on('data', (chunk: string) => {
        for (const raw of chunk.split(/\r?\n/)) {
          if (raw === '' && !inData) continue;
          if (inData) {
            if (raw === '.') {
              inData = false;
              talk.data = body;
              socket.write('250 OK queued\r\n');
            } else {
              body += raw + '\n';
            }
            continue;
          }
          talk.lines.push(raw);
          const up = raw.toUpperCase();
          if (opts.failAt && up.startsWith(opts.failAt)) {
            socket.write('550 отказано\r\n');
            continue;
          }
          if (up.startsWith('EHLO')) socket.write('250-fake\r\n250 AUTH LOGIN PLAIN\r\n');
          else if (up.startsWith('AUTH LOGIN')) socket.write('334 VXNlcm5hbWU6\r\n');
          else if (up.startsWith('AUTH PLAIN')) socket.write('235 ok\r\n');
          else if (up.startsWith('MAIL FROM')) socket.write('250 OK\r\n');
          else if (up.startsWith('RCPT TO')) socket.write('250 OK\r\n');
          else if (up.startsWith('DATA')) {
            inData = true;
            socket.write('354 go ahead\r\n');
          } else if (up.startsWith('QUIT')) {
            socket.write('221 bye\r\n');
            socket.end();
          } else if (talk.lines.filter((l) => l.startsWith('334') || true).length > 0) {
            // Ответы на логин и пароль (они приходят как base64 без команды).
            socket.write(talk.lines.filter((l) => !l.includes(' ')).length === 1 ? '334 UGFzc3dvcmQ6\r\n' : '235 ok\r\n');
          }
        }
      });
    });
    server.listen(port, '127.0.0.1', () => resolve({ talk, close: () => server.close() }));
  });
}

(async () => {
  // ---- Разбор адресов ------------------------------------------------------
  check('адреса через запятую', mailRecipients('a@b.ru, c@d.ru').length === 2);
  check('адреса через пробел и точку с запятой', mailRecipients('a@b.ru; c@d.ru e@f.ru').length === 3);
  check('мусор без собаки отбрасывается', mailRecipients('a@b.ru, дежурный').length === 1);

  // ---- HTML уведомления → текст письма -------------------------------------
  const text = htmlToText('<b>Авария</b><br>насос «P1»: код 12 &amp; стоп<p>дальше</p>');
  check('теги убраны', !text.includes('<'), text);
  check('перенос строки сохранён', text.includes('\n'), JSON.stringify(text));
  check('мнемоника раскрыта', text.includes('&') && !text.includes('&amp;'), text);

  // ---- Настоящая отправка на свой сервер -----------------------------------
  const PORT = 9539;
  const srv = await fakeServer(PORT);
  const cfg = {
    ...defaultMailConfig(),
    enabled: true,
    host: '127.0.0.1',
    port: PORT,
    security: 'none' as const,
    user: 'robot@fountain.ru',
    password: 'секрет',
    from: 'robot@fountain.ru',
    to: 'дежурный@object.ru, инженер@object.ru',
  };
  const r = await sendMail(cfg, { subject: 'Авария на объекте «Саки Пруд»', text: 'Насос P1 не отвечает.\nПроверьте ПЧ.' });
  check('письмо отправлено', r.ok, r.error);
  check('поздоровались', srv.talk.lines.some((l) => l.startsWith('EHLO')), srv.talk.lines.join(' | '));
  check('вошли по логину', srv.talk.lines.some((l) => l.toUpperCase().startsWith('AUTH LOGIN')));
  check('назвали отправителя', srv.talk.lines.some((l) => l.includes('MAIL FROM:<robot@fountain.ru>')));
  check('назвали обоих получателей', srv.talk.lines.filter((l) => l.startsWith('RCPT TO')).length === 2, srv.talk.lines.filter((l) => l.startsWith('RCPT TO')).join(', '));
  check('попрощались', srv.talk.lines.some((l) => l.toUpperCase().startsWith('QUIT')));
  check('тема закодирована по RFC 2047', /Subject: =\?UTF-8\?B\?/.test(srv.talk.data), srv.talk.data.split('\n').find((l) => l.startsWith('Subject')));
  {
    const subjLine = srv.talk.data.split('\n').find((l) => l.startsWith('Subject: ')) ?? '';
    const b64 = /=\?UTF-8\?B\?([^?]+)\?=/.exec(subjLine)?.[1] ?? '';
    check('тема читается по-русски', Buffer.from(b64, 'base64').toString('utf8').includes('Саки Пруд'), b64);
  }
  check('письмо в UTF-8 и base64', srv.talk.data.includes('Content-Type: text/plain; charset=UTF-8') && srv.talk.data.includes('Content-Transfer-Encoding: base64'));
  {
    const body = srv.talk.data.split('\n\n').slice(1).join('\n').replace(/\n/g, '');
    check('текст письма дошёл целым', Buffer.from(body, 'base64').toString('utf8').includes('Насос P1 не отвечает'), body.slice(0, 40));
  }
  srv.close();

  // ---- Отказ сервера не роняет движок --------------------------------------
  const srv2 = await fakeServer(PORT + 1, { failAt: 'RCPT' });
  const bad = await sendMail({ ...cfg, port: PORT + 1 }, { subject: 'т', text: 'т' });
  check('отказ сервера возвращается ошибкой, а не падением', !bad.ok && bad.error.includes('получатель'), bad.error);
  srv2.close();

  // ---- Проверки до подключения ---------------------------------------------
  const noHost = await sendMail({ ...cfg, host: '' }, { subject: 'т', text: 'т' });
  check('без сервера — понятная ошибка', !noHost.ok && noHost.error.includes('адрес сервера'), noHost.error);
  const noTo = await sendMail({ ...cfg, to: '' }, { subject: 'т', text: 'т' });
  check('без получателей — понятная ошибка', !noTo.ok && noTo.error.includes('получатель'), noTo.error);
  const noConn = await sendMail({ ...cfg, port: 9599 }, { subject: 'т', text: 'т' }, 1500);
  check('сервер не отвечает — ошибка без зависания', !noConn.ok, noConn.error);

  console.log(`почта: пройдено ${passed}, ошибок ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
