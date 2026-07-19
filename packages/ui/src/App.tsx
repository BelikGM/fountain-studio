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

const TABS: { id: Tab; label: string; full: string }[] = [
  { id: 'console', label: 'Пульт', full: 'Пульт — ручное управление: фейдеры адресов и тест-сигналы DMX' },
  { id: 'patch', label: 'Приборы', full: 'Приборы — список оборудования объекта и его DMX-адреса' },
  { id: 'layout', label: '3D', full: '3D — схема фонтана и живая визуализация струй/света' },
  { id: 'scenes', label: 'Сцены', full: 'Сцены — статичные картины по приборам (заготовки для остального)' },
  { id: 'sequences', label: 'Секвенсоры', full: 'Секвенсоры — сцены друг за другом по кругу или один раз' },
  { id: 'show', label: 'Шоу', full: 'Шоу — таймлайн под музыку: одна музыкальная программа' },
  { id: 'playlists', label: 'Плейлисты', full: 'Плейлисты — несколько шоу подряд: программа целого вечера' },
  { id: 'schedule', label: 'Расписание', full: 'Расписание — автозапуск по времени и дням недели' },
  { id: 'network', label: 'Диагностика', full: 'Диагностика — исправность оборудования: живы ли ноды и приборы на линии' },
  { id: 'remote', label: 'Внешние пульты', full: 'Внешние пульты — планшет (OSC/TouchOSC) и умный дом (MQTT)' },
  { id: 'keys', label: 'Клавиатура', full: 'Клавиатура — запуск сцен/шоу нажатием клавиш компьютера' },
];

export function App() {
  const engine = useEngine();
  const { connected, version, stats, project, playback, send } = engine;
  const [tab, setTab] = useState<Tab>('console');
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('fs-theme') === 'light' ? 'light' : 'dark',
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('fs-theme', theme);
  }, [theme]);

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
          <img
            key={theme}
            src={theme === 'dark' ? '/FBEST_final.png' : '/FBEST_final2.png'}
            alt=""
            className="brand-logo"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
          Fountain Studio <span className="brand-version">{version ? `версия ${version}` : ''}</span>
          <button
            className={theme === 'dark' ? 'theme-toggle theme-dark' : 'theme-toggle theme-light'}
            title={theme === 'dark' ? 'Тёмная тема — нажмите для светлой' : 'Светлая тема — нажмите для тёмной'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <span className="theme-knob">
              {theme === 'dark' ? (
                <span className="knob-moon">
                  <img src="/moon.jpg" alt="" className="knob-moon-img" />
                </span>
              ) : (
                <span className="knob-sun">
                  <img src="/sun.webp" alt="" className="knob-sun-img" />
                </span>
              )}
            </span>
          </button>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'tab active' : 'tab'}
              title={t.full}
              onClick={() => setTab(t.id)}
            >
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
            <span title="Шаг обновления: движок шлёт новый DMX-кадр каждые 50 мс — 20 раз в секунду">
              тик {stats.intervalMs} мс
            </span>
            <span title="Средняя погрешность такта: насколько движок отклоняется от ровных 50 мс. Единицы мс — норма">
              джиттер avg {stats.avgJitterMs} мс
            </span>
            <span title="Максимальное разовое отклонение такта с момента запуска движка">
              max {stats.maxJitterMs} мс
            </span>
            <span title="Сколько DMX-кадров движок отправил на оборудование с момента запуска (все вселенные вместе)">
              кадров {stats.framesSent.toLocaleString('ru-RU')}
            </span>
            <span title="Что сейчас исполняет движок: сцена, секвенсоры, шоу или плейлист. «Остановлено» — движок ничего не играет, каналы держат ручные значения пульта">
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
