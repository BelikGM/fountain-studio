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

/**
 * Экспоненциальное скользящее среднее. prev < 0 — ещё не было сэмплов (первый
 * сэмпл сразу становится средним, без разгона от нуля). Чистая функция —
 * проверяется в смоуке отдельно от реального таймера.
 */
export function emaStep(prev: number, sample: number, alpha: number): number {
  return prev < 0 ? sample : prev + alpha * (sample - prev);
}

export class Ticker {
  private running = false;
  private n = 0;
  private startNs = 0n;
  private timer: NodeJS.Timeout | undefined;
  /**
   * avg — EMA, не «сумма/n» за всё время жизни движка: headless-эксплуатация
   * (§9, §18) держит процесс сутками, и один-единственный сбой (сон Windows,
   * зависшая антивирусная проверка, что угодно, остановившее event loop на
   * время) даёт джиттер тика в порядки больше нормы; при кумулятивном среднем
   * такой выброс отравляет «avg» на буквально годы вперёд (при миллионах уже
   * накопленных тиков разбавить его обратно нечем) — показание становится
   * бесполезным навсегда, хотя реальная работа давно в норме. EMA отражает
   * недавнее поведение и отходит от выброса за секунды. max остаётся
   * пожизненным — это осознанно другой вопрос («был ли когда-нибудь сбой»).
   */
  private static readonly EMA_ALPHA = 0.01;
  private jitterEma = -1;
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
    this.jitterEma = -1;
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
    this.jitterEma = emaStep(this.jitterEma, jitterMs, Ticker.EMA_ALPHA);
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
      avgJitterMs: this.jitterEma < 0 ? 0 : round2(this.jitterEma),
      maxJitterMs: round2(this.jitterMax),
    };
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
