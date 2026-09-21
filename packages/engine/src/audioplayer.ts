import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CutRange } from '@fountain-studio/shared';

export interface AudioPlayerConfig {
  /** auto — использовать ffplay, если найден; none — без звука (только вода/свет). */
  player: 'auto' | 'ffplay' | 'none';
  /** Путь к ffplay (по умолчанию ищется в PATH). */
  ffplayPath: string;
  /** Громкость, 0…100 %. */
  volume: number;
}

/**
 * Громкость в допустимые 0…100 %.
 *
 * Выше 100 не пускаем сознательно: 100 % — это исходный уровень файла, а
 * усиление сверх него даёт клиппинг, и на объекте это слышно как хрип в
 * колонках. Кому мало — крутить усилитель, а не программу.
 */
export function clampVolume(raw: number): number {
  const v = Math.round(Number(raw));
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100;
}

/**
 * Аргументы запуска проигрывателя. Отдельной чистой функцией, чтобы её можно
 * было проверить тестом, не запуская настоящий ffplay и не трогая звуковую
 * карту (см. tools/audio-selftest.ts).
 *
 * Громкость идёт именно аргументом запуска: менять её у уже идущего процесса
 * ffplay не умеет.
 */
export function playArgs(file: string, cuts: CutRange[], volume: number): string[] {
  const args = ['-nodisp', '-autoexit', '-loglevel', 'error', '-volume', String(clampVolume(volume))];
  if (cuts.length > 0) {
    // Убираем вырезанные интервалы и пересобираем временные метки без пауз.
    const not = cuts.map((c) => `between(t,${(c.startMs / 1000).toFixed(3)},${(c.endMs / 1000).toFixed(3)})`).join('+');
    args.push('-af', `aselect='not(${not})',asetpts=N/SR/TB`);
  }
  args.push('-i', file);
  return args;
}
/**
 * Системный аудиоплеер для автономного воспроизведения (плейлисты, расписание):
 * движок сам играет музыку через ffplay (часть бесплатного ffmpeg), когда
 * редактор закрыт. Вырезки аудио применяются фильтром aselect — слышен тот же
 * монтаж, что и в редакторе. Если ffplay не найден, шоу идёт без звука
 * (вода и свет работают, об отсутствии плеера пишется предупреждение).
 */
export class AudioPlayer {
  private proc: ChildProcess | null = null;
  private available: boolean | null = null;
  private warned = false;

  constructor(
    private config: AudioPlayerConfig,
    private audioDir: string,
  ) {}

  /**
   * Новая громкость из настроек.
   *
   * Уже играющий трек НЕ трогаем: ffplay запущен с громкостью в аргументах, и
   * поменять её на лету можно только перезапуском — а это скачок и потеря
   * синхронизации с водой посреди вечерней программы. Новое значение
   * подхватит следующий трек.
   */
  setConfig(next: AudioPlayerConfig): void {
    // Плеер или путь сменились — заново проверить, что ffplay на месте.
    if (next.player !== this.config.player || next.ffplayPath !== this.config.ffplayPath) this.available = null;
    this.config = next;
  }

  /** Громкость сейчас, % — для ответа интерфейсу. */
  volume(): number {
    return this.config.volume;
  }

  /**
   * Есть ли чем играть звук. Проверка запускает ffplay с -version один раз и
   * запоминает ответ — спрашивать интерфейс будет часто.
   */
  ready(): boolean {
    return this.detect();
  }

  /** Открыли другой объект — играем из его папки; текущее воспроизведение гасим. */
  setDir(dir: string): void {
    this.stop();
    this.audioDir = dir;
  }

  private detect(): boolean {
    if (this.config.player === 'none') return false;
    if (this.available !== null) return this.available;
    const probe = spawnSync(this.config.ffplayPath, ['-version'], { stdio: 'ignore' });
    this.available = probe.status === 0;
    if (!this.available && !this.warned) {
      this.warned = true;
      console.warn(
        `[audio] ffplay не найден (${this.config.ffplayPath}) — плейлисты пойдут без звука. ` +
          'Установите ffmpeg (winget install Gyan.FFmpeg) или укажите audio.ffplayPath в fountain.config.json.',
      );
    }
    return this.available;
  }

  /** Играет файл с начала, применяя вырезки монтажа. Предыдущее воспроизведение обрывается. */
  play(fileName: string, cuts: CutRange[]): void {
    this.stop();
    if (!this.detect()) return;
    const file = path.join(this.audioDir, path.basename(fileName));
    if (!fs.existsSync(file)) {
      console.warn(`[audio] файла нет в хранилище: ${file}`);
      return;
    }
    const vol = clampVolume(this.config.volume);
    const args = playArgs(file, cuts, vol);
    this.proc = spawn(this.config.ffplayPath, args, { stdio: 'ignore' });
    this.proc.on('error', (err) => console.warn('[audio] ffplay ошибка запуска:', err.message));
    this.proc.on('exit', () => {
      this.proc = null;
    });
    console.log(`[audio] ▶ ${path.basename(file)} (громкость ${vol} %)${cuts.length > 0 ? `, вырезок: ${cuts.length}` : ''}`);
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
