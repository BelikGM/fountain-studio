/**
 * Самопроверка автопостановки (shared/autoshow.ts).
 *
 * Проверяем то, из-за чего прежний черновик не был похож на шоу: события
 * должны ложиться В ДОЛЮ, картина — меняться примерно раз в долю (в припеве
 * чаще, в проигрыше реже), команда — ставиться РАНЬШЕ доли на время подъёма
 * воды, а свет — жить своим, более медленным слоем.
 *
 * Трек синтетический: бочка по долям 120 BPM, громкая середина и тихие края —
 * по нему видно и сетку, и разметку частей. Настоящие треки с объекта
 * гоняются отдельно (см. docs/АВТОПОСТАНОВКА.md).
 *
 * Запуск: npm -w @fountain-studio/engine run autoshow-test
 */
import {
  analyzeTrack,
  buildAutoShow,
  figureGeometry,
  figureLevels,
  type BlocksTrack,
  type DeviceProfile,
  type Nozzle,
  type PatchedDevice,
  type Show,
} from '@fountain-studio/shared';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean | undefined, detail = ''): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ---- Синтетический трек: 120 BPM, тихо → громко → тихо ----------------------
const SR = 22050;
const BPM = 120;
const DUR_SEC = 96;
const samples = new Float32Array(SR * DUR_SEC);
const beatSec = 60 / BPM;
for (let i = 0; i < samples.length; i++) {
  const t = i / SR;
  // Громкость по частям: вступление тихо, середина громко, конец тихо.
  const part = t < 16 ? 0.25 : t < 64 ? 1 : 0.3;
  // Бочка: короткий низкочастотный удар в каждую долю.
  const phase = (t % beatSec) / beatSec;
  const kick = phase < 0.08 ? Math.sin(2 * Math.PI * 60 * t) * (1 - phase / 0.08) : 0;
  // Хай-хэт на восьмых — чтобы онсеты были не только в басу.
  const eighth = (t % (beatSec / 2)) / (beatSec / 2);
  const hat = eighth < 0.02 ? (Math.random() * 2 - 1) * 0.3 : 0;
  const pad = Math.sin(2 * Math.PI * 220 * t) * 0.08;
  samples[i] = (kick * 0.9 + hat + pad) * part;
}

const map = analyzeTrack(samples, SR);
check('темп определён около 120 BPM', Math.abs(map.bpm - BPM) <= 4 || Math.abs(map.bpm - BPM * 2) <= 6, String(map.bpm));
check('сетка долей построена', map.beatsMs.length > 100, String(map.beatsMs.length));
check('такты — каждая четвёртая доля', map.barsMs.length === Math.ceil(map.beatsMs.length / 4), `${map.barsMs.length}/${map.beatsMs.length}`);
check('удары найдены', map.onsets.length > 100, String(map.onsets.length));
check('части размечены', map.sections.length >= 2, JSON.stringify(map.sections.map((s) => s.kind)));
check(
  'тихое начало отмечено как вступление или проигрыш',
  map.sections[0]?.kind === 'intro' || map.sections[0]?.kind === 'break',
  map.sections[0]?.kind,
);
check('громкая середина отмечена как припев', map.sections.some((s) => s.kind === 'chorus' || s.kind === 'final'), JSON.stringify(map.sections.map((s) => s.kind)));

// ---- Объект: квадрат 5×5, у каждой форсунки насос, клапан и свет ------------
const profiles = new Map<string, DeviceProfile>([
  ['pump', { id: 'pump', name: 'Насос', kind: 'pump', channels: [{ name: 'Мощность', role: 'intensity' }] }],
  ['valve', { id: 'valve', name: 'Клапан', kind: 'valve', twoState: true, channels: [{ name: 'Положение', role: 'open' }] }],
  [
    'lamp',
    {
      id: 'lamp',
      name: 'Светильник RGB',
      kind: 'lamp',
      channels: [
        { name: 'Красный', role: 'red' },
        { name: 'Зелёный', role: 'green' },
        { name: 'Синий', role: 'blue' },
      ],
    },
  ],
]);

