/**
 * Картинки программы из логотипа FBEST: значок программы (.ico), значки
 * вкладки браузера под тёмную и светлую тему и оформление установщика.
 *
 * Зачем. Установщик собирался без единой своей картинки: стандартное белое
 * окно NSIS и значок Electron — «как будто ставится очень старое приложение»
 * (заказчик 24.09.2026). Картинки рисуются здесь, из того же логотипа, что в
 * шапке редактора, — поменяется логотип, перезапустите скрипт.
 *
 * Запуск (VS Code выставляет ELECTRON_RUN_AS_NODE, поэтому env -u):
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/make-brand-assets.cjs
 *
 * Что пишет:
 *   packages/ui/public/favicon-dark.png, favicon-light.png — 64×64
 *   packages/app/build/icon.ico — 16…256, значок программы и установщика
 *   packages/app/build/installerSidebar.bmp, uninstallerSidebar.bmp — 164×314
 *   packages/app/build/installerHeader.bmp — 150×57
 * Размеры BMP — те, что ждёт NSIS (Modern UI 2), 24 бита без сжатия.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'packages', 'ui', 'public');
const BUILD = path.join(ROOT, 'packages', 'app', 'build');

/** Цвета — те же, что в тёмной теме редактора (фон шапки и панелей). */
const BG = '#1e2230';
const BG_DEEP = '#12151c';
const ACCENT = '#4aa3ff';

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'fs-brand-')));
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const logoUrl = (file) => 'data:image/png;base64,' + fs.readFileSync(path.join(PUBLIC, file)).toString('base64');

/**
 * Страница рисует всё на canvas и отдаёт PNG в base64. Знак «F» — верхняя
 * часть логотипа без надписи FBEST: в 16–64 пикселях надпись не читается.
 */
const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<script>
const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
// Знак «F» в исходнике 1280×1600: строки 0…1225 (ниже — надпись).
const MARK = { x: 0, y: 0, w: 1280, h: 1225 };
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
/**
 * Логотип без его собственного фона: яркость пикселя → прозрачность, цвет —
 * заданный. Иначе на градиенте или на плашке другого оттенка был бы виден
 * прямоугольник исходной картинки.
 */
function tinted(img, color) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d');
  g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height); const p = d.data;
  const bg = 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
  const m = /^#(..)(..)(..)$/.exec(color); const [r, gg, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
  for (let i = 0; i < p.length; i += 4) {
    const l = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
    p[i + 3] = Math.max(0, Math.min(255, Math.round(((l - bg) / (255 - bg)) * 255)));
    p[i] = r; p[i + 1] = gg; p[i + 2] = b;
  }
  g.putImageData(d, 0, 0); return c;
}
/**
 * Знак «F» линиями — те же две ломаные, что в логотипе (координаты сняты с
 * исходника 1280×1600). Картинкой его не уменьшить: линии логотипа тонкие, и
 * в 32 и 16 пикселях от знака ничего не оставалось. Линией толщина
 * подбирается под размер значка.
 */
