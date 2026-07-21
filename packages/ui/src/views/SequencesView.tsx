import { useEffect, useState } from 'react';
import {
  sequenceDependents,
  sequenceGroupDependents,
  uid,
  type Sequence,
  type SequenceGroup,
  type SequenceStep,
} from '@fountain-studio/shared';
import { clipboardHasKind, copyToClipboard, pasteFromClipboard } from '../clipboard';
import { ListFilter } from '../components/ListFilter';
import { PencilIcon, TrashIcon } from '../components/Icons';
import { confirmDelete } from '../confirmDelete';
import type { EngineConnection } from '../useEngine';
import { SequenceMatrix } from './SequenceMatrix';

/** Секвенсоры: последовательности сцен с длительностью и фейдом, транспорт запуска. */
export function SequencesView({ engine }: { engine: EngineConnection }) {
  const { project, playback, send, updateProject } = engine;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  // Группы секвенсоров (§27 доработки) — переключает контент справа на панель
  // групп вместо редактора выбранного секвенсора, тот же принцип, что и
  // остальные переключаемые панели этой сессии (Генератор, TrackEffects…).
  const [groupsOpen, setGroupsOpen] = useState(false);

  const sequences = project?.sequences ?? [];
  const visibleSequences = sequences.filter((q) => q.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const selected = sequences.find((q) => q.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId === null && sequences.length > 0) setSelectedId(sequences[0]!.id);
    if (selectedId !== null && !sequences.some((q) => q.id === selectedId)) {
      setSelectedId(sequences[0]?.id ?? null);
    }
  }, [sequences, selectedId]);

  if (!project) return <main className="view">Ожидание проекта от движка…</main>;

  const addSequence = (): void => {
    const seq: Sequence = { id: uid(), name: `Секвенсор ${project.sequences.length + 1}`, mode: 'loop', steps: [] };
    updateProject({ ...project, sequences: [...project.sequences, seq] });
    setSelectedId(seq.id);
  };

  const duplicateSequence = (): void => {
    if (!selected) return;
    const copy: Sequence = {
      ...selected,
      id: uid(),
      name: `${selected.name} (копия)`,
      steps: selected.steps.map((s) => ({ ...s })),
    };
    updateProject({ ...project, sequences: [...project.sequences, copy] });
    setSelectedId(copy.id);
  };

  const removeSequence = (): void => {
    if (!selected) return;
    if (!confirmDelete('секвенсора', selected.name, sequenceDependents(project, selected.id))) return;
    send({ type: 'stopSequence', sequenceId: selected.id });
    updateProject({ ...project, sequences: project.sequences.filter((q) => q.id !== selected.id) });
  };

  const updateSequence = (seq: Sequence): void => {
    updateProject({ ...project, sequences: project.sequences.map((q) => (q.id === seq.id ? seq : q)) });
  };

  const runInfo = (id: string) => playback.running.find((r) => r.sequenceId === id);

  return (
    <main className="view view-split">
      <aside className="sidebar">
        <div className="sidebar-actions">
          <button className="btn" onClick={addSequence}>
            + Секвенсор
          </button>
          <button className="btn" onClick={duplicateSequence} disabled={!selected}>
            Дублировать
          </button>
          <button className="btn" onClick={removeSequence} disabled={!selected}>
            Удалить
          </button>
          <button
            className={groupsOpen ? 'btn btn-small active' : 'btn btn-small'}
            title="Группы секвенсоров — синхронный/параллельный запуск нескольких вместе"
            onClick={() => setGroupsOpen(!groupsOpen)}
          >
            Группы{project.sequenceGroups.length > 0 ? ` (${project.sequenceGroups.length})` : ''}
          </button>
        </div>
        {sequences.length > 5 && <ListFilter value={filter} onChange={setFilter} />}
        <ul className="list">
          {visibleSequences.map((q) => {
            const r = runInfo(q.id);
            return (
              <li
                key={q.id}
                className={
                  (q.id === selectedId ? 'list-item selected' : 'list-item') + (r ? ' playing' : '')
                }
                onClick={() => setSelectedId(q.id)}
              >
                {q.name}
                {r && <span className="badge badge-live">{r.paused ? 'пауза' : `шаг ${r.stepIndex + 1}`}</span>}
              </li>
            );
          })}
        </ul>
        {playback.running.length > 0 && (
          <button className="btn btn-danger" onClick={() => send({ type: 'stopAllPlayback' })}>
            ■ Стоп всё
          </button>
        )}
      </aside>

      <section className="content">
        {groupsOpen ? (
          <SequenceGroupsPanel engine={engine} />
        ) : selected === null ? (
          <div className="dim">Создайте секвенсор слева.</div>
        ) : (
          <SequenceEditor
            sequence={selected}
            engine={engine}
            running={runInfo(selected.id)}
            onChange={updateSequence}
          />
        )}
      </section>
    </main>
  );
}

