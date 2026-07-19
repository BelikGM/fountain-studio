import { sampleFrameStats, type VideoFrameSample } from '@fountain-studio/shared';

/**
 * Достаёт кадры из видеофайла через HTMLVideoElement/canvas (DOM-API, поэтому
 * не в shared — сам анализ пикселей уже там, в sampleFrameStats). Кадр
 * уменьшается до 64×36 — для средней яркости/цвета детали не нужны, а
 * скорость важна: перемотка (`currentTime` + ожидание 'seeked') на каждый
 * кадр — единственный надёжный кросс-браузерный способ читать пиксели видео
 * не в реальном времени. При длинных роликах шаг между кадрами растёт, чтобы
 * не перематывать тысячи раз.
 */
export async function extractVideoFrameSamples(
  file: File,
  opts: { fps?: number; maxFrames?: number; onProgress?: (frac: number) => void } = {},
): Promise<VideoFrameSample[]> {
  const maxFrames = opts.maxFrames ?? 600; // ~2.5 мин при 4 fps — щадящий потолок на перемотки
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('не удалось открыть видео (формат не поддержан браузером?)'));
    });
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('не удалось определить длительность видео');

    const requestedFps = opts.fps ?? 4;
    const stepFromCap = duration / maxFrames;
    const step = Math.max(1 / requestedFps, stepFromCap);

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 36;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('canvas 2d недоступен');

    const samples: VideoFrameSample[] = [];
    for (let t = 0; t < duration; t += step) {
      await new Promise<void>((resolve) => {
        const onSeeked = (): void => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = t;
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const stats = sampleFrameStats(pixels);
      samples.push({ atMs: Math.round(t * 1000), ...stats });
      opts.onProgress?.(t / duration);
    }
    return samples;
  } finally {
    URL.revokeObjectURL(url);
  }
}
