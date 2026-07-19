import { useEffect, useState } from 'react';
import { useEngine } from './useEngine';
import { KeysView } from './views/KeysView';
import { ConsoleView } from './views/ConsoleView';
import { LayoutView } from './views/LayoutView';
import { PatchView } from './views/PatchView';
import { ScenesView } from './views/ScenesView';
import { SequencesView } from './views/SequencesView';
import { ShowView } from './views/ShowView';
import { NetworkView } from './views/NetworkView';
import { PlaylistsView } from './views/PlaylistsView';
import { RemoteView } from './views/RemoteView';
import { ScheduleView } from './views/ScheduleView';

type Tab =
  | 'console'
  | 'patch'
  | 'layout'
  | 'scenes'
  | 'sequences'
  | 'show'
  | 'playlists'
  | 'schedule'
  | 'network'
  | 'remote'
  | 'keys';

const TABS: { id: Tab; label: string }[] = [
  { id: 'console', label: 'Консоль' },
  { id: 'patch', label: 'Патч' },
  { id: 'layout', label: '3D' },
  { id: 'scenes', label: 'Сцены' },
  { id: 'sequences', label: 'Секвенсоры' },
  { id: 'show', label: 'Шоу' },
  { id: 'playlists', label: 'Плейлисты' },
  { id: 'schedule', label: 'Расписание' },
  { id: 'network', label: 'Сеть' },
  { id: 'remote', label: 'Удалённо' },
  { id: 'keys', label: 'Клавиши' },
];

export function App() {
  const engine = useEngine();
  const { connected, version, stats, project, playback, send } = engine;
  const [tab, setTab] = useState<Tab>('console');

  // Глобальные клавиатурные привязки (вкладка «Клавиши»): работают из любой
  // вкладки, когда фокус не в поле ввода и клавишу не перехватил экран
  // (например, пробел на таймлайне шоу).
  useEffect(() => {
    if (!project || project.keys.length === 0) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const binding = project.keys.find((k) => k.code === e.code);
      if (!binding) return;
      e.preventDefault();
      const a = binding.action;
      switch (a.type) {
        case 'scene':
          send({ type: 'setScene', sceneId: playback.activeSceneId === a.refId ? null : a.refId! });
          break;
        case 'sequence':
          if (playback.running.some((r) => r.sequenceId === a.refId)) {
            send({ type: 'stopSequence', sequenceId: a.refId! });
          } else {
            send({ type: 'startSequence', sequenceId: a.refId! });
          }
          break;
        case 'show':
          if (playback.show?.showId === a.refId) send({ type: 'stopShow' });
          else send({ type: 'playShow', showId: a.refId!, positionMs: 0 });
          break;
        case 'playlist':
          if (playback.playlist?.playlistId === a.refId) send({ type: 'stopPlaylist' });
          else send({ type: 'playPlaylist', playlistId: a.refId! });
          break;
        case 'stopAll':
          send({ type: 'stopAllPlayback' });
          break;
        case 'blackout':
          send({ type: 'blackout' });
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, playback, send]);

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
      {tab === 'layout' && <LayoutView engine={engine} />}
      {tab === 'scenes' && <ScenesView engine={engine} />}
      {tab === 'sequences' && <SequencesView engine={engine} />}
      {tab === 'show' && <ShowView engine={engine} />}
      {tab === 'playlists' && <PlaylistsView engine={engine} />}
      {tab === 'schedule' && <ScheduleView engine={engine} />}
      {tab === 'network' && <NetworkView engine={engine} />}
      {tab === 'remote' && <RemoteView engine={engine} />}
      {tab === 'keys' && <KeysView engine={engine} />}

      <footer className="statusbar">
        {stats ? (
          <>
            <span>тик {stats.intervalMs} мс</span>
            <span>джиттер avg {stats.avgJitterMs} мс</span>
            <span>max {stats.maxJitterMs} мс</span>
            <span>кадров {stats.framesSent.toLocaleString('ru-RU')}</span>
            <span>
              {playback.activeSceneId !== null ||
              playback.running.length > 0 ||
              playback.show !== null ||
              playback.playlist !== null
                ? `воспроизведение: ${playback.running.length} секв.${playback.activeSceneId !== null ? ' + сцена' : ''}${
                    playback.show !== null ? ` + шоу (${playback.show.playing ? 'играет' : 'пауза'})` : ''
                  }${playback.playlist !== null ? ` + плейлист №${playback.playlist.itemIndex + 1}` : ''}`
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
