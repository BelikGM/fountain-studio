import { useState } from 'react';
import { profileMap, uid, type PatchedDevice, type Project, type Scene, type Sequence } from '@fountain-studio/shared';
import { hexToRgb, rgbToHex } from '../colorPresets';

/**
 * Матричный редактор секвенсора (§27 доработки, по примеру прежнего
 * приложения — «Area RGB/Channel») — сетка «шаг × прибор» вместо создания
 * отдельной именованной сцены на каждый шаг вручную. Не новая модель данных:
 * ячейки пишут в те же Sequence.steps[].sceneId → Scene.values, что и обычный
 * список шагов — просто быстрее для узоров на много приборов сразу
 * (наши генераторы волны/радуги уже закрывают частный случай программно,
 * матрица — для произвольной ручной росписи).
 *
 * Шаг «материализации»: если сцена шага используется где-то ещё (общая с
 * другим шагом/секвенсором), первое редактирование в матрице клонирует её в
 * отдельную — иначе правка одной ячейки могла бы неожиданно испортить сцену,
 * используемую в другом месте.
 */

type MatrixRow =
  | { key: string; kind: 'color'; device: PatchedDevice; ri: number; gi: number; bi: number; label: string }
  | {
      key: string;
      kind: 'value';
      device: PatchedDevice;
      channelIndex: number;
      twoState: boolean;
      label: string;
    };

function buildRows(project: Project): MatrixRow[] {
  const profiles = profileMap(project);
  const rows: MatrixRow[] = [];
  for (const d of project.devices) {
    const profile = profiles.get(d.profileId);
    if (!profile) continue;
    const ri = profile.channels.findIndex((c) => c.role === 'red');
    const gi = profile.channels.findIndex((c) => c.role === 'green');
    const bi = profile.channels.findIndex((c) => c.role === 'blue');
    if (ri >= 0 && gi >= 0 && bi >= 0) {
      rows.push({ key: `${d.id}:color`, kind: 'color', device: d, ri, gi, bi, label: d.name });
    } else {
      profile.channels.forEach((c, i) => {
        rows.push({
          key: `${d.id}:${i}`,
          kind: 'value',
          device: d,
          channelIndex: i,
          twoState: profile.twoState === true,
          label: profile.channels.length > 1 ? `${d.name} · ${c.name}` : d.name,
        });
      });
    }
  }
  return rows;
}

function stepSceneName(seq: Sequence, i: number): string {
  return `${seq.name} — шаг ${i + 1}`;
}

/** Даёт каждому шагу секвенсора свою собственную сцену, если она сейчас общая с чем-то ещё. Идемпотентно. */
function materialize(project: Project, sequence: Sequence): Project {
  const scenesById = new Map(project.scenes.map((s) => [s.id, s]));
  const scenes = [...project.scenes];
  let changed = false;
  const newSteps = sequence.steps.map((step, i) => {
    const wantName = stepSceneName(sequence, i);
    const current = scenesById.get(step.sceneId);
    if (current && current.name === wantName) return step;
    const clone: Scene = {
      id: uid(),
      name: wantName,
      values: current ? Object.fromEntries(Object.entries(current.values).map(([k, v]) => [k, [...v]])) : {},
    };
    scenes.push(clone);
    changed = true;
    return { ...step, sceneId: clone.id };
  });
  if (!changed) return project;
  return {
    ...project,
    scenes,
    sequences: project.sequences.map((q) => (q.id === sequence.id ? { ...sequence, steps: newSteps } : q)),
  };
}

