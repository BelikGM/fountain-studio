import { useEffect, useRef, useState } from 'react';
import { keptSegments, type Show } from '@fountain-studio/shared';
import { FountainScene } from '../three/FountainScene';
import { buildDeviceIndex, createLiveHooks, type DeviceIndexEntry } from '../three/liveHooks';
import type { EngineConnection } from '../useEngine';

const CANVAS_W = 960;
const CANVAS_H = 540;

/**
 * Рендер шоу в видео (§27 доработки, УХ п.17в) — показать заказчику программу
 * до выезда на объект. Записывается тот же canvas, что «3D» вкладка (общие
 * live-хуки из three/liveHooks), звук — тот же decoded-буфер, что редактор
 * шоу уже держит в памяти, смикшированный в MediaStreamAudioDestinationNode.
 *
 * Честно про формат: исходная идея говорила «mp4», но нативный контейнер/кодек
 * MediaRecorder отдаёт браузер — где Chromium умеет писать mp4/h264, пишем в
 * mp4; где нет — .webm (тоже открывается почти везде, только не в софте,
 * которому обязательно нужен именно mp4). Что реально получилось — видно в
 * статусе после записи, а не только тут в комментарии.
 */
const MIME_CANDIDATES_AV = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
const MIME_CANDIDATES_V = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function pickMimeType(hasAudio: boolean): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of hasAudio ? MIME_CANDIDATES_AV : MIME_CANDIDATES_V) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

type Status = 'idle' | 'recording' | 'done' | 'error';

export function ShowVideoRender({
  show,
  buffer,
  engine,
  onClose,
}: {
  show: Show;
  buffer: AudioBuffer | null;
  engine: EngineConnection;
  onClose: () => void;
}) {
  const { project, frames, send } = engine;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<FountainScene | null>(null);
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const deviceIndexRef = useRef<Map<string, DeviceIndexEntry>>(project ? buildDeviceIndex(project) : new Map());
  useEffect(() => {
    deviceIndexRef.current = project ? buildDeviceIndex(project) : new Map();
  }, [project]);

  const [status, setStatus] = useState<Status>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [mimeUsed, setMimeUsed] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const rafRef = useRef(0);
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const scene = new FountainScene(containerRef.current, {
      onSelect: () => {},
      onMove: () => {},
      onMoveEnd: () => {},
      live: createLiveHooks(deviceIndexRef, framesRef),
    });
    sceneRef.current = scene;
    if (project) scene.syncLayout(project.layout);
    return () => {
      sceneRef.current = null;
      scene.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (project) sceneRef.current?.syncLayout(project.layout);
  }, [project?.layout]);

  const cleanupPlayback = (): void => {
    cancelAnimationFrame(rafRef.current);
    for (const s of audioSourcesRef.current) {
      try {
        s.stop();
      } catch {
        /* уже остановлен */
      }
    }
    audioSourcesRef.current = [];
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
  };

  // Уход с экрана рендера — глушим звук, останавливаем запись и шоу в движке.
  useEffect(
    () => () => {
      cleanupPlayback();
      if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
      send({ type: 'stopShow' });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const stop = (): void => {
    cleanupPlayback();
    send({ type: 'stopShow' });
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
  };

  const start = (): void => {
    const canvas = containerRef.current?.querySelector('canvas');
    if (!canvas) return;
    const mime = pickMimeType(!!buffer);
    if (!mime) {
      setErrorMsg('Браузер не поддерживает запись видео (MediaRecorder недоступен)');
      setStatus('error');
      return;
    }

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const dest = ctx.createMediaStreamDestination();

    if (buffer) {
      const srcDurMs = buffer.duration * 1000;
      const segments = keptSegments(show.cuts, srcDurMs);
      let when = ctx.currentTime + 0.05;
      for (const seg of segments) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(dest);
        src.connect(ctx.destination); // и в колонки — контроль во время записи
        src.start(when, seg.startMs / 1000, (seg.endMs - seg.startMs) / 1000);
        audioSourcesRef.current.push(src);
        when += (seg.endMs - seg.startMs) / 1000;
      }
    }

    const canvasStream = (canvas as HTMLCanvasElement).captureStream(30);
    const combined = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);

    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    } catch (err) {
      setErrorMsg(`Не удалось запустить запись: ${err instanceof Error ? err.message : String(err)}`);
      setStatus('error');
      return;
    }
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mime.split(';')[0] });
      setResultUrl(URL.createObjectURL(blob));
      setStatus('done');
    };
    recRef.current = rec;
    rec.start(250);
    setMimeUsed(mime);
    setStatus('recording');
    setElapsedMs(0);
    startedAtRef.current = performance.now();

    send({ type: 'playShow', showId: show.id, positionMs: 0 });

    let lastSync = 0;
    const loop = (): void => {
      const el = performance.now() - startedAtRef.current;
      setElapsedMs(el);
      const t = performance.now();
      if (t - lastSync > 500) {
        lastSync = t;
        send({ type: 'syncShow', positionMs: Math.round(el) });
      }
      if (el >= show.durationMs) {
        stop();
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  const fileExt = mimeUsed?.startsWith('video/mp4') ? 'mp4' : 'webm';
  const safeName = show.name.replace(/[^\p{L}\p{N}_-]+/gu, '_');

  return (
    <div className="modal-overlay">
      <div className="modal video-render-modal">
        <div className="panel-title">Рендер «{show.name}» в видео</div>
        <p className="dim">
          Записывается окно предпросмотра ниже — покрутите камеру мышью (как на вкладке «3D»), чтобы выбрать ракурс,
          затем нажмите «Начать запись».
        </p>
        <div ref={containerRef} className="video-render-canvas" style={{ width: CANVAS_W, height: CANVAS_H }} />
        <div className="form-row">
          {status === 'idle' && (
            <button className="btn active" onClick={start}>
              ⏺ Начать запись
            </button>
          )}
          {status === 'recording' && (
            <>
              <span className="badge badge-live">⏺ идёт запись</span>
              <span className="dim">
                {(elapsedMs / 1000).toFixed(1)} / {(show.durationMs / 1000).toFixed(1)} с
              </span>
              <button className="btn btn-danger" onClick={stop}>
                ■ Остановить
              </button>
            </>
          )}
          {status === 'done' && resultUrl && (
            <>
              <span className="ok-text">Готово ({fileExt})</span>
              <a className="btn active" href={resultUrl} download={`${safeName}.${fileExt}`}>
                ⬇ Скачать {safeName}.{fileExt}
              </a>
            </>
          )}
          {status === 'error' && <span className="warn">{errorMsg}</span>}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Закрыть
          </button>
        </div>
        {status === 'done' && fileExt === 'webm' && (
          <p className="dim">
            Браузер не поддержал запись сразу в mp4 на этом устройстве — файл в .webm (открывается в большинстве
            плееров и браузеров; при необходимости именно .mp4 файл можно перекодировать сторонним конвертером).
          </p>
        )}
      </div>
    </div>
  );
}
