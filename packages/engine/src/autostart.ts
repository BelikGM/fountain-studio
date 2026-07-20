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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** src/autostart.ts → packages/engine/src → …/packages/engine → …/packages → repo root. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * REPO_ROOT — верный путь только пока движок запущен из исходников (tsx).
 * Собранный для Electron engine.cjs — один сплющенный esbuild-бандл (см.
 * packages/app/package.json → build:engine): там __dirname указывает внутрь
 * распакованного приложения, а не на репозиторий, и «npm run engine:watchdog»
 * там просто не сработает (нет package.json с workspaces). Проверяем это
 * явно — иначе кнопка создаст задачу планировщика с нерабочей командой.
 */
function repoRootValid(): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { workspaces?: unknown };
    return Array.isArray(pkg.workspaces);
  } catch {
    return false;
  }
}

export function isAutostartSupported(): boolean {
  return process.platform === 'win32' && repoRootValid();
}

/** Причина недоступности — для показа в UI (null, если платформа вообще не Windows: там и так очевидно). */
export function unsupportedReason(): string | null {
  if (process.platform !== 'win32') return null;
  if (!repoRootValid()) return 'Доступно только при запуске движка из репозитория (не из собранного приложения)';
  return null;
}

export function isAutostartEnabled(): boolean {
  if (!isAutostartSupported()) return false;
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
