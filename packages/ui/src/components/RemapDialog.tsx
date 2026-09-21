import { useMemo, useState } from 'react';
import { applyAddressRemap, profileMap, type AddressRemap, type Project } from '@fountain-studio/shared';

/**
 * Переадресация каналов — окно поверх вкладки «Оборудование».
 *
 * Зачем: смонтировали не так, как в схеме. Правильная схема проекта менять
 * нельзя — по ней собраны сцены, шоу и 3D-вид. Поэтому подменяется только то,
 * что уходит в линию.
 *
 * Направление таблицы «тянущее»: слева выходной адрес, справа — адрес, ОТКУДА
 * он берёт значение. Почему так, а не наоборот, разобрано у applyAddressRemap:
 * у каждого выхода ровно один источник, значит двое не могут писать в один
 * адрес, «многие к одному» получается само, а петель не бывает вовсе —
 * источники читаются из кадра до переадресации.
 *
 * Отдельной вкладки нет намеренно: сюда лезть каждый день не надо, и случайно
 * перепутать адреса всему объекту не должно быть просто.
 */

/** Адреса, занятые приборами: universeId → адрес → имя прибора и канал. */
export function usedAddresses(project: Project): Map<number, Map<number, string>> {
  const profiles = profileMap(project);
  const out = new Map<number, Map<number, string>>();
  for (const d of project.devices) {
    const p = profiles.get(d.profileId);
    if (!p) continue;
    let per = out.get(d.universe);
    if (!per) {
      per = new Map();
      out.set(d.universe, per);
    }
    p.channels.forEach((c, i) => {
      const addr = d.address + i;
      if (addr >= 1 && addr <= 512) per!.set(addr, `${d.name} · ${c.name}`);
    });
  }
  return out;
}

interface Problem {
  level: 'warn' | 'info';
  text: string;
}

/** Разбор таблицы: что куда уехало и на что стоит посмотреть. */
export function remapReport(
  project: Project,
  used: Map<number, Map<number, string>>,
): { lines: string[]; problems: Problem[] } {
  const lines: string[] = [];
  const problems: Problem[] = [];
  const map = project.addressRemap ?? {};
  for (const [uKey, table] of Object.entries(map)) {
    const universe = Number(uKey);
    const per = used.get(universe) ?? new Map<number, string>();
    const entries = Object.entries(table)
      .map(([d, s]) => [Number(d), Number(s)] as const)
      .sort((a, b) => a[0] - b[0]);
    if (entries.length === 0) continue;
    lines.push(`Вселенная ${universe}: переадресовано ${entries.length} адр.`);
    const bySource = new Map<number, number[]>();
    for (const [dst, src] of entries) {
      const who = per.get(dst);
      lines.push(`  ${dst} ← ${src}${who ? `  (${who})` : ''}`);
      bySource.set(src, [...(bySource.get(src) ?? []), dst]);
      if (!per.has(src)) {
        problems.push({
          level: 'warn',
          text: `Вселенная ${universe}: адрес ${dst} берёт значение с адреса ${src}, а на ${src} нет ни одного прибора — там всегда ноль.`,
        });
      }
    }
    for (const [src, dsts] of bySource) {
      if (dsts.length > 1) {
        problems.push({
          level: 'info',
          text: `Вселенная ${universe}: адреса ${dsts.join(', ')} повторяют один и тот же адрес ${src} — они будут работать синхронно.`,
        });
      }
    }
    for (const [dst] of entries) {
      if (bySource.has(dst)) {
        problems.push({
          level: 'info',
          text: `Вселенная ${universe}: адрес ${dst} и сам переадресован, и служит источником. Источники читаются ДО переадресации, поэтому цепочки не получится — берётся исходное значение ${dst}.`,
        });
      }
    }
  }
  if (lines.length === 0) lines.push('Переадресации нет: каждый адрес идёт сам в себя.');
  return { lines, problems };
}

