import fs from 'node:fs';
import path from 'node:path';
import type { BackupInfo } from '@fountain-studio/shared';

const MAX_BACKUPS = 20;

/**
 * Периодические именованные снимки fountain.project.json (§27 доработки, УХ п.5),
 * в папке backups/ рядом с проектом — отдельно от непрерывного живого
 * автосохранения в project.ts. Живое сохранение защищает от потери процесса,
 * бэкапы — от «сам всё сломал в редакторе»: снимок можно вернуть вручную.
 * Хранит последние MAX_BACKUPS штук, старые удаляются автоматически.
 */
export class BackupStore {
  private timer: NodeJS.Timeout | undefined;
  private enabled: boolean;
  private intervalMin: number;
  private readonly dir: string;

  constructor(
    projectFile: string,
    private readonly getProjectJson: () => string,
    initial: { enabled: boolean; intervalMin: number },
  ) {
    this.dir = path.join(path.dirname(projectFile), 'backups');
    this.enabled = initial.enabled;
    this.intervalMin = clampInterval(initial.intervalMin);
    this.reschedule();
  }

  setConfig(enabled: boolean, intervalMin: number): void {
    this.enabled = enabled;
    this.intervalMin = clampInterval(intervalMin);
    this.reschedule();
  }

  config(): { enabled: boolean; intervalMin: number } {
    return { enabled: this.enabled, intervalMin: this.intervalMin };
  }

  private reschedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = this.enabled ? setInterval(() => this.snapshot(), this.intervalMin * 60_000) : undefined;
  }

  /** Именованный снимок сейчас же — по таймеру или по запросу из UI. */
  snapshot(): void {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(this.dir, `${stamp}.json`), this.getProjectJson(), 'utf8');
      this.prune();
      console.log(`[backups] снимок сохранён: ${stamp}.json`);
    } catch (err) {
      console.error('[backups] не удалось сохранить снимок:', err);
    }
  }

  private prune(): void {
    for (const b of this.list().slice(MAX_BACKUPS)) {
      try {
        fs.unlinkSync(path.join(this.dir, b.file));
      } catch {
        // не критично — попробуем прибраться при следующем снимке
      }
    }
  }

  list(): BackupInfo[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const st = fs.statSync(path.join(this.dir, f));
        return { file: f, atMs: st.mtimeMs, sizeBytes: st.size };
      })
      .sort((a, b) => b.atMs - a.atMs);
  }

  /** Содержимое снимка по имени файла; имя проверяется от выхода за пределы папки бэкапов. */
  read(file: string): unknown {
    if (file.includes('/') || file.includes('\\') || file.includes('..')) {
      throw new Error('недопустимое имя файла бэкапа');
    }
    const full = path.join(this.dir, file);
    if (!fs.existsSync(full)) throw new Error('бэкап не найден');
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

function clampInterval(min: number): number {
  return Math.max(1, Math.min(30, Math.round(min) || 10));
}
