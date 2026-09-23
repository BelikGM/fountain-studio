import type { EngineConnection } from '../useEngine';
import { requestTab } from '../navigate';

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
 * Кнопка «режим наладки» показывается по ПРИЧИНЕ (`linkBad` — выход не
 * доставляет кадры), а не по мгновенному `failsafe.active`: на столе гашение то
 * срабатывает, то снимается, и кнопка исчезала из-под мыши.
 */
export function ManualBlocked({ engine }: { engine: EngineConnection }) {
  const { project, playback, engineConfig, failsafe, send, updateProject } = engine;
  const bench = engineConfig?.benchMode === true;
  const timeoutSec = project?.failsafe.timeoutSec ?? 10;

  type Strip = {
    /** Красная — сейчас мешает работать; жёлтая — напоминание. */
    danger: boolean;
    text: string;
    /** Кнопка справа: что делает и как подписана. */
    action?: { label: string; hint: string; run: () => void };
    tab?: 'settings' | 'schedule';
  };

  const benchOn: Strip['action'] = {
    label: 'Режим наладки',
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
          danger: true,
          text: `Работает аварийное гашение (${failsafe.reason || 'причина не указана'}). Насосы, клапаны и свет уходят в 0 каждый такт — поэтому ползунок и «падает». На столе включите режим наладки: гашение перестанет срабатывать здесь, в проекте останется включённым.`,
          action: bench ? undefined : benchOn,
          tab: 'settings',
        }
      : null,
    engine.connected && !failsafe?.active && failsafe?.linkBad && !bench && project?.failsafe.enabled
      ? {
          danger: true,
          text: `Кадры в линию не уходят: интерфейс DMX не найден или кабель не подключён. Через ${timeoutSec} с аварийное гашение уронит воду и свет в 0. На столе включите режим наладки.`,
          action: benchOn,
        }
      : null,
    engine.connected && !failsafe?.active && playback.dark === 'off'
      ? {
          danger: true,
          text: 'Стоп по расписанию: всё погашено до следующего запуска. Кадр обнуляется после всех слоёв, включая ручные ползунки и тест-генератор. Запустите сцену или шоу руками.',
          tab: 'schedule',
        }
      : null,
    // Напоминания — только когда ничего не мешает: две полосы сразу путают.
    project && !project.failsafe.enabled
      ? {
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
          danger: false,
          text: 'Режим наладки: на этом компьютере аварийное гашение не срабатывает — приборы держат последнее значение, даже если кадры перестанут доходить. Перед сдачей объекта выключите.',
          action: {
            label: 'Выключить режим наладки',
            hint: 'Вернуть аварийное гашение на этом компьютере',
            run: () => send({ type: 'setBenchMode', on: false }),
          },
        }
      : null,
  ];

  const strip = strips.find((s): s is Strip => s !== null);
  if (!strip) return null;

  return (
    <div className={strip.danger ? 'license-banner license-banner-grace' : 'license-banner'}>
      <span>⚠ {strip.text}</span>
      {strip.action && (
        <button className="btn btn-small" data-hint={strip.action.hint} onClick={strip.action.run}>
          {strip.action.label}
        </button>
      )}
      {strip.tab && (
        <button className="btn btn-small" onClick={() => requestTab(strip.tab!)}>
          Перейти
        </button>
      )}
    </div>
  );
}
