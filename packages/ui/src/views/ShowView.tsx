import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  bandEnergyEnvelope,
  bandEnvelopePoints,
  brightnessEnvelopePoints,
  colorChangeEvents,
  colorChannelEnvelopePoints,
  cutsTotalMs,
  decimateEnvelope,
  editedToSourceMs,
  energyEnvelope,
  estimateTempo,
  keptSegments,
  loudnessEnvelopePoints,
  mergeCuts,
  peakEvents,
  profileMap,
  showDependents,
  smoothEnvelopeValues,
  sourceToEditedMs,
  uid,
  type BlocksTrack,
  type CutRange,
  type DeviceProfile,
  type EnvelopePoint,
  type EnvelopeTrack,
  type Show,
  type ShowBlock,
  type ShowTrack,
  type TrackEffect,
  SMOOTHNESS_DEFAULT,
} from '@fountain-studio/shared';
import { clipboardHasKind, copyToClipboard, pasteFromClipboard } from '../clipboard';
import { ListFilter } from '../components/ListFilter';
import { confirmDelete } from '../confirmDelete';
import { comboFromEvent, getCombo } from '../hotkeys';
import { SmoothnessField } from '../components/SmoothnessField';
import type { EngineConnection } from '../useEngine';
import { extractVideoFrameSamples } from '../videoFrames';
import { ShowVideoRender } from './ShowVideoRender';
import { PauseIcon, PlayIcon, StopIcon } from '../components/Icons';

/**
 * Ширина шапки дорожки. Та же цифра стоит в .tl-head в styles.css — по ней
 * отсчитывается курсор времени. 252, а не 216: в строку должны влезть поле
 * «мс» с подписью, «Выкл», 🎚, ↑, ↓ и ✕; при 216 крестик уезжал под шкалу.
 */
const HEAD_W = 252;
const RULER_H = 28;
const AUDIO_H = 84;
/*
 * Высоты строк дорожек — под шапку слева: имя с ручкой и ряд кнопок (у
 * огибающей ещё ряд с прибором и каналом). Было 48 и 76 px, а шапке нужно 65 и
 * 85 (замер): у «Блоков» срезался ряд кнопок вместе с 🎚 — кнопку эффекта
 * плавности было просто не видно (снимок 22.09.2026).
 */
const BLOCKS_H = 66;
const ENV_H = 86;
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

/** Даунмикс в моно — вход для estimateTempo/энергии (та им работает с одним каналом). */
function toMono(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length);
  const nCh = buffer.numberOfChannels;
  for (let c = 0; c < nCh; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i]! += d[i]! / nCh;
  }
  return mono;
}

