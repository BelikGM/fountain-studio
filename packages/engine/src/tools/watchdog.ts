import { spawn } from 'node:child_process';

/**
 * Сторож движка: запускает движок и перезапускает его при любом падении
 * (с паузой 5 с, чтобы не молотить в цикле при постоянной ошибке).
 * Запуск: npm run watchdog (из корня — npm run engine:watchdog).
 * Для автозапуска при входе в Windows: tools/install-autostart.ps1.
 */
const RESTART_DELAY_MS = 5000;
let stopping = false;

function start(): void {
  console.log('[watchdog] запуск движка…');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[watchdog] движок завершился (код ${code ?? signal}); перезапуск через ${RESTART_DELAY_MS / 1000} с`);
    setTimeout(start, RESTART_DELAY_MS);
  });
  const stop = (): void => {
    stopping = true;
    child.kill('SIGINT');
    setTimeout(() => process.exit(0), 1000);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

start();
