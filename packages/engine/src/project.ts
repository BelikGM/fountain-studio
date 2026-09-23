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
  /**
   * Как часто дописывать правки на диск, мс; null — автосохранение выключено
   * (правки ждут «Сохранить»). По умолчанию — раз в секунду.
   *
   * Раньше каждая правка уходила на диск через полсекунды, и спрашивать при
   * переключении проекта было не о чем. Заказчик просил управляемое
   * автосохранение: включено по умолчанию, раз в N минут, можно выключить.
   */
  private autosaveMs: number | null = 1000;
  /** Когда проект последний раз записан на диск (unix-время, мс). */
  private savedAt: number | null = null;
  /** Правки появились или ушли на диск — для «не сохранено» в шапке. */
  onDirtyChange: ((dirty: boolean) => void) | null = null;

  private currentFile: string;

  constructor(file: string) {
    this.currentFile = file;
    this.current = this.load();
  }

  /** Файл открытого проекта. */
  get file(): string {
    return this.currentFile;
  }

  /**
   * Открыть другой объект тем же хранилищем. Сначала дописываем на диск то,
   * что не успело сохраниться у прежнего: переключение проекта не должно
   * стоить человеку последних правок.
   */
  rebind(file: string): void {
    this.flush();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.setDirty(false);
    this.savedAt = null;
    this.currentFile = file;
    this.current = this.load();
  }

  get project(): Project {
    return this.current;
  }

  /**
   * Есть ли правки, ещё не записанные на диск. Окно тут короткое (сброс
   * приходит через 500 мс сам собой), но при переключении объекта человек
   * может успеть кликнуть «Открыть» прямо в этот момент — тогда честнее
   * спросить, чем молча сохранить или молча потерять правку.
   */
  get isDirty(): boolean {
    return this.dirty;
  }

  get savedAtMs(): number | null {
    return this.savedAt;
  }

  /**
   * Включить или выключить автосохранение. Таймер не сбрасывается на каждую
   * правку: при непрерывной работе он иначе не сработал бы никогда. Он
   * взводится первой правкой после сохранения и пишет всё, что накопилось.
   */
  setAutosave(enabled: boolean, seconds: number): void {
    this.autosaveMs = enabled ? Math.max(1, seconds) * 1000 : null;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.dirty && this.autosaveMs !== null) this.saveTimer = setTimeout(() => this.flush(), this.autosaveMs);
  }

  private setDirty(d: boolean): void {
    if (this.dirty === d) return;
    this.dirty = d;
    this.onDirtyChange?.(d);
  }

  /**
   * «Не сохранять»: забыть правки в памяти и вернуться к тому, что реально
   * лежит на диске. Таймер отложенной записи гасим ДО перечитывания —
   * иначе он бы через 500 мс всё равно дописал то, что просили выбросить.
   */
  discard(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.setDirty(false);
    this.current = this.load();
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
    this.setDirty(true);
    if (this.autosaveMs !== null && !this.saveTimer) {
      this.saveTimer = setTimeout(() => this.flush(), this.autosaveMs);
    }
  }

  flush(): void {
    if (!this.dirty) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.current, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    this.savedAt = Date.now();
    this.setDirty(false);
    console.log(`[project] сохранён ${path.basename(this.file)}`);
  }
}
