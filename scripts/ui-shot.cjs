/**
 * Снимки редактора своими глазами — окно Electron, без браузера.
 *
 * Зачем. По CLAUDE.md визуальные правки проверяются СВОИМИ скриншотами, а не
 * «по описанию». Без этого инструмента подписи и плашки сдавались непроверенными
 * — заказчик справедливо спросил, почему. Electron уже есть в проекте, поэтому
 * снимок делается им: открыть редактор, пройти по шагам, снять кадр.
 *
 * Запуск:
 *   npx electron scripts/ui-shot.cjs <сценарий.json>
 *
 * Сценарий — JSON:
 *   {
 *     "url": "http://127.0.0.1:5180/?engine=9531",   // ?engine= — порт движка
 *     "out": "C:/.../папка-для-снимков",
 *     "width": 1600, "height": 1000,
 *     "steps": [
 *       { "tab": "Настройки" },                        // нажать вкладку по подписи
 *       { "click": "+ Вселенная" },                    // нажать кнопку по тексту
 *       { "clickNth": "Применить", "n": 1 },           // n-ю из одинаковых (с 0)
 *       { "select": "подпись поля", "value": "2" },   // выбрать в списке рядом с подписью
 *       { "scrollTo": "Вселенные DMX" },               // прокрутить к тексту
 *       { "wait": 500 },
 *       { "eval": "document.title" },                  // выполнить JS, результат в вывод
 *       { "shot": "settings.png" },                    // снять видимую часть окна
 *       { "shot": "x.png", "clip": {"x":0,"y":0,"width":400,"height":200}, "zoom": 2 }, // фрагмент крупно
 *       { "fit": "settings" }                          // найти обрезанные подписи
 *     ]
 *   }
 *
 * ВАЖНО (правило 4 в CLAUDE.md): сценарии, которые что-то МЕНЯЮТ (Применить,
 * Добавить), направлять только на изолированный движок — `?engine=9531`.
 * Рабочий движок на 9520 можно только смотреть.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scenarioFile = process.argv.find((a) => a.endsWith('.json'));
if (!scenarioFile) {
  console.error('Нужен файл сценария: npx electron scripts/ui-shot.cjs сценарий.json');
  process.exit(2);
}
const sc = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
const out = sc.out || path.join(os.tmpdir(), 'fs-shots');
fs.mkdirSync(out, { recursive: true });

// Свой профиль: ни настройки, ни localStorage установленной программы не трогаем.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'fs-shot-profile-')));
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Код, который ищет элемент по видимому тексту. */
const FIND = `
  (function find(text, n) {
    const want = text.trim();
    const all = [...document.querySelectorAll('button, a, [role=tab], .tab, label, summary, th, h2, h3, span, option, .panel-title, p, div')];
    const vis = all.filter((e) => e.offsetParent !== null || e.tagName === 'OPTION');
    const txt = (e) => (e.innerText || e.textContent || '').trim();
    /*
     * Тот же текст у кнопки и у обёртки вокруг неё (div.form-row с одной
     * кнопкой внутри). Нажимать надо КНОПКУ: клик по обёртке ничего не делает,
     * а шаг при этом рапортует «нажато» — на этом 22.09.2026 поймал себя сам.
     * Поэтому: сначала то, что нажимается, потом — самый внутренний элемент.
     */
    const clickable = (e) =>
      /^(BUTTON|A|LABEL|SUMMARY|OPTION|SELECT|INPUT)$/.test(e.tagName) || e.classList.contains('tab') || e.getAttribute('role') === 'tab';
    const order = (a, b) =>
      (clickable(b) ? 1 : 0) - (clickable(a) ? 1 : 0) || (a.contains(b) ? 1 : b.contains(a) ? -1 : 0) || txt(a).length - txt(b).length;
    const exact = vis.filter((e) => txt(e) === want).sort(order);
    const loose = vis.filter((e) => txt(e).startsWith(want)).sort(order);
    const list = exact.length ? exact : loose;
    return list[n || 0] || null;
  })
`;

/**
 * Обрезанные подписи: текст шире своего поля. Для выпадающих списков видимая
 * часть — выбранный пункт, его ширину меряем шрифтом самого списка.
 */
