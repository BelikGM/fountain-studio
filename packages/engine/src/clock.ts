/**
 * Тик-планировщик с компенсацией дрейфа.
 *
 * Цель n-го тика — фиксированный момент t0 + n*interval (не «через interval после
 * предыдущего»), поэтому ошибка не накапливается. На Windows разрешение setTimeout
 * ~15 мс, поэтому спим таймером только до (цель - spinMs), а остаток добиваем
 * циклом setImmediate — он даёт субмиллисекундную точность и не блокирует event loop.
 */
export interface TickerStats {
  ticks: number;
  intervalMs: number;
  lastJitterMs: number;
  avgJitterMs: number;
  maxJitterMs: number;
}

export class Ticker {
  private running = false;
  private n = 0;
  private startNs = 0n;
  private timer: NodeJS.Timeout | undefined;
  private jitterSum = 0;
  private jitterMax = 0;
  private jitterLast = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly spinMs: number,
    private readonly onTick: (tickIndex: number) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.n = 0;
    this.startNs = process.hrtime.bigint();
    this.jitterSum = 0;
    this.jitterMax = 0;
    this.arm();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private targetNs(): bigint {
    return this.startNs + BigInt(this.n + 1) * BigInt(Math.round(this.intervalMs * 1e6));
  }

  private arm(): void {
    const target = this.targetNs();
    const remainingMs = Number(target - process.hrtime.bigint()) / 1e6;
    const sleepMs = remainingMs - this.spinMs;
    if (sleepMs > 1) {
      this.timer = setTimeout(() => this.finish(target), Math.floor(sleepMs));
    } else {
      setImmediate(() => this.finish(target));
    }
  }

  private finish(target: bigint): void {
    if (!this.running) return;
    if (process.hrtime.bigint() < target) {
      setImmediate(() => this.finish(target));
      return;
    }
    this.n++;
    const jitterMs = Number(process.hrtime.bigint() - target) / 1e6;
    this.jitterLast = jitterMs;
    this.jitterSum += jitterMs;
    if (jitterMs > this.jitterMax) this.jitterMax = jitterMs;
    try {
      this.onTick(this.n);
    } catch (err) {
      console.error('[ticker] ошибка в обработчике тика:', err);
    }
    this.arm();
  }

  stats(): TickerStats {
    return {
      ticks: this.n,
      intervalMs: this.intervalMs,
      lastJitterMs: round2(this.jitterLast),
      avgJitterMs: this.n > 0 ? round2(this.jitterSum / this.n) : 0,
      maxJitterMs: round2(this.jitterMax),
    };
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
