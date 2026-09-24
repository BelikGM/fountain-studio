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
 *     "scale": 1.25,                                    // масштаб экрана (по умолчанию 1)
 *     "visible": true,                                  // обычное окно (см. ниже) — ТОЛЬКО на невидимом рабочем столе
 *     "steps": [
 *       { "tab": "Настройки" },                        // нажать вкладку по подписи
 *       { "click": "+ Вселенная" },                    // нажать кнопку по тексту
 *       { "clickNth": "Применить", "n": 1 },           // n-ю из одинаковых (с 0)
 *       { "select": "подпись поля", "value": "2" },   // выбрать в списке рядом с подписью
 *       { "scrollTo": "Вселенные DMX" },               // прокрутить к тексту
 *       { "focus": "input[type=number]", "n": 2 },     // фокус в поле (CSS-селектор)
 *       { "keys": ["Up", "Up", "5", "Tab"] },          // настоящие нажатия клавиш
 *       { "mouseAt": "input[type=number]", "n": 2, "fromRight": 6, "fromTop": 5, "times": 2 }, // щелчок мышью (кнопки ▲▼)
 *       { "wait": 500 },
 *       { "eval": "document.title" },                  // выполнить JS, результат в вывод
 *       { "shot": "settings.png" },                    // снять видимую часть окна
 *       { "shot": "x.png", "clip": {"x":0,"y":0,"width":400,"height":200}, "zoom": 2 }, // фрагмент крупно
 *       { "shot": "y.png", "clipTo": ".figure-preview", "pad": 8, "zoom": 1.5 },        // ровно элемент
 *       { "fit": "settings" },                         // найти обрезанные подписи
 *       { "align": "settings" }                        // проверить выравнивание по пикселям
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
// Масштаб экрана Windows: 1 = 100 %, 1.25 = 125 %… Округление пикселей при
// разных масштабах разное, и выравнивание надо смотреть хотя бы при двух.
app.commandLine.appendSwitch('force-device-scale-factor', String(sc.scale || 1));

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
    for (const e of document.querySelectorAll('button, .btn, th, td, label, .badge, .tab, input[type=text], input[type=number], input:not([type])')) {
      if (e.offsetParent === null) continue;
      const cs = getComputedStyle(e);
      if (cs.overflow === 'visible' && cs.textOverflow !== 'ellipsis' && e.tagName !== 'INPUT') {
        // Переносящийся текст не обрезается; ловим только то, что не влезло в одну строку без переноса.
        if (cs.whiteSpace !== 'nowrap' && cs.whiteSpace !== 'pre') continue;
      }
      if (e.tagName === 'INPUT') {
        // Свёрнутое поле (поиск-значок шириной 0) — не подпись, пропускаем.
        if (e.clientWidth < 8) continue;
        ctx.font = cs.font;
        // Пустое поле показывает подсказку-заглушку — её тоже должно быть видно
        // целиком («не зад» вместо «не задан» поймано глазами 22.09.2026).
        const w = ctx.measureText(e.value || e.placeholder || '').width;
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
    // Срезано по ширине и ряд кнопок шире своего места. Так в шапке дорожки
    // «Шоу» крестик ✕ уезжал под шкалу времени, а проверка выше молчала: сама
    // кнопка цела, обрезает её родитель (22.09.2026).
    for (const e of document.querySelectorAll('div, section, td, label, header, nav')) {
      if (e.offsetParent === null || e.clientWidth === 0) continue;
      const cs = getComputedStyle(e);
      if (cs.textOverflow === 'ellipsis' || cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
      const rowNoWrap = cs.display.includes('flex') && cs.flexDirection.startsWith('row') && cs.flexWrap === 'nowrap';
      if (cs.overflowX !== 'hidden' && !rowNoWrap) continue;
      if (e.scrollWidth > e.clientWidth + 2 && e.querySelector('button, input, select')) {
        bad.push({ what: cs.overflowX === 'hidden' ? 'срезано по ширине' : 'ряд шире места', text: label(e), need: e.scrollWidth, room: e.clientWidth });
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

/**
 * Выравнивание по ПИКСЕЛЯМ (шаг { "align": "подпись" }).
 *
 * Зачем. Заказчик раз за разом находил глазами то, что по DOM выглядит
 * ровным: «новая · не применена» в плашке ниже середины, «+» в кнопке не
 * посередине своего места, стрелки ниже текста (24.09.2026). Причина — метрики
 * шрифта: у Segoe UI строчный бокс несимметричен, и текст, отцентрованный по
 * боксу, на глаз сидит ниже. DOM этого не видит, поэтому проверяем снимок.
 *
 * Как. Для каждой видимой кнопки, плашки и вкладки берём её прямоугольник на
 * снимке (без рамки), фон — самый частый цвет внутри, «чернила» — всё, что
 * заметно отличается от фона. Основная полоса чернил — строки, где их не
 * меньше трети от самой густой строки: так выносные элементы («р», «у», «д»)
 * и точки не сдвигают оценку, а меряется то, что глаз считает серединой
 * текста. Сравниваем середину полосы с серединой рамки (по вертикали), поля
 * слева и справа (по горизонтали), а у кнопок «значок + подпись» — поле
 * слева до значка и зазор от значка до подписи.
 */
const ALIGN_TARGETS = `
  (function () {
    const out = [];
    const sel = 'button, .btn, .badge, .tab, [role=button], h2.panel-toggle';
    // Ссылки внутри строки (.link-btn, .statusbar-link) стоят по линии текста соседей, а не по своей рамке.
    const skip = '.fader-track, .color-swatch, .color-swatch-pick, .fader-toggle, input, select, .eq-slider, .theme-toggle, .list-item, .link-btn, .statusbar-link';
    // Открыто окно поверх страницы — проверяем только его: всё под затемнением
    // и выглядит, и меряется иначе.
    const modal = document.querySelector('.modal-overlay .modal');
    for (const e of (modal ?? document).querySelectorAll(sel)) {
      if (e.offsetParent === null || e.matches(skip) || e.closest('.hint-bubble')) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 12 || r.height < 12 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
      if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.5) continue;
      const text = (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 50);
      const kids = [...e.children].filter((c) => c.offsetParent !== null || c.tagName === 'svg');
      const iconFirst = kids.length > 0 && kids[0].tagName.toLowerCase() === 'svg' && text !== '';
      const chevron = !!e.querySelector(':scope > .panel-chevron');
      const iconOnly = !!e.querySelector('svg') && (e.innerText || '').trim() === '';
      out.push({
        text: text || (e.querySelector('svg') ? '[значок]' : '[пусто]'),
        cls: (e.className && e.className.baseVal === undefined ? e.className : '').toString().split(' ').slice(0, 3).join('.'),
        x: r.left, y: r.top, w: r.width, h: r.height,
        bt: parseFloat(cs.borderTopWidth), br: parseFloat(cs.borderRightWidth), bb: parseFloat(cs.borderBottomWidth), bl: parseFloat(cs.borderLeftWidth),
        radius: parseFloat(cs.borderTopLeftRadius) || 0,
        centered: !e.matches('h2') && (cs.textAlign === 'center' || cs.justifyContent === 'center' || e.tagName === 'BUTTON'),
        iconFirst,
        chevron,
        iconOnly,
      });
    }
    return out;
  })()
`;

function alignReport(img, targets, dpr, tol) {
  const { width: W, height: H } = img.getSize();
  const px = img.toBitmap(); // BGRA
  const bad = [];
  for (const t of targets) {
    // Внутренность без рамки и скруглений, в пикселях снимка.
    const inset = Math.max(1, Math.min(3, t.radius / 2));
    const x0 = Math.ceil((t.x + t.bl + inset) * dpr);
    const x1 = Math.floor((t.x + t.w - t.br - inset) * dpr);
    const y0 = Math.ceil((t.y + t.bt + 1) * dpr);
    const y1 = Math.floor((t.y + t.h - t.bb - 1) * dpr);
    if (x1 - x0 < 4 || y1 - y0 < 4 || x1 > W || y1 > H) continue;
    // Фон — самый частый цвет (с грубым квантованием).
    const hist = new Map();
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        const k = ((px[i + 2] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i] >> 3);
        hist.set(k, (hist.get(k) || 0) + 1);
      }
    }
    let bgK = 0;
    let bgN = -1;
    for (const [k, n] of hist) if (n > bgN) { bgN = n; bgK = k; }
    const bgR = ((bgK >> 10) & 31) * 8 + 4, bgG = ((bgK >> 5) & 31) * 8 + 4, bgB = (bgK & 31) * 8 + 4;
    const ink = (x, y) => {
      const i = (y * W + x) * 4;
      return Math.abs(px[i + 2] - bgR) + Math.abs(px[i + 1] - bgG) + Math.abs(px[i] - bgB) > 90;
    };
    const cols = new Array(x1 - x0).fill(0);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (ink(x, y)) cols[x - x0]++;
    const inkCols = cols.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
    if (inkCols.length === 0) continue;
    // Отрезки чернил по столбцам: значок, слова подписи, стрелка.
    const segs = [];
    let s0 = inkCols[0], p = inkCols[0];
    for (const c of inkCols.slice(1)) {
      if (c - p > 2 * dpr) { segs.push([s0, p]); s0 = c; }
      p = c;
    }
    segs.push([s0, p]);
    // Полоса по строкам в заданных столбцах: core — только густые строки (середина текста для глаза), иначе — все.
    const band = (c0, c1, core) => {
      const rows = [];
      for (let y = y0; y < y1; y++) {
        let n = 0;
        for (let x = x0 + c0; x <= x0 + c1; x++) if (ink(x, y)) n++;
        rows.push(n);
      }
      const max = Math.max(...rows);
      if (max === 0) return null;
      // Густые строки — не меньше половины самой густой: одна заглавная в начале
      // слова («Поток») не утягивает полосу вверх.
      const r = rows.map((n, i) => (n >= (core ? max / 2 : 1) ? i : -1)).filter((i) => i >= 0);
      return { top: r[0], bot: r[r.length - 1], mid: (r[0] + r[r.length - 1] + 1) / 2 };
    };
    const issues = [];
    const boxMid = (y1 - y0) / 2;
    // Что с чем сравнивать: значок перед подписью, стрелка после заголовка — с текстом;
    // текст — с серединой рамки (у заголовка панели рамки нет — только значок с текстом).
    const iconSeg = t.iconFirst && segs.length >= 2 ? segs[0] : t.chevron && segs.length >= 2 ? segs[segs.length - 1] : null;
    const textCols = iconSeg === segs[0] && iconSeg ? [segs[1][0], segs[segs.length - 1][1]] : iconSeg ? [segs[0][0], segs[segs.length - 2][1]] : [inkCols[0], inkCols[inkCols.length - 1]];
    // Кнопка из одного значка — берём весь значок: у стрелки «густые» только
    // строки наконечника, и середина по ним уезжала к острию.
    const iconOnly = t.iconOnly && !iconSeg;
    const text = band(textCols[0], textCols[1], !iconOnly);
    if (!text) continue;
    // Подпись без строчных букв («3D», «36», «СТОП»): её полоса — высота
    // заглавных, она по устройству шрифта выше середины строчных примерно на
    // пиксель, а стоит на той же линии, что и соседи. Допуск для неё шире.
    const capsOnly = !/[a-zа-яё]/.test(t.text);
    if (!t.chevron) {
      const dy = (text.mid - boxMid) / dpr;
      if (Math.abs(dy) >= tol + (capsOnly ? 1 : 0)) issues.push(`${iconSeg ? 'подпись ' : ''}по вертикали ${dy > 0 ? 'ниже' : 'выше'} середины на ${Math.abs(dy).toFixed(1)} px`);
    }
    if (iconSeg) {
      const ic = band(iconSeg[0], iconSeg[1], false);
      if (ic) {
        const d = (ic.mid - text.mid) / dpr;
        if (Math.abs(d) >= tol) issues.push(`${t.chevron ? 'стрелка' : 'значок'} ${d > 0 ? 'ниже' : 'выше'} текста на ${Math.abs(d).toFixed(1)} px`);
      }
    }
    // Поля считаем от внутреннего края рамки (x0 отступает ещё и от скругления).
    const padL = x0 / dpr - (t.x + t.bl);
    const padR = t.x + t.w - t.br - x1 / dpr;
    if (t.centered && !t.iconFirst && !t.chevron) {
      const left = inkCols[0] / dpr + padL;
      const right = (x1 - x0 - 1 - inkCols[inkCols.length - 1]) / dpr + padR;
      if (Math.abs(left - right) >= 3) issues.push(`по горизонтали: слева ${left.toFixed(1)} px, справа ${right.toFixed(1)} px`);
    }
    if (t.iconFirst && segs.length >= 2) {
      const lead = segs[0][0] / dpr + padL;
      const gap = (segs[1][0] - segs[0][1] - 1) / dpr;
      const right = (x1 - x0 - 1 - inkCols[inkCols.length - 1]) / dpr + padR;
      if (Math.abs(lead - gap) >= 2) issues.push(`значок не посередине своего места: слева ${lead.toFixed(1)} px, до подписи ${gap.toFixed(1)} px`);
      else if (Math.abs(lead - right) >= 3) issues.push(`поля неравные: слева ${lead.toFixed(1)} px, справа ${right.toFixed(1)} px`);
    }
    if (issues.length > 0) bad.push({ text: t.text, cls: t.cls, issues, rect: { x: t.x, y: t.y, w: t.w, h: t.h } });
  }
  return bad;
}

app.whenReady().then(async () => {
  /*
   * visible — обычное окно на экране, с фокусом. Нужно, когда проверяется то,
   * что внеэкранное окно не умеет: у него нет фокуса окна, поэтому не приходят
   * focus/blur, а кнопки ▲▼ числового поля не срабатывают (выяснено 24.09.2026).
   * ЗАПУСКАТЬ ТОЛЬКО НА НЕВИДИМОМ РАБОЧЕМ СТОЛЕ (scripts/run-hidden.ps1):
   * окно, выскочившее на экран человека, забирает у него фокус и нажатия.
   */
  const visible = sc.visible === true;
  const win = new BrowserWindow({
    width: sc.width || 1600,
    height: sc.height || 1000,
    show: visible,
    // У видимого окна размер — без рамки и заголовка, как у внеэкранного.
    useContentSize: visible,
    // Внеэкранная отрисовка: скрытое обычное окно перерисовывается с опозданием,
    // и снимок показывал СТАРУЮ картинку — галочка в DOM уже стоит, а на снимке
    // её нет (поймано 22.09.2026). Здесь кадры рисуются всегда.
    webPreferences: { backgroundThrottling: false, offscreen: !visible },
  });
  if (visible) win.focus();
  else win.webContents.setFrameRate(30);
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
      // Настоящие нажатия (события от «железа», а не из скрипта) — чтобы
      // проверять то, что делает сам браузер: стрелки ↑/↓ и кнопки числового
      // поля, набор цифр. focus — CSS-селектор поля (n — какое по счёту).
      if (step.focus) {
        const ok = await win.webContents.executeJavaScript(`
          (() => { const e = document.querySelectorAll(${JSON.stringify(step.focus)})[${step.n || 0}]; if (!e) return false; e.scrollIntoView({ block: 'center' }); e.focus(); if (e.select) e.select(); return true; })()
        `);
        log(`${ok ? '✔' : '✖ НЕ НАЙДЕНО'} фокус в «${step.focus}»`);
        await sleep(200);
      }
      // keys: ["Up", "Down", "5", "Tab"] — клавиши по очереди (имена — как у Electron).
      if (step.keys) {
        for (const k of step.keys) {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k });
          if (k.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: k });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k });
          await sleep(120);
        }
        log(`клавиши: ${step.keys.join(' ')}`);
        await sleep(step.after ?? 200);
      }
      // mouseAt: щёлкнуть мышью в точку элемента — fromRight/fromTop от его
      // правого верхнего угла (кнопки ▲▼ числового поля — у правого края).
      if (step.mouseAt) {
        const r = await win.webContents.executeJavaScript(`
          (() => { const e = document.querySelectorAll(${JSON.stringify(step.mouseAt)})[${step.n || 0}]; if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.right, y: b.top }; })()
        `);
        if (!r) log(`✖ НЕ НАЙДЕНО «${step.mouseAt}»`);
        else {
          const x = Math.round(r.x - (step.fromRight ?? 6));
          const y = Math.round(r.y + (step.fromTop ?? 5));
          // Сначала навести: кнопки ▲▼ поля браузер показывает только под мышью.
          win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          await sleep(150);
          for (let i = 0; i < (step.times || 1); i++) {
            win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
            await sleep(60);
            win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
            await sleep(250);
          }
          log(`мышь: ${step.times || 1} × в (${x}; ${y}) у «${step.mouseAt}»`);
        }
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
        // clipTo: CSS-селектор — снять ровно этот элемент (с полями pad), прокрутив к нему.
        let clip = step.clip;
        if (step.clipTo) {
          const pad = step.pad ?? 8;
          clip = await win.webContents.executeJavaScript(`
            (() => { const e = document.querySelectorAll(${JSON.stringify(step.clipTo)})[${step.n || 0}]; if (!e) return undefined; e.scrollIntoView({ block: 'center' });
              const b = e.getBoundingClientRect(); const x = Math.max(0, Math.floor(b.left - ${pad})), y = Math.max(0, Math.floor(b.top - ${pad}));
              return { x, y, width: Math.min(innerWidth - x, Math.ceil(b.width + 2 * ${pad})), height: Math.min(innerHeight - y, Math.ceil(b.height + 2 * ${pad})) }; })()
          `);
          if (!clip) log(`✖ НЕ НАЙДЕНО «${step.clipTo}» — снимок целиком`);
          await sleep(200);
        }
        let img = await win.webContents.capturePage(clip);
        if (step.zoom) img = img.resize({ width: Math.round(img.getSize().width * step.zoom), quality: 'best' });
        const file = path.join(out, step.shot);
        fs.writeFileSync(file, img.toPNG());
        log(`снимок: ${file}`);
      }
      if (step.align) {
        win.webContents.invalidate();
        await sleep(300);
        const targets = await win.webContents.executeJavaScript(ALIGN_TARGETS);
        const img = await win.webContents.capturePage();
        const dpr = img.getSize().width / (await win.webContents.executeJavaScript('innerWidth'));
        // Допуск: при масштабе 100 % шаг — целый пиксель, и отклонение ровно на
        // 1 px — это округление (полпикселя не нарисовать); при 125–150 % шаг мельче.
        const tol = step.tol ?? (dpr >= 1.24 ? 1 : 1.5);
        const bad = alignReport(img, targets, dpr, tol);
        if (bad.length === 0) log(`✔ ${step.align}: выровнено (${targets.length} кнопок и плашек, масштаб ${dpr})`);
        bad.forEach((b, i) => {
          log(`✖ ${step.align}: «${b.text}» (${b.cls}) — ${b.issues.join('; ')}`);
          // Вырезка крупно — посмотреть глазами, что именно не так.
          if (step.crops) {
            const r = b.rect;
            const crop = img.crop({ x: Math.max(0, Math.round((r.x - 4) * dpr)), y: Math.max(0, Math.round((r.y - 4) * dpr)), width: Math.round((r.w + 8) * dpr), height: Math.round((r.h + 8) * dpr) });
            const name = `${step.align}-${i}`.replace(/[^0-9a-zа-яё-]+/gi, '_') + '.png';
            fs.mkdirSync(path.join(out, 'crops'), { recursive: true });
            fs.writeFileSync(path.join(out, 'crops', name), crop.resize({ width: crop.getSize().width * 4, quality: 'good' }).toPNG());
          }
        });
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
