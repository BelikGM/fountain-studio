/**
 * Самопроверка драйвера интерфейса FountanPlay без самого интерфейса.
 *
 * 1. Кадр — байт в байт по алгоритму, снятому дизассемблером с рабочей
 *    FontanPlay 1.9.2.4 (см. drivers/musidora-proto.ts): эталон здесь собран
 *    отдельной, независимой реализацией того же алгоритма и сверен с кодом.
 * 2. Транспорт на заглушке ftd2xx: открытие, порядок выходов, выдернутый
 *    кабель и переподключение, «занят FontanPlay», нет устройства, закрытие.
 * 3. Если задан FS_FTD2XX_DLL — загрузка настоящей библиотеки FTDI.
 *
 * Запуск: npm -w @fountain-studio/engine run musidora-test
 */
import { DMX_UNIVERSE_SIZE } from '@fountain-studio/shared';
import { setD2xxForTests, loadD2xx, type D2xx, type FtdiDevice } from '../drivers/ftd2xx';
import { MusidoraOutput, musidoraLinkStates } from '../drivers/musidora';
import { encodeFrame, outCommand, FRAME_LENGTH } from '../drivers/musidora-proto';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- 1. Кадр байт в байт против независимого эталона ------------------------------
/**
 * Эталон, переписанный вручную с дизассемблера FontanPlay 1.9.2.4 (строитель
 * 5b48c8 + длина в FT_Write): FF FF FF <выход> 00, затем 512 байт (255→254),
 * затем один FF. Передаётся 518 байт (аргумент длины FT_Write = 518).
 */
function reference(out: number, data: Uint8Array): number[] {
  const cmd = [0xf0, 0xf8, 0xf9][Math.min(3, Math.max(1, out)) - 1]!;
  const f = [0xff, 0xff, 0xff, cmd, 0x00];
  for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
    const v = i < data.length ? data[i]! : 0;
    f.push(v === 0xff ? 0xfe : v);
  }
  f.push(0xff);
  return f;
}
{
  check('длина кадра 518', FRAME_LENGTH === 518, String(FRAME_LENGTH));
  check('выход 1 → F0', outCommand(1) === 0xf0);
  check('выход 2 → F8', outCommand(2) === 0xf8);
  check('выход 3 → F9', outCommand(3) === 0xf9);
  let seed = 987654321;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8) & 0xff;
  for (let k = 0; k < 40; k++) {
    const out = (k % 3) + 1;
    const data = Uint8Array.from({ length: DMX_UNIVERSE_SIZE }, (_, i) => (k % 4 === 0 && i % 7 === 0 ? 255 : rnd()));
    const got = encodeFrame(out, data);
    check(`кадр #${k}: совпал с эталоном`, Buffer.compare(got, Buffer.from(reference(out, data))) === 0);
  }
  // Точечно то, что важно для прошивки интерфейса.
  const d = new Uint8Array(DMX_UNIVERSE_SIZE);
  d[0] = 255; d[1] = 0; d[2] = 254; d[511] = 255;
  const f = encodeFrame(2, d);
  check('голова FF FF FF F8 00', f[0] === 0xff && f[1] === 0xff && f[2] === 0xff && f[3] === 0xf8 && f[4] === 0x00);
  check('255 → 254 в данных', f[5] === 0xfe && f[7] === 0xfe && f[FRAME_LENGTH - 2] === 0xfe);
  check('хвост FF', f[FRAME_LENGTH - 1] === 0xff);
  check('в данных нет 0xFF (метка кадра свободна)', f.subarray(4, FRAME_LENGTH - 1).every((x) => x !== 0xff));
  check('короткие данные дополняются нулями', encodeFrame(1, new Uint8Array([7])).length === 518);
}

// ---- 2. Транспорт на заглушке ftd2xx ------------------------------------------------
interface Fake extends D2xx {
  devices: FtdiDevice[];
  writes: Buffer[];
  failNext: number;
  opens: number;
  closes: number;
}
function fake(devices: FtdiDevice[]): Fake {
  const f: Fake = {
    version: '9.99.99',
    dll: 'заглушка',
    devices,
    writes: [],
    failNext: 0,
    opens: 0,
    closes: 0,
    list: () => f.devices.map((d) => ({ ...d })),
    open: (t) => {
      const dev = t.serial ? f.devices.find((d) => d.serial === t.serial) : f.devices[t.index ?? 0];
      if (!dev) return { error: 'устройство не найдено' };
      if (dev.opened) return { error: 'устройство не открылось (занято другой программой?)' };
      dev.opened = true;
      f.opens++;
      return { handle: { dev } };
    },
    prepare: () => null,
    write: async (_h, data) => {
      await sleep(2);
      if (f.failNext > 0) {
        f.failNext--;
        return { status: 4, written: 0 };
      }
      f.writes.push(Buffer.from(data));
      return { status: 0, written: data.length };
    },
    close: (h) => {
      f.closes++;
      (h as { dev: FtdiDevice }).dev.opened = false;
    },
  };
  return f;
}
const dev = (serial: string, opened = false): FtdiDevice => ({ index: 0, serial, description: 'USB DMX', type: 'FT232R/FT245R', id: 0x04036001, opened });

