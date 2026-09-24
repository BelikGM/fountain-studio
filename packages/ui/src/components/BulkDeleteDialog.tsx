import { useMemo, useState } from 'react';
import { countOf, devicesDependents, profileMap, type DeviceKind, type Project } from '@fountain-studio/shared';
import { askConfirm } from './ConfirmDialog';

/**
 * Удалить сразу несколько приборов (заказчик 24.09.2026: «приборов 38, а
 * удалять можно только по одному»).
 *
 * Безопасно в три слоя: сначала человек ВЫБИРАЕТ, что удалять (отмеченные,
 * все насосы, приборы одной фигуры…), и видит число, имена и где эти приборы
 * используются; потом отдельное подтверждение с тем же числом; и всё это одна
 * правка — Ctrl+Z возвращает приборы разом.
 */

type Scope = { id: string; label: string; ids: string[] };

const KIND_SCOPES: { kind: DeviceKind; label: string }[] = [
  { kind: 'pump', label: 'Все насосы' },
  { kind: 'valve', label: 'Все клапаны' },
  { kind: 'lamp', label: 'Все светильники' },
  { kind: 'other', label: 'Все прочие' },
];

export function BulkDeleteDialog({
  project,
  selectedIds,
  onClose,
  onDelete,
}: {
  project: Project;
  selectedIds: string[];
  onClose: () => void;
  onDelete: (ids: string[]) => void;
}) {
  const scopes = useMemo<Scope[]>(() => {
    const profiles = profileMap(project);
    const out: Scope[] = [];
    out.push({ id: 'selected', label: 'Отмеченные галочками', ids: selectedIds });
    for (const k of KIND_SCOPES) {
      const ids = project.devices.filter((d) => (profiles.get(d.profileId)?.kind ?? 'other') === k.kind).map((d) => d.id);
      if (ids.length > 0 || k.kind !== 'other') out.push({ id: k.kind, label: k.label, ids });
    }
    // Приборы, созданные фигурой, называются «Кольцо · насос 1»: предлагаем
    // убрать фигуру целиком — частый случай «создал не то, переделываю».
    const figures = new Map<string, string[]>();
    for (const d of project.devices) {
      const at = d.name.indexOf(' · ');
      if (at <= 0) continue;
      const name = d.name.slice(0, at);
      figures.set(name, [...(figures.get(name) ?? []), d.id]);
    }
    for (const [name, ids] of figures) out.push({ id: `figure:${name}`, label: `Приборы фигуры «${name}»`, ids });
    out.push({ id: 'all', label: 'Все приборы проекта', ids: project.devices.map((d) => d.id) });
    return out;
  }, [project, selectedIds]);

  const [scopeId, setScopeId] = useState(() => (selectedIds.length > 0 ? 'selected' : 'pump'));
  const scope = scopes.find((s) => s.id === scopeId) ?? scopes[0]!;
  const names = scope.ids.map((id) => project.devices.find((d) => d.id === id)?.name ?? id);
  const deps = devicesDependents(project, scope.ids);

  const run = async (): Promise<void> => {
    if (scope.ids.length === 0) return;
    const ok = await askConfirm(`Удалить ${countOf(scope.ids.length, 'прибор', 'прибора', 'приборов')}?`, {
      detail:
        `${scope.label}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` и ещё ${names.length - 6}` : ''}.` +
        (deps.length > 0 ? ` Используются: ${deps.join('; ')}.` : '') +
        ' Передумали сразу после удаления — Ctrl+Z вернёт все приборы разом.',
      okLabel: 'Удалить',
    });
    if (!ok) return;
    onDelete(scope.ids);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal bulk-delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-text">Удалить приборы</div>
        <p className="dim">Что удалить:</p>
        <div className="bulk-delete-scopes">
          {scopes.map((s) => (
            <label key={s.id} className={s.ids.length === 0 ? 'field dim' : 'field'}>
              <input
                type="radio"
                name="bulk-delete-scope"
                checked={s.id === scope.id}
                disabled={s.ids.length === 0}
                onChange={() => setScopeId(s.id)}
              />{' '}
              {s.label} <span className="dim">({s.ids.length})</span>
            </label>
          ))}
        </div>
        {scope.ids.length > 0 && (
          <div className="bulk-delete-preview">
            <div>
              {names.slice(0, 12).join(', ')}
              {names.length > 12 ? ` и ещё ${names.length - 12}` : ''}
            </div>
            {deps.length > 0 && <div className="warn">Используются: {deps.join('; ')}.</div>}
            <div className="dim">Отменить сразу после удаления — Ctrl+Z, вернутся все разом.</div>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-danger" disabled={scope.ids.length === 0} onClick={() => void run()}>
            Удалить {countOf(scope.ids.length, 'прибор', 'прибора', 'приборов')}
          </button>
        </div>
      </div>
    </div>
  );
}