const MARK_PATHS = [
  [[1235, 20], [1235, 318], [490, 318], [490, 465]],
  [[1235, 465], [1235, 762], [490, 762], [490, 1208], [45, 1208]],
];
const MARK_BOX = { x: 45, y: 20, w: 1190, h: 1188 };
/** Знак на квадратной плашке: bg — фон плашки, color — цвет линий. */
function markIcon(size, color, bg) {
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
  roundRect(g, 0, 0, size, size, Math.max(2, size * 0.18)); g.fillStyle = bg; g.fill();
  const lw = Math.min(9, Math.max(1.6, size * 0.036));
  const inner = size - 2 * Math.max(size * 0.2, lw * 2);
  drawMark(g, (size - inner) / 2, (size - inner) / 2, inner, color, lw);
  return c.toDataURL('image/png').split(',')[1];
}
/** Знак линиями в квадрат side×side с левым верхним углом (x, y). */
function drawMark(g, x, y, side, color, lw) {
  const k = side / MARK_BOX.w;
  const ox = x - MARK_BOX.x * k;
  const oy = y + (side - MARK_BOX.h * k) / 2 - MARK_BOX.y * k;
  g.strokeStyle = color; g.lineWidth = lw; g.lineCap = 'round'; g.lineJoin = 'miter';
  for (const pts of MARK_PATHS) {
    g.beginPath();
    pts.forEach(([px, py], i) => (i ? g.lineTo(ox + px * k, oy + py * k) : g.moveTo(ox + px * k, oy + py * k)));
    g.stroke();
  }
}
/** Струи фонтана — тонкие светящиеся дуги, как на объекте ночью. */
function jets(g, W, baseY, count, maxH, color) {
  for (let i = 0; i < count; i++) {
    const x = W * (i + 0.5) / count;
    const hgt = maxH * (0.45 + 0.55 * Math.sin(Math.PI * (i + 0.5) / count));
    const grad = g.createLinearGradient(0, baseY, 0, baseY - hgt);
    grad.addColorStop(0, color + 'cc'); grad.addColorStop(1, color + '00');
    g.strokeStyle = grad; g.lineWidth = 1.6; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x, baseY); g.lineTo(x, baseY - hgt); g.stroke();
  }
}
async function draw() {
  const src = await load(window.LOGO_WHITE);
  const white = tinted(src, '#ffffff');
  const out = {};
  out.faviconDark = markIcon(64, '#ffffff', '${BG}');
  out.faviconLight = markIcon(64, '${BG}', '#ffffff');
  out.ico = [256, 128, 64, 48, 32, 24, 16].map((s) => ({ size: s, png: markIcon(s, '#ffffff', '${BG}') }));

  // Боковая картинка установщика 164×314: логотип, название, струи.
  {
    const W = 164, H = 314; const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '${BG}'); bg.addColorStop(1, '${BG_DEEP}');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // Логотип целиком, с надписью FBEST.
    const lw = 84, lh = lw * 1600 / 1280;
    g.drawImage(white, (W - lw) / 2, 30, lw, lh);
    g.fillStyle = '#ffffff'; g.font = '600 17px "Segoe UI", sans-serif'; g.textAlign = 'center';
    g.fillText('Fountain Studio', W / 2, 30 + lh + 30);
    g.fillStyle = '#9aa3b5'; g.font = '11px "Segoe UI", sans-serif';
    g.fillText('управление', W / 2, 30 + lh + 50);
    g.fillText('светомузыкальными', W / 2, 30 + lh + 64);
    g.fillText('фонтанами', W / 2, 30 + lh + 78);
    jets(g, W, H - 14, 9, 54, '${ACCENT}');
    g.fillStyle = '${ACCENT}55'; g.fillRect(10, H - 14, W - 20, 1);
    out.sidebar = { w: W, h: H, data: Array.from(g.getImageData(0, 0, W, H).data), png: c.toDataURL('image/png').split(',')[1] };
  }
  // Шапка установщика 150×57 (справа в полосе заголовка): знак и название.
  {
    const W = 150, H = 57; const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    g.fillStyle = '${BG}'; g.fillRect(0, 0, W, H);
    const side = 32;
    drawMark(g, W - side - 12, (H - side) / 2, side, '#ffffff', 1.8);
    jets(g, W - side - 24, H - 6, 6, 30, '${ACCENT}');
    out.header = { w: W, h: H, data: Array.from(g.getImageData(0, 0, W, H).data), png: c.toDataURL('image/png').split(',')[1] };
  }
  return out;
}
</script></body></html>`;

/** 24-битный BMP (снизу вверх, строки выровнены по 4 байта) из RGBA. */
function bmp(w, h, rgba) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
  const b = Buffer.alloc(size);
  b.write('BM', 0);
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * h, 34);
  b.writeInt32LE(2835, 38);
  b.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const dst = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      b[dst + x * 3] = rgba[s + 2];
      b[dst + x * 3 + 1] = rgba[s + 1];
      b[dst + x * 3 + 2] = rgba[s];
    }
  }
  return b;
}

/** ICO с PNG внутри (так Windows хранит значки начиная с Vista). */
function ico(images) {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  const bodies = [];
  images.forEach((img, i) => {
    const png = Buffer.from(img.png, 'base64');
    const e = 6 + i * 16;
    head[e] = img.size >= 256 ? 0 : img.size;
    head[e + 1] = img.size >= 256 ? 0 : img.size;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
    bodies.push(png);
  });
  return Buffer.concat([head, ...bodies]);
}

app.whenReady().then(async () => {
  try {
    await make();
  } catch (err) {
    console.error('не получилось:', err);
    app.exit(1);
  }
});

async function make() {
  const win = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  await win.webContents.executeJavaScript(
    `window.LOGO_WHITE = ${JSON.stringify(logoUrl('FBEST_final.png'))}; 1`,
  );
  const out = await win.webContents.executeJavaScript('draw()');
  fs.mkdirSync(BUILD, { recursive: true });
  fs.writeFileSync(path.join(PUBLIC, 'favicon-dark.png'), Buffer.from(out.faviconDark, 'base64'));
  fs.writeFileSync(path.join(PUBLIC, 'favicon-light.png'), Buffer.from(out.faviconLight, 'base64'));
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico(out.ico));
  const sidebar = bmp(out.sidebar.w, out.sidebar.h, out.sidebar.data);
  fs.writeFileSync(path.join(BUILD, 'installerSidebar.bmp'), sidebar);
  fs.writeFileSync(path.join(BUILD, 'uninstallerSidebar.bmp'), sidebar);
  fs.writeFileSync(path.join(BUILD, 'installerHeader.bmp'), bmp(out.header.w, out.header.h, out.header.data));
  // PNG-копии для просмотра глазами (в репозиторий не нужны).
  const preview = path.join(os.tmpdir(), 'fs-brand-preview');
  fs.mkdirSync(preview, { recursive: true });
  fs.writeFileSync(path.join(preview, 'icon-256.png'), Buffer.from(out.ico[0].png, 'base64'));
  fs.writeFileSync(path.join(preview, 'icon-32.png'), Buffer.from(out.ico[4].png, 'base64'));
  fs.writeFileSync(path.join(preview, 'icon-16.png'), Buffer.from(out.ico[6].png, 'base64'));
  fs.writeFileSync(path.join(preview, 'favicon-light.png'), Buffer.from(out.faviconLight, 'base64'));
  fs.writeFileSync(path.join(preview, 'favicon-dark.png'), Buffer.from(out.faviconDark, 'base64'));
  fs.writeFileSync(path.join(preview, 'sidebar.png'), Buffer.from(out.sidebar.png, 'base64'));
  fs.writeFileSync(path.join(preview, 'header.png'), Buffer.from(out.header.png, 'base64'));
  console.log('готово; просмотр PNG:', preview);
  app.quit();
}
