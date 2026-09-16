/**
 * Прямой доступ к FTDI через ftd2xx.dll (драйвер D2XX) — так же, как это
 * делают программы Musidora. Нужен для интерфейса Musidora: у него внутри
 * FT245R, и без COM-порта (а на объектах его обычно нет — стоит драйвер D2XX)
 * до устройства иначе не достучаться.
 *
 * Библиотека вызывается через koffi (FFI без компиляции). И koffi, и DLL
 * подгружаются лениво, при первом обращении: если драйвера на компьютере нет,
 * движок работает как обычно, а в настройках видна понятная причина.
 *
 * Где берётся ftd2xx.dll. Официальный драйвер FTDI CDM (его же выкладывает
 * Musidora — «CDM v2.12.00 WHQL Certified») кладёт 64-битную библиотеку в
 * System32 под именем ftd2xx.dll. Если её там нет, пробуем ftd2xx64.dll рядом
 * и путь из переменной FS_FTD2XX_DLL.
 */

type Koffi = typeof import('koffi');
type Fn = ReturnType<import('koffi').LibraryHandle['func']>;

import fs from 'node:fs';
import type { UsbDriverProblem } from '@fountain-studio/shared';

/** Коды FT_STATUS из ftd2xx.h. */
const FT_STATUS_TEXT: Record<number, string> = {
  0: 'OK',
  1: 'неверный дескриптор',
  2: 'устройство не найдено',
  3: 'устройство не открылось (занято другой программой?)',
  4: 'ошибка ввода-вывода (устройство отключено?)',
  5: 'не хватает ресурсов',
  6: 'неверный параметр',
  7: 'неверная скорость',
  8: 'стирание памяти устройства запрещено',
  9: 'запись в память устройства запрещена',
  10: 'ошибка записи EEPROM',
  11: 'ошибка чтения EEPROM',
  12: 'ошибка стирания EEPROM',
  13: 'EEPROM не запрограммирована',
  14: 'неверные аргументы',
  15: 'функция не поддерживается',
  16: 'прочая ошибка',
  17: 'устройство в списке не найдено',
};

export function ftStatusText(status: number): string {
  return FT_STATUS_TEXT[status] ?? `код ${status}`;
}

/** FT_DEVICE из ftd2xx.h — для подписи в списке. FT232R и FT245R отдают один код. */
const FT_DEVICE_TEXT: Record<number, string> = {
  0: 'FT232BM',
  1: 'FT232AM',
  2: 'FT100AX',
  4: 'FT2232C',
  5: 'FT232R/FT245R',
  6: 'FT2232H',
  7: 'FT4232H',
  8: 'FT232H',
  9: 'FT-X',
};

const FT_OPEN_BY_SERIAL_NUMBER = 1;
const FT_FLAGS_OPENED = 1;

export interface FtdiDevice {
  /** Номер в списке драйвера (тот, что FT_Open). Меняется при переподключении. */
  index: number;
  serial: string;
  description: string;
  type: string;
  /** VID/PID: 0x04036001 — FT232R/FT245R. */
  id: number;
  /** Устройство уже открыто — нами или другой программой (FontanPlay). */
  opened: boolean;
}

export interface D2xx {
  /** Версия ftd2xx.dll, напр. «3.02.09». */
  version: string;
  /** Путь или имя, по которому загрузилась библиотека. */
  dll: string;
  list(): FtdiDevice[];
  /** Открыть по серийному номеру (если задан) или по номеру в списке. */
  open(target: { serial?: string; index?: number }): { handle: unknown } | { error: string };
  /** Сброс и таймауты — ровно как FontanPlay после открытия. */
  prepare(handle: unknown): string | null;
  /** Асинхронная запись (в потоке koffi — тик движка не ждёт USB). */
  write(handle: unknown, data: Buffer): Promise<{ status: number; written: number }>;
  close(handle: unknown): void;
}

let loaded: D2xx | null = null;
let lastError = '';
let lastProblem: UsbDriverProblem = 'other';

/** Чем именно вызвана неудача загрузки — по этому UI выбирает текст и цвет. */
export function d2xxProblem(): UsbDriverProblem {
  return lastProblem;
}
let lastTryMs = -Infinity;
let loading: Promise<D2xx | null> | null = null;

/** Повторная попытка загрузки не чаще, чем раз в столько мс (драйвер могли доставить на ходу). */
const RETRY_MS = 10_000;