function applyToCell(
  project: Project,
  sequenceId: string,
  row: MatrixRow,
  stepIdx: number,
  updates: { index: number; value: number }[],
): Project {
  const seq = project.sequences.find((q) => q.id === sequenceId)!;
  const step = seq.steps[stepIdx];
  if (!step) return project;
  const profile = profileMap(project).get(row.device.profileId)!;
  const scenes = project.scenes.map((s) => {
    if (s.id !== step.sceneId) return s;
    const cur = s.values[row.device.id] ?? [];
    const next = profile.channels.map((_, i) => cur[i] ?? 0);
    for (const u of updates) next[u.index] = Math.max(0, Math.min(255, Math.round(u.value)));
    return { ...s, values: { ...s.values, [row.device.id]: next } };
  });
  return { ...project, scenes };
}

function rowRaw(project: Project, sequence: Sequence, row: MatrixRow, stepIdx: number): number[] {
  const step = sequence.steps[stepIdx];
  const scene = step ? project.scenes.find((s) => s.id === step.sceneId) : undefined;
  const vals = scene?.values[row.device.id] ?? [];
  return row.kind === 'color' ? [vals[row.ri] ?? 0, vals[row.gi] ?? 0, vals[row.bi] ?? 0] : [vals[row.channelIndex] ?? 0];
}

function rowUpdates(row: MatrixRow, raw: number[]): { index: number; value: number }[] {
  return row.kind === 'color'
    ? [
        { index: row.ri, value: raw[0]! },
        { index: row.gi, value: raw[1]! },
        { index: row.bi, value: raw[2]! },
      ]
    : [{ index: row.channelIndex, value: raw[0]! }];
}

type Tool = 'edit' | 'fill' | 'ramp';

