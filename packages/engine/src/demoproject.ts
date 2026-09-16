import {
  BOWL_DEFAULTS,
  LIGHT_DEFAULTS, emptyProject, ringPositions, uid, type Project } from '@fountain-studio/shared';
import { DEMO_TRACK_DURATION_MS } from './demoaudio';

/**
 * Демо-проект «из коробки» (§27 доработки, раздел «Продукт») — вместо
 * пустого экрана при первом запуске: пара форсунок, пара прожекторов,
 * несколько сцен, дежурный секвенсор и короткое демо-шоу под процедурный
 * трек (см. demoaudio.ts). Показывает продукт в действии сразу же, вместо
 * заставляя покупателя сначала во всём разобраться самому.
 */
export const DEMO_AUDIO_FILE = 'demo-track.wav';

export function createDemoProject(): Project {
  const project = emptyProject('Демо-проект');

  project.devices = [
    { id: 'demo-pump1', name: 'Насос 1', profileId: 'pump', universe: 1, address: 1 },
    { id: 'demo-valve1', name: 'Клапан 1', profileId: 'valve', universe: 1, address: 2 },
    { id: 'demo-pump2', name: 'Насос 2', profileId: 'pump', universe: 1, address: 3 },
    { id: 'demo-valve2', name: 'Клапан 2', profileId: 'valve', universe: 1, address: 4 },
    { id: 'demo-light1', name: 'Свет 1', profileId: 'rgb', universe: 1, address: 5 },
    { id: 'demo-light2', name: 'Свет 2', profileId: 'rgb', universe: 1, address: 8 },
  ];

  const sceneOffId = uid();
  const sceneMaxId = uid();
  const sceneRainbowId = uid();
  project.scenes = [
    { id: sceneOffId, name: 'Всё выключено', values: {} },
    {
      id: sceneMaxId,
      name: 'Максимум',
      values: {
        'demo-pump1': [255],
        'demo-valve1': [255],
        'demo-pump2': [255],
        'demo-valve2': [255],
        'demo-light1': [255, 255, 255],
        'demo-light2': [255, 255, 255],
      },
    },
    {
      id: sceneRainbowId,
      name: 'Радуга',
      values: {
        'demo-pump1': [180],
        'demo-valve1': [255],
        'demo-pump2': [180],
        'demo-valve2': [255],
        'demo-light1': [255, 60, 180],
        'demo-light2': [60, 200, 255],
      },
    },
  ];

  project.sequences = [
    {
      id: uid(),
      name: 'Дежурная',
      mode: 'loop',
      steps: [
        { sceneId: sceneOffId, holdMs: 1000, fadeMs: 500 },
        { sceneId: sceneMaxId, holdMs: 1500, fadeMs: 800 },
        { sceneId: sceneRainbowId, holdMs: 1500, fadeMs: 800 },
      ],
    },
  ];

  const ring = ringPositions(2, 2);
  project.layout = {
    bowls: [
      { id: uid(), name: 'Чаша', shape: 'circle', x: 0, y: 0, radius: 3, width: 6, length: 6, height: 0.3, ...BOWL_DEFAULTS },
    ],
    nozzles: [
      {
        id: 'demo-noz1',
        name: 'Форсунка 1',
        kind: 'straight',
        x: ring[0]!.x,
        y: ring[0]!.y,
        z: 0,
        tiltDeg: 0,
        headingDeg: 0,
        maxHeightM: 4,
        widthM: 0.03,
        coneAngleDeg: 25,
        rotationSpeedDegPerSec: 60,
        riseMs: 400,
        fallMs: 600,
        pumpDeviceId: 'demo-pump1',
        pump2DeviceId: null,
        valveDeviceId: 'demo-valve1',

        extraPumpDeviceIds: [],

        extraValveDeviceIds: [],

        extraLightDeviceIds: [],

        extraPump2DeviceIds: [],
        modelFile: null,
        modelScale: 1,

        sprayFactor: 0.3,
        lightDeviceId: 'demo-light1',
      },
      {
        id: 'demo-noz2',
        name: 'Форсунка 2',
        kind: 'straight',
        x: ring[1]!.x,
        y: ring[1]!.y,
        z: 0,
        tiltDeg: 0,
        headingDeg: 0,
        maxHeightM: 3.5,
        widthM: 0.03,
        coneAngleDeg: 25,
        rotationSpeedDegPerSec: 60,
        riseMs: 400,
        fallMs: 600,
        pumpDeviceId: 'demo-pump2',
        pump2DeviceId: null,
        valveDeviceId: 'demo-valve2',

        extraPumpDeviceIds: [],

        extraValveDeviceIds: [],

        extraLightDeviceIds: [],

        extraPump2DeviceIds: [],
        modelFile: null,
        modelScale: 1,

        sprayFactor: 0.3,
        lightDeviceId: 'demo-light2',
      },
    ],
    lights: [
      { id: 'demo-lt1', name: 'Прожектор 1', x: ring[0]!.x, y: ring[0]!.y, z: -0.15, deviceId: 'demo-light1', ...LIGHT_DEFAULTS },
      { id: 'demo-lt2', name: 'Прожектор 2', x: ring[1]!.x, y: ring[1]!.y, z: -0.15, deviceId: 'demo-light2', ...LIGHT_DEFAULTS },
    ],
    nozzleGroups: [],
  };

  // Дорожка блоков — картины синхронно с ритмом трека (4 такта по 2 с).
  const blocks = [
    { id: uid(), type: 'scene' as const, refId: sceneMaxId, startMs: 0, durationMs: 2000, fadeInMs: 0, fadeOutMs: 200 },
    { id: uid(), type: 'scene' as const, refId: sceneRainbowId, startMs: 2000, durationMs: 2000, fadeInMs: 200, fadeOutMs: 200 },
    { id: uid(), type: 'scene' as const, refId: sceneMaxId, startMs: 4000, durationMs: 2000, fadeInMs: 200, fadeOutMs: 200 },
    { id: uid(), type: 'scene' as const, refId: sceneRainbowId, startMs: 6000, durationMs: 2000, fadeInMs: 200, fadeOutMs: 0 },
  ];
  // Огибающая насоса 1 — пульс в ритм долям трека (500 мс/доля, 120 BPM).
  const points: { tMs: number; value: number }[] = [];
  for (let beat = 0; beat * 500 <= DEMO_TRACK_DURATION_MS; beat++) {
    const t = beat * 500;
    points.push({ tMs: t, value: beat % 2 === 0 ? 90 : 220 });
  }

  project.shows = [
    {
      id: uid(),
      name: 'Демо-шоу',
      audioFile: DEMO_AUDIO_FILE,
      durationMs: DEMO_TRACK_DURATION_MS,
      cuts: [],
      tracks: [
        { id: uid(), name: 'Картины', kind: 'blocks', offsetMs: 0, muted: false, blocks, effects: [] },
        {
          id: uid(),
          name: 'Пульс насоса 1',
          kind: 'envelope',
          offsetMs: 0,
          muted: false,
          deviceId: 'demo-pump1',
          channel: 0,
          points,
        },
      ],
    },
  ];

  return project;
}
