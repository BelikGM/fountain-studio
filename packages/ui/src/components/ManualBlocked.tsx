import { useEffect, useReducer } from 'react';
import { failsafeTargetsText } from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';
import { requestSettingsPanel, requestTab } from '../navigate';

/**
 * Одна полоса: почему ручное управление сейчас не доходит до приборов.
 *
 * Человек двигает фейдер на «Отладке» или проверяет форсунку в 3D, а значение
 * возвращается в 0. Выглядит это как сломанная программа, хотя поверх ручного
 * управления работает что-то из четырёх: аварийное гашение, обрыв вывода на
 * линию (гашение сработает через timeoutSec), стоп по расписанию или движок не
 * отвечает.
 *
 * Полоса ВСЕГДА ОДНА. Раньше их могло вылезти две сразу — красная «гашение
 * работает» и жёлтая «в объекте гашение выключено», — и они противоречили друг
 * другу: понять, что происходит, было нельзя. Теперь показывается первая
 * подходящая причина по важности, остальные молчат.
 *
 * Полоса одинаковая на «Отладке» и в «3D»: раньше она была только на «Отладке»,
 * и в 3D человек видел просто неработающие ползунки прибора.
 *
 * Кнопка «режим отладки» показывается по ПРИЧИНЕ (`linkBad` — выход не
 * доставляет кадры), а не по мгновенному `failsafe.active`: на столе гашение то
 * срабатывает, то снимается, и кнопка исчезала из-под мыши.
 *
 * Кнопка «Скрыть» (заказчик 24.09.2026): пока объект налаживают на столе,
 * полоса горит часами и мешает. Скрыть можно любую, кроме «нет связи с
 * движком» — без движка не работает вообще ничего. Скрытая возвращается через
 * 15 минут: насовсем не пропадает, чтобы о причине не забыли.
 */
const HIDE_MS = 15 * 60 * 1000;
const HIDE_KEY = 'fountain.strips.hiddenUntil';

/** Полоса → до какого времени скрыта. Общее для «Отладки» и «3D». */
let hiddenUntil: Record<string, number> = loadHidden();
const hideListeners = new Set<() => void>();

function loadHidden(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDE_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((kv): kv is [string, number] => typeof kv[1] === 'number'));
  } catch {
    return {};
  }
}

function hideStrip(key: string): void {
  hiddenUntil = { ...hiddenUntil, [key]: Date.now() + HIDE_MS };
  try {
    localStorage.setItem(HIDE_KEY, JSON.stringify(hiddenUntil));
  } catch {
    // Не записалось — скрыто до перезагрузки окна, тоже годится.
  }
  for (const l of hideListeners) l();
}

