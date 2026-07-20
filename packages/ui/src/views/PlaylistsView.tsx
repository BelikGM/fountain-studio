import { useEffect, useState } from 'react';
import { playlistDependents, uid, type Playlist } from '@fountain-studio/shared';
import { ListFilter } from '../components/ListFilter';
import { confirmDelete } from '../confirmDelete';
import type { EngineConnection } from '../useEngine';

/**
 * Плейлисты: последовательности шоу с паузами. Исполняет движок автономно
 * (его тик — мастер-часы, звук — системный ffplay на ПК движка).
 */
export function PlaylistsView({ engine }: { engine: EngineConnection }) {
  const { project, playback, send, updateProject } = engine;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const playlists = project?.playlists ?? [];
  const visiblePlaylists = playlists.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const selected = playlists.find((p) => p.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId === null && playlists.length > 0) setSelectedId(playlists[0]!.id);
    if (selectedId !== null && !playlists.some((p) => p.id === selectedId)) {
      setSelectedId(playlists[0]?.id ?? null);
    }
  }, [playlists, selectedId]);

  if (!project) return <main className="view">Ожидание проекта от движка…</main>;

  const addPlaylist = (): void => {
    const p: Playlist = { id: uid(), name: `Плейлист ${project.playlists.length + 1}`, mode: 'loop', items: [] };
    updateProject({ ...project, playlists: [...project.playlists, p] });
    setSelectedId(p.id);
  };

  const removePlaylist = (): void => {
    if (!selected) return;
    if (!confirmDelete('плейлиста', selected.name, playlistDependents(project, selected.id))) return;
    if (playback.playlist?.playlistId === selected.id) send({ type: 'stopPlaylist' });
    updateProject({ ...project, playlists: project.playlists.filter((p) => p.id !== selected.id) });
  };

  const updatePlaylist = (next: Playlist): void => {
    updateProject({ ...project, playlists: project.playlists.map((p) => (p.id === next.id ? next : p)) });
  };

  const live = playback.playlist;

  return (
    <main className="view view-split">
      <aside className="sidebar">
        <div className="sidebar-actions">
          <button className="btn" onClick={addPlaylist}>
            + Плейлист
          </button>
          <button className="btn" onClick={removePlaylist} disabled={!selected}>
            Удалить
          </button>
        </div>
        {playlists.length > 5 && <ListFilter value={filter} onChange={setFilter} />}
        <ul className="list">
          {visiblePlaylists.map((p) => (
            <li
              key={p.id}
              className={
                (p.id === selectedId ? 'list-item selected' : 'list-item') +
                (live?.playlistId === p.id ? ' playing' : '')
              }
              onClick={() => setSelectedId(p.id)}
            >
              {p.name}
              {live?.playlistId === p.id && (
                <span className="badge badge-live">{live.inGap ? 'пауза' : `№${live.itemIndex + 1}`}</span>
              )}
            </li>
          ))}
        </ul>
      </aside>

      <section className="content">
        {selected === null ? (
          <div className="dim">
            Создайте плейлист: последовательность шоу для вечерней программы. Движок играет его сам —
            редактор можно закрыть. Звук на ПК движка (нужен ffplay из бесплатного ffmpeg; без него —
            вода и свет без музыки).
          </div>
        ) : (
          <PlaylistEditor playlist={selected} engine={engine} onChange={updatePlaylist} />
        )}
      </section>
    </main>
  );
}

