/**
 * Монитор Art-Net: слушает порт 6454, считает пакеты ArtDMX по вселенным
 * и измеряет равномерность интервалов между кадрами (мин/сред/макс/σ).
 *
 * Запуск: npm run monitor [-- --seconds 10]
 * Полезен и в поле: проверить, что до ноды доходит ровный поток.
 */
import dgram from 'node:dgram';

const secondsIdx = process.argv.indexOf('--seconds');
const positional = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const seconds = secondsIdx >= 0 ? Number(process.argv[secondsIdx + 1]) : positional ? Number(positional) : 0;

interface UniStat {
  count: number;
  lastNs: bigint;
  min: number;
  max: number;
  sum: number;
  sumSq: number;
  intervals: number;
}

const stats = new Map<number, UniStat>();

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

socket.on('message', (msg) => {
  if (msg.length < 18 || msg.toString('latin1', 0, 8) !== 'Art-Net\0') return;
  if (msg.readUInt16LE(8) !== 0x5000) return; // только ArtDMX
  const universe = msg.readUInt8(14) | (msg.readUInt8(15) << 8);
  const now = process.hrtime.bigint();
  let s = stats.get(universe);
  if (!s) {
    s = { count: 0, lastNs: 0n, min: Infinity, max: 0, sum: 0, sumSq: 0, intervals: 0 };
    stats.set(universe, s);
  }
  s.count++;
  if (s.lastNs !== 0n) {
    const dtMs = Number(now - s.lastNs) / 1e6;
    s.intervals++;
    s.sum += dtMs;
    s.sumSq += dtMs * dtMs;
    if (dtMs < s.min) s.min = dtMs;
    if (dtMs > s.max) s.max = dtMs;
  }
  s.lastNs = now;
});

socket.bind(6454, () => {
  console.log(`[monitor] слушаю Art-Net на 0.0.0.0:6454${seconds ? `, ${seconds} сек` : ' (Ctrl+C — отчёт)'}`);
});

function report(): void {
  console.log('\n===== ОТЧЁТ ПО ВСЕЛЕННЫМ =====');
  if (stats.size === 0) {
    console.log('Пакеты ArtDMX не получены.');
  }
  for (const [universe, s] of [...stats.entries()].sort((a, b) => a[0] - b[0])) {
    if (s.intervals === 0) {
      console.log(`universe ${universe}: пакетов ${s.count} (мало данных для интервалов)`);
      continue;
    }
    const avg = s.sum / s.intervals;
    const variance = s.sumSq / s.intervals - avg * avg;
    const std = Math.sqrt(Math.max(0, variance));
    console.log(
      `universe ${universe}: пакетов ${s.count}, интервал avg ${avg.toFixed(2)} мс ` +
        `(min ${s.min.toFixed(2)} / max ${s.max.toFixed(2)} / σ ${std.toFixed(2)}), ~${(1000 / avg).toFixed(1)} Гц`,
    );
  }
  console.log('==============================');
}

if (seconds > 0) {
  setTimeout(() => {
    report();
    socket.close();
    process.exit(0);
  }, seconds * 1000);
}

process.on('SIGINT', () => {
  report();
  socket.close();
  process.exit(0);
});
