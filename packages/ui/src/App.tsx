import { useEffect, useState } from 'react';
import { EXPIRY_WARNING_DAYS, daysUntilExpiry } from '@fountain-studio/shared';
import { comboFromEvent, getCombo } from './hotkeys';
import { registerTabNavigator } from './navigate';
import { isOperatorLocked } from './operatorMode';
import { useEngine } from './useEngine';
import { KeysView, keyLabel } from './views/KeysView';
import { ConsoleView } from './views/ConsoleView';
import { ConfirmHost } from './components/ConfirmDialog';
import { HintHost } from './hints';
import { TourOverlay, type TourStepDef } from './components/TourOverlay';
import { HelpView } from './views/HelpView';
import { LicenseView } from './views/LicenseView';
import { TOUR_STORAGE_KEY } from './tour';
import { LayoutView } from './views/LayoutView';
import { OperatorScreen } from './views/OperatorScreen';
import { PatchView } from './views/PatchView';
import { ScenesView } from './views/ScenesView';
import { SequencesView } from './views/SequencesView';
import { ShowView } from './views/ShowView';
import { StreamView } from './views/StreamView';
import { NetworkView } from './views/NetworkView';
import { PlaylistsView } from './views/PlaylistsView';
import { RemoteView } from './views/RemoteView';
import { ScheduleView } from './views/ScheduleView';
import { ProjectsView } from './views/ProjectsView';
import { SettingsView } from './views/SettingsView';
import { WelcomeView } from './views/WelcomeView';
import { lastManual, subscribeManual } from './manualActivity';

type Tab =
  | 'console'
  | 'patch'
  | 'layout'
  | 'scenes'
  | 'sequences'
  | 'show'
  | 'playlists'
  | 'schedule'
  | 'stream'
  | 'network'
  | 'remote'
  | 'keys'
  | 'settings';

/**
 * Тариф Pro (§27 доработки, «Продукт», уровни — 18.09.2026): воспроизведение
 * и текущая эксплуатация уже настроенного фонтана — шоу, плейлисты,
 * расписание. Заведение оборудования, 3D-схема, сцены/секвенсоры и
 * диагностика — уже Max. Сюда же падает истёкшая/отозванная max-лицензия
 * (см. AccessLevel в shared/license.ts) — фонтан не должен резко остаться
 * совсем без управления из-за забытого продления.
 */
const PRO_TABS: Tab[] = ['show', 'playlists', 'schedule'];

const TABS: { id: Tab; label: string; full: string }[] = [
  {
    id: 'console',
    label: 'Отладка',
    full: 'Отладка — ручное управление на пусконаладке и тестах: фейдеры адресов и тест-сигналы DMX',
  },
  // id остаётся 'patch' — он внутренний (data-tour, сохранённая вкладка,
  // ссылки в коде); меняется только то, что видит пользователь.
  {
    id: 'patch',
    label: 'Оборудование',
    full: 'Оборудование — из чего состоит фонтан: насосы, клапаны, светильники и их DMX-адреса',
  },
  { id: 'layout', label: '3D', full: '3D — схема фонтана и живая визуализация струй/света' },
  { id: 'scenes', label: 'Сцены', full: 'Сцены — статичные картины по приборам (заготовки для остального)' },
  { id: 'sequences', label: 'Секвенсоры', full: 'Секвенсоры — сцены друг за другом по кругу или один раз' },
  { id: 'show', label: 'Шоу', full: 'Шоу — таймлайн под музыку: одна музыкальная программа' },
  { id: 'playlists', label: 'Плейлисты', full: 'Плейлисты — несколько шоу подряд: программа целого вечера' },
  { id: 'schedule', label: 'Расписание', full: 'Расписание — автозапуск по времени и дням недели' },
  {
    id: 'stream',
    label: 'Поток',
    full: 'Поток — что уходит в линию и что приходит: DMX по участкам пути и обмен RDM в обе стороны',
  },
  { id: 'network', label: 'Диагностика', full: 'Диагностика — исправность оборудования: живы ли ноды и приборы на линии' },
  { id: 'remote', label: 'Внешние пульты', full: 'Внешние пульты — планшет (OSC/TouchOSC) и умный дом (MQTT)' },
  { id: 'keys', label: 'Клавиатура', full: 'Клавиатура — запуск сцен/шоу нажатием клавиш компьютера' },
  { id: 'settings', label: 'Настройки', full: 'Настройки — DMX-линии (вселенные) и частота обновления' },
];

