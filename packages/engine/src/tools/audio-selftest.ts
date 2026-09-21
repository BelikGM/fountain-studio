/**
 * Самопроверка звука вечерней программы — без звуковой карты.
 *
 * Две части:
 *  · как собираются аргументы запуска проигрывателя (громкость в дБ, «звук
 *    выключен», вырезки монтажа) и как разбирается настройка — в том числе
 *    старая, в процентах;
 *  · НАСТОЯЩИЙ замер: тот же фильтр, что получит проигрыватель, прогоняется
 *    через ffmpeg по тестовому тону, и уровень меряется. Это ловит то, чего
 *    проверка аргументов не видит, — что ffmpeg фильтр принял и что «−6 дБ» в
 *    настройках это действительно −6 дБ на выходе. Нет ffmpeg — эта часть
 *    честно пропускается, а не засчитывается.
 *
 * Сам факт «слышно в колонках» машиной не проверяется — это на объекте ушами.
 * Рабочие настройки не трогаются: всё во временной папке (правило 4).
 *
 * Запуск: npm -w @fountain-studio/engine run audio-test
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clampVolumeDb, levelFromPercent, volumeDbLabel } from '@fountain-studio/shared';
import { AudioPlayer, playArgs } from '../audioplayer';
import { sanitizeAudio } from '../config';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/** Значение флага в списке аргументов, например '-volume' → '100'. */
function argOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// ── Децибелы ───────────────────────────────────────────────────────────────
console.log('— громкость в дБ —');
check('0 дБ — как в файле', clampVolumeDb(0) === 0);
check('выше 0 дБ не поднимаем (перегруз в колонках)', clampVolumeDb(6) === 0, String(clampVolumeDb(6)));
check('ниже −40 дБ не опускаем — дальше только «выключен»', clampVolumeDb(-90) === -40, String(clampVolumeDb(-90)));
check('шаг 0,5 дБ', clampVolumeDb(-6.3) === -6.5, String(clampVolumeDb(-6.3)));
check('мусор вместо числа → 0 дБ', clampVolumeDb(Number.NaN) === 0);
check('подпись «−6 дБ»', volumeDbLabel({ volumeDb: -6, muted: false }) === '−6 дБ', volumeDbLabel({ volumeDb: -6, muted: false }));
check('подпись дробная — с запятой', volumeDbLabel({ volumeDb: -2.5, muted: false }) === '−2,5 дБ', volumeDbLabel({ volumeDb: -2.5, muted: false }));
check('подпись «звук выключен»', volumeDbLabel({ volumeDb: -6, muted: true }) === 'звук выключен');

console.log('— перевод старых процентов —');
check('100 % → 0 дБ', levelFromPercent(100).volumeDb === 0);
check('50 % → −6 дБ (амплитуда вдвое)', levelFromPercent(50).volumeDb === -6, String(levelFromPercent(50).volumeDb));
check('10 % → −20 дБ', levelFromPercent(10).volumeDb === -20, String(levelFromPercent(10).volumeDb));
check('0 % → звук выключен', levelFromPercent(0).muted === true);

// ── Аргументы запуска ──────────────────────────────────────────────────────
console.log('— аргументы проигрывателя —');
const plain = playArgs('C:/объект/audio/track.mp3', [], { volumeDb: 0, muted: false });
check('0 дБ: стартовая громкость полная', argOf(plain, '-volume') === '100', argOf(plain, '-volume'));
check('0 дБ: фильтра громкости нет — звук как в файле', !plain.includes('-af'));
check('файл передан последним', plain[plain.length - 1] === 'C:/объект/audio/track.mp3', plain[plain.length - 1]);
check('окно проигрывателя не показывается', plain.includes('-nodisp'));
check('проигрыватель закроется сам в конце трека', plain.includes('-autoexit'));

const quiet = playArgs('track.mp3', [], { volumeDb: -6, muted: false });
check('−6 дБ уходит фильтром', argOf(quiet, '-af') === 'volume=-6dB', argOf(quiet, '-af'));

const muted = playArgs('track.mp3', [], { volumeDb: -6, muted: true });
check('«звук выключен» — стартовая громкость 0', argOf(muted, '-volume') === '0', argOf(muted, '-volume'));
check('«звук выключен» — без лишнего фильтра', !muted.includes('-af'));

const cut = playArgs('track.mp3', [{ startMs: 1000, endMs: 2500 }], { volumeDb: -3, muted: false });
const cutAf = argOf(cut, '-af') ?? '';
check('вырезка монтажа осталась', cutAf.includes('aselect'), cutAf);
check('границы вырезки в секундах', cutAf.includes('between(t,1.000,2.500)'), cutAf);
check('метки времени пересобираются без пауз', cutAf.includes('asetpts'), cutAf);
check('громкость — в той же цепочке, после вырезок', cutAf.endsWith(',volume=-3dB'), cutAf);

