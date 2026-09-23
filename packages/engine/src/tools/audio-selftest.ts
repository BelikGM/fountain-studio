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
import {
  clampEq,
  clampVolumeDb,
  EQ_BANDS_HZ,
  EQ_PRESETS,
  eqPresetOf,
  levelFromPercent,
  toneDbLabel,
  volumeDbLabel,
} from '@fountain-studio/shared';
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
check('поднять можно: +6 дБ остаётся +6', clampVolumeDb(6) === 6, String(clampVolumeDb(6)));
check('выше +12 дБ не поднимаем', clampVolumeDb(30) === 12, String(clampVolumeDb(30)));
check('ниже −12 дБ не опускаем — дальше только «выключен»', clampVolumeDb(-90) === -12, String(clampVolumeDb(-90)));
check('подпись подъёма со знаком «+3 дБ»', volumeDbLabel({ volumeDb: 3, muted: false }) === '+3 дБ', volumeDbLabel({ volumeDb: 3, muted: false }));
check('шаг 0,1 дБ: −6,3 остаётся −6,3', clampVolumeDb(-6.3) === -6.3, String(clampVolumeDb(-6.3)));
check('мельче десятой округляется: −6,34 → −6,3', clampVolumeDb(-6.34) === -6.3, String(clampVolumeDb(-6.34)));
check('подпись десятых — с запятой «+2,7 дБ»', volumeDbLabel({ volumeDb: 2.7, muted: false }) === '+2,7 дБ', volumeDbLabel({ volumeDb: 2.7, muted: false }));
check('полоса эквалайзера — тоже шаг 0,1: 3,26 → 3,3', clampEq([3.26, -0.04], 0, 0)[0] === 3.3 && clampEq([3.26, -0.04], 0, 0)[1] === 0, JSON.stringify(clampEq([3.26, -0.04], 0, 0).slice(0, 2)));
check('мусор вместо числа → 0 дБ', clampVolumeDb(Number.NaN) === 0);
check('подпись «−6 дБ»', volumeDbLabel({ volumeDb: -6, muted: false }) === '−6 дБ', volumeDbLabel({ volumeDb: -6, muted: false }));
check('подпись дробная — с запятой', volumeDbLabel({ volumeDb: -2.5, muted: false }) === '−2,5 дБ', volumeDbLabel({ volumeDb: -2.5, muted: false }));
check('подпись «звук выключен»', volumeDbLabel({ volumeDb: -6, muted: true }) === 'звук выключен');

console.log('— перевод старых процентов —');
check('100 % → 0 дБ', levelFromPercent(100).volumeDb === 0);
check('50 % → −6 дБ (амплитуда вдвое)', levelFromPercent(50).volumeDb === -6, String(levelFromPercent(50).volumeDb));
check('10 % → −12 дБ (ниже шкала не идёт)', levelFromPercent(10).volumeDb === -12, String(levelFromPercent(10).volumeDb));
check('0 % → звук выключен', levelFromPercent(0).muted === true);

// ── Аргументы запуска ──────────────────────────────────────────────────────
console.log('— аргументы проигрывателя —');
const plain = playArgs('C:/объект/audio/track.mp3', [], { volumeDb: 0, muted: false, bassDb: 0, trebleDb: 0 });
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

const twoCuts = playArgs('track.mp3', [{ startMs: 0, endMs: 500 }, { startMs: 3000, endMs: 4000 }], { volumeDb: 0, muted: false, bassDb: 0, trebleDb: 0 });
check('две вырезки объединены в один фильтр', (argOf(twoCuts, '-af') ?? '').split('between').length === 3, argOf(twoCuts, '-af'));