export function ManualBlocked({ engine }: { engine: EngineConnection }) {
  const { project, playback, engineConfig, failsafe, send, updateProject } = engine;
  const bench = engineConfig?.benchMode === true;
  const timeoutSec = project?.failsafe.timeoutSec ?? 10;
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    hideListeners.add(rerender);
    return () => {
      hideListeners.delete(rerender);
    };
  }, []);

  type Strip = {
    /** Для «Скрыть»: у каждой причины своя отметка. Нет — скрыть нельзя. */
    key?: string;
    /** Красная — сейчас мешает работать; жёлтая — напоминание. */
    danger: boolean;
    text: string;
    /** Кнопка справа: что делает и как подписана. */
    action?: { label: string; hint: string; run: () => void };
    tab?: 'settings' | 'schedule';
    /** Панель «Настроек», к которой ведёт «Перейти» (раскрывается и прокручивается). */
    panel?: string;
  };

  const benchOn: Strip['action'] = {
    label: 'Режим отладки',
    hint: 'На ЭТОМ компьютере аварийное гашение перестанет срабатывать, и приборами можно управлять руками без интерфейса DMX. Настройка программы: в проект не попадёт, на фонтане гашение останется включённым. Переживает перезагрузку страницы и перезапуск программы.',
    run: () => send({ type: 'setBenchMode', on: true }),
  };

  const strips: (Strip | null)[] = [
    !engine.connected
      ? {
          danger: true,
          text: 'Нет связи с движком: ползунки, кнопки и тест-генератор ни на что не влияют. Кадры приборам шлёт движок — запустите программу (значок у часов) и дождитесь зелёной точки в шапке.',
        }
      : null,
    engine.connected && failsafe?.active
      ? {
          key: 'failsafe-active',
          danger: true,
          text: `Работает аварийное отключение: ${failsafe.reason || 'причина не указана'}. В 0 каждый такт уходят ${project ? failsafeTargetsText(project.failsafe) : 'насосы, клапаны и свет'} — поэтому ползунок и «падает». На столе включите режим отладки: на этом компьютере отключение перестанет срабатывать, в проекте останется включённым.`,
          action: bench ? undefined : benchOn,
          panel: 'Аварийное отключение',
        }
      : null,
    engine.connected && !failsafe?.active && failsafe?.linkBad && !bench && project?.failsafe.enabled
      ? {
          key: 'link-bad',
          danger: true,
          text: `Кадры в линию не уходят: интерфейс DMX не найден или кабель не подключён. Через ${timeoutSec} с аварийное отключение погасит приборы. На столе включите режим отладки.`,
          action: benchOn,
          panel: 'Аварийное отключение',
        }
      : null,
    engine.connected && !failsafe?.active && playback.dark === 'off'
      ? {
          key: 'schedule-off',
          danger: true,
          text: 'Стоп по расписанию: всё погашено до следующего запуска. Кадр обнуляется после всех слоёв, включая ручные ползунки и тест-генератор. Запустите сцену или шоу руками.',
          tab: 'schedule',
        }
      : null,
    // Напоминания — только когда ничего не мешает: две полосы сразу путают.
    project && !project.failsafe.enabled
      ? {
          key: 'failsafe-disabled',
          danger: false,
          text: 'В проекте выключено аварийное гашение. Эта настройка уедет на фонтан вместе с проектом — там она нужна включённой.',
          action: {
            label: 'Включить в проекте',
            hint: 'Вернуть аварийное гашение в настройках проекта',
            run: () => updateProject({ ...project, failsafe: { ...project.failsafe, enabled: true } }),
          },
        }
      : null,
    bench
      ? {
          key: 'bench',
          danger: false,
          text: 'Обратите внимание: включён режим отладки — на этом компьютере аварийное отключение не срабатывает, приборы держат последнее значение, даже если кадры перестанут доходить. Перед сдачей объекта выключите.',
          action: {
            label: 'Выключить режим отладки',
            hint: 'Вернуть аварийное гашение на этом компьютере',
            run: () => send({ type: 'setBenchMode', on: false }),
          },
        }
      : null,
  ];

  const now = Date.now();
  const hidden = (s: Strip): boolean => !!s.key && (hiddenUntil[s.key] ?? 0) > now;
  const strip = strips.find((s): s is Strip => s !== null && !hidden(s));
  // Скрытая полоса вернётся сама: будим отрисовку к ближайшему сроку.
  const nextWake = Math.min(...strips.filter((s): s is Strip => s !== null && hidden(s)).map((s) => hiddenUntil[s.key!]!));
  useEffect(() => {
    if (!Number.isFinite(nextWake)) return;
    const t = window.setTimeout(rerender, Math.max(1000, nextWake - Date.now() + 50));
    return () => window.clearTimeout(t);
  }, [nextWake]);
  if (!strip) return null;

  return (
    <div className={strip.danger ? 'license-banner license-banner-grace' : 'license-banner'}>
      <span>⚠ {strip.text}</span>
      {strip.action && (
        <button className="btn btn-small" data-hint={strip.action.hint} onClick={strip.action.run}>
          {strip.action.label}
        </button>
      )}
      {(strip.tab || strip.panel) && (
        <button
          className="btn btn-small"
          data-hint={strip.panel ? `Открыть «Настройки» → «${strip.panel}»` : undefined}
          onClick={() => (strip.panel ? requestSettingsPanel(strip.panel) : requestTab(strip.tab!))}
        >
          Перейти
        </button>
      )}
      {strip.key && (
        <button
          className="btn btn-small"
          data-hint="Спрятать на 15 минут под свою ответственность. Потом полоса появится снова."
          onClick={() => hideStrip(strip.key!)}
        >
          Скрыть
        </button>
      )}
    </div>
  );
}