export function SequenceMatrix({
  project,
  sequence,
  updateProject,
}: {
  project: Project;
  sequence: Sequence;
  updateProject: (p: Project) => void;
}) {
  const [tool, setTool] = useState<Tool>('edit');
  const [rangeStart, setRangeStart] = useState<{ row: number; col: number } | null>(null);
  const rows = buildRows(project);

  const editCell = (row: MatrixRow, stepIdx: number, updates: { index: number; value: number }[]): void => {
    const proj = materialize(project, sequence);
    updateProject(applyToCell(proj, sequence.id, row, stepIdx, updates));
  };

  const onToolCellClick = (rowIdx: number, stepIdx: number): void => {
    if (!rangeStart) {
      setRangeStart({ row: rowIdx, col: stepIdx });
      return;
    }
    let proj = materialize(project, sequence);
    const startRow = rows[rangeStart.row]!;
    if (tool === 'ramp') {
      if (rowIdx !== rangeStart.row) {
        setRangeStart(null);
        return;
      }
      const c1 = Math.min(rangeStart.col, stepIdx);
      const c2 = Math.max(rangeStart.col, stepIdx);
      const v1 = rowRaw(proj, sequence, startRow, c1);
      const v2 = rowRaw(proj, sequence, startRow, c2);
      for (let c = c1; c <= c2; c++) {
        const t = c2 === c1 ? 0 : (c - c1) / (c2 - c1);
        const raw = v1.map((a, i) => a + (v2[i]! - a) * t);
        proj = applyToCell(proj, sequence.id, startRow, c, rowUpdates(startRow, raw));
      }
    } else {
      const r1 = Math.min(rangeStart.row, rowIdx);
      const r2 = Math.max(rangeStart.row, rowIdx);
      const c1 = Math.min(rangeStart.col, stepIdx);
      const c2 = Math.max(rangeStart.col, stepIdx);
      for (let r = r1; r <= r2; r++) {
        const rr = rows[r]!;
        const source = rowRaw(proj, sequence, rr, c1);
        for (let c = c1; c <= c2; c++) proj = applyToCell(proj, sequence.id, rr, c, rowUpdates(rr, source));
      }
    }
    updateProject(proj);
    setRangeStart(null);
  };

  if (project.devices.length === 0) {
    return <p className="dim">Нет приборов в патче — матрице нечего показывать.</p>;
  }
  if (sequence.steps.length === 0) {
    return <p className="dim">В секвенсоре нет шагов — добавьте их в списке, затем вернитесь сюда.</p>;
  }

  return (
    <div className="matrix-wrap">
      <div className="form-row">
        <span className="dim">Инструмент:</span>
        <button
          className={tool === 'edit' ? 'btn btn-small active' : 'btn btn-small'}
          onClick={() => {
            setTool('edit');
            setRangeStart(null);
          }}
        >
          Правка
        </button>
        <button
          className={tool === 'fill' ? 'btn btn-small active' : 'btn btn-small'}
          title="Клик по двум ячейкам — прямоугольник заливается значением левого столбца выделения (в каждой строке своим)"
          onClick={() => {
            setTool('fill');
            setRangeStart(null);
          }}
        >
          Заливка
        </button>
        <button
          className={tool === 'ramp' ? 'btn btn-small active' : 'btn btn-small'}
          title="Клик по двум ячейкам ОДНОЙ строки — плавный переход между их текущими значениями"
          onClick={() => {
            setTool('ramp');
            setRangeStart(null);
          }}
        >
          Линия
        </button>
        {tool !== 'edit' && (
          <span className="dim">{rangeStart ? 'Кликните вторую ячейку…' : 'Кликните первую ячейку диапазона'}</span>
        )}
      </div>
      <div className="matrix-scroll">
        <table className="matrix-table">
          <thead>
            <tr>
              <th className="matrix-rowhead" />
              {sequence.steps.map((s, i) => (
                <th key={i} className="matrix-colhead">
                  {i + 1}
                  <span className="dim"> ({s.holdMs}мс)</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={row.key}>
                <th className="matrix-rowhead">{row.label}</th>
                {sequence.steps.map((_, ci) => {
                  const isRangeStart = rangeStart?.row === ri && rangeStart.col === ci;
                  const raw = rowRaw(project, sequence, row, ci);
                  // Вне режима «Правка» ячейка — не форма, а обычный div: клик по
                  // ней должен долетать до onClick <td> без риска, что его съест
                  // disabled-элемент управления (в части браузеров клик по
                  // disabled-контролу не всплывает вообще).
                  const readOnlyContent =
                    row.kind === 'color' ? (
                      <div className="matrix-swatch" style={{ background: rgbToHex(raw[0]!, raw[1]!, raw[2]!) }} />
                    ) : row.twoState ? (
                      <span className={raw[0]! >= 128 ? 'ok-text' : 'dim'}>{raw[0]! >= 128 ? 'ОТКР' : 'ЗАКР'}</span>
                    ) : (
                      <span>{raw[0]}</span>
                    );
                  return (
                    <td
                      key={ci}
                      className={isRangeStart ? 'matrix-cell matrix-cell-active' : 'matrix-cell'}
                      onClick={tool !== 'edit' ? () => onToolCellClick(ri, ci) : undefined}
                    >
                      {tool !== 'edit' ? (
                        readOnlyContent
                      ) : row.kind === 'color' ? (
                        <input
                          type="color"
                          className="matrix-swatch"
                          value={rgbToHex(raw[0]!, raw[1]!, raw[2]!)}
                          onChange={(e) => {
                            const [r, g, b] = hexToRgb(e.target.value);
                            editCell(row, ci, rowUpdates(row, [r, g, b]));
                          }}
                        />
                      ) : row.twoState ? (
                        <button
                          className={raw[0]! >= 128 ? 'btn btn-small toggle-open' : 'btn btn-small toggle-closed'}
                          onClick={() => editCell(row, ci, rowUpdates(row, [raw[0]! >= 128 ? 0 : 255]))}
                        >
                          {raw[0]! >= 128 ? 'ОТКР' : 'ЗАКР'}
                        </button>
                      ) : (
                        <input
                          className="input input-num matrix-num"
                          type="number"
                          min={0}
                          max={255}
                          value={raw[0]}
                          onChange={(e) => editCell(row, ci, rowUpdates(row, [Number(e.target.value)]))}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