const FIT = `
  (function () {
    const bad = [];
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const label = (e) => (e.innerText || e.value || e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    for (const e of document.querySelectorAll('button, .btn, th, td, label, .badge, .tab, input[type=text], input:not([type])')) {
      if (e.offsetParent === null) continue;
      const cs = getComputedStyle(e);
      if (cs.overflow === 'visible' && cs.textOverflow !== 'ellipsis' && e.tagName !== 'INPUT') {
        // Переносящийся текст не обрезается; ловим только то, что не влезло в одну строку без переноса.
        if (cs.whiteSpace !== 'nowrap' && cs.whiteSpace !== 'pre') continue;
      }
      if (e.tagName === 'INPUT') {
        ctx.font = cs.font;
        const w = ctx.measureText(e.value || '').width;
        const room = e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        if (w > room + 1) bad.push({ what: 'поле', text: e.value, need: Math.round(w), room: Math.round(room) });
        continue;
      }
      if (e.scrollWidth > e.clientWidth + 1) bad.push({ what: e.tagName.toLowerCase(), text: label(e), need: e.scrollWidth, room: e.clientWidth });
    }
    // Уехало за край окна — так обрезался статус связи в шапке на 1600 px:
    // сам элемент цел, но окно его не показывает.
    const W = document.documentElement.clientWidth;
    for (const e of document.querySelectorAll('header *, button, .btn, .conn, .tab, h2, label')) {
      if (e.offsetParent === null || e.children.length > 3) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.right > W + 1) bad.push({ what: 'за краем окна', text: label(e), need: Math.round(r.right), room: W });
    }
    // Срезано по высоте: блок с overflow:hidden, содержимое выше него. Так
    // пряталась шапка дорожек в «Шоу» вместе с кнопкой 🎚 (22.09.2026).
    for (const e of document.querySelectorAll('div, section, td, label')) {
      if (e.offsetParent === null || e.clientHeight === 0) continue;
      const cs = getComputedStyle(e);
      if (cs.overflowY !== 'hidden' || cs.textOverflow === 'ellipsis') continue;
      if (e.scrollHeight > e.clientHeight + 2 && e.querySelector('button, input, select, label')) {
        bad.push({ what: 'срезано по высоте', text: label(e), need: e.scrollHeight, room: e.clientHeight });
      }
    }
    for (const s of document.querySelectorAll('select')) {
      if (s.offsetParent === null) continue;
      const cs = getComputedStyle(s);
      ctx.font = cs.font;
      const opt = s.options[s.selectedIndex];
      if (!opt) continue;
      const w = ctx.measureText(opt.text).width;
      // Стрелка списка и отступы — около 24 px.
      const room = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20;
      if (w > room + 1) bad.push({ what: 'список', text: opt.text, need: Math.round(w), room: Math.round(room) });
    }
    return bad;
  })()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: sc.width || 1600,
    height: sc.height || 1000,
    show: false,
    // Внеэкранная отрисовка: скрытое обычное окно перерисовывается с опозданием,
    // и снимок показывал СТАРУЮ картинку — галочка в DOM уже стоит, а на снимке
    // её нет (поймано 22.09.2026). Здесь кадры рисуются всегда.
    webPreferences: { backgroundThrottling: false, offscreen: true },
  });
  win.webContents.setFrameRate(30);
  const report = [];
  const log = (s) => {
    report.push(s);
    console.log(s);
  };
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) log(`[ошибка в редакторе] ${message}`);
  });
  try {
    // Первый заход — чтобы положить настройки в localStorage (без экскурсии).
    await win.loadURL(sc.url);
    await win.webContents.executeJavaScript(`
      localStorage.setItem('fs-tour-done', '1');
      ${Object.entries(sc.localStorage || {})
        .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
        .join('\n')}
    `);
    await win.loadURL(sc.url);
    await sleep(sc.settle || 2500);

    for (const step of sc.steps || []) {
      if (step.wait) await sleep(step.wait);
      if (step.tab || step.click || step.clickNth) {
        const text = step.tab || step.click || step.clickNth;
        const ok = await win.webContents.executeJavaScript(`
          (() => { const e = ${FIND}(${JSON.stringify(text)}, ${step.n || 0}); if (!e) return false; e.scrollIntoView({ block: 'center' }); e.click(); return true; })()
        `);
        log(`${ok ? '✔' : '✖ НЕ НАЙДЕНО'} нажать «${text}»`);
        await sleep(step.after ?? 600);
      }
      if (step.select) {
        const ok = await win.webContents.executeJavaScript(`
          (() => {
            const l = ${FIND}(${JSON.stringify(step.select)}, 0);
            const s = l && (l.querySelector('select') || l.closest('label')?.querySelector('select') || l.parentElement?.querySelector('select'));
            if (!s) return false;
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
            setter.call(s, ${JSON.stringify(String(step.value))});
            s.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()
        `);
        log(`${ok ? '✔' : '✖ НЕ НАЙДЕНО'} выбрать «${step.value}» в «${step.select}»`);
        await sleep(step.after ?? 600);
      }
      if (step.scrollTo) {
        const ok = await win.webContents.executeJavaScript(`
          (() => { const e = ${FIND}(${JSON.stringify(step.scrollTo)}, ${step.n || 0}); if (!e) return false; e.scrollIntoView({ block: 'start' }); return true; })()
        `);
        log(`${ok ? '✔' : '✖ НЕ НАЙДЕНО'} прокрутить к «${step.scrollTo}»`);
        await sleep(300);
      }
      if (step.eval) {
        const r = await win.webContents.executeJavaScript(step.eval);
        log(`eval → ${JSON.stringify(r)}`);
      }
      if (step.shot) {
        // Перерисовать и дождаться свежего кадра — снимок должен показывать то,
        // что сейчас в редакторе, а не то, что было полсекунды назад.
        win.webContents.invalidate();
        await sleep(250);
        // clip: {x, y, width, height} — снять фрагмент, чтобы рассмотреть мелочь вблизи.
        let img = await win.webContents.capturePage(step.clip);
        if (step.zoom) img = img.resize({ width: Math.round(img.getSize().width * step.zoom), quality: 'best' });
        const file = path.join(out, step.shot);
        fs.writeFileSync(file, img.toPNG());
        log(`снимок: ${file}`);
      }
      if (step.fit) {
        const bad = await win.webContents.executeJavaScript(FIT);
        if (bad.length === 0) log(`✔ ${step.fit}: обрезанных подписей нет`);
        for (const b of bad) log(`✖ ${step.fit}: не влезает ${b.what} «${b.text}» — нужно ${b.need}px, есть ${b.room}px`);
      }
    }
  } catch (err) {
    log(`✖ сценарий упал: ${err && err.stack ? err.stack : err}`);
  }
  fs.writeFileSync(path.join(out, 'report.txt'), report.join('\n'), 'utf8');
  app.quit();
});