// ── Эквалайзер ─────────────────────────────────────────────────────────────
console.log('— эквалайзер —');
const eqWith = (pairs: Record<number, number>): number[] => EQ_BANDS_HZ.map((hz) => pairs[hz] ?? 0);
check('десять полос: 60 … 16000 Гц', EQ_BANDS_HZ.length === 10 && EQ_BANDS_HZ[0] === 60 && EQ_BANDS_HZ[9] === 16000);
check('у каждого пресета 10 значений в пределах ±12 дБ', EQ_PRESETS.every((p) => p.gains.length === 10 && p.gains.every((g) => Math.abs(g) <= 12)));
check('пресет узнаётся по своим значениям', EQ_PRESETS.every((p) => eqPresetOf(p.gains) === p.id));
check('накрученное руками — «своя настройка»', eqPresetOf(eqWith({ 600: 1.5 })) === 'custom');
check('подъём больше +12 дБ не даём', clampEq(eqWith({ 60: 99 }))[0] === 12);
check('старые «низкие +3 / высокие −6» переведены в полосы', clampEq(undefined, 3, -6).join(',') === '3,3,0,0,0,0,-6,-6,-6,-6', clampEq(undefined, 3, -6).join(','));
check('подпись со знаком «+3 дБ»', toneDbLabel(3) === '+3 дБ', toneDbLabel(3));
check('подпись «−6 дБ»', toneDbLabel(-6) === '−6 дБ', toneDbLabel(-6));
const shaped = argOf(playArgs('t.mp3', [], { volumeDb: -3, muted: false, eq: eqWith({ 60: 3, 12000: -6 }) }), '-af') ?? '';
check('полоса 60 Гц уходит своим фильтром', shaped.includes('equalizer=f=60:'), shaped);
check('полоса 12 кГц — своим', shaped.includes('equalizer=f=12000:'), shaped);
check('нулевые полосы фильтров не добавляют', !shaped.includes('equalizer=f=1000:'), shaped);
check('эквалайзер стоит раньше громкости', shaped.indexOf('equalizer') < shaped.indexOf('volume'), shaped);
check('при подъёме в конце ограничитель от хрипа', shaped.endsWith('alimiter=limit=0.95:level=false'), shaped);
const cutOnly = argOf(playArgs('t.mp3', [], { volumeDb: 0, muted: false, eq: eqWith({ 60: -6 }) }), '-af') ?? '';
check('при одном срезе ограничитель не нужен', !cutOnly.includes('alimiter'), cutOnly);
const louder = argOf(playArgs('t.mp3', [], { volumeDb: 6, muted: false }), '-af') ?? '';
check('громкость выше файла — с ограничителем', louder.includes('volume=6dB') && louder.endsWith('alimiter=limit=0.95:level=false'), louder);
const flat = playArgs('t.mp3', [], { volumeDb: 0, muted: false, eq: eqWith({}) });
check('ровный эквалайзер — фильтров нет, звук как в файле', !flat.includes('-af'));
const mutedTone = playArgs('t.mp3', [], { volumeDb: 0, muted: true, eq: eqWith({ 60: 6 }) });
check('«звук выключен» — эквалайзер не применяется', !mutedTone.includes('-af'));
const legacy = argOf(playArgs('t.mp3', [], { volumeDb: 0, muted: false, bassDb: 3, trebleDb: 0 }), '-af') ?? '';
check('старая настройка «низкие» тоже играет — через полосы', legacy.includes('equalizer=f=60:') && legacy.includes('equalizer=f=170:'), legacy);

// ── Разбор настройки ───────────────────────────────────────────────────────
console.log('— настройки из файла —');
check('по умолчанию 0 дБ, звук включён', sanitizeAudio(undefined).volumeDb === 0 && !sanitizeAudio(undefined).muted);
check('дБ из файла читаются', sanitizeAudio({ volumeDb: -12 } as never).volumeDb === -12);
check('старые 50 % из файла стали −6 дБ', sanitizeAudio({ volume: 50 } as never).volumeDb === -6);
check('старые 0 % — звук выключен', sanitizeAudio({ volume: 0 } as never).muted === true);
check('старое поле процентов больше не хранится', !('volume' in sanitizeAudio({ volume: 50 } as never)));
check('битая громкость не роняет движок', sanitizeAudio({ volumeDb: 'громко' } as never).volumeDb === 0);
check('эквалайзер по умолчанию ровный, пресет «По умолчанию»', (sanitizeAudio(undefined).eq ?? []).every((g) => g === 0) && sanitizeAudio(undefined).eqPreset === 'flat');
check('старый тембр из файла переведён в полосы', (sanitizeAudio({ bassDb: 4, trebleDb: 6 } as never).eq ?? [])[0] === 4 && (sanitizeAudio({ bassDb: 4, trebleDb: 6 } as never).eq ?? [])[9] === 6);
check('полосы из файла читаются и обрезаются', (sanitizeAudio({ eq: [99, 0, 0, 0, 0, 0, 0, 0, 0, -99] } as never).eq ?? []).join(',') === '12,0,0,0,0,0,0,0,0,-12');
check('путь к проигрывателю не теряется', sanitizeAudio({ ffplayPath: 'D:/ff/ffplay.exe' } as never).ffplayPath === 'D:/ff/ffplay.exe');