const devices: PatchedDevice[] = [];
const nozzles: Nozzle[] = [];
let addr = 1;
for (let row = 0; row < 5; row++) {
  for (let col = 0; col < 5; col++) {
    const i = row * 5 + col;
    devices.push({ id: `p${i}`, name: `Насос ${i + 1}`, profileId: 'pump', universe: 1, address: addr++ } as PatchedDevice);
    devices.push({ id: `v${i}`, name: `Клапан ${i + 1}`, profileId: 'valve', universe: 1, address: addr++ } as PatchedDevice);
    devices.push({ id: `l${i}`, name: `Свет ${i + 1}`, profileId: 'lamp', universe: 1, address: addr } as PatchedDevice);
    addr += 3;
    nozzles.push({
      id: `n${i}`,
      name: `Форсунка ${i + 1}`,
      kind: 'straight',
      x: col * 1.2,
      y: row * 1.2,
      z: 0,
      tiltDeg: 0,
      headingDeg: 0,
      maxHeightM: 4,
      widthM: 0.03,
      coneAngleDeg: 25,
      rotationSpeedDegPerSec: 0,
      riseMs: 400,
      fallMs: 600,
      pumpDeviceId: `p${i}`,
      pump2DeviceId: null,
      valveDeviceId: `v${i}`,
      lightDeviceId: `l${i}`,
      extraPumpDeviceIds: [],
      extraValveDeviceIds: [],
      extraLightDeviceIds: [],
      extraPump2DeviceIds: [],
      modelFile: null,
      modelScale: 1,
      sprayFactor: 0.3,
    } as unknown as Nozzle);
  }
}

// ---- Фигуры ----------------------------------------------------------------
{
  const geo = figureGeometry(nozzles);
  check('геометрия нормирована', Math.min(...geo.nx) === 0 && Math.max(...geo.nx) === 1);
  const all = figureLevels('all', geo, 0);
  check('«все» поднимает все форсунки', all.every((v) => v === 1));
  const wave = figureLevels('wave', geo, 0);
  check('волна в начале выше слева', (wave[0] ?? 0) > (wave[4] ?? 1), `${wave[0]} / ${wave[4]}`);
  const waveMid = figureLevels('wave', geo, 0.5);
  check('волна на середине выше в центре', (waveMid[2] ?? 0) > (waveMid[0] ?? 1), `${waveMid[2]} / ${waveMid[0]}`);
  const single = figureLevels('single', geo, 0);
  check('«одна струя» поднимает ровно одну', single.filter((v) => v > 0).length === 1);
  const low = figureLevels('low', geo, 0);
  check('«кипение» держит всех низко', low.every((v) => v > 0 && v < 0.4));
}

// ---- Черновик --------------------------------------------------------------
const show: Show = { id: 's1', name: 'Проверка', audioFile: 'x.mp3', durationMs: DUR_SEC * 1000, cuts: [], tracks: [] };
let seq = 0;
const res = buildAutoShow({
  show,
  nozzles,
  devices,
  profiles,
  map,
  uid: () => `id${++seq}`,
});

const water = res.tracks.find((t) => t.name.startsWith('Вода')) as BlocksTrack | undefined;
const light = res.tracks.find((t) => t.name.startsWith('Свет')) as BlocksTrack | undefined;
check('дорожка воды построена', (water?.blocks.length ?? 0) > 50, String(water?.blocks.length));
check('дорожка света построена', (light?.blocks.length ?? 0) > 3, String(light?.blocks.length));
check('сцены заведены', res.scenes.length > 3, String(res.scenes.length));
check('сцен не сотни — они переиспользуются', res.scenes.length < 60, String(res.scenes.length));