/**
 * Открытая вкладка переживает перезагрузку страницы.
 *
 * Раньше она была обычным состоянием и после F5 всегда сбрасывалась на Отладку:
 * настраиваешь 3D, обновляешь страницу — и снова ищи, где был. Хранится на этом
 * компьютере, в проект не попадает: это не свойство фонтана, а то, чем человек
 * сейчас занят.
 */
const TAB_STORAGE_KEY = 'fs-tab';

function loadTab(): Tab {
  try {
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    // Сверяем со списком: в сохранённом значении может лежать вкладка из старой
    // версии, которой больше нет.
    if (saved && TABS.some((t) => t.id === saved)) return saved as Tab;
  } catch {
    // Приватный режим браузера — просто начинаем с Отладки.
  }
  return 'console';
}

/** Короткий маршрут по мотивам docs/MANUAL.md §4 — полные 8 шагов остаются в Справке. */
const TOUR_STEPS: TourStepDef[] = [
  {
    tabId: 'console',
    // Нулевой шаг — не часть маршрута постройки, а ответ на вопрос «что я
    // сейчас вижу»: приложение открывается именно на Отладке, и раньше тур
    // молча уводил с него на «Оборудование», ничего про него не сказав.
    title: 'Отладка',
    text: 'Вкладка, на которой открывается программа: ручное управление линией — фейдеры по адресам, тест-сигналы и аварийный СТОП. Нужна на пусконаладке; чтобы собрать шоу, идите дальше.',
  },
  {
    tabId: 'patch',
    title: 'Оборудование',
    text: 'Начните здесь: заведите состав объекта — насосы, клапаны, светильники — с адресацией по DMX.',
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
  const { connected, version, stats, project, playback, send, undo, redo, savedAtMs, licenseStatus, openProject, pendingProjectSwitch } = engine;
  /*
   * Три уровня доступа (см. AccessLevel в shared/license.ts):
   *  · none — лицензии не было никогда: экран приветствия вместо вкладок;
   *  · pro  — воспроизведение и расписание (в т.ч. просроченная/отозванная
   *    max-лицензия падает сюда же, а не сразу до none — фонтан не должен
   *    резко остаться совсем без управления из-за забытого продления);
   *  · max  — полный доступ.
   * Пока движок не прислал статус (null) — не режем вкладки, чтобы окно не
   * мигало пустым экраном на каждом подключении.
   */
  const access = licenseStatus?.access ?? 'max';
  const unlicensed = access !== 'max';
  /*
   * Сколько осталось до конца подписки. Предупреждаем заранее (порог —
   * EXPIRY_WARNING_DAYS), чтобы продление не сваливалось человеку как
   * неожиданность в день, когда фонтан уже должен работать: списаться и
   * оплатить нужно время.
   */
  const daysLeft = licenseStatus?.licensed ? daysUntilExpiry(licenseStatus.expiresAt) : null;
  const inGrace = licenseStatus?.grace === true;
  const expiringSoon = inGrace || (daysLeft !== null && daysLeft <= EXPIRY_WARNING_DAYS);
  const [showSaved, setShowSaved] = useState(false);
  const [licenseOpen, setLicenseOpen] = useState(false);
  /**
   * Экран выбора объекта. Показывается сам, когда проект не открыт (первый
   * запуск, объект закрыли), и по кнопке в шапке — чтобы переключиться на
   * другой фонтан, не перезапуская программу.
   */
  const [projectsOpen, setProjectsOpen] = useState(false);
  const noProject = engine.projects !== null && engine.projects.current === null;

  /**
   * Объект открыли из Проводника, пока программа уже работала: главный процесс
   * прислал путь (см. preload.cjs), а просит движок открыть его окно — так же,
   * как если бы объект выбрали в списке.
   */
  useEffect(() => {
    const api = (window as unknown as { fountainApp?: { onOpenProject(h: (dir: string) => void): void } }).fountainApp;
    // openProject (не голый send) — если в текущем объекте есть несохранённые
    // правки, движок откажется переключать сам и спросит через тот же диалог,
    // что и на экране «Проекты».
    api?.onOpenProject((dir) => openProject(dir));
  }, [openProject]);
  useEffect(() => {
    if (savedAtMs === null) return;
    setShowSaved(true);
    const t = window.setTimeout(() => setShowSaved(false), 2000);
    return () => window.clearTimeout(t);
  }, [savedAtMs]);
  const [tab, setTab] = useState<Tab>(loadTab);
  /**
   * Последнее ручное вмешательство и «сейчас» для подписи «сколько назад».
   * Минутного тика хватает: строка и меряется минутами.
   */
  const [manual, setManual] = useState(lastManual);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const off = subscribeManual((a) => setManual(a));
    const t = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => {
      off();
      window.clearInterval(t);
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      // Не сохранилось — вкладка просто не переживёт перезагрузку.
    }
  }, [tab]);
  // Если лицензии нет, а сохранённая/текущая вкладка недоступна — подменяем показ,
  // не трогая tab, чтобы вернуться на неё же после активации лицензии.
  const effectiveTab: Tab = unlicensed && !PRO_TABS.includes(tab) ? 'playlists' : tab;
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
    // Без лицензии тур вести некуда (все его шаги — на закрытых вкладках) —
    // просто не продвигаем вкладку вслед за туром, пока не активирована лицензия.
    if (tourStep !== null && !unlicensed) setTab(TOUR_STEPS[tourStep]!.tabId as Tab);
  }, [tourStep, unlicensed]);
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
      const a = binding.action;
      // Без лицензии клавиатурой доступен тот же набор действий, что и вкладками —
      // плейлист и аварийная остановка, чтобы привязки не были лазейкой в обход §27.
      if (unlicensed && a.type !== 'playlist' && a.type !== 'stopAll' && a.type !== 'blackout' && a.type !== 'pauseAll') {
        return;
      }
      e.preventDefault();
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
  }, [project, playback, send, unlicensed]);

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
            data-hint={theme === 'dark' ? 'Тёмная тема — нажмите для светлой' : 'Светлая тема — нажмите для тёмной'}
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
        <button
          className={projectsOpen || noProject ? 'btn btn-small active' : 'btn btn-small'}
          style={{ marginLeft: 10 }}
          data-hint="Объекты: открыть другой фонтан, создать новый или посмотреть, где лежит текущий."
          onClick={() => setProjectsOpen(!projectsOpen)}
        >
          {engine.projects?.current ? `🏛 ${engine.projects.current.name}` : '🏛 Проекты'}
        </button>
        {/*
          Объект не открыт — переключать нечего: вкладки вели бы на пустые
          экраны. Оставляем только выбор объекта, лицензию и справку.
        */}
        <nav className="tabs">
          {(noProject || access === 'none' ? [] : access === 'pro' ? TABS.filter((t) => PRO_TABS.includes(t.id)) : TABS).map((t) => (
            <button
              key={t.id}
              data-tour={t.id}
              className={effectiveTab === t.id ? 'tab active' : 'tab'}
              data-hint={t.full}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button
          className={unlicensed || expiringSoon ? 'help-btn license-btn license-btn-warn' : 'help-btn license-btn'}
          data-hint={
            access === 'none'
              ? licenseStatus?.expired
                ? `${licenseStatus.reason ?? 'Срок подписки истёк'} — нажмите, чтобы продлить`
                : 'Лицензия не активирована — нажмите, чтобы выбрать тариф'
              : inGrace
                ? `Оплата просрочена — программа закроется через ${licenseStatus?.graceDaysLeft ?? 0} дн.`
                : expiringSoon
                ? `Подписка заканчивается через ${daysLeft} дн. — напишите нам, чтобы продлить`
                : access === 'pro'
                  ? 'Тариф Pro — воспроизведение и расписание. Нужен полный доступ? Оформите Max'
                  : 'Лицензия'
          }
          onClick={() => setLicenseOpen(true)}
        >
          {access === 'none' ? '🔒' : expiringSoon ? '⏳' : '🔑'}
        </button>
        <button className="help-btn" data-hint="Справка" onClick={() => setHelpOpen(true)}>
          ?
        </button>
        <div className={connected ? 'conn conn-on' : 'conn conn-off'}>
          {connected ? 'движок подключён' : 'нет связи с движком…'}
        </div>
      </header>
      <ConfirmHost />
      <HintHost />
      {helpOpen && <HelpView onClose={() => setHelpOpen(false)} />}
      {licenseOpen && <LicenseView engine={engine} onClose={() => setLicenseOpen(false)} />}
      {/*
        В открытом объекте есть правки, ещё не долетевшие до диска, а человек
        пытается переключиться на другой (или закрыть текущий) — движок сам
        отказался переключать и попросил решить. Рисуется здесь, а не внутри
        ProjectsView: переключить объект можно и не заходя на этот экран
        (двойной щелчок по .fsproj из Проводника, пока открыт «Пульт»).
      */}
      {pendingProjectSwitch && (
        <div className="modal-overlay" onClick={pendingProjectSwitch.cancel}>
          <div className="modal confirm-modal confirm-modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-text">
              В объекте «{engine.projects?.current?.name ?? ''}» есть несохранённые изменения
            </div>
            <p className="dim confirm-detail">
              {pendingProjectSwitch.targetName
                ? `Что сделать перед тем, как открыть «${pendingProjectSwitch.targetName}»?`
                : 'Что сделать перед тем, как закрыть объект?'}
            </p>
            <div className="confirm-actions confirm-actions-column">
              <button className="btn active" autoFocus onClick={pendingProjectSwitch.save}>
                💾 Сохранить и {pendingProjectSwitch.targetName ? 'открыть' : 'закрыть'}
              </button>
              <button className="btn" onClick={pendingProjectSwitch.discard}>
                Не сохранять и {pendingProjectSwitch.targetName ? 'открыть' : 'закрыть'}
              </button>
              <button className="btn btn-small" onClick={pendingProjectSwitch.cancel}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
      {tourStep !== null && !unlicensed && (
        <TourOverlay
          steps={TOUR_STEPS}
          step={tourStep}
          onSkip={finishTour}
          onNext={() => (tourStep >= TOUR_STEPS.length - 1 ? finishTour() : setTourStep(tourStep + 1))}
        />
      )}

      {/*
        Приоритет экранов: сперва лицензия (без неё смысла выбирать объект
        нет — лицензия привязана к КОМПЬЮТЕРУ, а не к проекту), потом выбор
        объекта (тот же экран и кнопкой в шапке — переключить фонтан можно не
        перезапуская программу), и только потом обычные вкладки.
      */}
      {access === 'none' ? (
        <WelcomeView engine={engine} />
      ) : noProject || projectsOpen ? (
        <ProjectsView engine={engine} {...(noProject ? {} : { onClose: () => setProjectsOpen(false) })} />
      ) : (
        <>
      {effectiveTab === 'console' && <ConsoleView engine={engine} />}
      {effectiveTab === 'patch' && <PatchView engine={engine} />}
      {effectiveTab === 'layout' && <LayoutView engine={engine} />}
      {effectiveTab === 'scenes' && <ScenesView engine={engine} />}
      {effectiveTab === 'sequences' && <SequencesView engine={engine} />}
      {effectiveTab === 'show' && <ShowView engine={engine} />}
      {effectiveTab === 'playlists' && <PlaylistsView engine={engine} />}
      {effectiveTab === 'schedule' && <ScheduleView engine={engine} />}
      {effectiveTab === 'stream' && <StreamView engine={engine} />}
      {effectiveTab === 'network' && <NetworkView engine={engine} />}
      {effectiveTab === 'remote' && <RemoteView engine={engine} />}
      {effectiveTab === 'keys' && <KeysView engine={engine} />}
      {effectiveTab === 'settings' && <SettingsView engine={engine} />}
        </>
      )}

      <footer className="statusbar">
        {showSaved && <span className="ok-text">✔ сохранено</span>}
        {/*
          Без открытого объекта цифры тика и кадров остались бы от прошлого
          фонтана и врали бы: на линию сейчас ничего не уходит.
        */}
        {noProject ? (
          <span data-hint="Объект не открыт: на линию ничего не отправляется. Выберите объект в списке.">
            объект не открыт — вывод на линию остановлен
          </span>
        ) : stats ? (
          <>
            <span data-hint="Шаг обновления: движок шлёт новый DMX-кадр каждые 50 мс — 20 раз в секунду">
              тик {stats.intervalMs} мс
            </span>
            <span data-hint="Средняя погрешность такта: насколько движок отклоняется от ровных 50 мс. Единицы мс — норма">
              джиттер avg {stats.avgJitterMs} мс
            </span>
            <span data-hint="Максимальное разовое отклонение такта с момента запуска движка">
              max {stats.maxJitterMs} мс
            </span>
            <span data-hint="Сколько DMX-кадров движок отправил на оборудование с момента запуска (все вселенные вместе)">
              кадров {stats.framesSent.toLocaleString('ru-RU')}
            </span>
            {(() => {
              const active =
                playback.activeSceneId !== null ||
                playback.running.length > 0 ||
                playback.show !== null ||
                playback.playlist !== null;
      /**
       * Когда шоу не играет, строка всё равно должна отвечать на вопрос «а
       * почему фонтан работает». Показываем последнее ручное вмешательство:
       * фейдер на Отладке или отладку прибора в 3D — коротко, с указанием, где
       * это было и как давно.
       */
      const manualText = (): string => {
        if (!manual) return 'воспроизведение остановлено';
        const mins = Math.floor((nowMs - manual.atMs) / 60000);
        const when = mins < 1 ? 'только что' : mins < 60 ? `${mins} мин назад` : `${Math.floor(mins / 60)} ч назад`;
        const where = manual.where === 'console' ? 'вкладка Отладка' : 'отладка прибора в 3D';
        return `шоу не играет · вручную: ${where}, ${manual.what} — ${when}`;
      };
              const text = active
                ? `воспроизведение: ${playback.running.length} секв.${playback.activeSceneId !== null ? ' + сцена' : ''}${
                    playback.show !== null ? ` + шоу (${playback.show.playing ? 'играет' : 'пауза'})` : ''
                  }${playback.playlist !== null ? ` + плейлист №${playback.playlist.itemIndex + 1}` : ''}`
                : manualText();
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
                      : manual
                        ? manual.where === 'console'
                          ? 'console'
                          : 'layout'
                        : null;
              return target ? (
                <button
                  className="statusbar-link"
                  data-hint="Что сейчас исполняет движок — клик переносит на вкладку с этим воспроизведением"
                  onClick={() => setTab(target)}
                >
                  {text}
                </button>
              ) : (
                <span data-hint="«Остановлено» — движок ничего не играет, каналы держат ручные значения пульта">{text}</span>
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