/**
 * Группы секвенсоров (§27 доработки) — синхронный/параллельный запуск: старт
 * группы вызывает startSequence на всех участниках в одном сообщении, движок
 * стартует их в одном тике (см. Playback.startGroup) — по абсолютному часу,
 * без риска разойтись по времени, в отличие от старой попытки в прежнем
 * приложении.
 */
function SequenceGroupsPanel({ engine }: { engine: EngineConnection }) {
  const { project, playback, send, updateProject } = engine;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  if (!project) return null;
  const groups = project.sequenceGroups;
  const sequences = project.sequences;

  const addGroup = (): void => {
    const g: SequenceGroup = { id: uid(), name: `Группа ${groups.length + 1}`, sequenceIds: [] };
    updateProject({ ...project, sequenceGroups: [...groups, g] });
  };

  const updateGroup = (g: SequenceGroup): void => {
    updateProject({ ...project, sequenceGroups: groups.map((x) => (x.id === g.id ? g : x)) });
  };

  const removeGroup = (g: SequenceGroup): void => {
    if (!confirmDelete('группы секвенсоров', g.name, sequenceGroupDependents(project, g.id))) return;
    send({ type: 'stopSequenceGroup', groupId: g.id });
    updateProject({ ...project, sequenceGroups: groups.filter((x) => x.id !== g.id) });
  };

  const toggleMember = (g: SequenceGroup, sequenceId: string): void => {
    const has = g.sequenceIds.includes(sequenceId);
    updateGroup({ ...g, sequenceIds: has ? g.sequenceIds.filter((id) => id !== sequenceId) : [...g.sequenceIds, sequenceId] });
  };

  const startRename = (g: SequenceGroup): void => {
    setRenamingId(g.id);
    setRenameDraft(g.name);
  };
  const commitRename = (g: SequenceGroup): void => {
    const name = renameDraft.trim();
    if (name && name !== g.name) updateGroup({ ...g, name });
    setRenamingId(null);
  };

  const groupRunState = (g: SequenceGroup): { running: number; paused: number } => {
    let running = 0;
    let paused = 0;
    for (const id of g.sequenceIds) {
      const r = playback.running.find((x) => x.sequenceId === id);
      if (r) (r.paused ? paused++ : running++);
    }
    return { running, paused };
  };

  return (
    <div className="panel">
      <div className="panel-title">Группы секвенсоров</div>
      <p className="dim">
        Секвенсоры одной группы запускаются/останавливаются вместе — например, вода и свет одним нажатием, вместо
        нескольких клавиш подряд.
      </p>
      {sequences.length === 0 ? (
        <p className="dim">Нет секвенсоров — создайте их слева.</p>
      ) : (
        <>
          {groups.length === 0 && <p className="dim">Групп ещё нет.</p>}
          {groups.map((g) => {
            const { running, paused } = groupRunState(g);
            const anyActive = running + paused > 0;
            return (
              <div key={g.id} className="panel" style={{ marginBottom: 8 }}>
                <div className="form-row">
                  {renamingId === g.id ? (
                    <input
                      className="input input-mini"
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => commitRename(g)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        else if (e.key === 'Escape') setRenamingId(null);
                      }}
                    />
                  ) : (
                    <span className="input-title">{g.name}</span>
                  )}
                  {anyActive && (
                    <span className="badge badge-live">
                      {running > 0 ? `играет (${running})` : ''}
                      {running > 0 && paused > 0 ? ', ' : ''}
                      {paused > 0 ? `пауза (${paused})` : ''}
                    </span>
                  )}
                  <span className="spacer" />
                  {!anyActive ? (
                    <button
                      className="btn active"
                      disabled={g.sequenceIds.length === 0}
                      onClick={() => send({ type: 'startSequenceGroup', groupId: g.id })}
                    >
                      ▶ Пуск
                    </button>
                  ) : (
                    <>
                      {paused === 0 ? (
                        <button className="btn" onClick={() => send({ type: 'pauseSequenceGroup', groupId: g.id })}>
                          ⏸ Пауза
                        </button>
                      ) : (
                        <button
                          className="btn active"
                          onClick={() => send({ type: 'resumeSequenceGroup', groupId: g.id })}
                        >
                          ▶ Продолжить
                        </button>
                      )}
                      <button className="btn" onClick={() => send({ type: 'stopSequenceGroup', groupId: g.id })}>
                        ■ Стоп
                      </button>
                    </>
                  )}
                  <button className="icon-btn" title="Переименовать" onClick={() => startRename(g)}>
                    <PencilIcon />
                  </button>
                  <button className="icon-btn icon-btn-danger" title="Удалить группу" onClick={() => removeGroup(g)}>
                    <TrashIcon />
                  </button>
                </div>
                <div className="utility-device-list">
                  {sequences.map((q) => (
                    <label key={q.id} className="field">
                      <input
                        type="checkbox"
                        checked={g.sequenceIds.includes(q.id)}
                        onChange={() => toggleMember(g, q.id)}
                      />{' '}
                      {q.name}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
          <button className="btn" onClick={addGroup}>
            + Группа
          </button>
        </>
      )}
    </div>
  );
}

function SequenceEditor({
  sequence,
  engine,
  running,
  onChange,
}: {
  sequence: Sequence;
  engine: EngineConnection;
  running: { stepIndex: number; paused: boolean } | undefined;
  onChange: (seq: Sequence) => void;
}) {
  const { project, send } = engine;
  const scenes = project!.scenes;
  const sceneName = (id: string): string => scenes.find((s) => s.id === id)?.name ?? '(сцена удалена)';
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Матричный редактор (§27 доработки) — сетка «шаг × прибор» вместо списка,
  // альтернативный вид тех же Sequence.steps, без отдельной модели данных.
  const [matrixOpen, setMatrixOpen] = useState(false);
  // clipboardHasKind сам по себе не React-состояние — отдельный флаг, чтобы
  // кнопка «Вставить шаг» появлялась сразу после копирования, без ожидания
  // случайного внешнего перерендера.
  const [hasStepClip, setHasStepClip] = useState(() => clipboardHasKind('sequenceStep'));

  const patchStep = (i: number, patch: Partial<SequenceStep>): void => {
    onChange({ ...sequence, steps: sequence.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  };

  const moveStep = (i: number, dir: -1 | 1): void => {
    const j = i + dir;
    if (j < 0 || j >= sequence.steps.length) return;
    const steps = [...sequence.steps];
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    onChange({ ...sequence, steps });
  };

  // Перетаскивание строк — то же самое, что кнопки ↑↓, просто на несколько
  // позиций за раз (§27 доработки, УХ п.9).
  const reorderStep = (from: number, to: number): void => {
    if (from === to) return;
    const steps = [...sequence.steps];
    const [moved] = steps.splice(from, 1);
    steps.splice(to, 0, moved!);
    onChange({ ...sequence, steps });
  };

  // Copy/paste шага (§27 доработки, УХ п.13) — вставка добавляет копию в конец.
  const pasteStep = (): void => {
    const step = pasteFromClipboard<SequenceStep>('sequenceStep');
    if (step) onChange({ ...sequence, steps: [...sequence.steps, { ...step }] });
  };

  const totalMs = sequence.steps.reduce((sum, s) => sum + s.holdMs, 0);

  return (
    <>
      <div className="form-row">
        <input
          className="input input-title"
          value={sequence.name}
          onChange={(e) => onChange({ ...sequence, name: e.target.value })}
        />
        <select
          value={sequence.mode}
          onChange={(e) => onChange({ ...sequence, mode: e.target.value as Sequence['mode'] })}
        >
          <option value="loop">По кругу</option>
          <option value="once">Один раз</option>
        </select>
        <span className="dim">длительность цикла: {(totalMs / 1000).toFixed(1)} с</span>
        <span className="spacer" />
        <button
          className={!matrixOpen ? 'btn btn-small active' : 'btn btn-small'}
          onClick={() => setMatrixOpen(false)}
        >
          Список
        </button>
        <button
          className={matrixOpen ? 'btn btn-small active' : 'btn btn-small'}
          title="Сетка «шаг × прибор» — быстрая роспись значений на много приборов сразу"
          onClick={() => setMatrixOpen(true)}
        >
          Матрица
        </button>
      </div>

      <div className="form-row">
        <span className="dim" title="Отдельно от «Фейд, мс» шага — тот один фиксированный переход, это постоянный фильтр на весь выход секвенсора">
          Эффект плавности:
        </span>
        <select
          value={sequence.effect?.mode ?? 'quick'}
          onChange={(e) => {
            const mode = e.target.value as 'quick' | 'rate' | 'decay';
            onChange(
              mode === 'quick'
                ? { ...sequence, effect: undefined }
                : { ...sequence, effect: { mode, strength: sequence.effect?.strength ?? 50 } },
            );
          }}
        >
          <option value="quick">Quick (без сглаживания)</option>
          <option value="rate">Rate (плавно в обе стороны)</option>
          <option value="decay">Decay (плавно только на спад)</option>
        </select>
        {sequence.effect && (
          <label className="field">
            Сила:{' '}
            <input
              className="input input-num"
              type="number"
              min={1}
              max={100}
              value={sequence.effect.strength}
              onChange={(e) =>
                onChange({
                  ...sequence,
                  effect: { mode: sequence.effect!.mode, strength: Math.max(1, Math.min(100, Number(e.target.value))) },
                })
              }
            />
          </label>
        )}
      </div>

      <div className="form-row transport">
        {!running && (
          <button
            className="btn active"
            disabled={sequence.steps.length === 0}
            onClick={() => send({ type: 'startSequence', sequenceId: sequence.id })}
          >
            ▶ Пуск
          </button>
        )}
        {running && !running.paused && (
          <button className="btn" onClick={() => send({ type: 'pauseSequence', sequenceId: sequence.id })}>
            ⏸ Пауза
          </button>
        )}
        {running?.paused && (
          <button className="btn active" onClick={() => send({ type: 'resumeSequence', sequenceId: sequence.id })}>
            ▶ Продолжить
          </button>
        )}
        {running && (
          <button className="btn" onClick={() => send({ type: 'stopSequence', sequenceId: sequence.id })}>
            ■ Стоп
          </button>
        )}
      </div>

      {scenes.length === 0 ? (
        <div className="dim">Нет сцен — создайте их на вкладке «Сцены».</div>
      ) : matrixOpen ? (
        <SequenceMatrix project={project!} sequence={sequence} updateProject={engine.updateProject} />
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th></th>
                <th>#</th>
                <th>Сцена</th>
                <th>Фейд, мс</th>
                <th>Длительность, мс</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sequence.steps.map((step, i) => (
                <tr
                  key={i}
                  className={
                    (running && running.stepIndex === i ? 'row-playing ' : '') + (dragIndex === i ? 'row-dragging' : '')
                  }
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIndex !== null) reorderStep(dragIndex, i);
                    setDragIndex(null);
                  }}
                >
                  <td
                    className="drag-handle"
                    title="Перетащить, чтобы изменить порядок"
                    draggable
                    onDragStart={() => setDragIndex(i)}
                    onDragEnd={() => setDragIndex(null)}
                  >
                    ⠿
                  </td>
                  <td className="dim">{i + 1}</td>
                  <td>
                    <select value={step.sceneId} onChange={(e) => patchStep(i, { sceneId: e.target.value })}>
                      {scenes.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                      {!scenes.some((s) => s.id === step.sceneId) && (
                        <option value={step.sceneId}>{sceneName(step.sceneId)}</option>
                      )}
                    </select>
                  </td>
                  <td>
                    <input
                      className="input input-num"
                      type="number"
                      min={0}
                      step={50}
                      value={step.fadeMs}
                      onChange={(e) => patchStep(i, { fadeMs: Math.max(0, Number(e.target.value)) })}
                    />
                  </td>
                  <td>
                    <input
                      className="input input-num"
                      type="number"
                      min={50}
                      step={100}
                      value={step.holdMs}
                      onChange={(e) => patchStep(i, { holdMs: Math.max(50, Number(e.target.value)) })}
                    />
                  </td>
                  <td>
                    <button className="btn btn-small" disabled={i === 0} onClick={() => moveStep(i, -1)}>
                      ↑
                    </button>
                    <button
                      className="btn btn-small"
                      disabled={i === sequence.steps.length - 1}
                      onClick={() => moveStep(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      className="btn btn-small"
                      title="Копировать шаг"
                      onClick={() => {
                        copyToClipboard('sequenceStep', step);
                        setHasStepClip(true);
                      }}
                    >
                      ⧉
                    </button>
                    <button
                      className="btn btn-small"
                      onClick={() => onChange({ ...sequence, steps: sequence.steps.filter((_, j) => j !== i) })}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form-row">
            <button
              className="btn"
              onClick={() =>
                onChange({
                  ...sequence,
                  steps: [...sequence.steps, { sceneId: scenes[0]!.id, holdMs: 2000, fadeMs: 500 }],
                })
              }
            >
              + Шаг
            </button>
            {hasStepClip && (
              <button className="btn btn-small" onClick={pasteStep}>
                Вставить шаг
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
