/**
 * Самопроверка звука вечерней программы — без звуковой карты и без ffplay.
 *
 * Проверяется то, что можно проверить честно: как собираются аргументы запуска
 * проигрывателя (громкость, вырезки монтажа) и как разбирается настройка
 * громкости из файла и из интерфейса. Сам факт «слышно в колонках» машиной не
 * проверяется — это делается на объекте ушами.
 *
 * Рабочие fountain.config.json и fountain.project.json не трогаются: берётся
 * временная папка (правило 4 в CLAUDE.md).
 *
 * Запуск: npm -w @fountain-studio/engine run audio-test
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AudioPlayer, clampVolume, playArgs } from '../audioplayer';
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

/** Значение флага в списке аргументов, например '-volume' → '60'. */
function argOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// ── Громкость: обрезка ─────────────────────────────────────────────────────
check('громкость 0 остаётся нулём, а не «по умолчанию»', clampVolume(0) === 0, String(clampVolume(0)));
check('громкость 60 проходит как есть', clampVolume(60) === 60, String(clampVolume(60)));
check('выше 100 обрезается (клиппинг в колонках)', clampVolume(500) === 100, String(clampVolume(500)));
check('отрицательная обрезается в 0', clampVolume(-20) === 0, String(clampVolume(-20)));
check('дробная округляется', clampVolume(42.7) === 43, String(clampVolume(42.7)));
check('мусор вместо числа → 100', clampVolume(Number.NaN) === 100, String(clampVolume(Number.NaN)));

// ── Аргументы запуска ──────────────────────────────────────────────────────
const plain = playArgs('C:/объект/audio/track.mp3', [], 60);
check('громкость ушла в проигрыватель', argOf(plain, '-volume') === '60', argOf(plain, '-volume'));
check('файл передан последним', plain[plain.length - 1] === 'C:/объект/audio/track.mp3', plain[plain.length - 1]);
check('окно проигрывателя не показывается', plain.includes('-nodisp'));
check('проигрыватель закроется сам в конце трека', plain.includes('-autoexit'));
check('без вырезок фильтр не добавляется', !plain.includes('-af'));

const zero = playArgs('track.mp3', [], 0);
check('нулевая громкость доходит как 0', argOf(zero, '-volume') === '0', argOf(zero, '-volume'));

const cut = playArgs('track.mp3', [{ startMs: 1000, endMs: 2500 }], 70);
check('вырезка монтажа осталась', (argOf(cut, '-af') ?? '').includes('aselect'), argOf(cut, '-af'));
check('границы вырезки в секундах', (argOf(cut, '-af') ?? '').includes('between(t,1.000,2.500)'), argOf(cut, '-af'));
check('метки времени пересобираются без пауз', (argOf(cut, '-af') ?? '').includes('asetpts'), argOf(cut, '-af'));
check('громкость и вырезки уживаются', argOf(cut, '-volume') === '70', argOf(cut, '-volume'));

const twoCuts = playArgs('track.mp3', [{ startMs: 0, endMs: 500 }, { startMs: 3000, endMs: 4000 }], 100);
check('две вырезки объединены в один фильтр', (argOf(twoCuts, '-af') ?? '').split('between').length === 3, argOf(twoCuts, '-af'));

// ── Разбор настройки ───────────────────────────────────────────────────────
check('в настройках по умолчанию 100 %', sanitizeAudio(undefined).volume === 100, String(sanitizeAudio(undefined).volume));
check('громкость из файла читается', sanitizeAudio({ volume: 45 } as never).volume === 45, String(sanitizeAudio({ volume: 45 } as never).volume));
check('битая громкость из файла не роняет движок', sanitizeAudio({ volume: 'громко' } as never).volume === 100);
check('громкость 0 из файла сохраняется', sanitizeAudio({ volume: 0 } as never).volume === 0);
check('путь к проигрывателю не теряется', sanitizeAudio({ ffplayPath: 'D:/ff/ffplay.exe' } as never).ffplayPath === 'D:/ff/ffplay.exe');

// ── Плеер целиком: «без звука» ничего не запускает ─────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-audio-'));
try {
  fs.writeFileSync(path.join(dir, 'track.mp3'), 'не настоящий mp3');
  const silent = new AudioPlayer({ player: 'none', ffplayPath: 'ffplay', volume: 100 }, dir);
  check('режим «без звука»: проигрывателя нет', !silent.ready());
  silent.play('track.mp3', []); // не должно ничего запустить и не должно упасть
  check('режим «без звука»: запуск трека проходит тихо и без ошибки', true);

  /*
   * Новая громкость НЕ должна обрывать уже идущий трек: обрыв посреди вечерней
   * программы — это скачок звука и уехавшая от музыки вода.
   */
  const live = new AudioPlayer({ player: 'none', ffplayPath: 'ffplay', volume: 30 }, dir);
  check('громкость видна наружу', live.volume() === 30, String(live.volume()));
  live.setConfig({ player: 'none', ffplayPath: 'ffplay', volume: 90 });
  check('новая громкость принята', live.volume() === 90, String(live.volume()));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`звук: пройдено ${passed}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
