import { useState } from 'react';
import { useEngine } from './useEngine';
import { ConsoleView } from './views/ConsoleView';
import { PatchView } from './views/PatchView';
import { ScenesView } from './views/ScenesView';
import { SequencesView } from './views/SequencesView';
import { ShowView } from './views/ShowView';

type Tab = 'console' | 'patch' | 'scenes' | 'sequences' | 'show';

const TABS: { id: Tab; label: string }[] = [
  { id: 'console', label: 'Консоль' },
  { id: 'patch', label: 'Патч' },
  { id: 'scenes', label: 'Сцены' },
  { id: 'sequences', label: 'Секвенсоры' },
  { id: 'show', label: 'Шоу' },
];

export function App() {
  const engine = useEngine();
  const { connected, version, stats, project, playback } = engine;
  const [tab, setTab] = useState<Tab>('console');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Fountain Studio <span className="brand-version">{version ? `движок ${version}` : ''}</span>
          {project ? <span className="brand-version">· {project.name}</span> : null}
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className={connected ? 'conn conn-on' : 'conn conn-off'}>
          {connected ? 'движок подключён' : 'нет связи с движком…'}
        </div>
      </header>

      {tab === 'console' && <ConsoleView engine={engine} />}
      {tab === 'patch' && <PatchView engine={engine} />}
      {tab === 'scenes' && <ScenesView engine={engine} />}
      {tab === 'sequences' && <SequencesView engine={engine} />}
      {tab === 'show' && <ShowView engine={engine} />}

      <footer className="statusbar">
        {stats ? (
          <>
            <span>тик {stats.intervalMs} мс</span>
            <span>джиттер avg {stats.avgJitterMs} мс</span>
            <span>max {stats.maxJitterMs} мс</span>
            <span>кадров {stats.framesSent.toLocaleString('ru-RU')}</span>
            <span>
              {playback.activeSceneId !== null || playback.running.length > 0 || playback.show !== null
                ? `воспроизведение: ${playback.running.length} секв.${playback.activeSceneId !== null ? ' + сцена' : ''}${
                    playback.show !== null ? ` + шоу (${playback.show.playing ? 'играет' : 'пауза'})` : ''
                  }`
                : 'воспроизведение остановлено'}
            </span>
          </>
        ) : (
          <span>ожидание статистики…</span>
        )}
      </footer>
    </div>
  );
}
