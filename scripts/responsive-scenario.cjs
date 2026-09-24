/**
 * Сценарий сплошной проверки адаптивности для scripts/ui-shot.cjs: ВСЕ вкладки
 * на размерах окна ноутбуков (docs/ВЁРСТКА.md, «Адаптивность»). На каждой
 * вкладке и размере — шаг fit (обрезанные подписи, за краем окна) и замер
 * «страница или панель прокручивается вбок».
 *
 *   node scripts/responsive-scenario.cjs <сценарий.json> [--desktop] [--sizes 1366x656,800x528] [--shots 1366,1024] [--out папка]
 *   npm -w @fountain-studio/engine run ui-shots -- <сценарий.json>
 *
 * --desktop — вид настольной программы (своя строка заголовка, ?titlebar=1):
 * высота окна в нём на 32 px меньше, это уже учтено в размерах по умолчанию.
 * Ищите в выводе «✖» и строки замера не «ок».
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith('.json'));
if (!file) {
  console.error('Куда записать сценарий: node scripts/responsive-scenario.cjs сценарий.json [--desktop]');
  process.exit(2);
}
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const desktop = args.includes('--desktop');
/*
 * Размеры — окно редактора на распространённых ноутбуках (ширина × высота в
 * точках CSS, за вычетом панели задач Windows и строки заголовка):
 *  1920 × 1080 при 100 %, 1536 × 864 (1920 при 125 % — самый частый),
 *  1440 × 900, 1366 × 768, 1280 × 720 (1920 при 150 %), 1024 — узкое окно,
 *  800 — меньше программа не сжимается (minWidth в main.cjs).
 */
const sizes = opt('--sizes', '1920x968,1536x784,1440x820,1366x656,1280x608,1024x608,800x528')
  .split(',')
  .map((s) => s.split('x').map(Number));
const shotAt = new Set(opt('--shots', '').split(',').filter(Boolean).map(Number));
const out = opt('--out', path.join(os.tmpdir(), 'fs-responsive'));
const tabs = ['Отладка', 'Оборудование', '3D', 'Сцены', 'Секвенсоры', 'Шоу', 'Плейлисты', 'Расписание', 'Поток', 'Диагностика', 'Внешние пульты', 'Клавиатура', 'Настройки'];

// Прокрутка вбок внутри .table-scroll — задумана (широкая таблица на узком окне), не считается.
const metrics = (tab) => `(() => {
  const W = document.documentElement.clientWidth;
  const out = [];
  if (document.documentElement.scrollWidth > W + 1) out.push('страница шире окна: ' + document.documentElement.scrollWidth);
  for (const v of document.querySelectorAll('main, .view, .content, .sidebar, .panel, section')) {
    if (v.offsetParent === null || v.closest('.table-scroll')) continue;
    const cs = getComputedStyle(v);
    if (v.scrollWidth > v.clientWidth + 2 && cs.overflowX !== 'visible') out.push((v.className || v.tagName).toString().slice(0, 40) + ' прокрутка вбок ' + v.scrollWidth + '/' + v.clientWidth);
  }
  const vis = [...document.querySelectorAll('button, input, select, label, h2, .tab')].filter((e) => e.offsetParent !== null && !e.closest('.tabs-measure') && !e.closest('.table-scroll'));
  let beyond = 0; const names = [];
  for (const e of vis) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.right > W + 1) { beyond++; if (names.length < 4) names.push((e.innerText || e.value || e.tagName).trim().slice(0, 24)); } }
  if (beyond) out.push('за краем окна: ' + beyond + ' (' + names.join(' | ') + ')');
  return ${JSON.stringify(tab)} + ' ' + innerWidth + '×' + innerHeight + ': ' + (out.length ? out.join('; ') : 'ок');
})()`;

const steps = [];
for (const [w, h] of sizes) {
  steps.push({ eval: `window.resizeTo(${w}, ${h}); new Promise((r) => setTimeout(() => r(innerWidth + '×' + innerHeight), 700))` });
  for (const t of tabs) {
    steps.push({ tab: t, after: t === '3D' ? 1800 : 900 });
    steps.push({ eval: metrics(t) });
    steps.push({ fit: `${t} ${w}` });
    if (shotAt.has(w)) steps.push({ shot: `${w}-${t}.png` });
  }
}
const sc = { out, width: sizes[0][0], height: sizes[0][1], steps };
if (desktop) sc.url = 'http://127.0.0.1:5180/?engine=9531&titlebar=1';
fs.writeFileSync(file, JSON.stringify(sc, null, 1));
console.log(`сценарий: ${file} — ${tabs.length} вкладок × ${sizes.length} размеров, шагов ${steps.length}`);
