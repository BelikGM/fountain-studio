import { useMemo, useState } from 'react';
import {
  findScheduleCollisions,
  scheduleSecondOfDay,
  uid,
  type Schedule,
  type ScheduleAction,
  type ScheduleEntry,
} from '@fountain-studio/shared';
import { askConfirm } from '../components/ConfirmDialog';
import { useDragOrder } from '../components/DragOrder';
import { clipboardHasKind, copyToClipboard, pasteFromClipboard } from '../clipboard';
import type { EngineConnection } from '../useEngine';

/** Пн..Вс в порядке отображения; значения — как в Date.getDay() (0=Вс). */
const DAYS: { d: number; label: string }[] = [
  { d: 1, label: 'Пн' },
  { d: 2, label: 'Вт' },
  { d: 3, label: 'Ср' },
  { d: 4, label: 'Чт' },
  { d: 5, label: 'Пт' },
  { d: 6, label: 'Сб' },
  { d: 0, label: 'Вс' },
];

const ACTION_LABEL: Record<ScheduleAction['type'], string> = {
  sequence: 'Макрос (секвенсор)',
  sequenceGroup: 'Группа секвенсоров',
  show: 'Шоу',
  playlist: 'Плейлист',
  scene: 'Сцена',
  stopAll: 'Стоп — погасить всё',
};

const ACTION_HINT =
  'Макрос, группа, шоу, плейлист, сцена — запустить; то, что играло, остановится.\n' +
  '«Стоп» — гаснет всё: программы, сцена покоя, служебный свет, ручные ползунки — до следующего запуска записью расписания или руками.';

/** Варианты перехода: 0 — сразу; остальное — гашение на столько секунд. */
const BLACKOUT_CHOICES = [0, 1, 3, 5, 10, 30];

const CLIP_KIND = 'schedule';

/**
 * Расписание: переходы по системному времени ПК. Исполняет движок — и с
 * закрытым редактором (для полной автономии — «Автозапуск» в «Настройках»).
 *
 * Расписаний может быть несколько («Будни», «Выходные», «Зима»), у каждого
 * галочка «активно». Записи можно копировать из одного в другое.
 */
export function ScheduleView({ engine }: { engine: EngineConnection }) {
  const { project, updateProject } = engine;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hasClip, setHasClip] = useState(() => clipboardHasKind(CLIP_KIND));
  if (!project) return <main className="view">Жду данные объекта от движка…</main>;

  const schedules = project.schedules;
  const selected = schedules.find((s) => s.id === selectedId) ?? schedules[0] ?? null;
  const setSchedules = (next: Schedule[]): void => updateProject({ ...project, schedules: next });
  const drag = useDragOrder(project.schedules, setSchedules);
  const patchSchedule = (id: string, p: Partial<Schedule>): void =>
    setSchedules(schedules.map((s) => (s.id === id ? { ...s, ...p } : s)));

  const addSchedule = (): void => {
    const s: Schedule = { id: uid(), name: `Расписание ${schedules.length + 1}`, enabled: false, entries: [] };
    setSchedules([...schedules, s]);
    setSelectedId(s.id);
  };
  const duplicate = (): void => {
    if (!selected) return;
    // Копия выключена: иначе каждая её запись сразу столкнулась бы с оригиналом.
    const s: Schedule = {
      id: uid(),
      name: `${selected.name} (копия)`,
      enabled: false,
      entries: selected.entries.map((e) => ({ ...e, id: uid() })),
    };
    setSchedules([...schedules, s]);
    setSelectedId(s.id);
  };
  const remove = async (): Promise<void> => {
    if (!selected) return;
    if (selected.entries.length > 0) {
      const ok = await askConfirm(`Удалить расписание «${selected.name}»?`, {
        detail: `В нём ${selected.entries.length} ${selected.entries.length === 1 ? 'запись' : 'записей'}.`,
        okLabel: 'Удалить',
      });
      if (!ok) return;
    }
    const rest = schedules.filter((s) => s.id !== selected.id);
    // Пустым список расписаний не оставляем: вкладке всегда есть что показать.
    setSchedules(rest.length > 0 ? rest : [{ id: uid(), name: 'Основное', enabled: true, entries: [] }]);
    setSelectedId(null);
  };
  const copy = (): void => {
    if (!selected) return;
    copyToClipboard(CLIP_KIND, selected.entries);
    setHasClip(true);
  };
  const paste = async (): Promise<void> => {
    if (!selected) return;
    const entries = pasteFromClipboard<ScheduleEntry[]>(CLIP_KIND);
    if (!entries) return;
    if (selected.entries.length > 0) {
      const ok = await askConfirm(`Заменить записи расписания «${selected.name}»?`, {
        detail: `Сейчас в нём записей: ${selected.entries.length}. Они будут удалены, вместо них — скопированные (${entries.length}).`,
        okLabel: 'Заменить',
      });
      if (!ok) return;
    }
    patchSchedule(selected.id, { entries: entries.map((e) => ({ ...e, id: uid() })) });
  };

  return (
    <main className="view view-split">
      <aside className="sidebar">
        <div className="sidebar-actions">
          <button className="btn" onClick={addSchedule}>
            + Расписание
          </button>
          <button className="btn" onClick={duplicate} disabled={!selected} data-hint="Копия создаётся выключенной — чтобы её записи не столкнулись с оригиналом">
            Дублировать
          </button>
          <button className="btn" onClick={() => void remove()} disabled={!selected}>
            Удалить
          </button>
        </div>
        <ul className="list">
          {schedules.map((s) => (
            <li
              key={s.id}
              className={s.id === selected?.id ? 'list-item selected' : 'list-item'}
              onClick={() => setSelectedId(s.id)}
              {...drag.dropProps(s.id)}
            >
              {drag.handle(s.id, 'Перетащить, чтобы изменить порядок расписаний. Порядок решает спор: при совпадении времени срабатывает запись из первого по списку')}
              <input
                type="checkbox"
                checked={s.enabled}
                data-hint={s.enabled ? 'Активно — записи срабатывают' : 'Выключено — записи не срабатывают'}
                onClick={(ev) => ev.stopPropagation()}
                onChange={(ev) => patchSchedule(s.id, { enabled: ev.target.checked })}
              />{' '}
              {s.name}
              {!s.enabled && <span className="dim"> — выкл.</span>}
            </li>
          ))}
        </ul>
      </aside>

      <section className="content">
        {selected && (
          <ScheduleEditor
            schedule={selected}
            schedules={schedules}
            engine={engine}
            onChange={(s) => setSchedules(schedules.map((x) => (x.id === s.id ? s : x)))}
            onCopy={copy}
            onPaste={() => void paste()}
            canPaste={hasClip}
          />
        )}
      </section>
    </main>
  );
}