const beatMs = 60000 / map.bpm;
const leadMs = Math.min(beatMs / 2, 400);
{
  // Команда ставится раньше клетки сетки: вода поднимается ровно к ней.
  // Сетка — восьмые: картина меняется и внутри доли, как на объекте.
  const grid: number[] = [];
  for (let k = 0; k < map.beatsMs.length; k++) {
    grid.push(map.beatsMs[k]!);
    const next = map.beatsMs[k + 1];
    if (next !== undefined) grid.push((map.beatsMs[k]! + next) / 2);
  }
  const hits = (water?.blocks ?? []).filter((b) =>
    grid.some((t) => Math.abs(b.startMs + leadMs - t) <= Math.max(60, beatMs * 0.12)),
  ).length;
  check('картины стоят по сетке восьмых', hits / Math.max(1, water?.blocks.length ?? 1) > 0.95, `${hits}/${water?.blocks.length}`);
  check('команда идёт раньше доли (вода успевает подняться)', (water?.blocks[10]?.startMs ?? 0) % Math.round(beatMs) !== 0 || leadMs === 0);
}
check('нет картин короче 150 мс', (water?.blocks ?? []).every((b) => b.durationMs >= 150));
check('картины не длиннее пяти долей', (water?.blocks ?? []).every((b) => b.durationMs <= beatMs * 5.5));

{
  // Плотность по частям: в припеве картина меняется чаще, чем в проигрыше.
  const inKind = (kind: string): number[] => {
    const secs = map.sections.filter((s) => s.kind === kind);
    return (water?.blocks ?? [])
      .filter((b) => secs.some((s) => b.startMs >= s.startMs && b.startMs < s.endMs))
      .map((b) => b.durationMs);
  };
  const chorus = inKind('chorus').concat(inKind('final'));
  const calm = inKind('break').concat(inKind('intro'));
  const med = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : 0);
  check('в припеве картина меняется чаще, чем в тихой части', chorus.length > 0 && calm.length > 0 && med(chorus) < med(calm), `${med(chorus)} / ${med(calm)}`);
}

{
  // Сцены: насосы получают уровень, клапаны — только 0 или 255, свет — цвет.
  const figure = res.scenes.find((s) => !s.name.includes('свет'))!;
  const pumpVals = Object.entries(figure.values).filter(([id]) => id.startsWith('p'));
  const valveVals = Object.entries(figure.values).filter(([id]) => id.startsWith('v'));
  check('в сцене-фигуре есть насосы', pumpVals.length > 0);
  check('клапаны двухпозиционные', valveVals.every(([, v]) => v.every((x) => x === 0 || x === 255)), JSON.stringify(valveVals[0]));
  const colorScene = res.scenes.find((s) => s.name.includes('свет'));
  check('сцена света раскрашивает светильники', !!colorScene && Object.keys(colorScene.values).length === 25);
}

{
  const g = res.report.grade;
  check('самокритика: события в долю', g.onBeat > 0.95, g.onBeat.toFixed(2));
  check('самокритика: удержание около доли', g.holdBeats >= 0.45 && g.holdBeats <= 2.6, g.holdBeats.toFixed(2));
  check('самокритика: нет мигания', g.tooShort === 0);
  check('самокритика: цвет меняется не чаще раза в секунду', g.colorPerMin <= 90, g.colorPerMin.toFixed(1));
  check('в отчёте есть итог', res.report.summary.includes('картин воды'), res.report.summary);
  check('фигуры разные', res.report.figures.length >= 3, JSON.stringify(res.report.figures));
}

// ---- Объект без света: вода всё равно строится ------------------------------
{
  const noLamps = devices.filter((d) => !d.id.startsWith('l'));
  const r2 = buildAutoShow({ show, nozzles, devices: noLamps, profiles, map, uid: () => `z${++seq}` });
  check('без светильников вода строится', ((r2.tracks[0] as BlocksTrack | undefined)?.blocks.length ?? 0) > 0);
  check('и об отсутствии света сказано', r2.report.grade.notes.some((n) => n.includes('нет светильников')), JSON.stringify(r2.report.grade.notes));
}

console.log(`автопостановка: пройдено ${passed}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
