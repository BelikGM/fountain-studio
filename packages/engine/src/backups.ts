import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BackupInfo } from '@fountain-studio/shared';

/**
 * Сколько снимков хранить — по ВОЗРАСТУ, а не просто «последние N».
 *
 * Плоский счётчик — ловушка: человек пять минут поправляет шоу, снимки идут
 * один за другим, и двадцать почти одинаковых состояний вытесняют ту самую
 * рабочую версию месячной давности, ради которой всё и затевалось.
 *
 * Поэтому прореживаем как принято в резервном копировании («дед — отец — сын»):
 * за последний час — по одному на каждые DENSE_MIN минут, за месяц — по одному
 * на день, дальше — по одному на месяц. История получается глубокой, а места
 * занимает столько же.
 */
const DENSE_MIN = 10;
const DENSE_HOURS = 6;
const DAILY_DAYS = 60;
/** Имя защищённого снимка — он не прореживается никогда. */
const REFERENCE_FILE = 'reference.json';

/**
 * Периодические именованные снимки fountain.project.json (§27 доработки, УХ п.5),
 * в папке backups/ рядом с проектом — отдельно от непрерывного живого
 * автосохранения в project.ts. Живое сохранение защищает от потери процесса,
 * бэкапы — от «сам всё сломал в редакторе»: снимок можно вернуть вручную.
 * Хранит последние MAX_BACKUPS штук, старые удаляются автоматически.
 */
export class BackupStore {
  private timer: NodeJS.Timeout | undefined;
  /** Отпечаток последнего снятого состояния — по нему видно, что менять нечего. */
  private lastHash = '';
  private enabled: boolean;
  private intervalMin: number;
  private dir: string;

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

  /**
   * Открыли другой объект: снимки этого объекта лежат в его папке, поэтому
   * меняем каталог и настройку и заводим расписание заново. Отпечаток
   * сбрасываем — иначе первый снимок нового объекта посчитался бы «таким же».
   */
  rebind(projectFile: string, initial: { enabled: boolean; intervalMin: number }): void {
    this.dir = path.join(path.dirname(projectFile), 'backups');
    this.lastHash = '';
    this.setConfig(initial.enabled, initial.intervalMin);
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

  /**
   * Снимок сейчас же — по таймеру или по запросу из UI.
   *
   * Ничего не изменилось с прошлого раза — снимок НЕ делается. Иначе за
   * простаивающие выходные набегала сотня одинаковых файлов, и они вытесняли
   * действительно разные состояния.
   *
   * @param force снять даже без изменений (ручная кнопка «Снимок сейчас»).
   */
  snapshot(force = false): void {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      const json = this.getProjectJson();
      const hash = crypto.createHash('sha1').update(json).digest('hex');
      if (!force && hash === this.lastHash) return;
      this.lastHash = hash;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(this.dir, `${stamp}.json`), json, 'utf8');
      this.prune();
      console.log(`[backups] снимок сохранён: ${stamp}.json`);
    } catch (err) {
      console.error('[backups] не удалось сохранить снимок:', err);
    }
  }

  /**
   * Эталон — снимок, который не трогает ни прореживание, ни время.
   *
   * К нему возвращаются, когда «кто-то пришёл и всё поменял»: это заведомо
   * рабочее состояние объекта, зафиксированное человеком осознанно. Перезаписать
   * его можно только этой командой, автоматика в него не пишет никогда.
   */
  setReference(): void {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, REFERENCE_FILE), this.getProjectJson(), 'utf8');
    console.log('[backups] эталон обновлён');
  }

  hasReference(): boolean {
    return fs.existsSync(path.join(this.dir, REFERENCE_FILE));
  }

  /**
   * Прореживание по возрасту: густо — недавнее, редко — старое.
   * Эталон в разбор не попадает вовсе.
   */
  private prune(): void {
    const now = Date.now();
    const all = this.list().filter((b) => b.file !== REFERENCE_FILE);
    /** Ключ «корзины», в которую попадает снимок по своему возрасту. */
    const bucket = (atMs: number): string => {
      const ageMs = now - atMs;
      const d = new Date(atMs);
      if (ageMs <= DENSE_HOURS * 3600_000) {
        return `m${Math.floor(atMs / (DENSE_MIN * 60_000))}`;
      }
      if (ageMs <= DAILY_DAYS * 86400_000) {
        return `d${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      }
      return `M${d.getFullYear()}-${d.getMonth()}`;
    };
    // Список уже отсортирован от свежих к старым — в каждой корзине оставляем
    // первый встреченный, то есть самый свежий снимок этого периода.
    const keep = new Set<string>();
    const seen = new Set<string>();
    for (const b of all) {
      const k = bucket(b.atMs);
      if (seen.has(k)) continue;
      seen.add(k);
      keep.add(b.file);
    }
    for (const b of all) {
      if (keep.has(b.file)) continue;
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
        return { file: f, atMs: st.mtimeMs, sizeBytes: st.size, reference: f === REFERENCE_FILE };
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