/**
 * Почему библиотека не загрузилась — человеческим языком.
 *
 * Тонкость Windows, на которой легко решить, что «драйвер не встал»: установщик
 * FTDI CDM только КЛАДЁТ пакет в хранилище драйверов, а сама ftd2xx.dll
 * появляется в System32 лишь тогда, когда FTDI-устройство первый раз воткнули в
 * USB — в этот момент Windows доустанавливает драйвер под конкретное устройство.
 * Поэтому на компьютере, где интерфейс ни разу не подключали, драйвер стоит, а
 * библиотеки нет, и это нормально.
 *
 * Отдельный случай — 32-битная библиотека рядом с FontanPlay или в SysWOW64:
 * её наш 64-битный процесс загрузить не может, нужна 64-битная из System32.
 */
function whyNoLibrary(): { text: string; problem: UsbDriverProblem } {
  const win = process.env.SystemRoot || 'C:\\Windows';
  const has64 = existsQuiet(`${win}\\System32\\ftd2xx.dll`);
  const has32 = existsQuiet(`${win}\\SysWOW64\\ftd2xx.dll`);
  if (!has64 && has32) {
    return {
      problem: 'wrong-bitness',
      text: 'найдена только 32-битная ftd2xx.dll (SysWOW64), а нужна 64-битная. Переустановите драйвер FTDI CDM (64-разрядный) и подключите интерфейс.',
    };
  }
  if (has64) {
    return {
      problem: 'broken',
      text: 'ftd2xx.dll в System32 есть, но не загрузилась — возможно, повреждён пакет драйвера FTDI. Переустановите драйвер FTDI CDM.',
    };
  }
  if (ftdiDriverInstalled()) {
    return {
      problem: 'no-device',
      text:
        'драйвер FTDI установлен, но библиотеки ftd2xx.dll ещё нет: Windows кладёт её только когда FTDI-устройство первый раз подключают к этому компьютеру. ' +
        'Подключите интерфейс по USB.',
    };
  }
  return {
    problem: 'no-driver',
    text:
      'драйвер FTDI на этом компьютере не установлен. Установите FTDI CDM (VCP+D2XX) — с сайта ftdichip.com/drivers или файлом «Driver v2 12 FTDI.exe» из комплекта FontanPlay, — затем подключите интерфейс по USB.',
  };
}

/**
 * Стоит ли на компьютере пакет драйвера FTDI. Смотрим хранилище драйверов
 * Windows: установщик CDM кладёт туда ftdibus.inf ещё до того, как устройство
 * первый раз воткнут, — по этому и отличаем «драйвера нет вовсе» от «драйвер
 * есть, просто интерфейс ни разу не подключали». Чтение каталога прав
 * администратора не требует.
 */
function ftdiDriverInstalled(): boolean {
  const win = process.env.SystemRoot || 'C:\\Windows';
  try {
    return fs
      .readdirSync(`${win}\\System32\\DriverStore\\FileRepository`)
      .some((n) => n.toLowerCase().startsWith('ftdibus.inf'));
  } catch {
    return false;
  }
}