export function RemapDialog({
  project,
  frames,
  onApply,
  onClose,
}: {
  project: Project;
  /** Живые кадры ДО переадресации — по ним показываем, что реально уедет. */
  frames: Record<number, Uint8Array>;
  onApply: (remap: AddressRemap) => void;
  onClose: () => void;
}) {
  const used = useMemo(() => usedAddresses(project), [project]);
  const universeIds = useMemo(() => [...used.keys()].sort((a, b) => a - b), [used]);
  const [universe, setUniverse] = useState<number>(universeIds[0] ?? 1);
  const [draft, setDraft] = useState<AddressRemap>(() =>
    JSON.parse(JSON.stringify(project.addressRemap ?? {})) as AddressRemap,
  );
  const [onlyChanged, setOnlyChanged] = useState(false);

  const table = draft[universe] ?? {};
  const per = used.get(universe) ?? new Map<number, string>();
  const addresses = [...per.keys()].sort((a, b) => a - b);
  const shown = onlyChanged ? addresses.filter((a) => table[a] !== undefined) : addresses;

  const setSrc = (dst: number, srcRaw: number): void => {
    const src = Math.round(srcRaw);
    const next: AddressRemap = { ...draft, [universe]: { ...table } };
    if (!Number.isFinite(src) || src < 1 || src > 512 || src === dst) delete next[universe]![dst];
    else next[universe]![dst] = src;
    if (Object.keys(next[universe]!).length === 0) delete next[universe];
    setDraft(next);
  };

  const preview = { ...project, addressRemap: draft } as Project;
  const report = remapReport(preview, used);
  const changed = Object.values(draft).reduce((s, t) => s + Object.keys(t).length, 0);

  const frame = frames[universe];
  const wire = frame ? applyAddressRemap(frame, draft[universe]) : undefined;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal remap-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Переадресация каналов</h2>
        <p className="dim">
          Слева — адрес, на который прибор <b>настроен на объекте</b>. Справа — адрес, <b>откуда</b> он берёт
          значение. По умолчанию каждый берёт своё. Схему проекта это не меняет: сцены, шоу и 3D-вид
          продолжают работать с правильными адресами, подменяется только то, что уходит в кабель.
        </p>

        <div className="form-row">
          <span className="quick-row-label">Вселенная:</span>
          {universeIds.map((id) => (
            <button
              key={id}
              className={id === universe ? 'btn btn-small state-on' : 'btn btn-small'}
              onClick={() => setUniverse(id)}
            >
              {id}
              {draft[id] ? ` (${Object.keys(draft[id]!).length})` : ''}
            </button>
          ))}
          <label className="field">
            <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> только
            изменённые
          </label>
          <button
            className="btn btn-small"
            disabled={!draft[universe]}
            onClick={() => {
              const next = { ...draft };
              delete next[universe];
              setDraft(next);
            }}
          >
            Сбросить вселенную
          </button>
        </div>

        <div className="remap-body">
          <div className="remap-list">
            {addresses.length === 0 && <p className="dim">В этой вселенной нет приборов.</p>}
            {shown.map((addr) => {
              const src = table[addr];
              const moved = src !== undefined;
              return (
                <div key={addr} className={moved ? 'remap-row moved' : 'remap-row'}>
                  <span className="remap-addr">{addr}</span>
                  <span className="remap-who dim">{per.get(addr)}</span>
                  <span className="remap-arrow">←</span>
                  <input
                    className="input input-num"
                    type="number"
                    min={1}
                    max={512}
                    value={src ?? addr}
                    onChange={(e) => setSrc(addr, Number(e.target.value))}
                  />
                  {wire && <span className="dim remap-val">{wire[addr - 1]}</span>}
                  {moved && (
                    <button className="btn btn-small" data-hint="Вернуть адрес себе" onClick={() => setSrc(addr, addr)}>
                      ↺
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="remap-report">
            <h3>Что переадресовано</h3>
            <pre className="remap-pre">{report.lines.join('\n')}</pre>
            {report.problems.length > 0 && (
              <>
                <h3>На что посмотреть</h3>
                {report.problems.map((p, i) => (
                  <p key={i} className={p.level === 'warn' ? 'warn' : 'dim'}>
                    {p.text}
                  </p>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <span className="dim">изменено адресов: {changed}</span>
          <button className="btn btn-small" onClick={onClose}>
            Отмена
          </button>
          <button className="btn btn-small state-on" onClick={() => onApply(draft)}>
            Применить
          </button>
        </div>
      </div>
    </div>
  );
}
