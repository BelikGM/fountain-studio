import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { clampVolumeDb, volumeDbLabel, type AudioLevel, type CutRange } from '@fountain-studio/shared';

export interface AudioPlayerConfig {
  /** auto — использовать ffplay, если найден; none — без звука (только вода/свет). */
  player: 'auto' | 'ffplay' | 'none';
  /** Путь к ffplay (по умолчанию ищется в PATH). */
  ffplayPath: string;
  /** Громкость, дБ (−40…0). */
  volumeDb: number;
  /** Звук выключен совсем. */
  muted: boolean;
}

/**
 * Аргументы запуска проигрывателя. Отдельной чистой функцией, чтобы её можно
 * было проверить тестом, не запуская настоящий ffplay и не трогая звуковую
 * карту (см. tools/audio-selftest.ts).
 *
 * Громкость — фильтром volume в децибелах, в той же цепочке, что и вырезки
 * монтажа: так уровень точный и совпадает с тем, что написано в настройках.
 * «Звук выключен» — стартовой громкостью 0, без фильтра. Выше 0 дБ не
 * поднимаем (см. shared/audiovolume.ts).
 */
export function playArgs(file: string, cuts: CutRange[], level: AudioLevel): string[] {
  const args = ['-nodisp', '-autoexit', '-loglevel', 'error', '-volume', level.muted ? '0' : '100'];
  const filters: string[] = [];
  if (cuts.length > 0) {
    // Убираем вырезанные интервалы и пересобираем временные метки без пауз.
    const not = cuts.map((c) => `between(t,${(c.startMs / 1000).toFixed(3)},${(c.endMs / 1000).toFixed(3)})`).join('+');
    filters.push(`aselect='not(${not})'`, 'asetpts=N/SR/TB');
  }
  const db = clampVolumeDb(level.volumeDb);
  if (!level.muted && db !== 0) filters.push(`volume=${db}dB`);
  if (filters.length > 0) args.push('-af', filters.join(','));
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

  /** Громкость сейчас — для ответа интерфейсу. */
  level(): AudioLevel {
    return { volumeDb: this.config.volumeDb, muted: this.config.muted };
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
    const level = this.level();
    const args = playArgs(file, cuts, level);
    this.proc = spawn(this.config.ffplayPath, args, { stdio: 'ignore' });
    this.proc.on('error', (err) => console.warn('[audio] ffplay ошибка запуска:', err.message));
    this.proc.on('exit', () => {
      this.proc = null;
    });
    console.log(`[audio] ▶ ${path.basename(file)} (${volumeDbLabel(level)})${cuts.length > 0 ? `, вырезок: ${cuts.length}` : ''}`);
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