const twoCuts = playArgs('track.mp3', [{ startMs: 0, endMs: 500 }, { startMs: 3000, endMs: 4000 }], { volumeDb: 0, muted: false });
check('две вырезки объединены в один фильтр', (argOf(twoCuts, '-af') ?? '').split('between').length === 3, argOf(twoCuts, '-af'));

// ── Разбор настройки ───────────────────────────────────────────────────────
console.log('— настройки из файла —');
check('по умолчанию 0 дБ, звук включён', sanitizeAudio(undefined).volumeDb === 0 && !sanitizeAudio(undefined).muted);
check('дБ из файла читаются', sanitizeAudio({ volumeDb: -12 } as never).volumeDb === -12);
check('старые 50 % из файла стали −6 дБ', sanitizeAudio({ volume: 50 } as never).volumeDb === -6);
check('старые 0 % — звук выключен', sanitizeAudio({ volume: 0 } as never).muted === true);
check('старое поле процентов больше не хранится', !('volume' in sanitizeAudio({ volume: 50 } as never)));
check('битая громкость не роняет движок', sanitizeAudio({ volumeDb: 'громко' } as never).volumeDb === 0);
check('путь к проигрывателю не теряется', sanitizeAudio({ ffplayPath: 'D:/ff/ffplay.exe' } as never).ffplayPath === 'D:/ff/ffplay.exe');

// ── Плеер целиком ──────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-audio-'));
try {
  fs.writeFileSync(path.join(dir, 'track.mp3'), 'не настоящий mp3');
  const silent = new AudioPlayer({ player: 'none', ffplayPath: 'ffplay', volumeDb: 0, muted: false }, dir);
  check('режим «без звука»: проигрывателя нет', !silent.ready());
  silent.play('track.mp3', []); // не должно ничего запустить и не должно упасть
  check('режим «без звука»: запуск трека проходит тихо и без ошибки', true);

  /*
   * Новая громкость НЕ должна обрывать уже идущий трек: обрыв посреди вечерней
   * программы — это скачок звука и уехавшая от музыки вода.
   */
  const live = new AudioPlayer({ player: 'none', ffplayPath: 'ffplay', volumeDb: -10, muted: false }, dir);
  check('громкость видна наружу', live.level().volumeDb === -10);
  live.setConfig({ player: 'none', ffplayPath: 'ffplay', volumeDb: -3, muted: true });
  check('новая громкость принята', live.level().volumeDb === -3 && live.level().muted);

  // ── Настоящий замер через ffmpeg ─────────────────────────────────────────
  console.log('— замер уровня через ffmpeg —');
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (probe.status !== 0) {
    console.log('  (ffmpeg не найден — замер пропущен, НЕ засчитан)');
  } else {
    const tone = path.join(dir, 'tone.wav');
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', tone]);
    /** Средний уровень после фильтра, дБ; null — ffmpeg фильтр не принял. */
    const measure = (af: string | undefined): number | null => {
      const chain = af ? `${af},volumedetect` : 'volumedetect';
      const r = spawnSync('ffmpeg', ['-hide_banner', '-i', tone, '-af', chain, '-f', 'null', '-'], { encoding: 'utf8' });
      const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr ?? '');
      return r.status === 0 && m ? Number(m[1]) : null;
    };
    const base = measure(argOf(playArgs(tone, [], { volumeDb: 0, muted: false }), '-af'));
    const at6 = measure(argOf(playArgs(tone, [], { volumeDb: -6, muted: false }), '-af'));
    const at20 = measure(argOf(playArgs(tone, [], { volumeDb: -20, muted: false }), '-af'));
    const withCut = measure(argOf(playArgs(tone, [{ startMs: 1000, endMs: 2000 }], { volumeDb: -6, muted: false }), '-af'));
    check('ffmpeg принял фильтр громкости', base !== null && at6 !== null && at20 !== null, `${base} / ${at6} / ${at20}`);
    check(
      '«−6 дБ» в настройках — это −6 дБ на выходе',
      base !== null && at6 !== null && Math.abs(base - at6 - 6) < 0.2,
      `${base} → ${at6} дБ`,
    );
    check(
      '«−20 дБ» — это −20 дБ',
      base !== null && at20 !== null && Math.abs(base - at20 - 20) < 0.2,
      `${base} → ${at20} дБ`,
    );
    check('громкость с вырезками монтажа — ffmpeg принял всю цепочку', withCut !== null && at6 !== null && Math.abs(withCut - at6) < 0.2, `${withCut}`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`звук: пройдено ${passed}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
