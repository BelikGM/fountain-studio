import { useEffect, useState } from 'react';
import { DMX_UNIVERSE_SIZE, type TestPatternMode } from '@fountain-studio/shared';
import { useEngine } from './useEngine';
import { Fader } from './components/Fader';

const PAGE_SIZE = 32;
const PAGE_COUNT = DMX_UNIVERSE_SIZE / PAGE_SIZE; // 16 страниц по 32 адреса

const PATTERNS: { mode: TestPatternMode; label: string }[] = [
  { mode: 'off', label: 'Выкл' },
  { mode: 'sine', label: 'Синус' },
  { mode: 'chase', label: 'Бегущая' },
  { mode: 'ramp', label: 'Пила' },
];

export function App() {
  const { connected, version, tickMs, universes, stats, frames, send } = useEngine();
  const [universeId, setUniverseId] = useState<number | null>(null);
  const [page, setPage] = useState(0);

  // При первом hello выбираем первую вселенную.
  useEffect(() => {
    if (universes.length > 0 && (universeId === null || !universes.some((u) => u.id === universeId))) {
      setUniverseId(universes[0]!.id);
    }
  }, [universes, universeId]);

  const frame = universeId !== null ? frames[universeId] : undefined;
  const activeUniverse = universes.find((u) => u.id === universeId);
  const pattern = stats?.pattern ?? 'off';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Fountain Studio <span className="brand-version">{version ? `движок ${version}` : ''}</span>
        </div>
        <div className={connected ? 'conn conn-on' : 'conn conn-off'}>
          {connected ? 'движок подключён' : 'нет связи с движком…'}
        </div>
      </header>

      <div className="toolbar">
        <div className="group">
          {universes.map((u) => (
            <button
              key={u.id}
              className={u.id === universeId ? 'btn active' : 'btn'}
              title={u.outputs.join('\n')}
              onClick={() => setUniverseId(u.id)}
            >
              {u.label}
            </button>
          ))}
        </div>

        <div className="group">
          <label>
            Адреса:{' '}
            <select value={page} onChange={(e) => setPage(Number(e.target.value))}>
              {Array.from({ length: PAGE_COUNT }, (_, p) => (
                <option key={p} value={p}>
                  {p * PAGE_SIZE + 1}–{(p + 1) * PAGE_SIZE}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="group">
          <span className="group-label">Тест-генератор:</span>
          {PATTERNS.map((p) => (
            <button
              key={p.mode}
              className={pattern === p.mode ? 'btn active' : 'btn'}
              onClick={() => send({ type: 'testPattern', mode: p.mode })}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="group">
          <button className="btn btn-danger" onClick={() => send({ type: 'blackout' })}>
            BLACKOUT
          </button>
        </div>
      </div>

      <main className="faders">
        {Array.from({ length: PAGE_SIZE }, (_, i) => {
          const channel = page * PAGE_SIZE + i + 1; // DMX-адрес 1..512
          return (
            <Fader
              key={`${universeId}-${channel}`}
              channel={channel}
              value={frame?.[channel - 1] ?? 0}
              onChange={(value) =>
                universeId !== null && send({ type: 'setChannel', universe: universeId, channel, value })
              }
            />
          );
        })}
      </main>

      <footer className="statusbar">
        {stats ? (
          <>
            <span>тик {stats.intervalMs} мс</span>
            <span>джиттер avg {stats.avgJitterMs} мс</span>
            <span>max {stats.maxJitterMs} мс</span>
            <span>кадров {stats.framesSent.toLocaleString('ru-RU')}</span>
            <span>{activeUniverse?.outputs.join(' · ') ?? ''}</span>
          </>
        ) : (
          <span>ожидание статистики…</span>
        )}
      </footer>
    </div>
  );
}