async function transportTests(): Promise<void> {
  // Два выхода одного интерфейса (USB2DMX), автопоиск.
  {
    const f = fake([dev('MUS001')]);
    setD2xxForTests(f);
    const o1 = new MusidoraOutput({ path: '', out: 1 });
    const o2 = new MusidoraOutput({ path: '', out: 2 });
    await sleep(30);
    const a = new Uint8Array(DMX_UNIVERSE_SIZE).fill(10);
    const b = new Uint8Array(DMX_UNIVERSE_SIZE).fill(20);
    for (let t = 0; t < 5; t++) {
      o1.send(a);
      o2.send(b);
      await sleep(20);
    }
    const st = musidoraLinkStates().find((s) => s.target === 'авто');
    check('авто: устройство открыто один раз на оба выхода', f.opens === 1, String(f.opens));
    check('авто: состояние open, серийный MUS001', st?.phase === 'open' && st.serial === 'MUS001', JSON.stringify(st));
    check('авто: выходы [1,2]', JSON.stringify(st?.outs) === '[1,2]', JSON.stringify(st?.outs));
    check('авто: ушло 10 кадров', f.writes.length === 10, String(f.writes.length));
    check('авто: чередование F0/F8', f.writes.every((w, i) => w[3] === (i % 2 === 0 ? 0xf0 : 0xf8)), f.writes.map((w) => w[3]!.toString(16)).join(','));
    check('авто: данные на месте (10 и 20)', f.writes[0]![5] === 10 && f.writes[1]![5] === 20);
    check('авто: длина кадров 518', f.writes.every((w) => w.length === 518));

    // Выдернули кабель: запись падает, через ~2 с — снова открыт.
    f.failNext = 1;
    f.devices[0]!.opened = false;
    o1.send(a);
    await sleep(30);
    const st2 = musidoraLinkStates().find((s) => s.target === 'авто');
    check('обрыв: состояние error', st2?.phase === 'error' && /запись не прошла/.test(st2.text), JSON.stringify(st2));
    check('обрыв: учтён неудачный кадр', (st2?.framesFailed ?? 0) === 1);
    await sleep(2300);
    o1.send(a);
    await sleep(30);
    const st3 = musidoraLinkStates().find((s) => s.target === 'авто');
    check('обрыв: переподключился', st3?.phase === 'open' && f.opens === 2, `${JSON.stringify(st3)} opens=${f.opens}`);

    const closesBefore = f.closes;
    o1.close();
    o2.close();
    await sleep(600);
    check('закрытие: FT_Close', f.closes === closesBefore + 1, `${f.closes - closesBefore}`);
    check('закрытие: интерфейс убран из списка', !musidoraLinkStates().some((s) => s.target === 'авто'));
  }

  // Занят FontanPlay.
  {
    const f = fake([dev('MUS002', true)]);
    setD2xxForTests(f);
    const o = new MusidoraOutput({ path: '' });
    await sleep(30);
    const st = musidoraLinkStates().find((s) => s.target === 'авто');
    check('занят: понятная причина', st?.phase === 'error' && /FontanPlay/.test(st.text), JSON.stringify(st));
    o.close();
    await sleep(500);
  }

  // Нет устройства, затем подключили на ходу.
  {
    const f = fake([]);
    setD2xxForTests(f);
    const o = new MusidoraOutput({ path: '' });
    await sleep(30);
    const st = musidoraLinkStates().find((s) => s.target === 'авто');
    check('нет устройства: searching', st?.phase === 'searching', JSON.stringify(st));
    f.devices.push(dev('MUS003'));
    await sleep(2300);
    o.send(new Uint8Array(DMX_UNIVERSE_SIZE));
    await sleep(30);
    const st2 = musidoraLinkStates().find((s) => s.target === 'авто');
    check('подключили на ходу: open', st2?.phase === 'open' && st2.serial === 'MUS003', JSON.stringify(st2));
    o.close();
    await sleep(500);
  }

  // По серийному номеру: из двух FTDI берём нужный.
  {
    const f = fake([dev('RS485X'), { ...dev('MUS004'), index: 1 }]);
    setD2xxForTests(f);
    const o = new MusidoraOutput({ path: 'MUS004', out: 1 });
    await sleep(30);
    o.send(new Uint8Array(DMX_UNIVERSE_SIZE));
    await sleep(30);
    check('серийный: открыт нужный', f.devices[1]!.opened && !f.devices[0]!.opened);
    o.close();
    await sleep(500);
    const o2 = new MusidoraOutput({ path: 'NOPE' });
    await sleep(30);
    const st = musidoraLinkStates().find((s) => s.target === 'NOPE');
    check('серийный: нет такого — причина', st?.phase === 'error' && /NOPE/.test(st.text), JSON.stringify(st));
    o2.close();
    await sleep(500);
  }

  // Нет библиотеки драйвера.
  {
    setD2xxForTests(null, 'не найдена библиотека драйвера FTDI (ftd2xx.dll)');
    const o = new MusidoraOutput({ path: '' });
    await sleep(30);
    const st = musidoraLinkStates().find((s) => s.target === 'авто');
    check('нет драйвера: причина видна', st?.phase === 'error' && /FTDI|ftd2xx/.test(st.text), JSON.stringify(st));
    o.close();
    await sleep(500);
  }
}

async function realDll(): Promise<void> {
  if (!process.env.FS_FTD2XX_DLL) {
    console.log('  (FS_FTD2XX_DLL не задан — проверка настоящей ftd2xx.dll пропущена)');
    return;
  }
  setD2xxForTests(null);
  const d2 = await loadD2xx(true);
  check('ftd2xx.dll: загрузилась', !!d2);
  if (d2) {
    const list = d2.list();
    console.log(`  ftd2xx ${d2.version} (${d2.dll}), устройств: ${list.length}`);
    check('ftd2xx.dll: версия прочитана', /^\d+\.\d\d\.\d\d$/.test(d2.version), d2.version);
    for (const x of list) console.log(`   · #${x.index} ${x.serial} «${x.description}» ${x.type}${x.opened ? ' (занят)' : ''}`);
  }
}

await transportTests();
await realDll();
console.log(`musidora: пройдено ${passed}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
