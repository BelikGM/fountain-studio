import fs from 'node:fs';
import path from 'node:path';

/**
 * Хранилище аудиофайлов шоу: папка audio/ рядом с fountain.project.json.
 * Файлы кладёт редактор через uploadAudio и забирает через getAudio —
 * проект остаётся переносимым (папка проекта содержит всё шоу целиком).
 */
export class AudioStore {
  private current: string;

  constructor(dir: string) {
    this.current = dir;
  }

  /** Папка аудио открытого объекта. */
  get dir(): string {
    return this.current;
  }

  /** Открыли другой объект — играем и сохраняем уже из его папки. */
  setDir(dir: string): void {
    this.current = dir;
  }

  /** Только имя файла без путей — защита от выхода за пределы папки. */
  private safePath(name: string): string | null {
    const base = path.basename(name).trim();
    if (base === '' || base === '.' || base === '..') return null;
    return path.join(this.dir, base);
  }

  save(name: string, dataBase64: string): string | null {
    const file = this.safePath(name);
    if (!file) return null;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(dataBase64, 'base64'));
    console.log(`[audio] сохранён ${path.basename(file)} (${fs.statSync(file).size} байт)`);
    return path.basename(file);
  }

  load(name: string): string | null {
    const file = this.safePath(name);
    if (!file || !fs.existsSync(file)) return null;
    return fs.readFileSync(file).toString('base64');
  }
}
