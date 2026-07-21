/**
 * Демо-трек «из коробки» (§27 доработки, раздел «Продукт») — процедурный
 * арпеджио по мажорному трезвучию, не настоящая музыка (без проблем с
 * авторским правом): 16 нот по 500 мс (120 BPM) = 8 секунд, синус с коротким
 * плавным входом и экспоненциальным спадом на каждую ноту, чтобы не щёлкало.
 * Кодируется вручную в PCM WAV — тот же hand-rolled подход, что и остальные
 * форматы в проекте (DXF, ZIP), без аудио-библиотеки.
 */

const SAMPLE_RATE = 44100;
const BPM = 120;
const BEAT_MS = (60 / BPM) * 1000; // 500 мс
const NOTES_HZ = [261.63, 329.63, 392.0, 523.25]; // C4-E4-G4-C5
const BEATS = 16; // 8 секунд

export const DEMO_TRACK_DURATION_MS = Math.round(BEATS * BEAT_MS);

export function generateDemoWav(): Buffer {
  const totalSamples = Math.round((DEMO_TRACK_DURATION_MS / 1000) * SAMPLE_RATE);
  const samples = new Float32Array(totalSamples);
  const noteSamples = Math.round((BEAT_MS / 1000) * SAMPLE_RATE);

  for (let beat = 0; beat < BEATS; beat++) {
    const freq = NOTES_HZ[beat % NOTES_HZ.length]!;
    const startSample = beat * noteSamples;
    for (let i = 0; i < noteSamples; i++) {
      const t = i / SAMPLE_RATE;
      const attack = Math.min(1, i / (SAMPLE_RATE * 0.01));
      const decay = Math.exp(-t * 4);
      const env = attack * decay;
      const idx = startSample + i;
      if (idx < totalSamples) samples[idx]! += Math.sin(2 * Math.PI * freq * t) * env * 0.3;
    }
  }

  const pcm = new Int16Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767)));
  }
  return encodeWav(pcm, SAMPLE_RATE);
}

function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // моно
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate (моно, 16 бит)
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // бит на семпл
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i]!, 44 + i * 2);
  return buf;
}