function ScheduleEditor({
  schedule,
  schedules,
  engine,
  onChange,
  onCopy,
  onPaste,
  canPaste,
}: {
  schedule: Schedule;
  schedules: Schedule[];
  engine: EngineConnection;
  onChange: (s: Schedule) => void;
  onCopy: () => void;
  onPaste: () => void;
  canPaste: boolean;
}) {
  const project = engine.project!;
  const entries = schedule.entries;
  const setEntries = (next: ScheduleEntry[]): void => onChange({ ...schedule, entries: next });
  const patch = (id: string, p: Partial<ScheduleEntry>): void =>
    setEntries(entries.map((e) => (e.id === id ? { ...e, ...p } : e)));

  const collisions = useMemo(() => findScheduleCollisions(schedules), [schedules]);
  /** Показываем по времени: так расписание читается как распорядок дня. */
  const sorted = [...entries].sort((a, b) => scheduleSecondOfDay(a.time) - scheduleSecondOfDay(b.time));
  const entryName = (id: string): string => {
    for (const s of schedules) {
      const e = s.entries.find((x) => x.id === id);
      if (e) return e.name || ACTION_LABEL[e.action.type];
    }
    return '?';
  };

  const refOptions = (type: ScheduleAction['type']): { id: string; name: string }[] => {
    switch (type) {
      case 'playlist':
        return project.playlists;
      case 'show':
        return project.shows;
      case 'sequence':
        return project.sequences;
      case 'sequenceGroup':
        return project.sequenceGroups;
      case 'scene':
        return project.scenes;
      default:
        return [];
    }
  };
  const firstAction = (): ScheduleAction => {
    if (project.sequences.length > 0) return { type: 'sequence', refId: project.sequences[0]!.id };
    if (project.playlists.length > 0) return { type: 'playlist', refId: project.playlists[0]!.id };
    if (project.shows.length > 0) return { type: 'show', refId: project.shows[0]!.id };
    if (project.scenes.length > 0) return { type: 'scene', refId: project.scenes[0]!.id };
    return { type: 'stopAll' };
  };
  const setAction = (e: ScheduleEntry, type: ScheduleAction['type']): void => {
    if (type === 'stopAll') {
      patch(e.id, { action: { type } });
      return;
    }
    const first = refOptions(type)[0];
    if (first) patch(e.id, { action: { type, refId: first.id } as ScheduleAction });
  };
  const addEntry = (): void =>
    setEntries([
      ...entries,
      { id: uid(), name: '', enabled: true, days: [], time: '08:00', action: firstAction(), blackoutSec: 0 },
    ]);

  const ownCollisions = entries.filter((e) => (collisions.get(e.id) ?? []).length > 0);

  return (
    <div className="panel">
      <div className="form-row">
        <input
          className="input"
          style={{ width: 200 }}
          value={schedule.name}
          onChange={(ev) => onChange({ ...schedule, name: ev.target.value })}
        />
        <label className="field">
          <input type="checkbox" checked={schedule.enabled} onChange={(ev) => onChange({ ...schedule, enabled: ev.target.checked })} />{' '}
          Активно
        </label>
        <span className="spacer" />
        <button className="btn btn-small" onClick={onCopy} disabled={entries.length === 0} data-hint="Скопировать записи — чтобы вставить в другое расписание">
          Копировать
        </button>
        <button className="btn btn-small" onClick={onPaste} disabled={!canPaste} data-hint="Вставить скопированные записи. В пустое — сразу, в заполненное — спросим: прежние записи будут удалены">
          Вставить
        </button>
      </div>
      <p className="dim">
        Каждая строка — переход: то, что играло, останавливается, ручные ползунки «Отладки» сбрасываются, и
        начинает играть новое. Дни не отмечены — каждый день. Движок играет расписание и с закрытым редактором, а
        после перезапуска сам включает то, что должно идти сейчас.
      </p>
      {!schedule.enabled && <p className="warn">Расписание выключено — его записи не срабатывают.</p>}
      {engine.engineConfig?.audioReady === false &&
        entries.some((e) => e.enabled && (e.action.type === 'playlist' || e.action.type === 'show')) && (
          <p className="error-text">
            ⚠ На этом компьютере нечем играть музыку (не установлен ffmpeg) — движок отыграет воду и свет в
            тишине. Как поставить — «Настройки» → «Громкость и тембр музыки» и памятка по установке.
          </p>
        )}
      {ownCollisions.length > 0 && (
        <p className="error-text">
          ⚠ Записи в одно и то же время:{' '}
          {ownCollisions
            // Пару показываем один раз: «А и Б», а не ещё и «Б и А».
            .filter((e) => {
              const c = collisions.get(e.id)![0]!;
              return c.wins || !entries.some((x) => x.id === c.otherId);
            })
            .map((e) => {
              const c = collisions.get(e.id)![0]!;
              return `${e.time.slice(0, 5)} «${e.name || ACTION_LABEL[e.action.type]}» и «${entryName(c.otherId)}»${c.otherScheduleName !== schedule.name ? ` (${c.otherScheduleName})` : ''}`;
            })
            .join('; ')}
          . Сработает только первая по списку — разведите время или дни.
        </p>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Вкл</th>
            <th>Время</th>
            <th>Дни</th>
            <th data-hint={ACTION_HINT}>Действие</th>
            <th>Что запустить</th>
            <th data-hint="Перед запуском: сразу — прежнее гаснет, новое начинается в тот же миг; с гашением — сначала всё в 0 на столько секунд, потом запуск">
              Переход
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => {
            const clash = (collisions.get(e.id) ?? []).length > 0;
            const program = 'refId' in e.action;
            return (
              <tr key={e.id} className={e.enabled ? '' : 'row-disabled'}>
                <td>
                  <input type="checkbox" checked={e.enabled} onChange={(ev) => patch(e.id, { enabled: ev.target.checked })} />
                </td>
                <td>
                  <input
                    className={clash ? 'input input-error' : 'input'}
                    type="time"
                    step={1}
                    value={e.time}
                    data-hint={clash ? 'В это же время есть другая запись — сработает только первая по списку' : undefined}
                    onChange={(ev) => {
                      if (ev.target.value !== '') patch(e.id, { time: ev.target.value });
                    }}
                  />
                </td>
                <td>
                  <div className="days">
                    {DAYS.map(({ d, label }) => (
                      <button
                        key={d}
                        className={e.days.includes(d) ? 'btn btn-small active' : 'btn btn-small'}
                        data-hint={e.days.length === 0 ? 'Дни не отмечены — каждый день' : ''}
                        onClick={() =>
                          patch(e.id, {
                            days: e.days.includes(d) ? e.days.filter((x) => x !== d) : [...e.days, d],
                          })
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </td>
                <td>
                  {/* Название — второй строкой под действием: отдельной колонкой
                      таблица не помещалась в окно 1280 px. */}
                  <div className="schedule-action">
                    <select
                      value={e.action.type}
                      data-hint={ACTION_HINT}
                      onChange={(ev) => setAction(e, ev.target.value as ScheduleAction['type'])}
                    >
                      {(Object.keys(ACTION_LABEL) as ScheduleAction['type'][]).map((t) => (
                        <option key={t} value={t}>
                          {ACTION_LABEL[t]}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input input-mini schedule-name"
                      placeholder="название (для журнала)"
                      value={e.name}
                      onChange={(ev) => patch(e.id, { name: ev.target.value })}
                    />
                  </div>
                </td>
                <td>
                  {'refId' in e.action && (
                    <select
                      value={e.action.refId}
                      onChange={(ev) =>
                        patch(e.id, { action: { type: e.action.type, refId: ev.target.value } as ScheduleAction })
                      }
                    >
                      {refOptions(e.action.type).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  {program ? (
                    <select value={e.blackoutSec} onChange={(ev) => patch(e.id, { blackoutSec: Number(ev.target.value) })}>
                      {[...new Set([...BLACKOUT_CHOICES, e.blackoutSec])]
                        .sort((a, b) => a - b)
                        .map((sec) => (
                          <option key={sec} value={sec}>
                            {sec === 0 ? 'сразу' : `гашение ${sec} с`}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
                <td>
                  <button className="btn btn-small" data-hint="Удалить запись" onClick={() => setEntries(entries.filter((x) => x.id !== e.id))}>
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="form-row" style={{ marginTop: 10 }}>
        <button className="btn" onClick={addEntry}>
          + Запись
        </button>
      </div>
    </div>
  );
}
