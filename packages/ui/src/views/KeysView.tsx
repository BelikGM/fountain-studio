import { useEffect, useState } from 'react';
import { uid, type KeyAction, type KeyBinding } from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';

const ACTION_LABEL: Record<KeyAction['type'], string> = {
  scene: 'Сцена (вкл/выкл)',
  sequence: 'Секвенсор (пуск/стоп)',
  sequenceGroup: 'Группа секвенсоров (пуск/стоп)',
  show: 'Шоу (пуск/стоп)',
  playlist: 'Плейлист (пуск/стоп)',
  stopAll: 'Стоп всё',
  blackout: 'Blackout — погасить всё',
  pauseAll: 'Пауза всего (вкл/выкл)',
};

/** Человекочитаемое имя физической клавиши из KeyboardEvent.code. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/** Клавиши: привязка запуска сцен/секвенсоров/шоу/плейлистов к клавиатуре. */
export function KeysView({ engine }: { engine: EngineConnection }) {
  const { project, updateProject } = engine;
  const [captureId, setCaptureId] = useState<string | null>(null);

  // Захват следующей нажатой клавиши для выбранной привязки.
  useEffect(() => {
    if (captureId === null || !project) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') {
        updateProject({
          ...project,
          keys: project.keys.map((k) => (k.id === captureId ? { ...k, code: e.code } : k)),
        });
      }
      setCaptureId(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [captureId, project, updateProject]);

  if (!project) return <main className="view">Жду данные объекта от движка…</main>;

  const update = (keys: KeyBinding[]): void => updateProject({ ...project, keys });

  const refOptions = (type: KeyAction['type']): { id: string; name: string }[] => {
    switch (type) {
      case 'scene':
        return project.scenes;
      case 'sequence':
        return project.sequences;
      case 'sequenceGroup':
        return project.sequenceGroups;
      case 'show':
        return project.shows;
      case 'playlist':
        return project.playlists;
      default:
        return [];
    }
  };

  const addBinding = (): void => {
    const action: KeyAction =
      project.scenes.length > 0 ? { type: 'scene', refId: project.scenes[0]!.id } : { type: 'stopAll' };
    update([...project.keys, { id: uid(), code: '', action }]);
  };

  const setAction = (b: KeyBinding, type: KeyAction['type']): void => {
    if (type === 'stopAll' || type === 'blackout' || type === 'pauseAll') {
      update(project.keys.map((k) => (k.id === b.id ? { ...k, action: { type } } : k)));
    } else {
      const first = refOptions(type)[0];
      if (first) {
        update(project.keys.map((k) => (k.id === b.id ? { ...k, action: { type, refId: first.id } } : k)));
      }
    }
  };

  return (
    <main className="view">
      <div className="panel">
        <h2>Клавиатурные привязки</h2>
        <p className="dim">
          Работают на любой вкладке редактора, если курсор не стоит в поле ввода. Повторное нажатие той же
          клавиши останавливает то, что она запустила. Привязка — к физической клавише (не зависит от раскладки).
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Клавиша</th>
              <th>Действие</th>
              <th>Цель</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {project.keys.map((b) => (
              <tr key={b.id}>
                <td>
                  <button
                    className={captureId === b.id ? 'btn active' : b.code === '' ? 'btn btn-danger' : 'btn'}
                    onClick={() => setCaptureId(captureId === b.id ? null : b.id)}
                  >
                    {captureId === b.id ? 'нажмите клавишу… (Esc — отмена)' : b.code === '' ? 'назначить' : keyLabel(b.code)}
                  </button>
                </td>
                <td>
                  <select value={b.action.type} onChange={(e) => setAction(b, e.target.value as KeyAction['type'])}>
                    {(Object.keys(ACTION_LABEL) as KeyAction['type'][]).map((t) => (
                      <option key={t} value={t}>
                        {ACTION_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {b.action.type !== 'stopAll' && b.action.type !== 'blackout' && b.action.type !== 'pauseAll' && (
                    <select
                      value={b.action.refId ?? ''}
                      onChange={(e) =>
                        update(
                          project.keys.map((k) =>
                            k.id === b.id ? { ...k, action: { type: b.action.type, refId: e.target.value } } : k,
                          ),
                        )
                      }
                    >
                      {refOptions(b.action.type).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  <button className="btn btn-small" onClick={() => update(project.keys.filter((k) => k.id !== b.id))}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form-row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={addBinding}>
            + Привязка
          </button>
        </div>
      </div>
    </main>
  );
}
