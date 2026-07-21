import { useEffect, useState } from 'react';
import { comboFromEvent, getCombo } from './hotkeys';
import { registerTabNavigator } from './navigate';
import { isOperatorLocked } from './operatorMode';
import { useEngine } from './useEngine';
import { KeysView, keyLabel } from './views/KeysView';
import { ConsoleView } from './views/ConsoleView';
import { TourOverlay, type TourStepDef } from './components/TourOverlay';
import { HelpView } from './views/HelpView';
import { TOUR_STORAGE_KEY } from './tour';
import { LayoutView } from './views/LayoutView';
import { OperatorScreen } from './views/OperatorScreen';
import { PatchView } from './views/PatchView';
import { ScenesView } from './views/ScenesView';
import { SequencesView } from './views/SequencesView';
import { ShowView } from './views/ShowView';
import { NetworkView } from './views/NetworkView';
import { PlaylistsView } from './views/PlaylistsView';
import { RemoteView } from './views/RemoteView';
import { ScheduleView } from './views/ScheduleView';
import { SettingsView } from './views/SettingsView';

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
  | 'keys'
  | 'settings';

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
  { id: 'settings', label: 'Настройки', full: 'Настройки — DMX-линии (вселенные) и частота обновления' },
];

/** Короткий маршрут по мотивам docs/MANUAL.md §4 — полные 8 шагов остаются в Справке. */
const TOUR_STEPS: TourStepDef[] = [
  {
    tabId: 'patch',
    title: 'Приборы',
    text: 'Начните здесь: заведите оборудование объекта — насосы, клапаны, светильники — с адресацией по DMX.',
  },
  {
    tabId: 'layout',
    title: '3D',
    text: 'Расставьте форсунки и прожекторы по реальной геометрии — дальше всё видно на экране, не только в цифрах.',
  },
  {
    tabId: 'scenes',
    title: 'Сцены',
    text: 'Соберите базовые картины: общий максимум, дежурную подсветку, кольцо. Каждую проверяйте кнопкой «Просмотр на выходе».',
  },
  {
    tabId: 'show',
    title: 'Шоу',
    text: 'Загрузите музыку и соберите номер: «⚡ Автопостановка», живая запись или ручная правка на таймлайне. Полный маршрут по всем разделам — в Справке (кнопка «?»).',
  },
];

