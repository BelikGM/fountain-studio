import { uid, type ScheduleAction, type ScheduleEntry } from '@fountain-studio/shared';
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

/**
 * Расписание: запуск действий по системному времени ПК. Исполняет движок —
 * достаточно, чтобы он был запущен (для полной автономии — служба с watchdog,
 * см. README «Автозапуск»).
 */
export function ScheduleView({ engine }: { engine: EngineConnection }) {
  const { project, updateProject } = engine;
  if (!project) return <main className="view">Жду данные объекта от движка…</main>;

  const schedule = project.schedule;

  const update = (next: ScheduleEntry[]): void => updateProject({ ...project, schedule: next });

  const patch = (id: string, p: Partial<ScheduleEntry>): void =>
    update(schedule.map((e) => (e.id === id ? { ...e, ...p } : e)));

  const addEntry = (): void =>
    update([
      ...schedule,
      {
        id: uid(),
        name: '',
        enabled: true,
        days: [],
        time: '20:00',
        action: firstAction(),
      },
    ]);

  const firstAction = (): ScheduleAction => {
    if (project.playlists.length > 0) return { type: 'playlist', refId: project.playlists[0]!.id };
    if (project.shows.length > 0) return { type: 'show', refId: project.shows[0]!.id };
    if (project.sequences.length > 0) return { type: 'sequence', refId: project.sequences[0]!.id };
    if (project.scenes.length > 0) return { type: 'scene', refId: project.scenes[0]!.id };
    return { type: 'stopAll' };
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
      case 'stopAll':
        return [];
    }
  };

  const setAction = (e: ScheduleEntry, type: ScheduleAction['type']): void => {
    if (type === 'stopAll') {
      patch(e.id, { action: { type: 'stopAll' } });
    } else {
      const first = refOptions(type)[0];
      if (first) patch(e.id, { action: { type, refId: first.id } as ScheduleAction });
    }
  };

  return (
    <main className="view">
      <div className="panel">
        <h2>Расписание фонтана</h2>
        <p className="dim">
          Действия запускаются по системным часам этого ПК, пока работает движок. Дни не отмечены —
          каждый день. Время можно с секундами. Движок играет расписание и с закрытым редактором; чтобы
          он сам поднимался после перезагрузки компьютера, включите «Автозапуск» в «Настройках».
        </p>

        <table className="table">
          <thead>
            <tr>
              <th>Вкл</th>
              <th>Название</th>
              <th>Время</th>
              <th>Дни</th>
              <th>Действие</th>
              <th>Что запустить</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {schedule.map((e) => (
              <tr key={e.id} className={e.enabled ? '' : 'row-disabled'}>
                <td>
                  <input
                    type="checkbox"
                    checked={e.enabled}
                    onChange={(ev) => patch(e.id, { enabled: ev.target.checked })}
                  />
                </td>
                <td>
                  <input
                    className="input"
                    style={{ width: 140 }}
                    placeholder="Вечерний запуск"
                    value={e.name}
                    onChange={(ev) => patch(e.id, { name: ev.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="input"
                    type="time"
                    step={1}
                    value={e.time}
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
                  <select value={e.action.type} onChange={(ev) => setAction(e, ev.target.value as ScheduleAction['type'])}>
                    <option value="playlist">Плейлист</option>
                    <option value="show">Шоу</option>
                    <option value="sequence">Секвенсор</option>
                    <option value="sequenceGroup">Группа секвенсоров</option>
                    <option value="scene">Сцена</option>
                    <option value="stopAll">Стоп всё</option>
                  </select>
                </td>
                <td>
                  {e.action.type !== 'stopAll' && (
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
                  <button
                    className="btn btn-small"
                    onClick={() => update(schedule.filter((x) => x.id !== e.id))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form-row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={addEntry}>
            + Запись расписания
          </button>
        </div>
      </div>
    </main>
  );
}
