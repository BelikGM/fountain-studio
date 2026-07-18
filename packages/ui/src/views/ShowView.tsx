import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cutsTotalMs,
  editedToSourceMs,
  energyEnvelope,
  estimateTempo,
  keptSegments,
  loudnessEnvelopePoints,
  mergeCuts,
  profileMap,
  sourceToEditedMs,
  uid,
  type BlocksTrack,
  type CutRange,
  type DeviceProfile,
  type EnvelopeTrack,
  type Show,
  type ShowBlock,
  type ShowTrack,
} from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';

const HEAD_W = 216;
const RULER_H = 28;
const AUDIO_H = 84;
const BLOCKS_H = 48;
const ENV_H = 76;
/** Ограничение ширины холста волновой формы (лимиты canvas у браузеров). */
const MAX_LANE_W = 30000;

/** Декодированные аудиофайлы: имя → буфер (живёт, пока открыт редактор). */
const audioCache = new Map<string, AudioBuffer>();

function fmtTime(ms: number): string {
  const t = Math.max(0, ms) / 1000;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Шоу: таймлайн с музыкой, дорожки блоков (сцены/секвенсоры) и огибающих каналов. */
export function ShowView({ engine }: { engine: EngineConnection }) {
  const { project, playback, send, updateProject } = engine;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const shows = project?.shows ?? [];
  const selected = shows.find((s) => s.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId === null && shows.length > 0) setSelectedId(shows[0]!.id);
    if (selectedId !== null && !shows.some((s) => s.id === selectedId)) {
      setSelectedId(shows[0]?.id ?? null);
    }
  }, [shows, selectedId]);

  if (!project) return <main className="view">Ожидание проекта от движка…</main>;

  const addShow = (): void => {
    const show: Show = {
      id: uid(),
      name: `Шоу ${project.shows.length + 1}`,
      audioFile: null,
      durationMs: 60_000,
      cuts: [],
      tracks: [],
    };
    updateProject({ ...project, shows: [...project.shows, show] });
    setSelectedId(show.id);
  };

  const duplicateShow = (): void => {
    if (!selected) return;
    const copy: Show = JSON.parse(JSON.stringify(selected)) as Show;
    copy.id = uid();
    copy.name = `${selected.name} (копия)`;
    for (const t of copy.tracks) {
      t.id = uid();
      if (t.kind === 'blocks') for (const b of t.blocks) b.id = uid();
    }
    updateProject({ ...project, shows: [...project.shows, copy] });
    setSelectedId(copy.id);
  };

  const removeShow = (): void => {
    if (!selected) return;
    if (playback.show?.showId === selected.id) send({ type: 'stopShow' });
    updateProject({ ...project, shows: project.shows.filter((s) => s.id !== selected.id) });
  };

  return (
    <main className="view view-split">
      <aside className="sidebar">
        <div className="sidebar-actions">
          <button className="btn" onClick={addShow}>
            + Шоу
          </button>
          <button className="btn" onClick={duplicateShow} disabled={!selected}>
            Дублировать
          </button>
          <button className="btn" onClick={removeShow} disabled={!selected}>
            Удалить
          </button>
        </div>
        <ul className="list">
          {shows.map((s) => (
            <li
              key={s.id}
              className={
                (s.id === selectedId ? 'list-item selected' : 'list-item') +
                (playback.show?.showId === s.id ? ' playing' : '')
              }
              onClick={() => setSelectedId(s.id)}
            >
              {s.name}
              {playback.show?.showId === s.id && (
                <span className="badge badge-live">{playback.show.playing ? '▶' : '⏸'}</span>
              )}
            </li>
          ))}
        </ul>
      </aside>

      <section className="content content-show">
        {selected === null ? (
          <div className="dim">Создайте шоу слева: таймлайн с музыкой, дорожками сцен и огибающих.</div>
        ) : (
          <ShowEditor
            key={selected.id}
            show={selected}
            engine={engine}
            onChange={(next) =>
              updateProject({ ...project, shows: project.shows.map((s) => (s.id === next.id ? next : s)) })
            }
          />
        )}
      </section>
    </main>
  );
}

// ── Редактор одного шоу ──────────────────────────────────────────────────────

interface DragState {
  kind: 'move' | 'resize';
  trackId: string;
  blockId: string;
  startX: number;
  origStartMs: number;
  origDurMs: number;
  dMs: number;
}

interface PointDrag {
  trackId: string;
  index: number;
  tMs: number;
  value: number;
}