// ── Плеер целиком ──────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-audio-'));
try {
  fs.writeFileSync(path.join(dir, 'track.mp3'), 'не настоящий mp3');
  const silent = new AudioPlayer({ player: 'none', ffplayPath: 'ffplay', volumeDb: 0, muted: false, bassDb: 0, trebleDb: 0 }, dir);
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
    const base = measure(argOf(playArgs(tone, [], { volumeDb: 0, muted: false, bassDb: 0, trebleDb: 0 }), '-af'));
    const at6 = measure(argOf(playArgs(tone, [], { volumeDb: -6, muted: false }), '-af'));
    const at20 = measure(argOf(playArgs(tone, [], { volumeDb: -12, muted: false }), '-af'));
    const up6 = measure(argOf(playArgs(tone, [], { volumeDb: 6, muted: false }), '-af'));
    const withCut = measure(argOf(playArgs(tone, [{ startMs: 1000, endMs: 2000 }], { volumeDb: -6, muted: false }), '-af'));
    check('ffmpeg принял фильтр громкости', base !== null && at6 !== null && at20 !== null, `${base} / ${at6} / ${at20}`);
    check(
      '«−6 дБ» в настройках — это −6 дБ на выходе',
      base !== null && at6 !== null && Math.abs(base - at6 - 6) < 0.2,
      `${base} → ${at6} дБ`,
    );
    check(
      '«−12 дБ» — это −12 дБ',
      base !== null && at20 !== null && Math.abs(base - at20 - 12) < 0.2,
      `${base} → ${at20} дБ`,
    );
    check(
      '«+6 дБ» — это +6 дБ (тихий тон ограничитель не трогает)',
      base !== null && up6 !== null && Math.abs(up6 - base - 6) < 0.3,
      `${base} → ${up6} дБ`,
    );
    check('громкость с вырезками монтажа — ffmpeg принял всю цепочку', withCut !== null && at6 !== null && Math.abs(withCut - at6) < 0.2, `${withCut}`);

    // Тембр: низкий тон, высокий тон и середина (тот же 440 Гц).
    const low = path.join(dir, 'low.wav');
    const high = path.join(dir, 'high.wav');
    const loud = path.join(dir, 'loud.wav');
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=60:duration=3', low]);
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=12000:duration=3', high]);
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'aevalsrc=0.95*sin(2*PI*50*t):d=3', loud]);
    const levelOf = (file: string, af: string | undefined): number | null => {
      const chain = af ? `${af},volumedetect` : 'volumedetect';
      const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', chain, '-f', 'null', '-'], { encoding: 'utf8' });
      const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr ?? '');
      return r.status === 0 && m ? Number(m[1]) : null;
    };
    /*
     * Пик — через astats: volumedetect пишет max_volume не выше 0 дБ, и выход
     * за потолок им не увидеть. Заодно ловим «clipping» — это фильтр сам
     * обрезал пики о потолок, то есть хрип уже случился внутри цепочки.
     */
    const peakOf = (file: string, af: string): { peak: number | null; clipped: boolean } => {
      const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', `${af},astats=measure_perchannel=none`, '-f', 'null', '-'], { encoding: 'utf8' });
      const err = r.stderr ?? '';
      const m = /Peak level dB:\s*(-?[\d.]+)/.exec(err);
      return { peak: r.status === 0 && m ? Number(m[1]) : null, clipped: /clipping/i.test(err) };
    };
    const af = (lowDb: number, highDb: number): string | undefined =>
      argOf(playArgs('x', [], { volumeDb: 0, muted: false, eq: eqWith({ 60: lowDb, 12000: highDb }) }), '-af');
    const low0 = levelOf(low, undefined);
    const lowCut = levelOf(low, af(-6, 0));
    const mid0 = base;
    const midBassCut = levelOf(tone, af(-6, 0));
    const high0 = levelOf(high, undefined);
    const highCut = levelOf(high, af(0, -6));
    const midTrebleCut = levelOf(tone, af(0, -6));
    check(
      '«60 Гц −6 дБ» убирает бас (60 Гц) почти на 6 дБ',
      low0 !== null && lowCut !== null && low0 - lowCut > 4,
      `${low0} → ${lowCut} дБ`,
    );
    check(
      '…и не трогает середину (440 Гц)',
      mid0 !== null && midBassCut !== null && Math.abs(mid0 - midBassCut) < 1,
      `${mid0} → ${midBassCut} дБ`,
    );
    check(
      '«12 кГц −6 дБ» убирает верха (12 кГц) почти на 6 дБ',
      high0 !== null && highCut !== null && high0 - highCut > 4,
      `${high0} → ${highCut} дБ`,
    );
    check(
      '…и не трогает середину',
      mid0 !== null && midTrebleCut !== null && Math.abs(mid0 - midTrebleCut) < 1,
      `${mid0} → ${midTrebleCut} дБ`,
    );
    // Громкий бас почти в потолок + подъём низов: без ограничителя ушёл бы за 0 дБ.
    const ours = peakOf(loud, af(6, 0) ?? 'anull');
    // Все полосы вверх и громкость +12 — худший случай; ограничитель держит.
    const worst = peakOf(loud, argOf(playArgs('x', [], { volumeDb: 12, muted: false, eq: EQ_BANDS_HZ.map(() => 12) }), '-af') ?? 'anull');
    check('всё на +12 и громкость +12 — пик всё равно ниже потолка', worst.peak !== null && worst.peak < 0.1, `${worst.peak} дБ`);
    const raw = peakOf(loud, 'aformat=sample_fmts=fltp,bass=g=6:f=100');
    const naive = peakOf(loud, 'bass=g=6:f=100');
    check(
      'без ограничителя подъём низов вывел бы громкий трек за потолок (проверка, что опыт честный)',
      raw.peak !== null && raw.peak > 1,
      `${raw.peak} дБ`,
    );
    check(
      'в 16 битах фильтр сам режет пики — поэтому тембр считаем в плавающей точке (проверка, что опыт честный)',
      naive.clipped,
    );
    check('с нашей цепочкой пик ниже потолка', ours.peak !== null && ours.peak < 0, `${ours.peak} дБ`);
    check('…и ни один фильтр не обрезал пики — хрипа нет', !ours.clipped);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`звук: пройдено ${passed}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