/** Шоу: таймлайн с музыкой, дорожки блоков (сцены/секвенсоры) и огибающих каналов. */
export function ShowView({ engine, readOnly = false }: { engine: EngineConnection; readOnly?: boolean }) {
  const { project, playback, send } = engine;
  /*
   * Тариф Pro: шоу можно выбрать и запустить, но не менять. Запрет стоит ЗДЕСЬ,
   * в единственной точке, через которую вьюха правит проект, — а не только на
   * кнопках. Кнопок в этой вьюхе десятки, пропустить одну легко, и тогда правка
   * ушла бы в проект тихо. Так — не уйдёт даже если кнопка осталась на виду.
   */
  const updateProject = readOnly ? () => {} : engine.updateProject;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showFilter, setShowFilter] = useState('');
  const [templateId, setTemplateId] = useState('');

  const shows = project?.shows ?? [];
  const visibleShows = shows.filter((s) => s.name.toLowerCase().includes(showFilter.trim().toLowerCase()));
  const selected = shows.find((s) => s.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId === null && shows.length > 0) setSelectedId(shows[0]!.id);
    if (selectedId !== null && !shows.some((s) => s.id === selectedId)) {
      setSelectedId(shows[0]?.id ?? null);
    }
  }, [shows, selectedId]);

  if (!project) return <main className="view">Жду данные объекта от движка…</main>;

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

  // Шаблон шоу (§27 доработки, УХ п.17а): та же структура дорожек (имена,
  // виды, опережение, привязки огибающих к устройству/каналу), но без
  // содержимого — пустые blocks/points и без своего аудиофайла, под новую
  // песню. Зоны эффекта плавности тоже не копируем: они привязаны к
  // конкретным моментам конкретного трека, в новой песне будут не к месту.
  const createFromTemplate = (): void => {
    const template = shows.find((s) => s.id === templateId);
    if (!template) return;
    const show: Show = {
      id: uid(),
      name: `${template.name} (по шаблону)`,
      audioFile: null,
      durationMs: template.durationMs,
      cuts: [],
      tracks: template.tracks.map((t) =>
        t.kind === 'blocks'
          ? { ...t, id: uid(), blocks: [], effects: [] }
          : { ...t, id: uid(), points: [] },
      ),
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

  const removeShow = async (): Promise<void> => {
    if (!selected) return;
    if (!(await confirmDelete('шоу', selected.name, showDependents(project, selected.id)))) return;
    if (playback.show?.showId === selected.id) send({ type: 'stopShow' });
    updateProject({ ...project, shows: project.shows.filter((s) => s.id !== selected.id) });
  };

  return (
    <main className="view view-split">
      <aside className="sidebar">
        {readOnly ? (
          <p className="dim">
            Тариф Pro: шоу можно выбирать и запускать, но не менять. Для правок нужен тариф Max.
          </p>
        ) : (
          <div className="sidebar-actions">
            <button className="btn" onClick={addShow}>
              + Шоу
            </button>
            <button className="btn" onClick={duplicateShow} disabled={!selected}>
              Дублировать
            </button>
            <button className="btn" onClick={() => void removeShow()} disabled={!selected}>
              Удалить
            </button>
          </div>
        )}
        {!readOnly && shows.length > 0 && (
          <div className="sidebar-actions" data-hint="Новое шоу с той же структурой дорожек (имена, виды, привязки огибающих), но без содержимого и своего аудио — задел под новую песню">
            <select className="input-mini" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">по шаблону…</option>
              {shows.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button className="btn btn-small" onClick={createFromTemplate} disabled={!templateId}>
              Создать
            </button>
          </div>
        )}
        {shows.length > 5 && <ListFilter value={showFilter} onChange={setShowFilter} />}
        <ul className="list">
          {visibleShows.map((s) => (
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
                <span className="badge badge-live badge-icon">
                  {playback.show.playing ? <PlayIcon /> : <PauseIcon />}
                </span>
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
            readOnly={readOnly}
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
  readOnly,
}: {
  show: Show;
  engine: EngineConnection;
  onChange: (show: Show) => void;
  /**
   * Тариф Pro: только смотреть и запускать. Правки в проект всё равно не
   * уходят (запрет стоит выше, в одной точке), но органы, которые ничего не
   * делают, показывать нельзя — человек решит, что программа сломалась.
   */
  readOnly: boolean;
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
  /** Какую дорожку тащим — для подсветки и самой перестановки. */
  const [dragTrack, setDragTrack] = useState<number | null>(null);
  /**
   * Набор выделенных блоков — «дорожка:блок».
   *
   * Отдельно от selBlock: тот показывает, чьи свойства открыты, а набор
   * говорит, что сдвинется, скопируется и удалится разом. Ровно как выделение
   * элементов на схеме: есть состав набора и есть активный в нём.
   */
  const [selBlocks, setSelBlocks] = useState<Set<string>>(new Set());
  const blockKey = (trackId: string, blockId: string): string => trackId + ':' + blockId;
  // Набор нужен внутри обработчиков мыши, живущих вне перерисовки.
  const selBlocksRef = useRef(selBlocks);
  selBlocksRef.current = selBlocks;
  const [drag, setDrag] = useState<DragState | null>(null);
  // Панель зон эффекта плавности дорожки (§27 доработки, УХ п.16) — открыта на
  // одной дорожке за раз, id null — все закрыты.
  const [effectsOpenId, setEffectsOpenId] = useState<string | null>(null);
  // Панель прореживания/сглаживания живой записи огибающей (§27 доработки,
  // УХ п.17б) — тот же принцип «одна открыта за раз», что и у зон эффекта.
  const [smoothOpenId, setSmoothOpenId] = useState<string | null>(null);
  // Сетка долей (§27 доработки, УХ п.14): те же estimateTempo/beatsMs, что и
  // «⚡ Автопостановка» уже используют для темпа — просто теперь ещё и на
  // экран, и как основа прилипания блоков. Считаем от decoded-буфера, доли
  // внутри вырезок выбрасываем, остальные переводим в смонтированное время.
  const [beatsMs, setBeatsMs] = useState<number[]>([]);
  const [bpm, setBpm] = useState(0);
  const [snapToBeat, setSnapToBeat] = useState(false);

  useEffect(() => {
    if (!buffer) {
      setBeatsMs([]);
      setBpm(0);
      return;
    }
    const tempo = estimateTempo(toMono(buffer), buffer.sampleRate, {});
    setBpm(tempo.bpm);
    const cuts = show.cuts;
    const inCut = (srcMs: number): boolean => cuts.some((c) => srcMs >= c.startMs && srcMs < c.endMs);
    setBeatsMs(
      tempo.beatsMs
        .filter((t) => !inCut(t))
        .map((t) => Math.round(sourceToEditedMs(cuts, t)))
        .filter((t) => t <= show.durationMs),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer, show.cuts, show.durationMs]);
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

  // ── Живая запись (§2 доработки): клавиши → блоки, фейдеры → точки огибающей ─
  // Раньше не было реализовано — просто не входило в объём того, что строилось
  // в предыдущих заходах (в исходном плане §8 упоминалось как «задел», но ни
  // одна фаза его явно не планировала). Клавиши уже переиспользуют
  // project.keys — то же самое действие одновременно и уходит в движок как
  // обычно (живой эффект виден сразу), и пишется в дорожку блоков.
  const [recording, setRecording] = useState(false);
  const [recordTrackId, setRecordTrackId] = useState<string | null>(null);
  const [envRecordArmed, setEnvRecordArmed] = useState<Set<string>>(new Set());
  const pendingKeyRecRef = useRef<Map<string, { startMs: number; type: 'scene' | 'sequence'; refId: string }>>(
    new Map(),
  );
  const lastEnvPointAtRef = useRef<Map<string, number>>(new Map());

  const blocksTracks = show.tracks.filter((t): t is BlocksTrack => t.kind === 'blocks');

  useEffect(() => {
    if (!recording || !project) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      // Не проверяем e.defaultPrevented: глобальный обработчик клавиш в App.tsx
      // сам вызывает preventDefault() на каждое обычное срабатывание привязки
      // (это нормально, не признак конфликта) — если полагаться на этот флаг,
      // запись не сработает вообще никогда, хотя живой эффект (сцена/секвенсор
      // на выходе) отработает штатно.
      if (e.repeat) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (pendingKeyRecRef.current.has(e.code)) return;
      const binding = project.keys.find((k) => k.code === e.code);
      if (!binding || (binding.action.type !== 'scene' && binding.action.type !== 'sequence')) return;
      pendingKeyRecRef.current.set(e.code, {
        startMs: currentPos(),
        type: binding.action.type,
        refId: binding.action.refId!,
      });
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      const pending = pendingKeyRecRef.current.get(e.code);
      if (!pending) return;
      pendingKeyRecRef.current.delete(e.code);
      if (!recordTrackId) return;
      const endMs = currentPos();
      const block: ShowBlock = {
        id: uid(),
        type: pending.type,
        refId: pending.refId,
        startMs: Math.round(pending.startMs),
        durationMs: Math.max(100, Math.round(endMs - pending.startMs)),
        fadeInMs: 0,
        fadeOutMs: 0,
      };
      onChange({
        ...showRef.current,
        tracks: showRef.current.tracks.map((t) =>
          t.id === recordTrackId && t.kind === 'blocks'
            ? { ...t, blocks: [...t.blocks, block].sort((a, b) => a.startMs - b.startMs) }
            : t,
        ),
      });
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [recording, recordTrackId, project, currentPos, onChange]);

  const toggleRecording = (): void => {
    if (recording) {
      setRecording(false);
      pendingKeyRecRef.current.clear();
      return;
    }
    if (blocksTracks.length === 0) return; // нечего писать — сначала «+ Дорожка блоков»
    if (!recordTrackId || !blocksTracks.some((t) => t.id === recordTrackId)) setRecordTrackId(blocksTracks[0]!.id);
    if (!playing) play();
    setRecording(true);
  };

  const recordEnvelopeValue = (track: EnvelopeTrack, value: number): void => {
    if (!recording || !envRecordArmed.has(track.id)) return;
    const now = currentPos();
    const last = lastEnvPointAtRef.current.get(track.id) ?? -Infinity;
    if (now - last < 30) return; // не чаще ~33 точки/с — плавно, но не заваливаем массив
    lastEnvPointAtRef.current.set(track.id, now);
    const points = [...track.points, { tMs: Math.round(now), value: Math.max(0, Math.min(255, Math.round(value))) }].sort(
      (a, b) => a.tMs - b.tMs,
    );
    updateTrack({ ...track, points });
  };

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

  // Пробел — пуск/пауза, Home — в начало, Ctrl+C/Ctrl+V — копировать/вставить
  // выбранный блок таймлайна (§27 доработки, УХ п.13) — вставка на позицию
  // плейхеда, в ту же дорожку, откуда скопирован (когда фокус не в поле ввода).
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
      } else if (comboFromEvent(e) === getCombo('copy')) {
        /**
         * Копируем ВЕСЬ выделенный набор — вместе с его внутренними
         * расстояниями. При вставке набор встаёт от плейхеда, сохраняя
         * рисунок: именно так переносят найденную связку блоков в другое место
         * трека, а не блок за блоком.
         */
        const sel = selBlocksRef.current;
        const picked: { trackId: string; block: ShowBlock }[] = [];
        for (const t of showRef.current.tracks) {
          if (t.kind !== 'blocks') continue;
          for (const b of t.blocks) if (sel.has(blockKey(t.id, b.id))) picked.push({ trackId: t.id, block: b });
        }
        if (picked.length === 0 && selBlock) {
          const track = showRef.current.tracks.find((t) => t.id === selBlock.trackId);
          const block = track && track.kind === 'blocks' ? track.blocks.find((b) => b.id === selBlock.blockId) : undefined;
          if (block) picked.push({ trackId: selBlock.trackId, block });
        }
        if (picked.length > 0) {
          e.preventDefault();
          const base = Math.min(...picked.map((p) => p.block.startMs));
          copyToClipboard('showBlocks', picked.map((p) => ({ ...p, offsetMs: p.block.startMs - base })));
        }
      } else if (comboFromEvent(e) === getCombo('paste') && clipboardHasKind('showBlocks')) {
        const clip = pasteFromClipboard<{ trackId: string; block: ShowBlock; offsetMs: number }[]>('showBlocks');
        if (clip && clip.length > 0) {
          e.preventDefault();
          const at = Math.round(currentPos());
          const added = new Set<string>();
          const tracks = showRef.current.tracks.map((t) => {
            if (t.kind !== 'blocks') return t;
            const mine = clip.filter((c) => c.trackId === t.id);
            if (mine.length === 0) return t;
            const fresh = mine.map((c) => {
              const nb: ShowBlock = { ...c.block, id: uid(), startMs: Math.max(0, at + c.offsetMs) };
              added.add(blockKey(t.id, nb.id));
              return nb;
            });
            return { ...t, blocks: [...t.blocks, ...fresh].sort((a, b) => a.startMs - b.startMs) };
          });
          onChange({ ...showRef.current, tracks });
          setSelBlocks(added);
        }
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
      effects: [],
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
  const [videoStatus, setVideoStatus] = useState<string | null>(null);
  const [videoBusy, setVideoBusy] = useState(false);
  // Рендер шоу в видеофайл (§27 доработки, УХ п.17в) — отдельный оверлей,
  // открывается по кнопке ниже.
  const [videoRenderOpen, setVideoRenderOpen] = useState(false);

  const autoStage = (): void => {
    if (!buffer || !project) return;
    const mono = toMono(buffer);
    const sr = buffer.sampleRate;

    const tempo = estimateTempo(mono, sr, {});
    const env = energyEnvelope(mono, sr, 80);
    const cuts = show.cuts;
    const inCut = (srcMs: number): boolean => cuts.some((c) => srcMs >= c.startMs && srcMs < c.endMs);

    // Источник → монтаж: точки внутри вырезок отбрасываем, остальные переводим
    // в смонтированное время; затем прореживаем (шаг > 250 мс или скачок > 6).
    // Общий хелпер — используется и громкостью, и полосами частот.
    const toEdited = (srcPoints: { tMs: number; value: number }[]): { tMs: number; value: number }[] => {
      const out: { tMs: number; value: number }[] = [];
      let lastT = -Infinity;
      let lastV = -Infinity;
      for (const p of srcPoints) {
        if (inCut(p.tMs)) continue;
        const t = Math.round(sourceToEditedMs(cuts, p.tMs));
        if (t > show.durationMs) break;
        if (t - lastT < 250 && Math.abs(p.value - lastV) < 6) continue;
        out.push({ tMs: t, value: p.value });
        lastT = t;
        lastV = p.value;
      }
      return out;
    };

    // Целевые устройства: все с каналом intensity (насосы/диммеры). Нет таких — черновика не будет.
    const intensityDevices = project.devices.filter((d) =>
      profiles.get(d.profileId)?.channels.some((c) => c.role === 'intensity'),
    );
    if (intensityDevices.length === 0) {
      setAutoStatus('Нет приборов с каналом уровня (насос или одноканальный свет) — добавьте их на вкладке «Оборудование».');
      return;
    }

    const newTracks: ShowTrack[] = [];
    const summary: string[] = [];

    // Общая громкость → первое устройство (обычно насос: §17 п.5 «громкость/бас → высота воды»).
    const target1 = intensityDevices[0]!;
    const ch1 = Math.max(0, profiles.get(target1.profileId)!.channels.findIndex((c) => c.role === 'intensity'));
    const loudnessPoints = toEdited(loudnessEnvelopePoints(env, { min: 0, max: 255, gamma: 1.4 }));
    const envTrack1: EnvelopeTrack = {
      id: uid(),
      name: `Громкость → ${target1.name}`,
      kind: 'envelope',
      offsetMs: 0,
      muted: false,
      deviceId: target1.id,
      channel: ch1,
      points: loudnessPoints,
    };
    newTracks.push(envTrack1);
    summary.push(`громкость → «${target1.name}» (${loudnessPoints.length} точек)`);

    // Второе устройство (если есть) — высокие частоты, отдельной полосой (блеск/вспышки света).
    if (intensityDevices.length > 1) {
      const target2 = intensityDevices[1]!;
      const ch2 = Math.max(0, profiles.get(target2.profileId)!.channels.findIndex((c) => c.role === 'intensity'));
      const trebleBand = bandEnergyEnvelope(mono, sr, [{ loHz: 2000, hiHz: 8000 }], 80, 1024).bands[0]!;
      const treblePoints = toEdited(bandEnvelopePoints(trebleBand, 80, { min: 0, max: 255, gamma: 1.2 }));
      const envTrack2: EnvelopeTrack = {
        id: uid(),
        name: `Высокие → ${target2.name}`,
        kind: 'envelope',
        offsetMs: 0,
        muted: false,
        deviceId: target2.id,
        channel: ch2,
        points: treblePoints,
      };
      newTracks.push(envTrack2);
      summary.push(`высокие частоты → «${target2.name}» (${treblePoints.length} точек)`);
    }

    // Форте → залпы (§17 п.5): заметные всплески громкости становятся короткими блоками первой сцены.
    if (project.scenes.length > 0) {
      const scene = project.scenes[0]!;
      const blocks: ShowBlock[] = [];
      for (const p of peakEvents(env, { thresholdRatio: 1.4, minGapMs: 400 })) {
        if (inCut(p.tMs)) continue;
        const t = Math.round(sourceToEditedMs(cuts, p.tMs));
        if (t > show.durationMs) continue;
        blocks.push({ id: uid(), type: 'scene', refId: scene.id, startMs: t, durationMs: 300, fadeInMs: 0, fadeOutMs: 100 });
      }
      if (blocks.length > 0) {
        const burstTrack: BlocksTrack = {
          id: uid(),
          name: `Форте → «${scene.name}»`,
          kind: 'blocks',
          offsetMs: 0,
          muted: false,
          blocks,
          effects: [],
        };
        newTracks.push(burstTrack);
        summary.push(`${blocks.length} залпов «${scene.name}» на всплесках`);
      }
    }

    onChange({ ...show, tracks: [...show.tracks, ...newTracks] });
    const bpmText = tempo.bpm > 0 ? `темп ≈ ${tempo.bpm} уд/мин` : 'темп не определён';
    setAutoStatus(`Черновик: ${summary.join(', ')}, ${bpmText}. Правьте на таймлайне.`);
  };

  // ── Анализ видео (§4 доработки) ─────────────────────────────────────────────
  // Не «обучение» в смысле ИИ (это исследовательская CV/ML-задача — см. комментарий
  // в shared/videoanalysis.ts), а рабочий прототип: яркость и цвет по кадрам ролика
  // → черновые дорожки, тем же приёмом, что аудио-автопостановка.
  const videoStage = async (file: File): Promise<void> => {
    if (!project) return;
    setVideoBusy(true);
    setVideoStatus('Читаю кадры видео…');
    try {
      const samples = await extractVideoFrameSamples(file, {
        onProgress: (frac) => setVideoStatus(`Читаю кадры видео… ${Math.round(frac * 100)}%`),
      });
      if (samples.length === 0) throw new Error('не удалось извлечь ни одного кадра');

      const cuts = show.cuts;
      const inCut = (srcMs: number): boolean => cuts.some((c) => srcMs >= c.startMs && srcMs < c.endMs);
      const toEdited = (srcPoints: { tMs: number; value: number }[]): { tMs: number; value: number }[] => {
        const out: { tMs: number; value: number }[] = [];
        let lastT = -Infinity;
        let lastV = -Infinity;
        for (const p of srcPoints) {
          if (inCut(p.tMs)) continue;
          const t = Math.round(sourceToEditedMs(cuts, p.tMs));
          if (t > show.durationMs) break;
          if (t - lastT < 250 && Math.abs(p.value - lastV) < 6) continue;
          out.push({ tMs: t, value: p.value });
          lastT = t;
          lastV = p.value;
        }
        return out;
      };

      const newTracks: ShowTrack[] = [];
      const summary: string[] = [];

      const intensityDevice = project.devices.find((d) => profiles.get(d.profileId)?.channels.some((c) => c.role === 'intensity'));
      if (intensityDevice) {
        const ch = Math.max(0, profiles.get(intensityDevice.profileId)!.channels.findIndex((c) => c.role === 'intensity'));
        const points = toEdited(brightnessEnvelopePoints(samples, { min: 0, max: 255, gamma: 1.2 }));
        newTracks.push({
          id: uid(), name: `Яркость видео → ${intensityDevice.name}`, kind: 'envelope', offsetMs: 0, muted: false,
          deviceId: intensityDevice.id, channel: ch, points,
        });
        summary.push(`яркость → «${intensityDevice.name}» (${points.length} точек)`);
      }

      const rgbDevice = project.devices.find((d) => {
        const roles = profiles.get(d.profileId)?.channels.map((c) => c.role) ?? [];
        return roles.includes('red') && roles.includes('green') && roles.includes('blue');
      });
      if (rgbDevice) {
        const channels = profiles.get(rgbDevice.profileId)!.channels;
        (['red', 'green', 'blue'] as const).forEach((role, ri) => {
          const ch = channels.findIndex((c) => c.role === role);
          if (ch < 0) return;
          const colorChannel = (['r', 'g', 'b'] as const)[ri]!;
          const points = toEdited(colorChannelEnvelopePoints(samples, colorChannel));
          newTracks.push({
            id: uid(), name: `Цвет видео (${role[0]!.toUpperCase()}) → ${rgbDevice.name}`, kind: 'envelope', offsetMs: 0,
            muted: false, deviceId: rgbDevice.id, channel: ch, points,
          });
        });
        summary.push(`цвет → «${rgbDevice.name}» (RGB, 3 дорожки)`);
      }

      if (project.scenes.length > 0) {
        const scene = project.scenes[0]!;
        const blocks: ShowBlock[] = [];
        for (const ev of colorChangeEvents(samples, { thresholdDelta: 80 })) {
          if (inCut(ev.tMs)) continue;
          const t = Math.round(sourceToEditedMs(cuts, ev.tMs));
          if (t > show.durationMs) continue;
          blocks.push({ id: uid(), type: 'scene', refId: scene.id, startMs: t, durationMs: 300, fadeInMs: 0, fadeOutMs: 100 });
        }
        if (blocks.length > 0) {
          newTracks.push({
            id: uid(), name: `Склейки видео → «${scene.name}»`, kind: 'blocks', offsetMs: 0, muted: false, blocks, effects: [],
          });
          summary.push(`${blocks.length} вспышек «${scene.name}» на монтажных склейках`);
        }
      }

      if (newTracks.length === 0) {
        setVideoStatus('Нет подходящих приборов: нужен насос или одноканальный свет и (или) светильник RGB — черновик не создан.');
        return;
      }
      onChange({ ...show, tracks: [...show.tracks, ...newTracks] });
      setVideoStatus(`Черновик из видео: ${summary.join(', ')} (${samples.length} кадров прочитано). Правьте на таймлайне.`);
    } catch (err) {
      setVideoStatus(`Ошибка чтения видео: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setVideoBusy(false);
    }
  };

  const updateTrack = (next: ShowTrack): void => {
    onChange({ ...show, tracks: show.tracks.map((t) => (t.id === next.id ? next : t)) });
  };

  const removeTrack = (id: string): void => {
    onChange({ ...show, tracks: show.tracks.filter((t) => t.id !== id) });
    if (selBlock?.trackId === id) setSelBlock(null);
  };

  /**
   * Перестановка дорожки мышью на любое место.
   *
   * Кнопки ↑↓ двигают на одну позицию — этого хватает на трёх дорожках, но
   * когда их полтора десятка, поднять нижнюю наверх становится десятком
   * кликов. Порядок дорожек — это порядок их полос на таймлайне, и собирать
   * рядом связанные (свет чаши, струи кольца) удобно именно перетаскиванием.
   */
  const reorderTrack = (from: number, to: number): void => {
    if (from === to) return;
    const tracks = [...show.tracks];
    const [moved] = tracks.splice(from, 1);
    if (!moved) return;
    tracks.splice(to, 0, moved);
    onChange({ ...show, tracks });
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
        if (!d) return null;
        /**
         * Сдвиг применяется КО ВСЕМУ набору, а растягивание — только к тому
         * блоку, за край которого потянули: одинаковая длительность у разных
         * блоков почти никогда не нужна, а вот подвинуть связку блоков как
         * целое — постоянная работа при монтаже под музыку.
         */
        const sel = selBlocksRef.current;
        const group = d.kind === 'move' && sel.size > 0;
        const next = showRef.current.tracks.map((t) => {
          if (t.kind !== 'blocks') return t;
          const touched = group
            ? t.blocks.some((b) => sel.has(blockKey(t.id, b.id)))
            : t.id === d.trackId;
          if (!touched) return t;
          const blocks = t.blocks
            .map((b) => {
              const mine = group ? sel.has(blockKey(t.id, b.id)) : t.id === d.trackId && b.id === d.blockId;
              if (!mine) return b;
              // Каждый блок едет от СВОЕГО исходного места на общую дельту.
              return group
                ? { ...b, startMs: Math.max(0, snap(b.startMs + d.dMs)) }
                : adjustedBlock(b, d);
            })
            .sort((a, b) => a.startMs - b.startMs);
          return { ...t, blocks };
        });
        onChange({ ...showRef.current, tracks: next });
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

  // Прилипание к долям (§27 доработки, УХ п.14) — вместо шага 100 мс блок
  // тянется к ближайшей доле сетки, посчитанной из estimateTempo. Нет сетки
  // (нет аудио/темп не распознан) — тихо остаёмся на обычном шаге 100 мс.
  const snap = (ms: number): number => {
    if (snapToBeat && beatsMs.length > 0) {
      let nearest = beatsMs[0]!;
      let best = Math.abs(ms - nearest);
      for (const b of beatsMs) {
        const d = Math.abs(ms - b);
        if (d < best) {
          best = d;
          nearest = b;
        }
      }
      return nearest;
    }
    return Math.round(ms / 100) * 100;
  };
  /**
   * Рамка выделения по таймлайну.
   *
   * Время берём из положения рамки по горизонтали, дорожки — по вертикали: у
   * каждой ленты в разметке стоит её id, и на отпускании достаточно спросить
   * у браузера, какие ленты рамка накрыла. Так не приходится ни держать
   * геометрию дорожек в состоянии, ни перестраивать разметку таймлайна.
   */
  const startBand = (clientX: number, clientY: number): void => {
    const el = document.createElement('div');
    el.className = 'tl-band';
    document.body.appendChild(el);
    const draw = (x: number, y: number): void => {
      el.style.left = `${Math.min(clientX, x)}px`;
      el.style.top = `${Math.min(clientY, y)}px`;
      el.style.width = `${Math.abs(x - clientX)}px`;
      el.style.height = `${Math.abs(y - clientY)}px`;
    };
    draw(clientX, clientY);
    const onMove = (e: MouseEvent): void => draw(e.clientX, e.clientY);
    const onUp = (e: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const box = el.getBoundingClientRect();
      el.remove();
      if (box.width < 4 && box.height < 4) return;
      const picked = new Set<string>();
      for (const t of showRef.current.tracks) {
        if (t.kind !== 'blocks') continue;
        const lane = document.querySelector<HTMLElement>(`[data-blocks-lane="${t.id}"]`);
        if (!lane) continue;
        const lr = lane.getBoundingClientRect();
        // Лента должна попасть в рамку по вертикали.
        if (lr.bottom < box.top || lr.top > box.bottom) continue;
        const fromMs = ((box.left - lr.left) / scale) * 1000;
        const toMs = ((box.right - lr.left) / scale) * 1000;
        for (const b of t.blocks) {
          // Берём блок, если он хоть частью попал в отрезок времени.
          if (b.startMs + b.durationMs < fromMs || b.startMs > toMs) continue;
          picked.add(blockKey(t.id, b.id));
        }
      }
      setSelBlocks((prev) => (e.ctrlKey || e.metaKey ? new Set([...prev, ...picked]) : picked));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

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
      {readOnly && (
        <p className="dim">
          Тариф Pro: шоу можно смотреть и запускать, дорожки и блоки не правятся. Перемотка и
          масштаб работают. Для правок нужен тариф Max.
        </p>
      )}
      <div className="form-row">
        <input
          className="input input-title"
          value={show.name}
          readOnly={readOnly}
          onChange={(e) => onChange({ ...show, name: e.target.value })}
        />
        {readOnly ? (
          <span className="dim">{show.audioFile ? `♪ ${show.audioFile}` : 'без музыки'}</span>
        ) : (
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
        )}
        {audioStatus === 'loading' && <span className="dim">загрузка аудио…</span>}
        {audioStatus === 'missing' && <span className="warn">аудиофайл не найден в папке объекта — загрузите его заново</span>}
        {!readOnly && !show.audioFile && (
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
          <button className="btn btn-icon active" onClick={play} disabled={durMs <= 0}>
            <PlayIcon />
            Пуск
          </button>
        ) : (
          <button className="btn btn-icon" onClick={() => pause()}>
            <PauseIcon />
            Пауза
          </button>
        )}
        <button className="btn btn-icon" onClick={stop}>
          <StopIcon />
          Стоп
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
        {!readOnly && (
          <>
            <button className="btn" onClick={addBlocksTrack}>
              + Дорожка блоков
            </button>
            <button className="btn" onClick={addEnvelopeTrack} disabled={devices.length === 0}>
              + Огибающая
            </button>
          </>
        )}
        <button
          className="btn"
          onClick={autoStage}
          disabled={!buffer}
          data-hint="Черновик шоу по музыке: громкость — на насос, высокие частоты — на второй прибор, всплески — залпами сцены. Дальше правится руками"
        >
          ⚡ Автопостановка
        </button>
        {bpm > 0 && (
          <label className="field" data-hint="Темп определён автоматически по аудиодорожке (та же оценка, что у «Автопостановки»)">
            <input type="checkbox" checked={snapToBeat} onChange={(e) => setSnapToBeat(e.target.checked)} /> прилипание к
            долям ({bpm} уд/мин)
          </label>
        )}
        <label className={videoBusy ? 'btn' : 'btn'} data-hint="Черновик шоу по видеоролику: яркость и цвет кадров — на дорожки, монтажные склейки — вспышками. Дальше правится руками">
          {videoBusy ? '🎬 Читаю…' : '🎬 Из видео'}
          <input
            type="file"
            accept="video/*"
            style={{ display: 'none' }}
            disabled={videoBusy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void videoStage(f);
              e.target.value = '';
            }}
          />
        </label>
        <button
          className="btn"
          onClick={() => {
            if (playing) pause();
            setVideoRenderOpen(true);
          }}
          disabled={durMs <= 0}
          data-hint="Записать 3D-сцену на время шоу в видеофайл — показать заказчику программу до выезда на объект"
        >
          🎥 Видеоролик шоу
        </button>
        <span className="spacer" />
        {blocksTracks.length > 0 && (
          <select
            className="input-mini"
            value={recordTrackId ?? blocksTracks[0]!.id}
            onChange={(e) => setRecordTrackId(e.target.value)}
            disabled={recording}
            data-hint="Дорожка блоков, куда пишутся клавиши во время записи"
          >
            {blocksTracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <button
          className={recording ? 'btn btn-danger active' : 'btn'}
          onClick={toggleRecording}
          disabled={blocksTracks.length === 0}
          data-hint="Живая запись: клавиши с вкладки «Клавиатура» (сцены и секвенсоры) пишутся в выбранную дорожку блоков; у огибающих с включённой записью — тяните ползунок"
        >
          {recording ? '⏺ Идёт запись' : '⏺ Запись'}
        </button>
      </div>
      {autoStatus && <div className="dim" style={{ padding: '4px 12px' }}>{autoStatus}</div>}
      {videoStatus && <div className="dim" style={{ padding: '4px 12px' }}>{videoStatus}</div>}
      {recording && (
        <div className="dim" style={{ padding: '4px 12px' }}>
          Идёт запись в «{blocksTracks.find((t) => t.id === recordTrackId)?.name ?? '?'}»: жмите клавиши сцен и
          секвенсоров (вкладка «Клавиатура») — длительность нажатия пишется как длина блока. Для огибающих — кнопка
          «●» у дорожки включает запись, тяните появившийся ползунок.
        </div>
      )}

      <div className="tl-scroll">
        <div className="tl-inner" style={{ width: HEAD_W + laneW }}>
          <div className="tl-row" style={{ height: RULER_H }}>
            <div className="tl-head tl-head-ruler" />
            <Ruler
              laneW={laneW}
              scale={scale}
              durMs={durMs}
              currentMs={dispMs}
              onSeek={seek}
              beatsMs={snapToBeat ? beatsMs : []}
            />
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
              readOnly={readOnly}
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
              <div
                className={dragTrack === ti ? 'tl-head row-dragging' : 'tl-head'}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragTrack !== null) reorderTrack(dragTrack, ti);
                  setDragTrack(null);
                }}
              >
                <div className="tl-head-top">
                <span
                  className="drag-handle"
                  data-hint="Перетащить, чтобы переставить дорожку. Кнопками ↑↓ — на одну позицию"
                  draggable
                  onDragStart={() => setDragTrack(ti)}
                  onDragEnd={() => setDragTrack(null)}
                >
                  ⠿
                </span>
                <input
                  className="input input-mini tl-track-name"
                  value={track.name}
                  onChange={(e) => updateTrack({ ...track, name: e.target.value })}
                />
                </div>
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
                    {recording && (
                      <>
                        <button
                          className={envRecordArmed.has(track.id) ? 'btn btn-small btn-danger' : 'btn btn-small'}
                          data-hint="Включить запись этой огибающей: во время воспроизведения тяните появившийся ползунок"
                          onClick={() =>
                            setEnvRecordArmed((prev) => {
                              const next = new Set(prev);
                              if (next.has(track.id)) next.delete(track.id);
                              else next.add(track.id);
                              return next;
                            })
                          }
                        >
                          ●
                        </button>
                        {envRecordArmed.has(track.id) && (
                          <input
                            type="range"
                            min={0}
                            max={255}
                            defaultValue={0}
                            className="input-mini"
                            onInput={(e) => recordEnvelopeValue(track, Number((e.target as HTMLInputElement).value))}
                          />
                        )}
                      </>
                    )}
                  </div>
                )}
                <div className="tl-head-controls">
                  <label className="dim" data-hint="Опережение дорожки, мс: команды воде можно посылать раньше, чем свету, — вода инертна">
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
                    data-hint={
                      track.muted
                        ? 'Дорожка выключена: её блоки и кривые не играют. Нажмите, чтобы включить'
                        : 'Выключить дорожку: её блоки и кривые перестанут играть, остальные дорожки — как были'
                    }
                    onClick={() => updateTrack({ ...track, muted: !track.muted })}
                  >
                    Выкл
                  </button>
                  {track.kind === 'blocks' && (
                    <button
                      className={
                        track.effects.length > 0 || effectsOpenId === track.id ? 'btn btn-small active' : 'btn btn-small'
                      }
                      data-hint="Плавность на этой дорожке: где смягчить резкие перепады значений"
                      onClick={() => setEffectsOpenId(effectsOpenId === track.id ? null : track.id)}
                    >
                      🎚{track.effects.length > 0 ? ` ${track.effects.length}` : ''}
                    </button>
                  )}
                  {track.kind === 'envelope' && track.points.length > 2 && (
                    <button
                      className={smoothOpenId === track.id ? 'btn btn-small active' : 'btn btn-small'}
                      data-hint="Прореживание и сглаживание записанной вживую огибающей"
                      onClick={() => setSmoothOpenId(smoothOpenId === track.id ? null : track.id)}
                    >
                      ∿
                    </button>
                  )}
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
                  {!readOnly && (
                    <button className="btn btn-small" onClick={() => removeTrack(track.id)}>
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {track.kind === 'blocks' ? (
                <BlocksLane
                  readOnly={readOnly}
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
                  snapMs={snap}
                  selectedKeys={selBlocks}
                  trackKey={blockKey}
                  onBand={startBand}
                  onStartDrag={(block, kind, clientX, additive) => {
                    const key = blockKey(track.id, block.id);
                    setSelBlock({ trackId: track.id, blockId: block.id });
                    setSelBlocks((prev) => {
                      if (additive) {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      }
                      // Клик по блоку, который уже в наборе, набор не сбрасывает —
                      // иначе групповой сдвиг было бы не начать.
                      return prev.has(key) ? prev : new Set([key]);
                    });
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
                  readOnly={readOnly}
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
              начало, с:{' '}
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
              конец, с:{' '}
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
                <button className="btn btn-small" data-hint="Восстановить фрагмент" onClick={() => removeCut(i)}>
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

        {effectsOpenId &&
          (() => {
            const track = show.tracks.find((t) => t.id === effectsOpenId);
            if (!track || track.kind !== 'blocks') return null;
            return (
              <TrackEffectsPanel
                track={track}
                durationMs={show.durationMs}
                onChange={(effects) => updateTrack({ ...track, effects })}
              />
            );
          })()}

        {smoothOpenId &&
          (() => {
            const track = show.tracks.find((t) => t.id === smoothOpenId);
            if (!track || track.kind !== 'envelope') return null;
            return (
              <EnvelopeSmoothPanel
                track={track}
                onApply={(points) => {
                  updateTrack({ ...track, points });
                  setSmoothOpenId(null);
                }}
              />
            );
          })()}
      </div>

      {videoRenderOpen && (
        <ShowVideoRender show={show} buffer={buffer} engine={engine} onClose={() => setVideoRenderOpen(false)} />
      )}
    </>
  );
}

// ── Линейка времени ──────────────────────────────────────────────────────────

function Ruler({
  laneW,
  scale,
  durMs,
  currentMs,
  onSeek,
  beatsMs = [],
}: {
  laneW: number;
  scale: number;
  durMs: number;
  currentMs: number;
  onSeek: (ms: number) => void;
  /** Сетка долей (§27 доработки, УХ п.14) — пусто, если прилипание выключено/темп не определён. */
  beatsMs?: number[];
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

  // Колесо мыши — скраб (§27 доработки, по примеру прежнего приложения). React
  // вешает onWheel как passive-слушатель — preventDefault там молча не
  // срабатывает (и страница вместе со скрабом прокручивается) — нужен родной
  // addEventListener с passive:false. currentMs/onSeek — через ref, чтобы не
  // пересоздавать слушатель на каждый рендер (позиция обновляется часто).
  const rulerElRef = useRef<HTMLDivElement | null>(null);
  const wheelStateRef = useRef({ currentMs, onSeek });
  wheelStateRef.current = { currentMs, onSeek };
  useEffect(() => {
    const el = rulerElRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const stepMs = e.shiftKey ? 1000 : 200;
      const { currentMs: cur, onSeek: seek } = wheelStateRef.current;
      seek(cur + (e.deltaY > 0 ? stepMs : -stepMs));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      ref={rulerElRef}
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
      {beatsMs.map((t, i) => (
        <div key={`b${i}`} className="tick-beat" style={{ left: t * (scale / 1000) }} />
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
  readOnly,
}: {
  laneW: number;
  scale: number;
  buffer: AudioBuffer | null;
  cuts: CutRange[];
  sel: CutRange | null;
  onSelect: (sel: CutRange | null) => void;
  onSeek: (ms: number) => void;
  /** Тариф Pro: правки в таймлайне запрещены. */
  readOnly: boolean;
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
        if (readOnly) return;
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
  snapMs,
  selBlockId,
  selectedKeys,
  trackKey,
  sceneName,
  seqName,
  onAdd,
  onStartDrag,
  onBand,
  readOnly,
}: {
  track: BlocksTrack;
  laneW: number;
  scale: number;
  drag: DragState | null;
  adjustedBlock: (b: ShowBlock, d: DragState) => ShowBlock;
  /** Прилипание к сетке — то же, что при записи в проект. */
  snapMs: (ms: number) => number;
  selBlockId: string | null;
  /** Ключи выделенных блоков — по ним подсвечиваем весь набор. */
  selectedKeys: Set<string>;
  trackKey: (trackId: string, blockId: string) => string;
  sceneName: (id: string) => string;
  seqName: (id: string) => string;
  onAdd: (tMs: number) => void;
  onStartDrag: (block: ShowBlock, kind: 'move' | 'resize', clientX: number, additive: boolean) => void;
  /** Начата рамка выделения — с Shift по пустому месту ленты. */
  onBand: (clientX: number, clientY: number) => void;
  /** Тариф Pro: правки в таймлайне запрещены. */
  readOnly: boolean;
}) {
  return (
    <div
      className={track.muted ? 'tl-lane lane-muted' : 'tl-lane'}
      data-blocks-lane={track.id}
      style={{ width: laneW }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.block')) return;
        const r = e.currentTarget.getBoundingClientRect();
        onAdd(((e.clientX - r.left) / scale) * 1000);
      }}
      data-hint="Двойной щелчок — добавить блок · Shift и протяжка — выделить блоки рамкой"
      onMouseDown={(e) => {
        if (readOnly) return;
        if (!e.shiftKey || (e.target as HTMLElement).closest('.block')) return;
        e.preventDefault();
        onBand(e.clientX, e.clientY);
      }}
    >
      {track.blocks.map((raw) => {
        const inSet = selectedKeys.has(trackKey(track.id, raw.id));
        const dragged = drag !== null && drag.trackId === track.id && drag.blockId === raw.id;
        /**
         * Двигается ВЕСЬ набор: тянут один блок — едут все выделенные, и
         * каждый от своего исходного места. Растягивание так не размножается:
         * его получает только тот блок, за край которого взялись.
         */
        const b =
          drag === null
            ? raw
            : dragged && drag.kind === 'resize'
              ? adjustedBlock(raw, drag)
              : drag.kind === 'move' && (dragged || inSet)
                ? { ...raw, startMs: Math.max(0, snapMs(raw.startMs + drag.dMs)) }
                : raw;
        return (
          <div
            key={b.id}
            className={
              'block' +
              (b.type === 'sequence' ? ' block-seq' : '') +
              (b.id === selBlockId ? ' selected' : '') +
              (inSet ? ' block-marked' : '')
            }
            style={{ left: (b.startMs / 1000) * scale, width: Math.max(8, (b.durationMs / 1000) * scale) }}
            onMouseDown={(e) => {
        if (readOnly) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              const kind = e.clientX > r.right - 8 ? 'resize' : 'move';
              onStartDrag(raw, kind, e.clientX, e.ctrlKey || e.metaKey);
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
  readOnly,
}: {
  track: EnvelopeTrack;
  laneW: number;
  scale: number;
  pointDrag: PointDrag | null;
  onAddPoint: (tMs: number, value: number) => void;
  onRemovePoint: (i: number) => void;
  onStartDrag: (i: number) => void;
  /** Тариф Pro: правки в таймлайне запрещены. */
  readOnly: boolean;
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
      data-blocks-lane={track.id}
      style={{ width: laneW }}
      data-lane={track.id}
      data-hint="Двойной щелчок — точка; правая кнопка — удалить точку"
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
        if (readOnly) return;
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
        начало, с:{' '}
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
        длительность, с:{' '}
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
        нарастание, мс:{' '}
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
        затухание, мс:{' '}
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

/**
 * Зоны эффекта плавности дорожки (§27 доработки, УХ п.16): промежуток времени
 * (числами) + режим + сила. Вне зон дорожка ведёт себя как раньше (Quick).
 */
function TrackEffectsPanel({
  track,
  durationMs,
  onChange,
}: {
  track: BlocksTrack;
  durationMs: number;
  onChange: (effects: TrackEffect[]) => void;
}) {
  const patch = (id: string, p: Partial<TrackEffect>): void =>
    onChange(track.effects.map((e) => (e.id === id ? { ...e, ...p } : e)));
  const addZone = (): void => {
    const start = 0;
    const end = Math.min(durationMs, Math.max(500, Math.round(durationMs * 0.2)));
    onChange([...track.effects, { id: uid(), mode: 'rate', smoothness: SMOOTHNESS_DEFAULT, startMs: start, endMs: end }]);
  };
  return (
    <div className="panel">
      <div className="panel-title">Эффект плавности на «{track.name}»</div>
      <p className="dim">
        Вне зон значение применяется мгновенно. Внутри зоны оно подходит к новому плавно — так
        резкий перепад (например, 255 → 0 на стыке блоков) превращается в переход. Чем больше
        плавность, тем дольше переход; рядом написано время.
      </p>
      <p className="dim">
        Проверить проще всего так: поставить зону на стык двух блоков с разными значениями,
        запустить шоу и смотреть вкладку «Поток» — там видно, что уходит приборам. Плавность 100
        (10 с) видно сразу глазами, плавность 1 (0,1 с) от мгновенного перехода уже не отличить.
      </p>
      {track.effects.length === 0 && <p className="dim">Зон ещё нет.</p>}
      {track.effects.map((e) => (
        <div className="form-row" key={e.id}>
          <select value={e.mode} onChange={(ev) => patch(e.id, { mode: ev.target.value as 'rate' | 'decay' })}>
            <option value="rate">Плавно вверх и вниз</option>
            <option value="decay">Плавно только вниз</option>
          </select>
          <SmoothnessField value={e.smoothness} onChange={(v) => patch(e.id, { smoothness: v })} />
          <label data-hint="С какой секунды дорожки зона действует.">
            начало, с:{' '}
            <input
              className="input input-num"
              type="number"
              step={0.1}
              min={0}
              value={(e.startMs / 1000).toFixed(1)}
              onChange={(ev) => patch(e.id, { startMs: Math.max(0, Number(ev.target.value) * 1000) })}
            />
          </label>
          <label data-hint="По какую секунду дорожки зона действует.">
            конец, с:{' '}
            <input
              className="input input-num"
              type="number"
              step={0.1}
              min={0}
              value={(e.endMs / 1000).toFixed(1)}
              onChange={(ev) => patch(e.id, { endMs: Math.max(e.startMs + 100, Number(ev.target.value) * 1000) })}
            />
          </label>
          <button className="btn btn-small" onClick={() => onChange(track.effects.filter((x) => x.id !== e.id))}>
            ✕
          </button>
        </div>
      ))}
      <button className="btn btn-small" onClick={addZone}>
        + Зона
      </button>
    </div>
  );
}

/**
 * Прореживание/сглаживание живой записи огибающей (§27 доработки, УХ п.17б).
 * Оба ползунка считаются на лету (превью числа точек до применения), правка
 * дорожки происходит одним «Применить» — черновик не сохраняется, пока не
 * подтверждён.
 */
function EnvelopeSmoothPanel({
  track,
  onApply,
}: {
  track: EnvelopeTrack;
  onApply: (points: EnvelopePoint[]) => void;
}) {
  const [windowMs, setWindowMs] = useState(150);
  const [tolerance, setTolerance] = useState(4);
  const preview = useMemo(
    () => decimateEnvelope(smoothEnvelopeValues(track.points, windowMs), tolerance),
    [track.points, windowMs, tolerance],
  );
  return (
    <div className="panel">
      <div className="panel-title">Сглаживание «{track.name}»</div>
      <p className="dim">Убирает дрожь и лишние точки живой записи. Точки по времени не двигаются.</p>
      <div className="form-row">
        <label>
          окно сглаживания, мс:{' '}
          <input
            type="range"
            min={0}
            max={1000}
            step={10}
            value={windowMs}
            onChange={(e) => setWindowMs(Number(e.target.value))}
          />{' '}
          {windowMs}
        </label>
      </div>
      <div className="form-row">
        <label>
          сколько точек убрать:{' '}
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={tolerance}
            onChange={(e) => setTolerance(Number(e.target.value))}
          />{' '}
          {tolerance}
        </label>
      </div>
      <div className="form-row">
        <span className="dim">
          было {track.points.length} точек → станет {preview.length}
        </span>
        <button className="btn" onClick={() => onApply(preview)}>
          Применить
        </button>
      </div>
    </div>
  );
}