export function App() {
  const engine = useEngine();
  const { connected, version, stats, project, playback, send, undo, redo, savedAtMs } = engine;
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (savedAtMs === null) return;
    setShowSaved(true);
    const t = window.setTimeout(() => setShowSaved(false), 2000);
    return () => window.clearTimeout(t);
  }, [savedAtMs]);
  const [tab, setTab] = useState<Tab>('console');
  // Режим оператора (§27 доработки, УХ п.8): состояние в localStorage,
  // переживает перезапуск приложения — снимается только паролем.
  const [locked, setLocked] = useState(() => isOperatorLocked());
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('fs-theme') === 'light' ? 'light' : 'dark',
  );
  const [helpOpen, setHelpOpen] = useState(false);
  // Тур при первом запуске (§27 доработки) — null = не идёт; иначе индекс
  // шага в TOUR_STEPS. Переключает вкладку вслед за собой, чтобы подсказка
  // всегда указывала на реально открытый раздел.
  const [tourStep, setTourStep] = useState<number | null>(() =>
    localStorage.getItem(TOUR_STORAGE_KEY) === '1' ? null : 0,
  );
  useEffect(() => {
    if (tourStep !== null) setTab(TOUR_STEPS[tourStep]!.tabId as Tab);
  }, [tourStep]);
  const finishTour = (): void => {
    localStorage.setItem(TOUR_STORAGE_KEY, '1');
    setTourStep(null);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('fs-theme', theme);
  }, [theme]);

  useEffect(() => {
    registerTabNavigator((t) => setTab(t as Tab));
    return () => registerTabNavigator(null);
  }, []);

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
      // Движок сам не видит клавиатурные привязки редактора — явно сообщаем
      // о срабатывании в общий журнал событий (§27 доработки, §3 п.1).
      const refName = (list: { id: string; name: string }[]): string =>
        list.find((x) => x.id === a.refId)?.name ?? a.refId ?? '?';
      const actionLabel: Record<typeof a.type, string> = {
        scene: `сцена «${refName(project.scenes)}»`,
        sequence: `секвенсор «${refName(project.sequences)}»`,
        sequenceGroup: `группа секвенсоров «${refName(project.sequenceGroups)}»`,
        show: `шоу «${refName(project.shows)}»`,
        playlist: `плейлист «${refName(project.playlists)}»`,
        stopAll: 'стоп всё',
        blackout: 'blackout',
        pauseAll: 'пауза всего',
      };
      send({ type: 'clientEvent', source: 'key', message: `${keyLabel(e.code)} → ${actionLabel[a.type]}` });
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
        case 'sequenceGroup': {
          const group = project.sequenceGroups.find((g) => g.id === a.refId);
          const anyRunning = group?.sequenceIds.some((id) => playback.running.some((r) => r.sequenceId === id));
          if (anyRunning) send({ type: 'stopSequenceGroup', groupId: a.refId! });
          else send({ type: 'startSequenceGroup', groupId: a.refId! });
          break;
        }
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
        case 'pauseAll':
          send({ type: playback.pausedAll ? 'resumeAll' : 'pauseAll' });
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, playback, send]);

  // Горячие клавиши редактора — отменить/повторить/сохранить (§27 доработки,
  // УХ п.6), комбинации переназначаются в «Настройках» (см. hotkeys.ts).
  // Отдельно от привязок «Клавиатуры» выше: те явно игнорируют ctrlKey,
  // конфликтов нет. Внутри полей ввода не перехватываем — там работает
  // штатный undo браузера.
  useEffect(() => {
    if (locked) return; // нечего отменять/сохранять на экране оператора
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.repeat) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const combo = comboFromEvent(e);
      if (combo === getCombo('undo')) {
        e.preventDefault();
        undo();
      } else if (combo === getCombo('redo')) {
        e.preventDefault();
        redo();
      } else if (combo === getCombo('save')) {
        e.preventDefault();
        send({ type: 'saveNow' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked, undo, redo, send]);

  if (locked) {
    return <OperatorScreen engine={engine} onUnlock={() => setLocked(false)} />;
  }

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
              data-tour={t.id}
              className={tab === t.id ? 'tab active' : 'tab'}
              title={t.full}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button className="help-btn" title="Справка" onClick={() => setHelpOpen(true)}>
          ?
        </button>
        <div className={connected ? 'conn conn-on' : 'conn conn-off'}>
          {connected ? 'движок подключён' : 'нет связи с движком…'}
        </div>
      </header>
      {helpOpen && <HelpView onClose={() => setHelpOpen(false)} />}
      {tourStep !== null && (
        <TourOverlay
          steps={TOUR_STEPS}
          step={tourStep}
          onSkip={finishTour}
          onNext={() => (tourStep >= TOUR_STEPS.length - 1 ? finishTour() : setTourStep(tourStep + 1))}
        />
      )}

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
      {tab === 'settings' && <SettingsView engine={engine} />}

      <footer className="statusbar">
        {showSaved && <span className="ok-text">✔ сохранено</span>}
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
            {(() => {
              const active =
                playback.activeSceneId !== null ||
                playback.running.length > 0 ||
                playback.show !== null ||
                playback.playlist !== null;
              const text = active
                ? `воспроизведение: ${playback.running.length} секв.${playback.activeSceneId !== null ? ' + сцена' : ''}${
                    playback.show !== null ? ` + шоу (${playback.show.playing ? 'играет' : 'пауза'})` : ''
                  }${playback.playlist !== null ? ` + плейлист №${playback.playlist.itemIndex + 1}` : ''}`
                : 'воспроизведение остановлено';
              // Приоритет перехода — от самого «внешнего» уровня автоматизации к
              // самому конкретному: плейлист уже включает в себя шоу и т.д.
              const target: Tab | null = playback.playlist
                ? 'playlists'
                : playback.show
                  ? 'show'
                  : playback.running.length > 0
                    ? 'sequences'
                    : playback.activeSceneId !== null
                      ? 'scenes'
                      : null;
              return target ? (
                <button
                  className="statusbar-link"
                  title="Что сейчас исполняет движок — клик переносит на вкладку с этим воспроизведением"
                  onClick={() => setTab(target)}
                >
                  {text}
                </button>
              ) : (
                <span title="«Остановлено» — движок ничего не играет, каналы держат ручные значения пульта">{text}</span>
              );
            })()}
          </>
        ) : (
          <span>ожидание статистики…</span>
        )}
      </footer>
    </div>
  );
}
