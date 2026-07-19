import { useEffect, useMemo, useState } from 'react';
import { DMX_UNIVERSE_SIZE, profileMap, type TestPatternMode } from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';
import { Fader } from '../components/Fader';

/** Варианты числа адресов на странице; 512 — вся вселенная одной лентой. */
const PAGE_SIZES = [16, 32, 64, 128, 256, DMX_UNIVERSE_SIZE];

const PATTERNS: { mode: TestPatternMode; label: string }[] = [
  { mode: 'off', label: 'Выкл' },
  { mode: 'sine', label: 'Синус' },
  { mode: 'chase', label: 'Бегущая' },
  { mode: 'ramp', label: 'Пила' },
];

const PATTERN_HINT: Record<TestPatternMode, string> = {
  off: 'Выключить тест-генератор: линия возвращается к обычному управлению (сцены и ручные фейдеры продолжают работать)',
  sine: 'Плавная волна яркости по всем каналам со сдвигом фазы',
  chase: 'Бегущий огонёк: группа из 8 соседних адресов пробегает всю вселенную по кругу — проверка порядка адресов',
  ramp: 'Пила: все каналы одновременно плавно растут 0→255 и резко сбрасываются',
};

/** Консоль прямого управления: фейдеры адресов, тест-генераторы, blackout. */
export function ConsoleView({ engine }: { engine: EngineConnection }) {
  const { project, universes, stats, frames, send } = engine;
  const [universeId, setUniverseId] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState(32);
  const [page, setPage] = useState(0);

  // При первом hello выбираем первую вселенную.
  useEffect(() => {
    if (universes.length > 0 && (universeId === null || !universes.some((u) => u.id === universeId))) {
      setUniverseId(universes[0]!.id);
    }
  }, [universes, universeId]);

  // адрес-1 → «Имя прибора · Канал» из патча (для подписи фейдера).
  const owners = useMemo(() => {
    const map = new Map<number, string>();
    if (!project || universeId === null) return map;
    const profiles = profileMap(project);
    for (const d of project.devices) {
      if (d.universe !== universeId) continue;
      const profile = profiles.get(d.profileId);
      if (!profile) continue;
      for (let k = 0; k < profile.channels.length; k++) {
        const idx = d.address - 1 + k;
        if (idx >= 0 && idx < DMX_UNIVERSE_SIZE) map.set(idx, `${d.name} · ${profile.channels[k]!.name}`);
      }
    }
    return map;
  }, [project, universeId]);

  const frame = universeId !== null ? frames[universeId] : undefined;
  const pattern = stats?.pattern ?? 'off';
  const pageCount = Math.ceil(DMX_UNIVERSE_SIZE / pageSize);

  const changePageSize = (size: number): void => {
    // Сохраняем первый видимый адрес, чтобы страница «не уезжала» при смене размера.
    const startAddr = page * pageSize;
    setPageSize(size);
    setPage(Math.floor(startAddr / size));
  };

  return (
    <>
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
            По:{' '}
            <select value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))}>
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {pageCount > 1 && (
            <label>
              Адреса:{' '}
              <select value={page} onChange={(e) => setPage(Number(e.target.value))}>
                {Array.from({ length: pageCount }, (_, p) => (
                  <option key={p} value={p}>
                    {p * pageSize + 1}–{Math.min(DMX_UNIVERSE_SIZE, (p + 1) * pageSize)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="group">
          <span className="group-label">Тест-генератор:</span>
          {PATTERNS.map((p) => (
            <button
              key={p.mode}
              className={
                pattern === p.mode ? (p.mode === 'off' ? 'btn btn-off-active' : 'btn active') : 'btn'
              }
              title={PATTERN_HINT[p.mode]}
              onClick={() => send({ type: 'testPattern', mode: p.mode })}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="group">
          <button
            className="btn btn-danger"
            title="Аварийный стоп: мгновенно гасит ВСЕ каналы всех вселенных и останавливает всё воспроизведение (сцены, секвенсоры, шоу, плейлисты)"
            onClick={() => send({ type: 'blackout' })}
          >
            BLACKOUT
          </button>
        </div>
      </div>

      <main className="faders">
        {Array.from({ length: Math.min(pageSize, DMX_UNIVERSE_SIZE - page * pageSize) }, (_, i) => {
          const channel = page * pageSize + i + 1; // DMX-адрес 1..512
          return (
            <Fader
              key={`${universeId}-${channel}`}
              channel={channel}
              value={frame?.[channel - 1] ?? 0}
              owner={owners.get(channel - 1)}
              onChange={(value) =>
                universeId !== null && send({ type: 'setChannel', universe: universeId, channel, value })
              }
            />
          );
        })}
      </main>
    </>
  );
}
