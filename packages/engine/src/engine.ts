import {
  DMX_UNIVERSE_SIZE,
  clampDmx,
  type EngineStats,
  type TestPatternMode,
  type UniverseInfo,
} from '@fountain-studio/shared';
import { Ticker } from './clock';
import type { EngineConfig, OutputConfig } from './config';
import { ArtNetOutput } from './drivers/artnet';
import { SacnOutput } from './drivers/sacn';
import type { UniverseOutput } from './drivers/output';

interface UniverseState {
  id: number;
  label: string;
  /** Ручные уровни (слой live-управления из UI). */
  manual: Uint8Array;
  /** Итоговый кадр, уходящий в выходы и визуализацию. */
  out: Uint8Array;
  outputs: UniverseOutput[];
}

/**
 * Движок реального времени. Каждый тик собирает итоговый кадр каждой вселенной
 * и отправляет его во все настроенные выходы. Кадры шлются каждый тик даже без
 * изменений — это keep-alive для нод и гарантия равномерного потока.
 */
export class Engine {
  readonly universes: UniverseState[] = [];
  private readonly ticker: Ticker;
  private pattern: TestPatternMode = 'off';
  private framesSent = 0;

  constructor(readonly config: EngineConfig) {
    for (const u of config.universes) {
      this.universes.push({
        id: u.id,
        label: u.label ?? `Вселенная ${u.id}`,
        manual: new Uint8Array(DMX_UNIVERSE_SIZE),
        out: new Uint8Array(DMX_UNIVERSE_SIZE),
        outputs: u.outputs.map(createOutput),
      });
    }
    this.ticker = new Ticker(config.timing.tickMs, config.timing.spinMs, (n) => this.tick(n));
  }

  start(): void {
    for (const u of this.universes) {
      for (const o of u.outputs) console.log(`[engine] ${u.label}: ${o.describe()}`);
    }
    this.ticker.start();
    console.log(
      `[engine] тик ${this.config.timing.tickMs} мс (${Math.round(1000 / this.config.timing.tickMs)} Гц), вселенных: ${this.universes.length}`,
    );
  }

  stop(): void {
    this.ticker.stop();
    for (const u of this.universes) for (const o of u.outputs) o.close();
  }

  private tick(n: number): void {
    const tSec = (n * this.config.timing.tickMs) / 1000;
    for (let i = 0; i < this.universes.length; i++) {
      const u = this.universes[i]!;
      if (this.pattern === 'off') {
        u.out.set(u.manual);
      } else {
        fillTestPattern(this.pattern, tSec, i, u.out);
      }
      for (const o of u.outputs) {
        o.send(u.out);
        this.framesSent++;
      }
    }
  }

  setChannel(universeId: number, channel: number, value: number): void {
    const u = this.universes.find((x) => x.id === universeId);
    if (!u || channel < 1 || channel > DMX_UNIVERSE_SIZE) return;
    u.manual[channel - 1] = clampDmx(value);
  }

  setChannels(universeId: number, start: number, values: number[]): void {
    const u = this.universes.find((x) => x.id === universeId);
    if (!u || start < 1) return;
    for (let i = 0; i < values.length && start - 1 + i < DMX_UNIVERSE_SIZE; i++) {
      u.manual[start - 1 + i] = clampDmx(values[i] ?? 0);
    }
  }

  blackout(): void {
    this.pattern = 'off';
    for (const u of this.universes) u.manual.fill(0);
  }

  setTestPattern(mode: TestPatternMode): void {
    this.pattern = mode;
  }

  universeInfos(): UniverseInfo[] {
    return this.universes.map((u) => ({
      id: u.id,
      label: u.label,
      outputs: u.outputs.map((o) => o.describe()),
    }));
  }

  stats(): EngineStats {
    return {
      ...this.ticker.stats(),
      framesSent: this.framesSent,
      pattern: this.pattern,
    };
  }
}

function createOutput(cfg: OutputConfig): UniverseOutput {
  switch (cfg.type) {
    case 'artnet': {
      if (!cfg.host) throw new Error('artnet: не указан host (IP ноды или broadcast-адрес)');
      return new ArtNetOutput({
        host: cfg.host,
        port: cfg.port,
        universe: cfg.universe,
        broadcast: cfg.broadcast,
      });
    }
    case 'sacn':
      return new SacnOutput({
        universe: cfg.universe,
        priority: cfg.priority,
        host: cfg.host,
        port: cfg.port,
      });
    default:
      throw new Error(`Неизвестный тип выхода: ${(cfg as { type: string }).type}`);
  }
}

/**
 * Тестовые генераторы: меняют ВСЕ каналы каждый тик — проверка пропускной
 * способности и наглядная «жизнь» на приборах при пусконаладке.
 */
function fillTestPattern(mode: TestPatternMode, tSec: number, universeIndex: number, out: Uint8Array): void {
  switch (mode) {
    case 'sine': {
      const base = tSec * 2 * Math.PI * 0.2 + universeIndex * 1.3;
      for (let ch = 0; ch < out.length; ch++) {
        out[ch] = Math.round((Math.sin(base + ch * 0.06) + 1) * 127.5);
      }
      break;
    }
    case 'chase': {
      out.fill(0);
      const pos = Math.floor(tSec * 40) % out.length;
      for (let w = 0; w < 8; w++) out[(pos + w) % out.length] = 255 - w * 30;
      break;
    }
    case 'ramp': {
      const v = Math.round(tSec * 100) % 256;
      out.fill(v);
      break;
    }
    case 'off':
      break;
  }
}