function ShowEditor({
  show,
  engine,
  onChange,
}: {
  show: Show;
  engine: EngineConnection;
  onChange: (show: Show) => void;
}) {
  const { project, send, requestAudio } = engine;
  const [pxPerSec, setPxPerSec] = useState(30);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(
    show.audioFile ? (audioCache.get(show.audioFile) ?? null) : null,
  );
  const [audioStatus, setAudioStatus] = useState<'none' | 'loading' | 'ready' | 'missing'>(
    show.audioFile ? (audioCache.has(show.audioFile) ? 'ready' : 'loading') : 'none',
  );
  const [playing, setPlaying] = useState(false);
  const [dispMs, setDispMs] = useState(0);
  const [sel, setSel] = useState<CutRange | null>(null);
  const [selBlock, setSelBlock] = useState<{ trackId: string; blockId: string } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [pointDrag, setPointDrag] = useState<PointDrag | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const posRef = useRef(0);
  const anchorRef = useRef<{ pos: number; at: number } | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const showRef = useRef(show);
  showRef.current = show;

  const durMs = show.durationMs;
  const laneW = Math.min(MAX_LANE_W, Math.max(200, Math.ceil((durMs / 1000) * pxPerSec)));
  const scale = durMs > 0 ? laneW / (durMs / 1000) : pxPerSec; // px на секунду с учётом ограничения ширины
  const xOf = (ms: number): number => (ms / 1000) * scale;
  const msOf = (x: number): number => (x / scale) * 1000;

  const ensureCtx = (): AudioContext => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  };
  const nowMs = (): number => (ctxRef.current ? ctxRef.current.currentTime * 1000 : performance.now());
  const currentPos = useCallback((): number => {
    const a = anchorRef.current;
    return a ? Math.min(showRef.current.durationMs, a.pos + (nowMs() - a.at)) : posRef.current;
  }, []);

  // ── Загрузка и декодирование аудио ─────────────────────────────────────────
  useEffect(() => {
    const name = show.audioFile;
    if (!name) {
      setBuffer(null);
      setAudioStatus('none');
      return;
    }
    const cached = audioCache.get(name);
    if (cached) {
      setBuffer(cached);
      setAudioStatus('ready');
      return;
    }
    let cancelled = false;
    setAudioStatus('loading');
    void requestAudio(name).then(async (data) => {
      if (cancelled) return;
      if (!data) {
        setAudioStatus('missing');
        return;
      }
      try {
        const buf = await ensureCtx().decodeAudioData(data.buffer.slice(0) as ArrayBuffer);
        audioCache.set(name, buf);
        if (!cancelled) {
          setBuffer(buf);
          setAudioStatus('ready');
        }
      } catch {
        if (!cancelled) setAudioStatus('missing');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [show.audioFile, requestAudio]);

  // Длительность смонтированного таймлайна = аудио минус вырезки.
  useEffect(() => {
    if (!buffer) return;
    const edited = Math.max(0, Math.round(buffer.duration * 1000) - cutsTotalMs(show.cuts));
    if (edited > 0 && edited !== show.durationMs) onChange({ ...show, durationMs: edited });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer, show.cuts]);

  // ── Транспорт (мастер-часы — аудио редактора) ──────────────────────────────
  const stopSources = (): void => {
    for (const s of sourcesRef.current) {
      try {
        s.stop();
      } catch {
        /* уже остановлен */
      }
    }
    sourcesRef.current = [];
  };

  const scheduleAudio = (fromEditedMs: number): void => {
    const ctx = ctxRef.current;
    if (!ctx || !buffer) return;
    const srcDurMs = buffer.duration * 1000;
    const segments = keptSegments(show.cuts, srcDurMs);
    let editedStart = 0;
    let when = ctx.currentTime + 0.03;
    for (const seg of segments) {
      const segLen = seg.endMs - seg.startMs;
      const editedEnd = editedStart + segLen;
      if (editedEnd > fromEditedMs) {
        const skip = Math.max(0, fromEditedMs - editedStart);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(when, (seg.startMs + skip) / 1000, (segLen - skip) / 1000);
        sourcesRef.current.push(src);
        when += (segLen - skip) / 1000;
      }
      editedStart = editedEnd;
    }
  };

  const play = (): void => {
    if (playing || durMs <= 0) return;
    const from = posRef.current >= durMs ? 0 : posRef.current;
    posRef.current = from;
    if (buffer) {
      const ctx = ensureCtx();
      void ctx.resume();
      stopSources();
      scheduleAudio(from);
    }
    anchorRef.current = { pos: from, at: nowMs() };
    setPlaying(true);
    send({ type: 'playShow', showId: show.id, positionMs: Math.round(from) });
  };

  const pause = (atMs?: number): void => {
    posRef.current = atMs ?? currentPos();
    anchorRef.current = null;
    stopSources();
    setPlaying(false);
    setDispMs(posRef.current);
    send({ type: 'pauseShow' });
  };

  const stop = (): void => {
    posRef.current = 0;
    anchorRef.current = null;
    stopSources();
    setPlaying(false);
    setDispMs(0);
    send({ type: 'stopShow' });
  };

  const seek = (ms: number): void => {
    const clamped = Math.max(0, Math.min(durMs, ms));
    posRef.current = clamped;
    setDispMs(clamped);
    if (playing) {
      stopSources();
      scheduleAudio(clamped);
      anchorRef.current = { pos: clamped, at: nowMs() };
      send({ type: 'seekShow', positionMs: Math.round(clamped) });
    } else if (engine.playback.show?.showId === show.id) {
      // Шоу загружено в движок (пауза) — скраб сразу виден на выходе DMX.
      send({ type: 'seekShow', positionMs: Math.round(clamped) });
    }
  };

  // Пока играет: двигаем курсор, обновляем счётчик, шлём коррекцию позиции движку.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let lastDisp = 0;
    let lastSync = 0;
    const loop = (): void => {
      const pos = currentPos();
      if (playheadRef.current) playheadRef.current.style.left = `${HEAD_W + xOf(pos)}px`;
      const t = performance.now();
      if (t - lastDisp > 100) {
        lastDisp = t;
        setDispMs(pos);
      }
      if (t - lastSync > 500) {
        lastSync = t;
        send({ type: 'syncShow', positionMs: Math.round(pos) });
      }
      if (pos >= showRef.current.durationMs) {
        pause(showRef.current.durationMs);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, scale]);

  // Курсор в актуальной позиции и на паузе (после перемотки/зума).
  useEffect(() => {
    if (playheadRef.current) playheadRef.current.style.left = `${HEAD_W + xOf(dispMs)}px`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispMs, scale, show.tracks.length]);

  // Пробел — пуск/пауза, Home — в начало (когда фокус не в поле ввода).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        playing ? pause() : play();
      } else if (e.code === 'Home') {
        e.preventDefault();
        seek(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Уход со вкладки/смена шоу: глушим локальный звук (движок продолжает сам).
  useEffect(() => stopSources, []);

  // ── Аудиофайл ──────────────────────────────────────────────────────────────
  const onUpload = async (file: File): Promise<void> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    send({ type: 'uploadAudio', name: file.name, dataBase64: btoa(bin) });
    setAudioStatus('loading');
    try {
      const buf = await ensureCtx().decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
      audioCache.set(file.name, buf);
      setBuffer(buf);
      setAudioStatus('ready');
      onChange({
        ...show,
        audioFile: file.name,
        cuts: [],
        durationMs: Math.round(buf.duration * 1000),
      });
    } catch {
      setAudioStatus('missing');
    }
  };

  // ── Вырезки ────────────────────────────────────────────────────────────────
  const applyCut = (): void => {
    if (!sel || !buffer) return;
    const a = Math.min(sel.startMs, sel.endMs);
    const b = Math.max(sel.startMs, sel.endMs);
    if (b - a < 50) return;
    if (playing) pause();
    // Выделение в смонтированном времени → диапазон исходного файла.
    const cut: CutRange = {
      startMs: Math.round(editedToSourceMs(show.cuts, a)),
      endMs: Math.round(editedToSourceMs(show.cuts, b)),
    };
    const cuts = mergeCuts([...show.cuts, cut]);
    const edited = Math.max(0, Math.round(buffer.duration * 1000) - cutsTotalMs(cuts));
    onChange({ ...show, cuts, durationMs: edited });
    setSel(null);
    if (posRef.current > edited) posRef.current = edited;
  };

  const removeCut = (i: number): void => {
    if (playing) pause();
    const cuts = show.cuts.filter((_, j) => j !== i);
    const edited = buffer ? Math.max(0, Math.round(buffer.duration * 1000) - cutsTotalMs(cuts)) : show.durationMs;
    onChange({ ...show, cuts, durationMs: edited });
  };

  // ── Дорожки ────────────────────────────────────────────────────────────────
  const devices = project?.devices ?? [];
  const profiles = project ? profileMap(project) : new Map<string, DeviceProfile>();

  const addBlocksTrack = (): void => {
    const track: BlocksTrack = {
      id: uid(),
      name: `Дорожка ${show.tracks.length + 1}`,
      kind: 'blocks',
      offsetMs: 0,
      muted: false,
      blocks: [],
    };
    onChange({ ...show, tracks: [...show.tracks, track] });
  };

  const addEnvelopeTrack = (): void => {
    const dev = devices[0];
    if (!dev) return;
    const track: EnvelopeTrack = {
      id: uid(),
      name: `Огибающая ${show.tracks.length + 1}`,
      kind: 'envelope',
      offsetMs: 0,
      muted: false,
      deviceId: dev.id,
      channel: 0,
      points: [],
    };
    onChange({ ...show, tracks: [...show.tracks, track] });
  };

  // ── Автопостановка от аудиоанализа (§17 п.5) ───────────────────────────────
  const [autoStatus, setAutoStatus] = useState<string | null>(null);

  const autoStage = (): void => {
    if (!buffer || !project) return;
    // Downmix в моно.
    const ch0 = buffer.getChannelData(0);
    const mono = new Float32Array(ch0.length);
    const nCh = buffer.numberOfChannels;
    for (let c = 0; c < nCh; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) mono[i]! += d[i]! / nCh;
    }
    const sr = buffer.sampleRate;

    const tempo = estimateTempo(mono, sr, {});
    const env = energyEnvelope(mono, sr, 80);
    const srcPoints = loudnessEnvelopePoints(env, { min: 0, max: 255, gamma: 1.4 });

    // Источник → монтаж: точки внутри вырезок отбрасываем, остальные переводим
    // в смонтированное время; затем прореживаем (шаг > 250 мс или скачок > 6).
    const cuts = show.cuts;
    const inCut = (srcMs: number): boolean => cuts.some((c) => srcMs >= c.startMs && srcMs < c.endMs);
    const edited: { tMs: number; value: number }[] = [];
    let lastT = -Infinity;
    let lastV = -Infinity;
    for (const p of srcPoints) {
      if (inCut(p.tMs)) continue;
      const t = Math.round(sourceToEditedMs(cuts, p.tMs));
      if (t > show.durationMs) break;
      if (t - lastT < 250 && Math.abs(p.value - lastV) < 6) continue;
      edited.push({ tMs: t, value: p.value });
      lastT = t;
      lastV = p.value;
    }

    // Целевые устройства: все с каналом intensity (насосы/диммеры). Нет таких — огибающая не создаётся.
    const intensityDevices = project.devices.filter((d) =>
      profiles.get(d.profileId)?.channels.some((c) => c.role === 'intensity'),
    );
    if (intensityDevices.length === 0) {
      setAutoStatus('Нет устройств с каналом «яркость/мощность» — добавьте насос или диммер в патч.');
      return;
    }
    // Одна огибающая громкости на первое такое устройство; остальные пользователь
    // размножит копированием дорожки. Опережение воды по инерции — offsetMs правит вручную.
    const target = intensityDevices[0]!;
    const channel = profiles.get(target.profileId)!.channels.findIndex((c) => c.role === 'intensity');
    const track: EnvelopeTrack = {
      id: uid(),
      name: `Громкость → ${target.name}`,
      kind: 'envelope',
      offsetMs: 0,
      muted: false,
      deviceId: target.id,
      channel: Math.max(0, channel),
      points: edited,
    };
    onChange({ ...show, tracks: [...show.tracks, track] });
    const bpmText = tempo.bpm > 0 ? `темп ≈ ${tempo.bpm} BPM` : 'темп не определён';
    setAutoStatus(`Черновик: огибающая громкости на «${target.name}» (${edited.length} точек), ${bpmText}. Правьте на таймлайне.`);
  };

  const updateTrack = (next: ShowTrack): void => {
    onChange({ ...show, tracks: show.tracks.map((t) => (t.id === next.id ? next : t)) });
  };

  const removeTrack = (id: string): void => {
    onChange({ ...show, tracks: show.tracks.filter((t) => t.id !== id) });
    if (selBlock?.trackId === id) setSelBlock(null);
  };

  const moveTrack = (i: number, dir: -1 | 1): void => {
    const j = i + dir;
    if (j < 0 || j >= show.tracks.length) return;
    const tracks = [...show.tracks];
    [tracks[i], tracks[j]] = [tracks[j]!, tracks[i]!];
    onChange({ ...show, tracks });
  };

  // ── Перетаскивание блоков (локально, запись в проект на отпускании) ────────
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent): void => {
      setDrag((d) => (d ? { ...d, dMs: msOf(e.clientX - d.startX) } : null));
    };
    const onUp = (): void => {
      setDrag((d) => {
        if (d) {
          const track = showRef.current.tracks.find((t) => t.id === d.trackId);
          if (track && track.kind === 'blocks') {
            const blocks = track.blocks
              .map((b) => (b.id === d.blockId ? adjustedBlock(b, d) : b))
              .sort((a, b) => a.startMs - b.startMs);
            updateTrack({ ...track, blocks });
          }
        }
        return null;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null, scale]);

  const snap = (ms: number): number => Math.round(ms / 100) * 100;
  const adjustedBlock = (b: ShowBlock, d: DragState): ShowBlock =>
    d.kind === 'move'
      ? { ...b, startMs: Math.max(0, snap(d.origStartMs + d.dMs)) }
      : { ...b, durationMs: Math.max(200, snap(d.origDurMs + d.dMs)) };

  // ── Перетаскивание точек огибающих ─────────────────────────────────────────
  useEffect(() => {
    if (!pointDrag) return;
    const onMove = (e: MouseEvent): void => {
      const lane = document.querySelector<HTMLElement>(`[data-lane="${pointDrag.trackId}"]`);
      if (!lane) return;
      const r = lane.getBoundingClientRect();
      const tMs = Math.max(0, Math.min(showRef.current.durationMs, msOf(e.clientX - r.left)));
      const value = Math.max(0, Math.min(255, Math.round(255 * (1 - (e.clientY - r.top - 4) / (ENV_H - 8)))));
      setPointDrag((p) => (p ? { ...p, tMs, value } : null));
    };
    const onUp = (): void => {
      setPointDrag((p) => {
        if (p) {
          const track = showRef.current.tracks.find((t) => t.id === p.trackId);
          if (track && track.kind === 'envelope') {
            const points = track.points
              .map((pt, i) => (i === p.index ? { tMs: Math.round(p.tMs), value: p.value } : pt))
              .sort((a, b) => a.tMs - b.tMs);
            updateTrack({ ...track, points });
          }
        }
        return null;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointDrag !== null, scale]);

  // ── Разметка ───────────────────────────────────────────────────────────────
  const selectedBlockData = useMemo(() => {
    if (!selBlock) return null;
    const track = show.tracks.find((t) => t.id === selBlock.trackId);
    if (!track || track.kind !== 'blocks') return null;
    const block = track.blocks.find((b) => b.id === selBlock.blockId);
    return block ? { track, block } : null;
  }, [selBlock, show.tracks]);

  const engineShow = engine.playback.show;
  const scenes = project?.scenes ?? [];
  const sequences = project?.sequences ?? [];

  return (
    <>
      <div className="form-row">
        <input
          className="input input-title"
          value={show.name}
          onChange={(e) => onChange({ ...show, name: e.target.value })}
        />
        <label className="btn">
          {show.audioFile ? `♪ ${show.audioFile}` : '♪ Загрузить аудио…'}
          <input
            type="file"
            accept="audio/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onUpload(f);
              e.target.value = '';
            }}
          />
        </label>
        {audioStatus === 'loading' && <span className="dim">загрузка аудио…</span>}
        {audioStatus === 'missing' && <span className="warn">аудиофайл не найден в хранилище движка</span>}
        {!show.audioFile && (
          <label className="dim">
            длительность, с:{' '}
            <input
              className="input input-num"
              type="number"
              min={1}
              value={Math.round(durMs / 1000)}
              onChange={(e) => onChange({ ...show, durationMs: Math.max(1, Number(e.target.value)) * 1000 })}
            />
          </label>
        )}
      </div>

      <div className="form-row transport">
        {!playing ? (
          <button className="btn active" onClick={play} disabled={durMs <= 0}>
            ▶ Пуск
          </button>
        ) : (
          <button className="btn" onClick={() => pause()}>
            ⏸ Пауза
          </button>
        )}
        <button className="btn" onClick={stop}>
          ■ Стоп
        </button>
        <span className="time-display">
          {fmtTime(dispMs)} / {fmtTime(durMs)}
        </span>
        {engineShow?.showId === show.id && (
          <span className="badge badge-live">движок: {engineShow.playing ? 'играет' : 'пауза'}</span>
        )}
        <span className="spacer" />
        <button className="btn btn-small" onClick={() => setPxPerSec((z) => Math.max(4, z / 1.5))}>
          −
        </button>
        <span className="dim">масштаб</span>
        <button className="btn btn-small" onClick={() => setPxPerSec((z) => Math.min(400, z * 1.5))}>
          +
        </button>
        <button className="btn" onClick={addBlocksTrack}>
          + Дорожка блоков
        </button>
        <button className="btn" onClick={addEnvelopeTrack} disabled={devices.length === 0}>
          + Огибающая
        </button>
        <button
          className="btn"
          onClick={autoStage}
          disabled={!buffer}
          title="Аудиоанализ трека: черновая огибающая громкости на насос/диммер + оценка темпа (§17)"
        >
          ⚡ Автопостановка
        </button>
      </div>
      {autoStatus && <div className="dim" style={{ padding: '4px 12px' }}>{autoStatus}</div>}

      <div className="tl-scroll">
        <div className="tl-inner" style={{ width: HEAD_W + laneW }}>
          <div className="tl-row" style={{ height: RULER_H }}>
            <div className="tl-head tl-head-ruler" />
            <Ruler laneW={laneW} scale={scale} durMs={durMs} onSeek={seek} />
          </div>

          <div className="tl-row" style={{ height: AUDIO_H }}>
            <div className="tl-head">
              <div className="tl-track-name dim">Аудио</div>
              {sel && (
                <div className="tl-head-controls">
                  <button className="btn btn-small" onClick={applyCut} disabled={!buffer}>
                    ✂ Вырезать
                  </button>
                  <button className="btn btn-small" onClick={() => setSel(null)}>
                    ✕
                  </button>
                </div>
              )}
            </div>
            <WaveLane
              laneW={laneW}
              scale={scale}
              buffer={buffer}
              cuts={show.cuts}
              sel={sel}
              onSelect={setSel}
              onSeek={seek}
            />
          </div>

          {show.tracks.map((track, ti) => (
            <div key={track.id} className="tl-row" style={{ height: track.kind === 'blocks' ? BLOCKS_H : ENV_H }}>
              <div className="tl-head">
                <input
                  className="input input-mini tl-track-name"
                  value={track.name}
                  onChange={(e) => updateTrack({ ...track, name: e.target.value })}
                />
                {track.kind === 'envelope' && (
                  <div className="tl-head-controls">
                    <select
                      className="input-mini"
                      value={track.deviceId}
                      onChange={(e) => updateTrack({ ...track, deviceId: e.target.value, channel: 0 })}
                    >
                      {devices.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                    <select
                      className="input-mini"
                      value={track.channel}
                      onChange={(e) => updateTrack({ ...track, channel: Number(e.target.value) })}
                    >
                      {(profiles.get(devices.find((d) => d.id === track.deviceId)?.profileId ?? '')?.channels ?? []).map(
                        (c, i) => (
                          <option key={i} value={i}>
                            {c.name}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                )}
                <div className="tl-head-controls">
                  <label className="dim" title="Опережение дорожки, мс: вода читается раньше света">
                    <input
                      className="input input-mini input-offset"
                      type="number"
                      step={100}
                      value={track.offsetMs}
                      onChange={(e) => updateTrack({ ...track, offsetMs: Number(e.target.value) || 0 })}
                    />
                    мс
                  </label>
                  <button
                    className={track.muted ? 'btn btn-small btn-danger' : 'btn btn-small'}
                    title="Приглушить дорожку"
                    onClick={() => updateTrack({ ...track, muted: !track.muted })}
                  >
                    M
                  </button>
                  <button className="btn btn-small" disabled={ti === 0} onClick={() => moveTrack(ti, -1)}>
                    ↑
                  </button>
                  <button
                    className="btn btn-small"
                    disabled={ti === show.tracks.length - 1}
                    onClick={() => moveTrack(ti, 1)}
                  >
                    ↓
                  </button>
                  <button className="btn btn-small" onClick={() => removeTrack(track.id)}>
                    ✕
                  </button>
                </div>
              </div>

              {track.kind === 'blocks' ? (
                <BlocksLane
                  track={track}
                  laneW={laneW}
                  scale={scale}
                  drag={drag}
                  adjustedBlock={adjustedBlock}
                  selBlockId={selBlock?.trackId === track.id ? selBlock.blockId : null}
                  sceneName={(id) => scenes.find((s) => s.id === id)?.name ?? '?'}
                  seqName={(id) => sequences.find((q) => q.id === id)?.name ?? '?'}
                  onAdd={(tMs) => {
                    const ref = scenes[0] ?? null;
                    const seq = sequences[0] ?? null;
                    if (!ref && !seq) return;
                    const block: ShowBlock = {
                      id: uid(),
                      type: ref ? 'scene' : 'sequence',
                      refId: ref ? ref.id : seq!.id,
                      startMs: Math.max(0, snap(tMs)),
                      durationMs: 4000,
                      fadeInMs: 0,
                      fadeOutMs: 0,
                    };
                    updateTrack({ ...track, blocks: [...track.blocks, block].sort((a, b) => a.startMs - b.startMs) });
                    setSelBlock({ trackId: track.id, blockId: block.id });
                  }}
                  onStartDrag={(block, kind, clientX) => {
                    setSelBlock({ trackId: track.id, blockId: block.id });
                    setDrag({
                      kind,
                      trackId: track.id,
                      blockId: block.id,
                      startX: clientX,
                      origStartMs: block.startMs,
                      origDurMs: block.durationMs,
                      dMs: 0,
                    });
                  }}
                />
              ) : (
                <EnvelopeLane
                  track={track}
                  laneW={laneW}
                  scale={scale}
                  pointDrag={pointDrag?.trackId === track.id ? pointDrag : null}
                  onAddPoint={(tMs, value) => {
                    const points = [...track.points, { tMs: Math.round(tMs), value }].sort((a, b) => a.tMs - b.tMs);
                    updateTrack({ ...track, points });
                  }}
                  onRemovePoint={(i) => updateTrack({ ...track, points: track.points.filter((_, j) => j !== i) })}
                  onStartDrag={(i) => {
                    const pt = track.points[i]!;
                    setPointDrag({ trackId: track.id, index: i, tMs: pt.tMs, value: pt.value });
                  }}
                />
              )}
            </div>
          ))}

          <div ref={playheadRef} className="playhead" style={{ left: HEAD_W }} />
        </div>
      </div>

      <div className="show-panels">
        {sel && (
          <div className="panel">
            <div className="panel-title">Выделение аудио</div>
            <label>
              с, с:{' '}
              <input
                className="input input-num"
                type="number"
                step={0.1}
                min={0}
                value={(Math.min(sel.startMs, sel.endMs) / 1000).toFixed(1)}
                onChange={(e) => setSel({ startMs: Number(e.target.value) * 1000, endMs: Math.max(sel.startMs, sel.endMs) })}
              />
            </label>
            <label>
              по, с:{' '}
              <input
                className="input input-num"
                type="number"
                step={0.1}
                min={0}
                value={(Math.max(sel.startMs, sel.endMs) / 1000).toFixed(1)}
                onChange={(e) => setSel({ startMs: Math.min(sel.startMs, sel.endMs), endMs: Number(e.target.value) * 1000 })}
              />
            </label>
            <button className="btn" onClick={applyCut} disabled={!buffer}>
              ✂ Вырезать фрагмент
            </button>
          </div>
        )}

        {show.cuts.length > 0 && (
          <div className="panel">
            <div className="panel-title">Вырезки (по исходному файлу)</div>
            {show.cuts.map((c, i) => (
              <span key={i} className="cut-chip">
                {fmtTime(c.startMs)}–{fmtTime(c.endMs)}
                <button className="btn btn-small" title="Восстановить фрагмент" onClick={() => removeCut(i)}>
                  ↩
                </button>
              </span>
            ))}
          </div>
        )}

        {selectedBlockData && (
          <BlockPanel
            track={selectedBlockData.track}
            block={selectedBlockData.block}
            scenes={scenes}
            sequences={sequences}
            onChange={(b) =>
              updateTrack({
                ...selectedBlockData.track,
                blocks: selectedBlockData.track.blocks
                  .map((x) => (x.id === b.id ? b : x))
                  .sort((a, x) => a.startMs - x.startMs),
              })
            }
            onRemove={() => {
              updateTrack({
                ...selectedBlockData.track,
                blocks: selectedBlockData.track.blocks.filter((x) => x.id !== selectedBlockData.block.id),
              });
              setSelBlock(null);
            }}
          />
        )}
      </div>
    </>
  );
}

// ── Линейка времени ──────────────────────────────────────────────────────────

function Ruler({
  laneW,
  scale,
  durMs,
  onSeek,
}: {
  laneW: number;
  scale: number;
  durMs: number;
  onSeek: (ms: number) => void;
}) {
  const steps = [0.1, 0.5, 1, 2, 5, 10, 30, 60];
  const minor = steps.find((s) => s * scale >= 9) ?? 60;
  const major = minor * 5;
  const ticks: { x: number; label: string | null }[] = [];
  for (let t = 0; t <= durMs / 1000 + 1e-9; t = Math.round((t + minor) * 1000) / 1000) {
    const isMajor = Math.round(t / minor) % 5 === 0;
    ticks.push({ x: t * scale, label: isMajor ? fmtTime(t * 1000) : null });
  }
  const seekAt = (e: React.MouseEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(((e.clientX - r.left) / scale) * 1000);
  };
  return (
    <div
      className="tl-lane ruler"
      style={{ width: laneW }}
      onMouseDown={(e) => {
        seekAt(e);
        const move = (ev: MouseEvent): void => {
          const r = (e.target as HTMLElement).closest('.ruler')!.getBoundingClientRect();
          onSeek(((ev.clientX - r.left) / scale) * 1000);
        };
        const up = (): void => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    >
      {ticks.map((t, i) => (
        <div key={i} className={t.label !== null ? 'tick tick-major' : 'tick'} style={{ left: t.x }}>
          {t.label !== null && <span className="tick-label">{t.label}</span>}
        </div>
      ))}
      <span className="dim ruler-hint">масштаб: {major} с</span>
    </div>
  );
}

// ── Волновая форма ───────────────────────────────────────────────────────────

function WaveLane({
  laneW,
  scale,
  buffer,
  cuts,
  sel,
  onSelect,
  onSeek,
}: {
  laneW: number;
  scale: number;
  buffer: AudioBuffer | null;
  cuts: CutRange[];
  sel: CutRange | null;
  onSelect: (sel: CutRange | null) => void;
  onSeek: (ms: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    ctx2d.clearRect(0, 0, laneW, AUDIO_H);
    if (!buffer) {
      ctx2d.fillStyle = '#2a2e38';
      ctx2d.fillRect(0, AUDIO_H / 2 - 1, laneW, 2);
      return;
    }
    const data = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const mid = AUDIO_H / 2;
    ctx2d.fillStyle = '#3ba7e0';
    for (let x = 0; x < laneW; x++) {
      // Пиксель смонтированной шкалы → отрезок исходного файла (вырезки перепрыгнуты).
      const src0 = editedToSourceMs(cuts, (x / scale) * 1000);
      const src1 = editedToSourceMs(cuts, ((x + 1) / scale) * 1000);
      const s0 = Math.floor((src0 / 1000) * sr);
      const s1 = Math.min(data.length, Math.max(s0 + 1, Math.floor((src1 / 1000) * sr)));
      if (s0 >= data.length) break;
      let min = 1;
      let max = -1;
      const stride = Math.max(1, Math.floor((s1 - s0) / 64));
      for (let s = s0; s < s1; s += stride) {
        const v = data[s]!;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y0 = mid - max * (mid - 4);
      const y1 = mid - min * (mid - 4);
      ctx2d.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }, [buffer, cuts, laneW, scale]);

  const msAt = (e: { clientX: number }, el: HTMLElement): number => {
    const r = el.getBoundingClientRect();
    return Math.max(0, ((e.clientX - r.left) / scale) * 1000);
  };

  return (
    <div
      className="tl-lane wave"
      style={{ width: laneW }}
      onMouseDown={(e) => {
        const el = e.currentTarget;
        const startMs = msAt(e, el);
        let moved = false;
        const move = (ev: MouseEvent): void => {
          const cur = msAt(ev, el);
          if (Math.abs(cur - startMs) > (5 / scale) * 1000 || moved) {
            moved = true;
            onSelect({ startMs, endMs: cur });
          }
        };
        const up = (ev: MouseEvent): void => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          if (!moved) onSeek(msAt(ev, el));
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    >
      <canvas ref={canvasRef} width={laneW} height={AUDIO_H} />
      {sel && (
        <div
          className="wave-sel"
          style={{
            left: Math.min(sel.startMs, sel.endMs) / 1000 * scale,
            width: Math.abs(sel.endMs - sel.startMs) / 1000 * scale,
          }}
        />
      )}
    </div>
  );
}

// ── Дорожка блоков ───────────────────────────────────────────────────────────

function BlocksLane({
  track,
  laneW,
  scale,
  drag,
  adjustedBlock,
  selBlockId,
  sceneName,
  seqName,
  onAdd,
  onStartDrag,
}: {
  track: BlocksTrack;
  laneW: number;
  scale: number;
  drag: DragState | null;
  adjustedBlock: (b: ShowBlock, d: DragState) => ShowBlock;
  selBlockId: string | null;
  sceneName: (id: string) => string;
  seqName: (id: string) => string;
  onAdd: (tMs: number) => void;
  onStartDrag: (block: ShowBlock, kind: 'move' | 'resize', clientX: number) => void;
}) {
  return (
    <div
      className={track.muted ? 'tl-lane lane-muted' : 'tl-lane'}
      style={{ width: laneW }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.block')) return;
        const r = e.currentTarget.getBoundingClientRect();
        onAdd(((e.clientX - r.left) / scale) * 1000);
      }}
      title="Двойной щелчок — добавить блок"
    >
      {track.blocks.map((raw) => {
        const b = drag && drag.trackId === track.id && drag.blockId === raw.id ? adjustedBlock(raw, drag) : raw;
        return (
          <div
            key={b.id}
            className={
              'block' + (b.type === 'sequence' ? ' block-seq' : '') + (b.id === selBlockId ? ' selected' : '')
            }
            style={{ left: (b.startMs / 1000) * scale, width: Math.max(8, (b.durationMs / 1000) * scale) }}
            onMouseDown={(e) => {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              const kind = e.clientX > r.right - 8 ? 'resize' : 'move';
              onStartDrag(raw, kind, e.clientX);
            }}
          >
            <span className="block-label">{b.type === 'scene' ? sceneName(b.refId) : `⟳ ${seqName(b.refId)}`}</span>
            <span className="block-resize" />
          </div>
        );
      })}
    </div>
  );
}

// ── Дорожка огибающей ────────────────────────────────────────────────────────

function EnvelopeLane({
  track,
  laneW,
  scale,
  pointDrag,
  onAddPoint,
  onRemovePoint,
  onStartDrag,
}: {
  track: EnvelopeTrack;
  laneW: number;
  scale: number;
  pointDrag: PointDrag | null;
  onAddPoint: (tMs: number, value: number) => void;
  onRemovePoint: (i: number) => void;
  onStartDrag: (i: number) => void;
}) {
  const points = pointDrag
    ? track.points
        .map((p, i) => (i === pointDrag.index ? { tMs: pointDrag.tMs, value: pointDrag.value } : p))
        .sort((a, b) => a.tMs - b.tMs)
    : track.points;
  const yOf = (v: number): number => 4 + (1 - v / 255) * (ENV_H - 8);
  const poly = points.map((p) => `${(p.tMs / 1000) * scale},${yOf(p.value)}`).join(' ');

  return (
    <div
      className={track.muted ? 'tl-lane lane-muted' : 'tl-lane'}
      style={{ width: laneW }}
      data-lane={track.id}
      title="Двойной щелчок — точка; правая кнопка — удалить точку"
    >
      <svg width={laneW} height={ENV_H} className="env-svg">
        {points.length > 0 && <polyline points={poly} className="env-line" />}
        {track.points.map((p, i) => {
          const shown = pointDrag && pointDrag.index === i ? { tMs: pointDrag.tMs, value: pointDrag.value } : p;
          return (
            <circle
              key={i}
              cx={(shown.tMs / 1000) * scale}
              cy={yOf(shown.value)}
              r={4.5}
              className="env-point"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onStartDrag(i);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onRemovePoint(i);
              }}
            />
          );
        })}
      </svg>
      <div
        className="env-hit"
        onDoubleClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const tMs = ((e.clientX - r.left) / scale) * 1000;
          const value = Math.max(0, Math.min(255, Math.round(255 * (1 - (e.clientY - r.top - 4) / (ENV_H - 8)))));
          onAddPoint(tMs, value);
        }}
      />
    </div>
  );
}

// ── Панель выбранного блока ──────────────────────────────────────────────────

function BlockPanel({
  track,
  block,
  scenes,
  sequences,
  onChange,
  onRemove,
}: {
  track: BlocksTrack;
  block: ShowBlock;
  scenes: { id: string; name: string }[];
  sequences: { id: string; name: string }[];
  onChange: (b: ShowBlock) => void;
  onRemove: () => void;
}) {
  const options = block.type === 'scene' ? scenes : sequences;
  return (
    <div className="panel">
      <div className="panel-title">Блок на «{track.name}»</div>
      <select
        value={block.type}
        onChange={(e) => {
          const type = e.target.value as ShowBlock['type'];
          const first = (type === 'scene' ? scenes : sequences)[0];
          if (first) onChange({ ...block, type, refId: first.id });
        }}
      >
        <option value="scene">Сцена</option>
        <option value="sequence">Секвенсор</option>
      </select>
      <select value={block.refId} onChange={(e) => onChange({ ...block, refId: e.target.value })}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <label>
        старт, с:{' '}
        <input
          className="input input-num"
          type="number"
          step={0.1}
          min={0}
          value={(block.startMs / 1000).toFixed(1)}
          onChange={(e) => onChange({ ...block, startMs: Math.max(0, Number(e.target.value) * 1000) })}
        />
      </label>
      <label>
        длит., с:{' '}
        <input
          className="input input-num"
          type="number"
          step={0.1}
          min={0.2}
          value={(block.durationMs / 1000).toFixed(1)}
          onChange={(e) => onChange({ ...block, durationMs: Math.max(200, Number(e.target.value) * 1000) })}
        />
      </label>
      <label>
        фейд-ввод, мс:{' '}
        <input
          className="input input-num"
          type="number"
          step={100}
          min={0}
          value={block.fadeInMs}
          onChange={(e) => onChange({ ...block, fadeInMs: Math.max(0, Number(e.target.value)) })}
        />
      </label>
      <label>
        фейд-вывод, мс:{' '}
        <input
          className="input input-num"
          type="number"
          step={100}
          min={0}
          value={block.fadeOutMs}
          onChange={(e) => onChange({ ...block, fadeOutMs: Math.max(0, Number(e.target.value)) })}
        />
      </label>
      <button className="btn btn-danger" onClick={onRemove}>
        Удалить блок
      </button>
    </div>
  );
}
