import fs from 'node:fs';
import path from 'node:path';
import { emptyProject, sanitizeProject, type Project } from '@fountain-studio/shared';

/**
 * Хранилище проекта: fountain.project.json рядом с fountain.config.json.
 * Запись на диск отложенная (дебаунс), чтобы частые правки в редакторе
 * не молотили диск; при остановке движка выполняется финальный сброс.
 */
export class ProjectStore {
  private current: Project;
  private saveTimer: NodeJS.Timeout | undefined;
  private dirty = false;

  constructor(readonly file: string) {
    this.current = this.load();
  }

  get project(): Project {
    return this.current;
  }

  private load(): Project {
    if (!fs.existsSync(this.file)) {
      console.log(`[project] файла нет, новый проект (${this.file})`);
      return emptyProject();
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      const project = sanitizeProject(raw);
      console.log(
        `[project] загружен «${project.name}»: устройств ${project.devices.length}, сцен ${project.scenes.length}, секвенсоров ${project.sequences.length}`,
      );
      return project;
    } catch (err) {
      // Битый файл не затираем молча: переименовываем в .broken и стартуем с чистого.
      const backup = `${this.file}.broken`;
      fs.copyFileSync(this.file, backup);
      console.error(`[project] файл повреждён (копия: ${backup}):`, err);
      return emptyProject();
    }
  }

  /** Заменяет проект целиком (уже прошедший sanitizeProject) и планирует сохранение. */
  update(project: Project): void {
    this.current = project;
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.current, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    console.log(`[project] сохранён ${path.basename(this.file)}`);
  }
}