function existsQuiet(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Подменить библиотеку заглушкой — только для самопроверки (tools/musidora-selftest.ts). */
export function setD2xxForTests(api: D2xx | null, error = ''): void {
  loaded = api;
  lastError = error;
  lastTryMs = api || !error ? -Infinity : Date.now();
}

/** Текст причины, если библиотека не загрузилась. */
export function d2xxError(): string {
  return lastError;
}

/**
 * Загрузить koffi и ftd2xx.dll. Возвращает null, если не удалось (причина — в
 * d2xxError()); повторяет попытку не чаще RETRY_MS.
 */
export function loadD2xx(force = false): Promise<D2xx | null> {
  if (loaded) return Promise.resolve(loaded);
  if (loading) return loading;
  if (!force && Date.now() - lastTryMs < RETRY_MS) return Promise.resolve(null);
  lastTryMs = Date.now();
  loading = (async () => {
    if (process.platform !== 'win32') {
      lastError = 'драйвер D2XX подключается только в Windows';
      return null;
    }
    let koffi: Koffi;
    try {
      // В собранном приложении движок — CJS-бандл (engine.cjs), и там надёжнее
      // обычный require: import() из архива asar Electron умеет не везде.
      // Из исходников (tsx, ESM) require нет — тогда динамический import.
      const mod = (typeof require === 'function' ? require('koffi') : await import('koffi')) as Koffi & {
        default?: Koffi;
      };
      koffi = mod.default ?? mod;
    } catch (e) {
      lastError = `не загрузился модуль koffi: ${(e as Error).message}`;
      return null;
    }
    const candidates = [
      process.env.FS_FTD2XX_DLL,
      'ftd2xx.dll',
      'ftd2xx64.dll',
      ...(typeof (process as { resourcesPath?: string }).resourcesPath === 'string'
        ? [`${(process as { resourcesPath?: string }).resourcesPath}\\ftd2xx64.dll`]
        : []),
    ].filter((x): x is string => !!x);
    const failures: string[] = [];
    for (const name of candidates) {
      try {
        const lib = koffi.load(name);
        const api = bind(koffi, lib, name);
        loaded = api;
        lastError = '';
        return api;
      } catch (e) {
        failures.push(`${name}: ${(e as Error).message}`);
      }
    }
    const why = whyNoLibrary();
    lastProblem = why.problem;
    lastError = `${why.text} Пробовали: ${failures.join('; ')}`;
    return null;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

function bind(koffi: Koffi, lib: import('koffi').LibraryHandle, dll: string): D2xx {
  const u32out = koffi.out(koffi.pointer('uint32'));
  const handleOut = koffi.out(koffi.pointer('void *'));
  type Arg = string | ReturnType<Koffi['out']> | ReturnType<Koffi['opaque']>;
  const f = (name: string, args: Arg[]): Fn => lib.func('__stdcall', name, 'uint32', args);

  const FT_GetLibraryVersion = f('FT_GetLibraryVersion', [u32out]);
  const FT_CreateDeviceInfoList = f('FT_CreateDeviceInfoList', [u32out]);
  const FT_GetDeviceInfoDetail = f('FT_GetDeviceInfoDetail', [
    'uint32',
    u32out,
    u32out,
    u32out,
    u32out,
    'void *',
    'void *',
    handleOut,
  ]);
  const FT_Open = f('FT_Open', ['int', handleOut]);
  const FT_OpenEx = f('FT_OpenEx', ['void *', 'uint32', handleOut]);
  const FT_Close = f('FT_Close', ['void *']);
  const FT_ResetDevice = f('FT_ResetDevice', ['void *']);
  const FT_SetTimeouts = f('FT_SetTimeouts', ['void *', 'uint32', 'uint32']);
  const FT_Write = f('FT_Write', ['void *', 'void *', 'uint32', u32out]);

  const ver = [0];
  FT_GetLibraryVersion(ver);
  const v = ver[0] ?? 0;
  const hex = (x: number): string => x.toString(16).padStart(2, '0');
  const version = `${(v >> 16) & 0xff}.${hex((v >> 8) & 0xff)}.${hex(v & 0xff)}`;

  const cstr = (b: Buffer): string => {
    const end = b.indexOf(0);
    return b.toString('latin1', 0, end < 0 ? b.length : end).trim();
  };

  return {
    version,
    dll,
    list() {
      const num = [0];
      if (FT_CreateDeviceInfoList(num) !== 0) return [];
      const out: FtdiDevice[] = [];
      for (let i = 0; i < (num[0] ?? 0); i++) {
        const flags = [0];
        const type = [0];
        const id = [0];
        const loc = [0];
        const serial = Buffer.alloc(16);
        const descr = Buffer.alloc(64);
        const h = [null];
        if (FT_GetDeviceInfoDetail(i, flags, type, id, loc, serial, descr, h) !== 0) continue;
        out.push({
          index: i,
          serial: cstr(serial),
          description: cstr(descr),
          type: FT_DEVICE_TEXT[type[0] ?? -1] ?? `тип ${type[0]}`,
          id: id[0] ?? 0,
          opened: ((flags[0] ?? 0) & FT_FLAGS_OPENED) !== 0,
        });
      }
      return out;
    },
    open(target) {
      const h: unknown[] = [null];
      let status: number;
      if (target.serial) {
        const arg = Buffer.alloc(target.serial.length + 1);
        arg.write(target.serial, 'latin1');
        status = FT_OpenEx(arg, FT_OPEN_BY_SERIAL_NUMBER, h) as number;
      } else {
        status = FT_Open(target.index ?? 0, h) as number;
      }
      if (status !== 0 || !h[0]) return { error: ftStatusText(status) };
      return { handle: h[0] };
    },
    prepare(handle) {
      const r = FT_ResetDevice(handle) as number;
      if (r !== 0) return `FT_ResetDevice: ${ftStatusText(r)}`;
      const t = FT_SetTimeouts(handle, 500, 500) as number;
      if (t !== 0) return `FT_SetTimeouts: ${ftStatusText(t)}`;
      return null;
    },
    write(handle, data) {
      return new Promise((resolve) => {
        const written = [0];
        FT_Write.async(handle, data, data.length, written, (err: unknown, status: number) => {
          if (err) resolve({ status: 16, written: 0 });
          else resolve({ status, written: written[0] ?? 0 });
        });
      });
    },
    close(handle) {
      FT_Close(handle);
    },
  };
}
