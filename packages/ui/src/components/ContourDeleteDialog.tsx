import { useEffect, useState } from 'react';
import {
  contourOverlaps,
  contourOwnDevices,
  countOf,
  devicesDependents,
  removeContour,
  type ContourRemoval,
  type NozzleGroup,
  type Project,
} from '@fountain-studio/shared';

/**
 * «Удалить контур» с выбором, что удалить (заказчик 25.09.2026). Раньше
 * удалялась только группировка: кольцо из 36 форсунок оставалось на схеме, и
 * убирать его приходилось по одной форсунке, а удалённые на «Оборудовании»
 * приборы форсунок со схемы не убирали.
 *
 * Выбор — в самом окне, отдельного подтверждения нет: окно и есть
 * подтверждение, с числами. Одна правка — Ctrl+Z возвращает всё разом.
 */
export function ContourDeleteDialog({
  project,
  group,
  onClose,
  onApply,
}: {
  project: Project;
  group: NozzleGroup;
  onClose: () => void;
  onApply: (next: Project) => void;
}) {
  const [what, setWhat] = useState<'group' | 'elements'>('group');
  const [withDevices, setWithDevices] = useState(false);
  const own = contourOwnDevices(project, group.id);
  const overlaps = contourOverlaps(project, group.id);
  const n = group.nozzleIds.length;
  const l = group.lightIds.length;
  const elements = [n > 0 ? countOf(n, 'форсунка', 'форсунки', 'форсунок') : '', l > 0 ? countOf(l, 'прожектор', 'прожектора', 'прожекторов') : '']
    .filter(Boolean)
    .join(' и ');
  const deps = withDevices && what === 'elements' ? devicesDependents(project, own).filter((d) => !d.startsWith('форсунки') && !d.startsWith('прожекторы')) : [];
  const mode: ContourRemoval = what === 'group' ? 'group' : withDevices ? 'all' : 'elements';
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal bulk-delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-text">Удалить контур «{group.name}»</div>
        <div className="bulk-delete-scopes">
          <label className="field">
            <input type="radio" name="contour-delete" checked={what === 'group'} onChange={() => setWhat('group')} /> Только контур
            <span className="dim"> — {elements || 'элементы'} останутся на схеме на своих местах</span>
          </label>
          <label className={elements ? 'field' : 'field dim'}>
            <input type="radio" name="contour-delete" disabled={!elements} checked={what === 'elements'} onChange={() => setWhat('elements')} />{' '}
            Контур вместе с элементами<span className="dim"> — {elements ? `${elements} удалятся со схемы` : 'в контуре пусто'}</span>
          </label>
          <label className={what === 'elements' && own.length > 0 ? 'field contour-delete-sub' : 'field contour-delete-sub dim'}>
            <input
              type="checkbox"
              disabled={what !== 'elements' || own.length === 0}
              checked={withDevices && what === 'elements'}
              onChange={(e) => setWithDevices(e.target.checked)}
            />{' '}
            и их приборы на «Оборудовании» ({own.length})
            <span className="dim"> — только те, что больше ни к чему на схеме не привязаны</span>
          </label>
        </div>
        {(overlaps.length > 0 || deps.length > 0) && what === 'elements' && (
          <div className="bulk-delete-preview">
            {overlaps.length > 0 && (
              <div className="warn">
                Эти элементы входят и в {overlaps.length === 1 ? 'контур' : 'контуры'} {overlaps.map((x) => `«${x}»`).join(', ')} — оттуда
                они тоже пропадут.
              </div>
            )}
            {deps.length > 0 && <div className="warn">Приборы используются: {deps.join('; ')}.</div>}
          </div>
        )}
        <p className="dim">Передумали сразу после удаления — Ctrl+Z вернёт всё разом.</p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Отмена
          </button>
          <button
            className="btn btn-danger"
            autoFocus
            onClick={() => {
              onApply(removeContour(project, group.id, mode));
              onClose();
            }}
          >
            {mode === 'group' ? 'Удалить контур' : mode === 'elements' ? 'Удалить с элементами' : 'Удалить с элементами и приборами'}
          </button>
        </div>
      </div>
    </div>
  );
}
