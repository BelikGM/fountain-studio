import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Автозапуск движка при входе в Windows (§27 доработки, §3 п.3) — та же задача
 * планировщика, что и раньше ставилась вручную через tools/install-autostart.ps1
 * (`npm run engine:watchdog` при ONLOGON, сторож перезапускает движок при
 * падении), теперь доступна кнопкой на вкладке «Настройки» вместо запуска
 * PowerShell-скрипта руками. Механизм намеренно тот же самый — просто обёрнут.
 *
 * Для собранного Electron-приложения (npm run app:dist) это не единственный
 * путь: там уместнее app.setLoginItemSettings() в main.cjs (Electron сам
 * прописывает автозапуск EXE через свой установщик) — эта обёртка нацелена
 * на текущий сценарий «движок из репозитория» (разработка/техник на объекте
 * без готового инсталлятора).
 */
const TASK_NAME = 'FountainStudioEngine';

/**
 * Установленное приложение (npm run app:dist). main.cjs передаёт движку
 * готовую команду запуска самого себя «в фоне» (--hidden). До 23.09.2026 в
 * установленной программе автозапуска не было вовсе: кнопка говорила «только
 * из репозитория», и после перезагрузки компьютера объекта фонтан молчал.
 *
 * Пишем в «Автозагрузку» пользователя (реестр Run), а не в планировщик: прав
 * администратора не нужно, и Windows сама покажет это в «Диспетчер задач →
 * Автозагрузка», где человек привык такое искать.
 */
const APP_CMD = process.env.FOUNTAIN_APP_CMD ?? '';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
/** Имя записи; переменная — только для проверки, чтобы не трогать настоящую. */
const RUN_NAME = process.env.FOUNTAIN_AUTOSTART_NAME || 'FountainStudio';

/** Установленная программа (а не запуск из исходников). */
export function isPackagedApp(): boolean {
  return packagedApp();
}

function packagedApp(): boolean {
  return process.platform === 'win32' && APP_CMD !== '';
}

/**
 * Папка этого файла — только когда движок запущен из исходников (tsx, ESM).
 *
 * В собранном engine.cjs (CommonJS) import.meta пустой, и прежнее
 * `fileURLToPath(import.meta.url)` падало ПРИ ЗАГРУЗКЕ модуля: установленная
 * программа с 21.07.2026 не могла поднять движок вовсе. Поймано 23.09.2026
 * проверкой собранного приложения; теперь это проверяется всегда
 * (npm run app-test).
 */
function moduleDir(): string | null {
  try {
    const url = (import.meta as { url?: string } | undefined)?.url;
    return url ? path.dirname(fileURLToPath(url)) : null;
  } catch {
    return null;
  }
}
const MODULE_DIR = moduleDir();
/** src/autostart.ts → packages/engine/src → …/packages/engine → …/packages → repo root. */
const REPO_ROOT = MODULE_DIR ? path.resolve(MODULE_DIR, '..', '..', '..') : '';

/**
 * REPO_ROOT — верный путь только пока движок запущен из исходников (tsx).
 * Собранный для Electron engine.cjs — один сплющенный esbuild-бандл (см.
 * packages/app/package.json → build:engine): там __dirname указывает внутрь
 * распакованного приложения, а не на репозиторий, и «npm run engine:watchdog»
 * там просто не сработает (нет package.json с workspaces). Проверяем это
 * явно — иначе кнопка создаст задачу планировщика с нерабочей командой.
 */
function repoRootValid(): boolean {
  if (!REPO_ROOT) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { workspaces?: unknown };
    return Array.isArray(pkg.workspaces);
  } catch {
    return false;
  }
}

export function isAutostartSupported(): boolean {
  return packagedApp() || (process.platform === 'win32' && repoRootValid());
}

/** Причина недоступности — для показа в UI (null, если платформа вообще не Windows: там и так очевидно). */
export function unsupportedReason(): string | null {
  if (process.platform !== 'win32') return null;
  if (packagedApp()) return null;
  if (!repoRootValid()) return 'Доступно только при запуске движка из репозитория (не из собранного приложения)';
  return null;
}

export function isAutostartEnabled(): boolean {
  if (!isAutostartSupported()) return false;
  if (packagedApp()) {
    try {
      execFileSync('reg', ['query', RUN_KEY, '/v', RUN_NAME], { stdio: 'ignore' });
      return true;
    } catch {
      return false; // записи нет — reg возвращает ненулевой код
    }
  }
  try {
    execFileSync('schtasks', ['/Query', '/TN', TASK_NAME], { stdio: 'ignore' });
    return true;
  } catch {
    return false; // задачи нет — schtasks возвращает ненулевой код
  }
}

export function setAutostart(enabled: boolean): { ok: boolean; error?: string } {
  if (!isAutostartSupported()) {
    return { ok: false, error: unsupportedReason() ?? 'Автозапуск через планировщик поддержан только на Windows' };
  }
  if (packagedApp()) {
    try {
      if (enabled) execFileSync('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', APP_CMD, '/f'], { stdio: 'ignore' });
      else if (isAutostartEnabled()) execFileSync('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f'], { stdio: 'ignore' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  try {
    if (enabled) {
      const tr = `cmd /c cd /d "${REPO_ROOT}" && npm run engine:watchdog`;
      execFileSync('schtasks', ['/Create', '/TN', TASK_NAME, '/TR', tr, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F'], {
        stdio: 'ignore',
      });
    } else {
      execFileSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { stdio: 'ignore' });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
