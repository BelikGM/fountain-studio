import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CutRange } from '@fountain-studio/shared';

export interface AudioPlayerConfig {
  /** auto — использовать ffplay, если найден; none — без звука (только вода/свет). */
  player: 'auto' | 'ffplay' | 'none';
  /** Путь к ffplay (по умолчанию ищется в PATH). */
  ffplayPath: string;
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
    private readonly config: AudioPlayerConfig,
    private audioDir: string,
  ) {}

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
    const args = ['-nodisp', '-autoexit', '-loglevel', 'error'];
    if (cuts.length > 0) {
      // Убираем вырезанные интервалы и пересобираем временные метки без пауз.
      const not = cuts.map((c) => `between(t,${(c.startMs / 1000).toFixed(3)},${(c.endMs / 1000).toFixed(3)})`).join('+');
      args.push('-af', `aselect='not(${not})',asetpts=N/SR/TB`);
    }
    args.push('-i', file);
    this.proc = spawn(this.config.ffplayPath, args, { stdio: 'ignore' });
    this.proc.on('error', (err) => console.warn('[audio] ffplay ошибка запуска:', err.message));
    this.proc.on('exit', () => {
      this.proc = null;
    });
    console.log(`[audio] ▶ ${path.basename(file)}${cuts.length > 0 ? ` (вырезок: ${cuts.length})` : ''}`);
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