function PlaylistEditor({
  playlist,
  engine,
  onChange,
}: {
  playlist: Playlist;
  engine: EngineConnection;
  onChange: (p: Playlist) => void;
}) {
  const { project, playback, send } = engine;
  const shows = project?.shows ?? [];
  const live = playback.playlist?.playlistId === playlist.id ? playback.playlist : null;
  const showName = (id: string): string => shows.find((s) => s.id === id)?.name ?? '(шоу удалено)';
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const totalMs = playlist.items.reduce((sum, it) => {
    const show = shows.find((s) => s.id === it.showId);
    return sum + (show?.durationMs ?? 0) + it.gapMs;
  }, 0);

  const moveItem = (i: number, dir: -1 | 1): void => {
    const j = i + dir;
    if (j < 0 || j >= playlist.items.length) return;
    const items = [...playlist.items];
    [items[i], items[j]] = [items[j]!, items[i]!];
    onChange({ ...playlist, items });
  };

  // Перетаскивание строк — то же самое, что кнопки ↑↓, за один шаг на любую
  // позицию (§27 доработки, УХ п.9).
  const reorderItem = (from: number, to: number): void => {
    if (from === to) return;
    const items = [...playlist.items];
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved!);
    onChange({ ...playlist, items });
  };

  return (
    <>
      <div className="form-row">
        <input
          className="input input-title"
          value={playlist.name}
          onChange={(e) => onChange({ ...playlist, name: e.target.value })}
        />
        <select
          value={playlist.mode}
          onChange={(e) => onChange({ ...playlist, mode: e.target.value as Playlist['mode'] })}
        >
          <option value="loop">По кругу</option>
          <option value="once">Один раз</option>
        </select>
        <span className="dim">общая длительность: {(totalMs / 60000).toFixed(1)} мин</span>
      </div>

      <div className="form-row transport">
        {!live ? (
          <button
            className="btn active"
            disabled={playlist.items.length === 0}
            onClick={() => send({ type: 'playPlaylist', playlistId: playlist.id })}
          >
            ▶ Пуск
          </button>
        ) : (
          <>
            <button className="btn" onClick={() => send({ type: 'skipPlaylist', dir: -1 })}>
              ⏮ Пред.
            </button>
            <button className="btn" onClick={() => send({ type: 'skipPlaylist', dir: 1 })}>
              ⏭ След.
            </button>
            <button className="btn" onClick={() => send({ type: 'stopPlaylist' })}>
              ■ Стоп
            </button>
            <span className="badge badge-live">
              {live.inGap ? 'пауза между шоу' : `играет №${live.itemIndex + 1}: ${showName(playlist.items[live.itemIndex]?.showId ?? '')}`}
            </span>
          </>
        )}
      </div>

      {shows.length === 0 ? (
        <div className="dim">Нет шоу — создайте их на вкладке «Шоу».</div>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th></th>
                <th>#</th>
                <th>Шоу</th>
                <th>Длительность</th>
                <th>Пауза после, с</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {playlist.items.map((item, i) => {
                const show = shows.find((s) => s.id === item.showId);
                return (
                  <tr
                    key={i}
                    className={
                      (live && !live.inGap && live.itemIndex === i ? 'row-playing ' : '') +
                      (dragIndex === i ? 'row-dragging' : '')
                    }
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragIndex !== null) reorderItem(dragIndex, i);
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
                      <select
                        value={item.showId}
                        onChange={(e) =>
                          onChange({
                            ...playlist,
                            items: playlist.items.map((x, j) => (j === i ? { ...x, showId: e.target.value } : x)),
                          })
                        }
                      >
                        {shows.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                        {!show && <option value={item.showId}>{showName(item.showId)}</option>}
                      </select>
                    </td>
                    <td className="dim">{show ? `${Math.round(show.durationMs / 1000)} с` : '—'}</td>
                    <td>
                      <input
                        className="input input-num"
                        type="number"
                        min={0}
                        step={1}
                        value={Math.round(item.gapMs / 1000)}
                        onChange={(e) =>
                          onChange({
                            ...playlist,
                            items: playlist.items.map((x, j) =>
                              j === i ? { ...x, gapMs: Math.max(0, Number(e.target.value)) * 1000 } : x,
                            ),
                          })
                        }
                      />
                    </td>
                    <td>
                      <button className="btn btn-small" disabled={i === 0} onClick={() => moveItem(i, -1)}>
                        ↑
                      </button>
                      <button
                        className="btn btn-small"
                        disabled={i === playlist.items.length - 1}
                        onClick={() => moveItem(i, 1)}
                      >
                        ↓
                      </button>
                      <button
                        className="btn btn-small"
                        onClick={() => onChange({ ...playlist, items: playlist.items.filter((_, j) => j !== i) })}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="form-row">
            <button
              className="btn"
              onClick={() =>
                onChange({ ...playlist, items: [...playlist.items, { showId: shows[0]!.id, gapMs: 5000 }] })
              }
            >
              + Шоу в плейлист
            </button>
          </div>
        </>
      )}
    </>
  );
}
