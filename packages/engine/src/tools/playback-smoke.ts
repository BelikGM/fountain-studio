/**
 * Смоук-тест во
  type WindCorrectionState,спроизведения: поднимает движок с WebSocket-сервером в этом же
 * процессе, подключается клиентом и проверяет: загрузку проекта, статическую
 * сцену, HTP-слияние с ручной консолью, секвенсор с фейдом и переходами шагов,
 * общий стоп, шоу-таймлайн (блоки, огибающие, опережение дорожек, транспорт),
 * монтажную арифметику вырезок, мониторинг сети Art-Net/RDM, насос на Modbus TCP
 * (мок-ПЧ), хранилище аудио и сохранение проекта на диск.
 *
 * Запуск: npm run smoke (или npm -w @fountain-studio/engine run smoke)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  actorPhases,
  legacyStrengthToSmoothness,
  smoothReachSec,
  smoothStep,
  bandEnergyEnvelope,
  bandEnvelopePoints,
  breathingSequenceScenes,
  cascadeSequenceScenes,
  decimateEnvelope,
  editedToSourceMs,
  emptyProject,
  encodeOscMessage,
  energyEnvelope,
  estimateTempo,
  insunitsToMeters,
  invertScene,
  keptSegments,
  layoutActors,
  layoutFromDxf,
  loudnessEnvelopePoints,
  measureCyclePeriodMs,
  mergeCuts,
  mirrorScene,
  nozzleGroupCentroid,
  parseDxf,
  peakEvents,
  planDeviceWizard,
  profileMap,
  radialWaveScene,
  radialWaveSequenceScenes,
  rainbowSequenceScenes,
  ringPositions,
  rotateNozzleGroup,
  saluteSequenceScenes,
  sanitizeProject,
  shiftDeviceAddresses,
  silenceRanges,
  smoothEnvelopeValues,
  sourceToEditedMs,
  spectralCentroidEnvelope,
  swapDeviceAddresses,
  tempoCategory,
  translateNozzleGroup,
  brightnessEnvelopePoints,
  colorChangeEvents,
  colorChannelEnvelopePoints,
  defaultWindLimitConfig,
  initialWindCorrectionState,
  stepWindCorrection,
  type WindCorrectionState,
  computeWindLimitPercent,
  defaultUtilityLightConfig,
  isUtilityLightOn,
  sampleFrameStats,
  type VideoFrameSample,
  type LicenseFile,
  type LicensePayload,
  type LogEvent,
  type ModbusState,
  type NetworkState,
  type PlaybackState,
  type Project,
  type Scene,
  type ClientMessage,
  type ServerMessage,
  applyAddressRemap,
  sanitizeAddressRemap,
  GRACE_PERIOD_DAYS,
} from '@fountain-studio/shared';
import { wireAlarmNotifications } from '../alarms';
import { AudioStore } from '../audio';
import { BackupStore } from '../backups';
import dgram from 'node:dgram';
import { createServer as createTcpServer, createConnection as createTcpConnection } from 'node:net';
import { emaStep } from '../clock';
import { generateDemoWav } from '../demoaudio';
import { DEMO_AUDIO_FILE, createDemoProject } from '../demoproject';
import { DmxCapture } from '../dmxcapture';
import { DmxTriggerWatcher } from '../dmxtriggers';
import { Engine } from '../engine';
import { canonicalPayload, loadLicenseStatus, machineFingerprint, verifyLicenseFile } from '../license';
import { RemoteControl } from '../remotecontrol';
import { NetworkMonitor } from '../netmonitor';
import {
  CC_GET_COMMAND,
  CC_SET_COMMAND,
  PID_DEVICE_INFO,
  PID_DMX_START_ADDRESS,
  PID_IDENTIFY_DEVICE,
  PID_MANUFACTURER_LABEL,
  encodeIdentify,
  encodeStartAddress,
  parseDeviceInfoResponse,
  parseIdentifyResponse,
  parseLabelResponse,
  parseStartAddressResponse,
} from '../rdm';
import { ProjectStore } from '../project';
import { Scheduler } from '../schedule';
import { startServer } from '../server';
import { createZip, readZip } from '../zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9521;
const MOCK_NODE_PORT = 16454; // мок-нода Art-Net (не 6454, чтобы не мешать реальным)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fountain-smoke-'));
const projectFile = path.join(tmpDir, 'fountain.project.json');

/**
 * Доп. значения, подмешиваемые мок-нодой в её ArtDMX-кадр при следующем
 * ArtPoll-ответе (вместе с фиксированными 111/222/33 на адр.1/2/20) — рычаг
 * для проверки DMX-in-триггеров без гонки за портом с NetworkMonitor.
 * Прямая инъекция UDP-пакета в MOCK_NODE_PORT ненадёжна: мок-нода и
 * NetworkMonitor.listenSocket оба сидят на нём через reuseAddr, и на Windows
 * пакет может достаться не тому сокету. Кадр, который мок-нода шлёт САМА в
 * ответ на опрос, идёт через уже проверенный путь (this.socket движка).
 */
let mockDmxOverride: Record<number, number> = {};

// Мок-нода: отвечает на ArtPoll (ArtPollReply), ArtTodRequest (ArtTodData с 2 UID)
// и ArtRdm (§3 доработки — универсальные PID E1.20), пока mockNodeAlive = true.
// Умолкание имитирует пропажу ноды из сети.
let mockNodeAlive = true;
let mockRdmAddress = 5; // текущий DMX-адрес мок-прибора (GET/SET DMX_START_ADDRESS)
let mockRdmIdentify = false; // текущее состояние IDENTIFY_DEVICE мок-прибора
const mockNode = dgram.createSocket({ type: 'udp4', reuseAddr: true });
mockNode.on('message', (msg, rinfo) => {
  if (!mockNodeAlive || msg.toString('latin1', 0, 8) !== 'Art-Net\0') return;
  const op = msg.readUInt16LE(8);
  if (op === 0x2000) {
    const reply = Buffer.alloc(239);
    reply.write('Art-Net\0', 0, 'latin1');
    reply.writeUInt16LE(0x2100, 8); // OpPollReply
    // Имена в Art-Net — ASCII (кириллица в latin1 не кодируется).
    reply.write('MockNode', 26, 'latin1'); // ShortName
    reply.write('Smoke test node', 44, 'latin1'); // LongName
    reply.writeUInt8(1, 173); // NumPortsLo = 1
    reply.writeUInt8(0x80, 174); // PortTypes[0]: выход
    reply.writeUInt8(0, 190); // SwOut[0] → вселенная 0
    mockNode.send(reply, rinfo.port, rinfo.address);
    // Заодно — кадр ArtDMX «внешнего источника» (проверка захвата §17 п.1).
    const dmx = Buffer.alloc(18 + 512);
    dmx.write('Art-Net\0', 0, 'latin1');
    dmx.writeUInt16LE(0x5000, 8); // OpDmx
    dmx.writeUInt8(0, 10);
    dmx.writeUInt8(14, 11);
    dmx.writeUInt8(0, 14); // SubUni = 0
    dmx.writeUInt8(0, 15); // Net = 0
    dmx.writeUInt8(2, 16); // LengthHi
    dmx.writeUInt8(0, 17); // LengthLo → 512
    dmx.writeUInt8(111, 18); // адрес 1
    dmx.writeUInt8(222, 19); // адрес 2
    dmx.writeUInt8(33, 18 + 19); // адрес 20 (насос 2)
    for (const [addr, v] of Object.entries(mockDmxOverride)) dmx.writeUInt8(v, 18 + (Number(addr) - 1));
    mockNode.send(dmx, rinfo.port, rinfo.address);
  } else if (op === 0x8000) {
    const uids = [
      [0x4d, 0x4f, 0x00, 0x00, 0x00, 0x01],
      [0x4d, 0x4f, 0x00, 0x00, 0x00, 0x02],
    ];
    const tod = Buffer.alloc(28 + uids.length * 6);
    tod.write('Art-Net\0', 0, 'latin1');
    tod.writeUInt16LE(0x8100, 8); // OpTodData
    tod.writeUInt8(0, 21); // Net
    tod.writeUInt8(0, 23); // Address
    tod.writeUInt16BE(uids.length, 24);
    tod.writeUInt8(1, 26); // BlockCount
    tod.writeUInt8(uids.length, 27);
    uids.forEach((u, i) => tod.set(u, 28 + i * 6));
    mockNode.send(tod, rinfo.port, rinfo.address);
  } else if (op === 0x8300) {
    // ArtRdm: RDM-пакет начинается со смещения 24. Отвечаем на универсальные
    // PID E1.20 независимо реализованным кодом (не переиспользуем rdm.ts) —
    // так проверка не «замыкается сама на себя», а честно гоняет протокол.
    const rdm = msg.subarray(24);
    if (rdm.length < 24 || rdm[0] !== 0xcc || rdm[1] !== 0x01) return;
    const cc = rdm.readUInt8(20);
    const pid = rdm.readUInt16BE(21);
    const transactionNum = rdm.readUInt8(15);
    const requesterUid = rdm.subarray(3, 9); // станет Destination UID в ответе
    const targetUid = rdm.subarray(9, 15); // станет Source UID в ответе (мок-прибор)

    let paramData: Buffer;
    if (cc === 0x20 && pid === 0x0060) {
      paramData = Buffer.alloc(19);
      paramData.writeUInt8(1, 0);
      paramData.writeUInt8(0, 1); // протокол 1.0
      paramData.writeUInt16BE(0x1234, 2); // deviceModelId
      paramData.writeUInt16BE(0x0100, 4); // productCategory
      paramData.writeUInt32BE(0x01000000, 6); // softwareVersionId
      paramData.writeUInt16BE(3, 10); // dmxFootprint
      paramData.writeUInt8(1, 12);
      paramData.writeUInt8(1, 13); // personality current/total
      paramData.writeUInt16BE(mockRdmAddress, 14);
      paramData.writeUInt16BE(0, 16); // subDeviceCount
      paramData.writeUInt8(0, 18); // sensorCount
    } else if (cc === 0x20 && pid === 0x0081) {
      paramData = Buffer.from('Mock Manufacturer', 'ascii');
    } else if (cc === 0x20 && pid === 0x0080) {
      paramData = Buffer.from('Mock Fixture', 'ascii');
    } else if (cc === 0x20 && pid === 0x00c0) {
      paramData = Buffer.from('1.0.0', 'ascii');
    } else if (cc === 0x20 && pid === 0x1000) {
      paramData = Buffer.from([mockRdmIdentify ? 1 : 0]);
    } else if (cc === 0x30 && pid === 0x1000) {
      mockRdmIdentify = rdm.readUInt8(24) !== 0;
      paramData = Buffer.alloc(0);
    } else if (cc === 0x20 && pid === 0x00f0) {
      paramData = Buffer.alloc(2);
      paramData.writeUInt16BE(mockRdmAddress, 0);
    } else if (cc === 0x30 && pid === 0x00f0) {
      mockRdmAddress = rdm.readUInt16BE(24);
      paramData = Buffer.alloc(0);
    } else {
      return; // неизвестный PID — мок молчит, как реальный прибор без этого параметра
    }

    const respCc = cc === 0x20 ? 0x21 : 0x31; // GET/SET _COMMAND_RESPONSE
    const msgLength = 24 + paramData.length;
    const resp = Buffer.alloc(msgLength + 2);
    resp.writeUInt8(0xcc, 0);
    resp.writeUInt8(0x01, 1);
    resp.writeUInt8(msgLength, 2);
    requesterUid.copy(resp, 3); // Destination = кто спрашивал
    targetUid.copy(resp, 9); // Source = мок-прибор
    resp.writeUInt8(transactionNum, 15);
    resp.writeUInt8(0, 16);
    resp.writeUInt8(0, 17);
    resp.writeUInt16BE(0, 18);
    resp.writeUInt8(respCc, 20);
    resp.writeUInt16BE(pid, 21);
    resp.writeUInt8(paramData.length, 23);
    paramData.copy(resp, 24);
    let checksum = 0;
    for (let i = 0; i < msgLength; i++) checksum += resp[i]!;
    resp.writeUInt16BE(checksum & 0xffff, msgLength);

    const artResp = Buffer.alloc(24 + resp.length);
    artResp.write('Art-Net\0', 0, 'latin1');
    artResp.writeUInt16LE(0x8300, 8);
    artResp.writeUInt8(0, 10);
    artResp.writeUInt8(14, 11);
    artResp.writeUInt8(1, 12);
    artResp.writeUInt8(0, 21);
    artResp.writeUInt8(0, 22);
    artResp.writeUInt8(0, 23);
    resp.copy(artResp, 24);
    mockNode.send(artResp, rinfo.port, rinfo.address);
  }
});
mockNode.bind(MOCK_NODE_PORT, '127.0.0.1');

// Мок-ПЧ: минимальный сервер Modbus TCP (MBAP), держит холдинг-регистры уставки
// частоты/команды/аварии (карта Elhart EMD-PUMP) и лог записей — для проверки
// PumpModbusManager без реального привода.
const MOCK_VFD_PORT = 15020;
const vfdRegs = new Map<number, number>([
  [8193, 0], // FREQ_SET
  [8192, 0], // CMD
  [10, 0], // F0.10 — код последней аварии
  // Телеметрия (§27 доработки, §4 п.2) — условные тестовые регистры (не карта
  // Elhart, та телеметрию не описывает — сверяется с картой конкретного ПЧ).
  [11, 150], // ток, сотые А → 1.50 А
  [12, 1450], // обороты, напрямую об/мин
  [13, 452], // температура, десятые °C → 45.2°C
]);
const vfdWrites: { register: number; value: number; at: number }[] = [];
const vfdServer = createTcpServer((socket) => {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 8) return;
      const length = buf.readUInt16BE(4);
      const total = 6 + length;
      if (buf.length < total) return;
      const frame = buf.subarray(0, total);
      buf = buf.subarray(total);
      const txId = frame.readUInt16BE(0);
      const unitId = frame.readUInt8(6);
      const pdu = frame.subarray(7);
      const fc = pdu.readUInt8(0);
      let respPdu: Buffer;
      if (fc === 0x06) {
        const addr = pdu.readUInt16BE(1);
        const value = pdu.readUInt16BE(3);
        vfdRegs.set(addr, value);
        vfdWrites.push({ register: addr, value, at: Date.now() });
        respPdu = pdu; // ответ на запись одного регистра — эхо запроса
      } else if (fc === 0x03) {
        const addr = pdu.readUInt16BE(1);
        respPdu = Buffer.alloc(4);
        respPdu.writeUInt8(0x03, 0);
        respPdu.writeUInt8(2, 1);
        respPdu.writeUInt16BE(vfdRegs.get(addr) ?? 0, 2);
      } else {
        respPdu = Buffer.from([fc | 0x80, 0x01]); // неподдерживаемая функция
      }
      const header = Buffer.alloc(7);
      header.writeUInt16BE(txId, 0);
      header.writeUInt16BE(0, 2);
      header.writeUInt16BE(respPdu.length + 1, 4);
      header.writeUInt8(unitId, 6);
      socket.write(Buffer.concat([header, respPdu]));
    }
  });
});
vfdServer.listen(MOCK_VFD_PORT, '127.0.0.1');

// Мок-брокер MQTT: наивный релей PUBLISH между подключёнными сокетами (для
// теста этого достаточно — участвует движок-клиент и один тестовый «внешний
// издатель»). CONNECT/SUBSCRIBE/PINGREQ отвечают без проверки содержимого.
const MOCK_MQTT_PORT = 15022;
const mqttSockets = new Set<import('node:net').Socket>();
const mqttServer = createTcpServer((socket) => {
  mqttSockets.add(socket);
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const type = buf[0]! >> 4;
      let multiplier = 1;
      let remLen = 0;
      let idx = 1;
      let byte: number;
      do {
        if (idx >= buf.length) return;
        byte = buf[idx]!;
        remLen += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        idx++;
      } while ((byte & 0x80) !== 0);
      const total = idx + remLen;
      if (buf.length < total) return;
      const full = buf.subarray(0, total);
      const body = buf.subarray(idx, total);
      buf = buf.subarray(total);
      if (type === 1) socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00])); // CONNECT → CONNACK
      else if (type === 8) socket.write(Buffer.concat([Buffer.from([0x90, 0x03]), body.subarray(0, 2), Buffer.from([0x00])])); // SUBSCRIBE → SUBACK
      else if (type === 12) socket.write(Buffer.from([0xd0, 0x00])); // PINGREQ → PINGRESP
      else if (type === 3) for (const c of mqttSockets) if (c !== socket) c.write(full); // PUBLISH → релей остальным
    }
  });
  socket.on('close', () => mqttSockets.delete(socket));
});
mqttServer.listen(MOCK_MQTT_PORT, '127.0.0.1');

/** Собирает сырой MQTT PUBLISH (QoS0) — имитация внешнего издателя без полного клиента. */
function encodeMqttPublish(topic: string, payload: string): Buffer {
  const topicBuf = Buffer.from(topic, 'utf8');
  const topicLenBuf = Buffer.alloc(2);
  topicLenBuf.writeUInt16BE(topicBuf.length, 0);
  const payloadBuf = Buffer.from(payload, 'utf8');
  const variableAndPayload = Buffer.concat([topicLenBuf, topicBuf, payloadBuf]);
  const remLen: number[] = [];
  let len = variableAndPayload.length;
  do {
    let b = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) b |= 0x80;
    remLen.push(b);
  } while (len > 0);
  return Buffer.concat([Buffer.from([0x30, ...remLen]), variableAndPayload]);
}

/**
 * Разбирает поток кадров MQTT, отдаёт PUBLISH (тип 3) как {topic, payload};
 * прочие типы (CONNACK, SUBACK, PINGRESP…) молча пропускает. Возвращает
 * остаток буфера (неполный кадр в конце).
 */
function decodeMqttFrames(buf: Buffer, onPublish: (topic: string, payload: string) => void): Buffer {
  for (;;) {
    if (buf.length < 2) return buf;
    const type = buf[0]! >> 4;
    let multiplier = 1;
    let remLen = 0;
    let idx = 1;
    let byte: number;
    do {
      if (idx >= buf.length) return buf;
      byte = buf[idx]!;
      remLen += (byte & 0x7f) * multiplier;
      multiplier *= 128;
      idx++;
    } while ((byte & 0x80) !== 0);
    const total = idx + remLen;
    if (buf.length < total) return buf;
    const body = buf.subarray(idx, total);
    buf = buf.subarray(total);
    if (type === 3) {
      const topicLen = body.readUInt16BE(0);
      const topic = body.subarray(2, 2 + topicLen).toString('utf8');
      const payload = body.subarray(2 + topicLen).toString('utf8');
      onPublish(topic, payload);
    }
  }
}

/** «Внешний подписчик» на мок-брокере — ловит всё, что движок публикует (уведомления об авариях). */
const mqttAlarms: { topic: string; payload: string }[] = [];
const mqttSub = createTcpConnection({ host: '127.0.0.1', port: MOCK_MQTT_PORT }, () => {
  mqttSub.write(Buffer.from([0x10, 0x00])); // минимальный CONNECT — мок проверяет только тип кадра
});
let mqttSubBuf: Buffer = Buffer.alloc(0);
mqttSub.on('data', (chunk: Buffer) => {
  mqttSubBuf = decodeMqttFrames(Buffer.concat([mqttSubBuf, chunk]), (topic, payload) => {
    if (topic.startsWith('test/alarms')) mqttAlarms.push({ topic, payload });
  });
});

const engine = new Engine({
  server: { port: PORT },
  timing: { tickMs: 50, spinMs: 10, uiFrameMs: 40 },
  audio: { player: 'none', ffplayPath: 'ffplay', volumeDb: 0, muted: false, bassDb: 0, trebleDb: 0 },
  universes: [{ id: 1, label: 'Тест', outputs: [{ type: 'artnet', host: '127.0.0.1', universe: 0 }] }],
  backup: { enabled: false, intervalMin: 10 }, // таймер выключен — снимки берём вручную в тесте
  // Настройки программы — во временной папке: тест проверяет, что пульты
  // записываются в файл, и не должен трогать настоящий app-config.json.
  configFile: path.join(tmpDir, 'app-config.json'),
});
const store = new ProjectStore(projectFile);
const backups = new BackupStore(projectFile, () => JSON.stringify(store.project, null, 2), {
  enabled: false,
  intervalMin: 10,
});
engine.setProject(store.project);
engine.start();
const net = new NetworkMonitor({
  targets: ['127.0.0.1'],
  universes: [0],
  port: MOCK_NODE_PORT,
  pollMs: 150,
  nodeTimeoutMs: 700,
  rdmTimeoutMs: 5000,
});
const dmxCapture = new DmxCapture();
const dmxTriggerWatcher = new DmxTriggerWatcher();
net.onDmx = (universe, data, fromIp) => {
  dmxCapture.handle(universe, data, fromIp);
  dmxTriggerWatcher.handle(engine, store.project.dmxTriggers, universe, data);
};
net.start();

const OSC_PORT = 15021;
/** Второй порт OSC — проверка переключения на ходу. */
const OSC_PORT_2 = 15023;
// Тот же класс, что поднимает index.ts: OSC и MQTT включаются и
// перенастраиваются на ходу с вкладки «Внешние пульты».
const remote = new RemoteControl(
  engine,
  () => store.project.oscBindings,
  () => store.project.mqttBindings,
  {
    osc: { enabled: true, port: OSC_PORT },
    mqtt: { enabled: true, host: '127.0.0.1', port: MOCK_MQTT_PORT, topicPrefix: 'test', username: '' },
  },
);
remote.start();
// Та же обёртка, что index.ts включает в проде — проверяем реальную функцию,
// не переписанную для теста копию.
wireAlarmNotifications(remote);

const wss = startServer(
  engine,
  store,
  new AudioStore(path.join(tmpDir, 'audio')),
  backups,
  net,
  dmxCapture,
  remote,
);

// Демо-проект: насос (адрес 1), клапан (2), RGB (10–12).
const demo: Project = {
  ...emptyProject('Смоук-тест'),
  devices: [
    { id: 'pump1', name: 'Насос 1', profileId: 'pump', universe: 1, address: 1 },
    { id: 'valve1', name: 'Клапан 1', profileId: 'valve', universe: 1, address: 2 },
    { id: 'rgb1', name: 'RGB 1', profileId: 'rgb', universe: 1, address: 10 },
    {
      id: 'pump2',
      name: 'Насос 2 (Modbus)',
      profileId: 'pump',
      universe: 1,
      address: 20,
      modbus: {
        connection: { kind: 'tcp', host: '127.0.0.1', port: MOCK_VFD_PORT },
        unitId: 1,
        freqRegister: 8193,
        freqRegScale: 100,
        freqScaleHz: 50,
        cmdRegister: 8192,
        faultRegister: 10,
        currentRegister: 11,
        speedRegister: 12,
        tempRegister: 13,
      },
    },
  ],
  scenes: [
    { id: 'sceneA', name: 'Картина A', values: { pump1: [200], valve1: [255], rgb1: [255, 0, 40] } },
    { id: 'sceneB', name: 'Картина B', values: { pump1: [60], rgb1: [0, 128, 255] } },
  ],
  sequences: [
    {
      id: 'seq1',
      name: 'Секвенсор 1',
      mode: 'loop',
      steps: [
        { sceneId: 'sceneA', holdMs: 600, fadeMs: 0 },
        { sceneId: 'sceneB', holdMs: 600, fadeMs: 400 },
      ],
    },
    {
      // §27 доработки, УХ п.16: эффект на весь секвенсор — отдельно от fadeMs
      // шага (тот 0, чтобы не путать со сглаживанием, которое проверяем).
      id: 'seqEffect',
      name: 'Секвенсор с эффектом',
      mode: 'once',
      steps: [
        { sceneId: 'sceneA', holdMs: 150, fadeMs: 0 },
        { sceneId: 'sceneB', holdMs: 5000, fadeMs: 0 },
      ],
      // Намеренно в СТАРОЙ записи — «сила 10» (обратная шкала до 22.09.2026):
      // движок обязан перевести её в «плавность 11» с тем же временем перехода.
      effect: { mode: 'rate', strength: 10 } as never,
    },
  ],
  shows: [
    {
      id: 'show1',
      name: 'Шоу 1',
      audioFile: null,
      durationMs: 4000,
      cuts: [],
      tracks: [
        {
          id: 'trkBlocks',
          name: 'Блоки',
          kind: 'blocks',
          offsetMs: 0,
          muted: false,
          blocks: [
            // Сцена A на 0.5–2.0 с; секвенсор seq1 на 2.5–3.7 с.
            { id: 'b1', type: 'scene', refId: 'sceneA', startMs: 500, durationMs: 1500, fadeInMs: 0, fadeOutMs: 0 },
            { id: 'b2', type: 'sequence', refId: 'seq1', startMs: 2500, durationMs: 1200, fadeInMs: 0, fadeOutMs: 0 },
          ],
          effects: [],
        },
        {
          id: 'trkEnv',
          name: 'Зелёный RGB',
          kind: 'envelope',
          offsetMs: 0,
          muted: false,
          deviceId: 'rgb1',
          channel: 1,
          points: [
            { tMs: 0, value: 0 },
            { tMs: 2000, value: 200 },
            { tMs: 4000, value: 0 },
          ],
        },
        {
          // Опережение +1000 мс: точки 3.0–4.0 с исполняются на позиции 2.0–3.0 с.
          id: 'trkValve',
          name: 'Клапан (опережение 1 с)',
          kind: 'envelope',
          offsetMs: 1000,
          muted: false,
          deviceId: 'valve1',
          channel: 0,
          points: [
            { tMs: 3000, value: 255 },
            { tMs: 4000, value: 255 },
          ],
        },
      ],
    },
    {
      id: 'showP1',
      name: 'Короткое 1',
      audioFile: null,
      durationMs: 600,
      cuts: [],
      tracks: [
        {
          id: 'p1t',
          name: 'Блоки',
          kind: 'blocks',
          offsetMs: 0,
          muted: false,
          blocks: [{ id: 'p1b', type: 'scene', refId: 'sceneA', startMs: 0, durationMs: 600, fadeInMs: 0, fadeOutMs: 0 }],
          effects: [],
        },
      ],
    },
    {
      id: 'showP2',
      name: 'Короткое 2',
      audioFile: null,
      durationMs: 500,
      cuts: [],
      tracks: [
        {
          id: 'p2t',
          name: 'Блоки',
          kind: 'blocks',
          offsetMs: 0,
          muted: false,
          blocks: [{ id: 'p2b', type: 'scene', refId: 'sceneB', startMs: 0, durationMs: 500, fadeInMs: 0, fadeOutMs: 0 }],
          effects: [],
        },
      ],
    },
    {
      // §27 доработки, УХ п.16: зона эффекта на дорожке — сцена A → сцена B
      // впритык (фейд блока 0, чтобы не путать с сглаживанием) внутри одной
      // зоны rate/10 на всю дорожку.
      id: 'showEffect',
      name: 'Шоу с эффектом дорожки',
      audioFile: null,
      durationMs: 5200,
      cuts: [],
      tracks: [
        {
          id: 'trkEffect',
          name: 'Эффект дорожки',
          kind: 'blocks',
          offsetMs: 0,
          muted: false,
          blocks: [
            { id: 'te1', type: 'scene', refId: 'sceneA', startMs: 0, durationMs: 200, fadeInMs: 0, fadeOutMs: 0 },
            { id: 'te2', type: 'scene', refId: 'sceneB', startMs: 200, durationMs: 5000, fadeInMs: 0, fadeOutMs: 0 },
          ],
          effects: [{ id: 'fx1', mode: 'rate', smoothness: 11, startMs: 0, endMs: 5200 }],
        },
      ],
    },
  ],
  playlists: [
    {
      id: 'pl1',
      name: 'Вечерняя программа',
      mode: 'once',
      onStart: 'restart',
      items: [
        { showId: 'showP1', gapMs: 300 },
        { showId: 'showP2', gapMs: 0 },
      ],
    },
  ],
  oscBindings: [{ id: 'osc1', address: '/scene/a', action: { type: 'scene', refId: 'sceneA' } }],
  mqttBindings: [{ id: 'mq1', topic: 'stop-all', action: { type: 'stopAll' } }],
};

let frame = new Uint8Array(512);
let playback: PlaybackState = { activeSceneId: null, running: [], show: null, playlist: null, pausedAll: false };
let projectEcho: Project | null = null;
/** Последнее «есть ли несохранённые правки» и настройки программы от движка. */
let dirtyMsg: Extract<ServerMessage, { type: 'projectDirty' }> | null = null;
let configMsg: Extract<ServerMessage, { type: 'config' }> | null = null;
let audioMsg: { name: string; dataBase64: string } | null = null;
let networkState: NetworkState | null = null;
let modbusState: ModbusState | null = null;
let dmxCaptureMsg: Extract<ServerMessage, { type: 'dmxCapture' }> | null = null;
let dmxCycleMsg: Extract<ServerMessage, { type: 'dmxCycle' }> | null = null;
let remoteStatusMsg: Extract<ServerMessage, { type: 'remoteStatus' }> | null = null;
let backupConfigMsg: Extract<ServerMessage, { type: 'backupConfig' }> | null = null;
let backupListMsg: Extract<ServerMessage, { type: 'backupList' }> | null = null;
let logEvents: LogEvent[] = [];
let autostartMsg: Extract<ServerMessage, { type: 'autostartState' }> | null = null;
let licenseMsg: Extract<ServerMessage, { type: 'license' }> | null = null;
let projectExportMsg: Extract<ServerMessage, { type: 'projectExport' }> | null = null;
let importResultMsg: Extract<ServerMessage, { type: 'importResult' }> | null = null;
let sawStep1 = false;
let sawFadeMidpoint = false;

const failures: string[] = [];
function check(cond: boolean, label: string): void {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}`);
  if (!cond) failures.push(label);
}

const ch = (addr: number): number => frame[addr - 1] ?? 0;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const send = (msg: ClientMessage): void => ws.send(JSON.stringify(msg));

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === 'frame' && msg.universe === 1) {
    frame = new Uint8Array(Buffer.from(msg.data, 'base64'));
    // Ловим промежуточный кадр фейда шага 2: насос между 60 и 200 не включительно.
    if (playback.running.length > 0 && playback.running[0]!.stepIndex === 1) {
      if (ch(1) > 60 && ch(1) < 200) sawFadeMidpoint = true;
    }
  } else if (msg.type === 'playback') {
    playback = msg.state;
    if (playback.running.some((r) => r.stepIndex === 1)) sawStep1 = true;
  } else if (msg.type === 'project') {
    projectEcho = msg.project;
  } else if (msg.type === 'projectDirty') {
    dirtyMsg = msg;
  } else if (msg.type === 'config') {
    configMsg = msg;
  } else if (msg.type === 'audio') {
    audioMsg = { name: msg.name, dataBase64: msg.dataBase64 };
  } else if (msg.type === 'projectExport') {
    projectExportMsg = msg;
  } else if (msg.type === 'importResult') {
    importResultMsg = msg;
  } else if (msg.type === 'network') {
    networkState = msg.state;
  } else if (msg.type === 'modbus') {
    modbusState = msg.state;
  } else if (msg.type === 'dmxCapture') {
    dmxCaptureMsg = msg;
  } else if (msg.type === 'dmxCycle') {
    dmxCycleMsg = msg;
  } else if (msg.type === 'remoteStatus') {
    remoteStatusMsg = msg;
  } else if (msg.type === 'backupConfig') {
    backupConfigMsg = msg;
  } else if (msg.type === 'backupList') {
    backupListMsg = msg;
  } else if (msg.type === 'logHistory') {
    logEvents = msg.events;
  } else if (msg.type === 'logEvent') {
    logEvents = [...logEvents, msg.event];
  } else if (msg.type === 'autostartState') {
    autostartMsg = msg;
  } else if (msg.type === 'license') {
    licenseMsg = msg;
  }
});

function waitFor(label: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Таймаут ожидания: ${label}`));
      }
    }, 10);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await waitFor('подключение', () => ws.readyState === WebSocket.OPEN);

  console.log('— Проект —');
  send({ type: 'updateProject', project: demo });
  await waitFor('эхо проекта', () => projectEcho !== null && projectEcho.devices.length === 4);
  check(projectEcho!.name === 'Смоук-тест', 'проект принят и разослан обратно');

  console.log('— Статическая сцена —');
  send({ type: 'setScene', sceneId: 'sceneA' });
  await waitFor('кадр сцены A', () => ch(1) === 200 && ch(2) === 255 && ch(10) === 255 && ch(12) === 40);
  check(true, 'сцена A на выходе: насос 200, клапан 255, RGB (255,0,40)');
  // Ждём, а не проверяем сразу: когда расчёт идёт в отдельном потоке, кадр
  // приходит через общую память, а состояние — сообщением, и оно отстаёт на
  // десяток миллисекунд. Для человека это незаметно, а для проверки — гонка.
  await waitFor('состояние: активна сцена A', () => playback.activeSceneId === 'sceneA');
  check(true, 'состояние воспроизведения: активна сцена A');

  console.log('— HTP: ручной слой против сцены —');
  send({ type: 'setChannel', universe: 1, channel: 1, value: 250 });
  await waitFor('ручной 250 побеждает', () => ch(1) === 250);
  check(true, 'фейдер 250 поверх сцены 200 → на выходе 250');
  send({ type: 'setChannel', universe: 1, channel: 1, value: 100 });
  await sleep(200);
  check(ch(1) === 200, 'фейдер 100 под сценой 200 → на выходе 200 (HTP)');
  send({ type: 'setChannel', universe: 1, channel: 1, value: 0 });
  send({ type: 'setScene', sceneId: null });
  await waitFor('сцена снята', () => ch(1) === 0 && ch(10) === 0);
  check(true, 'сцена выключена — каналы в ноль');

  console.log('— Секвенсор с фейдом —');
  send({ type: 'startSequence', sequenceId: 'seq1' });
  await waitFor('шаг 1: сцена A', () => ch(1) === 200 && ch(2) === 255);
  check(true, 'шаг 1 отработал (без фейда, сразу 200)');
  await waitFor('переход на шаг 2', () => sawStep1, 2000);
  await waitFor('фейд завершён: сцена B', () => ch(1) === 60 && ch(11) === 128, 2000);
  check(sawFadeMidpoint, 'во время фейда были промежуточные значения (60 < насос < 200)');
  check(ch(2) === 0, 'клапан ушёл в 0 (его нет в сцене B)');
  await waitFor('цикл: возврат на шаг 1', () => playback.running[0]?.stepIndex === 0, 2000);
  check(true, 'режим loop вернулся на первый шаг');

  console.log('— Пауза/стоп —');
  send({ type: 'pauseSequence', sequenceId: 'seq1' });
  await waitFor('пауза отражена', () => playback.running[0]?.paused === true);
  const held = ch(1);
  await sleep(300);
  check(ch(1) === held, `на паузе значение держится (${held})`);
  send({ type: 'resumeSequence', sequenceId: 'seq1' });
  await waitFor('снят с паузы', () => playback.running[0]?.paused === false);
  send({ type: 'stopAllPlayback' });
  await waitFor('общий стоп', () => playback.running.length === 0 && ch(1) === 0 && ch(10) === 0);
  check(true, 'общий стоп — все каналы в ноль');

  console.log('— Тест-генератор: строб/ступени/шум (§27 доработки — новые пресеты) —');
  {
    send({ type: 'testPattern', mode: 'strobe' });
    await waitFor('строб включает все каналы', () => ch(1) === 255 && ch(50) === 255, 2000);
    await waitFor('строб выключает все каналы', () => ch(1) === 0 && ch(50) === 0, 500);
    check(true, 'strobe: все каналы мигают синхронно 0/255 (2 Гц)');

    send({ type: 'testPattern', mode: 'stairs' });
    await waitFor('ступени применились', () => ch(1) !== ch(2) || ch(2) !== ch(3), 2000);
    check(true, 'stairs: соседние адреса дают разные уровни — видна ступенчатая структура');

    send({ type: 'testPattern', mode: 'solo' });
    let sample: number[] = [];
    await waitFor(
      'шум применился и не «залипает» на одном уровне',
      () => {
        sample = [ch(1), ch(2), ch(3), ch(4), ch(5)];
        return !sample.every((v) => v === sample[0]);
      },
      2000,
    );
    check(true, `random: соседние каналы не совпадают (${sample.join(',')})`);

    send({ type: 'testPattern', mode: 'off' });
    await waitFor('тест-генератор выключен', () => ch(1) === 0 && ch(50) === 0, 2000);
    check(true, 'off: возврат к обычному управлению, каналы в 0');
  }

  console.log('— Холостая сцена (§27 доработки, по примеру прежнего приложения — «Color Form») —');
  {
    send({ type: 'updateProject', project: { ...store.project, idleSceneId: 'sceneA' } });
    await waitFor('idleSceneId применён', () => projectEcho?.idleSceneId === 'sceneA');
    // valve1 (ch2) и R-канал rgb1 (ch10) — без калибровки, точные числа из sceneA (200/255/[255,0,40]).
    await waitFor('холостая сцена на выходе — ничего не играет', () => ch(2) === 255 && ch(10) === 255, 2000);
    check(true, 'idleSceneId: пока ничего не играет — на выходе холостая сцена вместо чёрного');

    send({ type: 'setScene', sceneId: 'sceneB' }); // sceneB не трогает valve1/R — обнулятся, если холостая реально снята
    await waitFor(
      'активная сцена полностью вытеснила холостую (не смешивается)',
      () => ch(2) === 0 && ch(10) === 0 && ch(11) === 128,
      2000,
    );
    check(true, 'холостая сцена не подмешивается, пока реально что-то играет');

    send({ type: 'setScene', sceneId: null });
    await waitFor('холостая сцена вернулась после снятия активной', () => ch(2) === 255 && ch(10) === 255, 2000);
    check(true, 'снятие активной сцены — холостая снова на выходе');

    // Пауза между элементами плейлиста — намеренное затемнение, холостая туда не подставляется.
    send({ type: 'playPlaylist', playlistId: 'pl1' });
    await waitFor('элемент 1 играет', () => playback.playlist?.itemIndex === 0 && ch(1) === 200, 2000);
    await waitFor('пауза между шоу — чёрное, не холостая', () => playback.playlist?.inGap === true && ch(2) === 0, 2000);
    check(true, 'пауза между элементами плейлиста остаётся чёрной, даже когда задана холостая сцена');
    send({ type: 'stopPlaylist' });
    await waitFor('плейлист остановлен, холостая снова на выходе', () => ch(2) === 255 && ch(10) === 255, 2000);

    send({ type: 'updateProject', project: { ...store.project, idleSceneId: null } });
    await waitFor('idleSceneId снят', () => projectEcho?.idleSceneId === null);
    await waitFor('без холостой сцены — чёрное', () => ch(2) === 0 && ch(10) === 0);
  }

  console.log('— Пауза всего (§27 доработки: заморозка картины, не гашение) —');
  send({ type: 'startSequence', sequenceId: 'seq1' });
  await waitFor('шаг 1 играет', () => ch(1) === 200 && ch(2) === 255);
  send({ type: 'pauseAll' });
  await waitFor('pausedAll отражён в состоянии', () => playback.pausedAll === true);
  const frozenVal = ch(1);
  await sleep(900); // дольше holdMs шага (600 мс) — без паузы секвенсор успел бы перейти на шаг 2
  check(
    ch(1) === frozenVal && playback.running[0]?.stepIndex === 0,
    `пауза всего держит картину (насос ${frozenVal}) и не даёт секвенсору продвинуться, хотя реальное время прошло`,
  );
  send({ type: 'resumeAll' });
  await waitFor('pausedAll снят', () => playback.pausedAll === false);
  await waitFor('секвенсор продолжил после снятия паузы', () => playback.running[0]?.stepIndex === 1, 2000);
  check(true, 'после resumeAll секвенсор продолжил с той же точки, а не скакнул вперёд');
  send({ type: 'stopAllPlayback' });
  await waitFor('стоп после теста паузы', () => playback.running.length === 0 && ch(1) === 0);

  console.log('— Эффект плавности секвенсора: Rate (§27 доработки, УХ п.16) —');
  send({ type: 'startSequence', sequenceId: 'seqEffect' });
  await waitFor('шаг 1 (сцена A, насос 200) отработал мгновенно — это ещё не зона перехода', () => ch(1) === 200, 500);
  // В 150 мс секвенсор переходит на шаг 2 (сцена B, насос 60, fadeMs=0) —
  // без эффекта канал прыгнул бы мгновенно; с rate/10 (tau=200мс) должен ещё
  // не долететь через ~60–150 мс после перехода.
  await waitFor(
    'после перехода на шаг 2 насос ещё в процессе плавного схождения к 60, не прыгнул мгновенно',
    () => ch(1) > 60 && ch(1) < 200,
    600,
  );
  check(true, `rate-эффект секвенсора: промежуточное значение поймано (${ch(1)})`);
  await waitFor('через ~1.5 с (7+ постоянных времени) значение сошлось к целевому 60', () => Math.abs(ch(1) - 60) <= 3, 2000);
  check(true, `rate-эффект секвенсора: сошлось к цели (${ch(1)})`);
  send({ type: 'stopAllPlayback' });
  await waitFor('стоп после теста эффекта секвенсора', () => playback.running.length === 0 && ch(1) === 0);

  console.log('— Эффект плавности дорожки шоу: Rate в зоне, вне зоны — как раньше (§27 доработки, УХ п.16) —');
  send({ type: 'playShow', showId: 'showEffect', positionMs: 0 });
  await waitFor(
    'на границе блоков A→B (t≈200-260мс) насос ещё не долетел до 60 — сглаживается зоной эффекта дорожки',
    () => ch(1) > 60 && ch(1) < 200,
    600,
  );
  check(true, `трек-эффект: промежуточное значение поймано (${ch(1)})`);
  await waitFor('через ~1.5 с сошлось к целевому 60', () => Math.abs(ch(1) - 60) <= 3, 2000);
  check(true, `трек-эффект: сошлось к цели (${ch(1)})`);
  send({ type: 'stopShow' });
  await waitFor('стоп после теста эффекта дорожки', () => ch(1) === 0);

  console.log('— Шкала плавности: больше — плавнее; старые проекты переводятся —');
  check(smoothReachSec(1) === 0.1 && smoothReachSec(100) === 10, 'плавность 1 — 0,1 с до цели, 100 — 10 с');
  {
    // Одинаковый скачок 0 → 255, полсекунды: чем больше плавность, тем меньше пройдено.
    const after = (sm: number): number => {
      let v = 0;
      for (let t = 0; t < 500; t += 50) v = smoothStep(v, 255, 'rate', sm, 50);
      return v;
    };
    check(after(5) > after(20) && after(20) > after(80), `больше плавность — медленнее переход (${after(5).toFixed(0)} > ${after(20).toFixed(0)} > ${after(80).toFixed(0)})`);
  }
  check(legacyStrengthToSmoothness(10) === 11, 'старая «сила 10» (≈ 1,1 с) → плавность 11');
  check(legacyStrengthToSmoothness(50) === 2, 'старая «сила 50» (≈ 0,22 с) → плавность 2');
  check(legacyStrengthToSmoothness(1) === 100, 'старая «сила 1» (≈ 11 с) упирается в верх шкалы — 10 с');
  check(
    projectEcho?.sequences.find((q) => q.id === 'seqEffect')?.effect?.smoothness === 11,
    'проект со старой «силой 10» движок сохранил как «плавность 11» — время перехода то же',
  );

  console.log('— Шоу: перемотка на паузе (стейтлес-рендер таймлайна) —');
  send({ type: 'playShow', showId: 'show1', positionMs: 0 });
  send({ type: 'pauseShow' });
  await waitFor('шоу на паузе', () => playback.show !== null && !playback.show.playing);
  send({ type: 'seekShow', positionMs: 1000 });
  await waitFor('позиция 1.0 с', () => ch(1) === 200 && ch(11) === 100);
  check(true, '1.0 с: блок сцены A (насос 200) + огибающая зелёного = 100');
  send({ type: 'seekShow', positionMs: 2200 });
  await waitFor('позиция 2.2 с', () => ch(2) === 255 && ch(1) === 0 && ch(11) === 180);
  check(true, '2.2 с: опережение +1 с — клапан 255 от точек 3.0–4.0 с, блок сцены уже погас');
  send({ type: 'seekShow', positionMs: 2600 });
  await waitFor('позиция 2.6 с', () => ch(1) === 200 && ch(2) === 255 && ch(11) === 140);
  check(true, '2.6 с: блок-секвенсор шаг 1 (сцена A целиком)');
  send({ type: 'seekShow', positionMs: 3300 });
  await waitFor('позиция 3.3 с', () => ch(1) === 130 && ch(2) === 128 && ch(11) === 70);
  check(true, '3.3 с: шаг 2 в середине фейда (насос 130, клапан 128), огибающая HTP 70');

  console.log('— Шоу: воспроизведение, синхронизация, автопауза в конце —');
  send({ type: 'playShow', showId: 'show1', positionMs: 0 });
  await waitFor('шоу играет', () => playback.show?.playing === true);
  send({ type: 'syncShow', positionMs: 2200 });
  await waitFor('тихая коррекция позиции', () => ch(2) === 255, 1000);
  check(true, 'syncShow перекинул позицию по аудио-часам без остановки');
  await waitFor(
    'автопауза в конце',
    () => playback.show?.playing === false && playback.show.positionMs === 4000,
    3000,
  );
  check(true, 'конец таймлайна: автопауза ровно на 4.000 с');
  send({ type: 'stopShow' });
  await waitFor('стоп шоу', () => playback.show === null && ch(1) === 0 && ch(2) === 0 && ch(11) === 0);
  check(true, 'стоп шоу — слой снят, каналы в ноль');

  console.log('— Монтаж вырезок (хелперы) —');
  const cuts = mergeCuts([
    { startMs: 3000, endMs: 3500 },
    { startMs: 1000, endMs: 2000 },
    { startMs: 1800, endMs: 2000 },
  ]);
  check(
    cuts.length === 2 && cuts[0]!.startMs === 1000 && cuts[0]!.endMs === 2000,
    'mergeCuts: сортировка и слияние пересечений',
  );
  check(editedToSourceMs(cuts, 2600) === 4100, 'editedToSourceMs: 2.6 с монтажа = 4.1 с исходника');
  check(sourceToEditedMs(cuts, 4100) === 2600, 'sourceToEditedMs: обратное преобразование');
  const segs = keptSegments(cuts, 5000);
  check(
    segs.length === 3 && segs[2]!.startMs === 3500 && segs[2]!.endMs === 5000,
    'keptSegments: куски аудио между вырезками',
  );

  console.log('— Плейлист: автономная последовательность шоу —');
  send({ type: 'playPlaylist', playlistId: 'pl1' });
  await waitFor(
    'элемент 1 играет',
    () => playback.playlist?.itemIndex === 0 && playback.playlist.inGap === false && ch(1) === 200,
  );
  check(true, 'элемент 1: «Короткое 1» на выходе (сцена A)');
  await waitFor('пауза между шоу', () => playback.playlist?.inGap === true && ch(1) === 0, 2000);
  check(true, 'после 0.6 с — пауза между шоу, каналы в ноль');
  await waitFor(
    'элемент 2 играет',
    () => playback.playlist?.itemIndex === 1 && ch(1) === 60 && ch(11) === 128,
    2000,
  );
  check(true, 'через 0.3 с паузы — элемент 2 (сцена B)');
  await waitFor(
    'плейлист завершён',
    () => playback.playlist === null && playback.show === null && ch(1) === 0 && ch(11) === 0,
    2000,
  );
  check(true, 'режим «один раз»: плейлист закончился, всё в ноль');

  console.log('— Плейлист: перехват управления редактором —');
  send({ type: 'playPlaylist', playlistId: 'pl1' });
  await waitFor('плейлист снова играет', () => playback.playlist !== null && ch(1) === 200);
  send({ type: 'pauseShow' });
  await waitFor(
    'редактор перехватил шоу',
    () => playback.playlist === null && playback.show !== null && !playback.show.playing,
  );
  check(true, 'pauseShow из редактора снял плейлист, шоу осталось на паузе');
  send({ type: 'stopShow' });
  await waitFor('шоу остановлено', () => playback.show === null && ch(1) === 0);

  console.log('— Плейлист: старт «с места остановки» (§27 доработки, по примеру прежнего приложения) —');
  {
    send({ type: 'updateProject', project: { ...store.project, playlists: store.project.playlists.map((p) => (p.id === 'pl1' ? { ...p, onStart: 'resume' } : p)) } });
    await waitFor('onStart=resume применён', () => projectEcho?.playlists.find((p) => p.id === 'pl1')?.onStart === 'resume');

    send({ type: 'playPlaylist', playlistId: 'pl1' });
    await waitFor('элемент 1 играет (первый запуск — с начала)', () => playback.playlist?.itemIndex === 0 && ch(1) === 200);
    await waitFor('элемент 2 играет', () => playback.playlist?.itemIndex === 1 && ch(1) === 60 && ch(11) === 128, 2000);
    send({ type: 'stopPlaylist' }); // прерываем на элементе 2 (itemIndex=1)
    await waitFor('плейлист остановлен на элементе 2', () => playback.playlist === null && ch(1) === 0);

    send({ type: 'playPlaylist', playlistId: 'pl1' }); // без явного itemIndex — должен сразу продолжить с элемента 2
    await waitFor('resume сразу вернул на элемент 2, минуя элемент 1', () => playback.playlist?.itemIndex === 1 && ch(11) === 128, 2000);
    check(true, 'onStart=resume: повторный запуск без явного itemIndex продолжил с последнего пункта (1), а не с начала');
    await waitFor('плейлист доигран целиком', () => playback.playlist === null && playback.show === null, 2000);

    send({ type: 'playPlaylist', playlistId: 'pl1' }); // доигран естественно — resume должен начать заново
    await waitFor('после естественного завершения resume начал сначала (элемент 0)', () => playback.playlist?.itemIndex === 0 && ch(1) === 200, 2000);
    check(true, 'onStart=resume: плейлист, доигранный до конца (не прерванный), в следующий раз стартует с начала');
    send({ type: 'stopPlaylist' });
    await waitFor('плейлист снова остановлен', () => playback.playlist === null && ch(1) === 0);

    // Место остановки сохраняется и переживает перезапуск движка.
    const savedPositions: Record<string, number>[] = [];
    engine.onPlaylistPositions = (p) => savedPositions.push(p);
    // Остановили посреди пункта 2 — сохраниться должен он (шоу здесь короткие,
    // естественное окончание дало бы «с начала», и это тоже верно).
    send({ type: 'playPlaylist', playlistId: 'pl1', itemIndex: 1 });
    await waitFor('играет элемент 2', () => playback.playlist?.itemIndex === 1, 2000);
    send({ type: 'stopPlaylist' });
    await waitFor('плейлист остановлен', () => playback.playlist === null);
    await waitFor('место остановки сохранено', () => savedPositions.length > 0 && savedPositions[savedPositions.length - 1]!.pl1 === 1, 3000);
    check(true, 'движок сообщил место плейлиста для сохранения на диск (остановлен на пункте 2 → pl1: 1)');
    engine.onPlaylistPositions = null;
    {
      // «Перезапуск»: новый движок, в памяти воспроизведения пусто, есть только сохранённое.
      const fresh = new Engine({
        server: { port: 9599 },
        timing: { tickMs: 50, spinMs: 2, uiFrameMs: 100 },
        audio: { player: 'none', ffplayPath: '', volumeDb: 0, muted: false, bassDb: 0, trebleDb: 0 },
        universes: [{ id: 1, label: 'Вселенная 1', outputs: [] }],
        backup: { enabled: false, intervalMin: 60 },
      } as never);
      fresh.setProject(store.project);
      fresh.start();
      fresh.setPlaylistPositions({ pl1: 1 });
      fresh.playPlaylist('pl1', undefined);
      let itemAfterRestart: number | null = null;
      for (let i = 0; i < 40 && itemAfterRestart === null; i++) {
        await new Promise((r) => setTimeout(r, 50));
        itemAfterRestart = fresh.playbackState().playlist?.itemIndex ?? null;
      }
      fresh.stop();
      check(itemAfterRestart === 1, `после перезапуска движка «с места остановки» продолжил с пункта 2, а не с начала (${itemAfterRestart})`);
    }

    send({ type: 'updateProject', project: { ...store.project, playlists: store.project.playlists.map((p) => (p.id === 'pl1' ? { ...p, onStart: 'restart' } : p)) } });
    await waitFor('onStart возвращён в restart', () => projectEcho?.playlists.find((p) => p.id === 'pl1')?.onStart === 'restart');
  }

  console.log('— Расписание по системному времени —');
  const scheduler = new Scheduler(engine, () => store.project.schedules);
  scheduler.start();
  /** Время «ЧЧ:ММ:СС» через ms от сейчас. */
  const hms = (ms: number): string => {
    const at = new Date(Date.now() + ms);
    return [at.getHours(), at.getMinutes(), at.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
  };
  const entry = (id: string, time: string, action: unknown, blackoutSec = 0): unknown => ({
    id,
    name: id,
    enabled: true,
    days: [],
    time,
    action,
    blackoutSec,
  });
  const setSchedules = (schedules: unknown[]): void =>
    send({ type: 'updateProject', project: { ...demo, schedules } as never });
  const t1 = hms(1500);
  setSchedules([{ id: 's1', name: 'Основное', enabled: true, entries: [entry('sch1', t1, { type: 'scene', refId: 'sceneA' })] }]);
  await waitFor('расписание сработало', () => playback.activeSceneId === 'sceneA' && ch(1) === 200, 5000);
  check(true, `запись «${t1} → сцена» сработала по системным часам`);

  // Переход: ручные ползунки и прежнее воспроизведение сбрасываются.
  send({ type: 'setChannel', universe: 1, channel: 12, value: 77 });
  await waitFor('ручной ползунок', () => ch(12) === 77);
  const t2 = hms(1500);
  setSchedules([{ id: 's1', name: 'Основное', enabled: true, entries: [entry('sch2', t2, { type: 'stopAll' })] }]);
  // Остановку воспроизведения поток расчёта подтверждает чуть позже, чем гаснет
  // кадр, — ждём и её, а не смотрим в тот же миг.
  await waitFor('«Стоп» сработал', () => playback.dark === 'off' && ch(1) === 0 && ch(12) === 0 && playback.activeSceneId === null, 5000);
  check(playback.activeSceneId === null, '«Стоп»: сцена остановлена, всё в 0 до следующего запуска');
  check(ch(12) === 0, 'ручной ползунок с «Отладки» сброшен записью расписания');
  // Сцена покоя при «Стопе» тоже не горит: стоп гасит всё.
  send({
    type: 'updateProject',
    project: { ...demo, idleSceneId: 'sceneB', schedules: [{ id: 's1', name: 'Основное', enabled: true, entries: [] }] } as never,
  });
  await new Promise((r) => setTimeout(r, 600));
  check(ch(1) === 0 && playback.dark === 'off', `после «Стопа» сцена покоя не горит (насос ${ch(1)})`);
  send({ type: 'setScene', sceneId: 'sceneA' });
  await waitFor('ручной запуск после стопа', () => playback.dark !== 'off' && ch(1) === 200, 3000);
  check(true, 'ручной запуск после «Стопа» — фонтан снова работает');

  // Гашение перехода: сначала всё в 0, через секунду — новое.
  const t3 = hms(1500);
  setSchedules([
    { id: 's1', name: 'Основное', enabled: true, entries: [entry('sch3', t3, { type: 'sequence', refId: 'seq1' }, 1)] },
  ]);
  await waitFor('гашение перехода', () => playback.dark === 'transition' && ch(1) === 0 && playback.activeSceneId === null, 5000);
  check(playback.activeSceneId === null, 'запись с гашением: прежняя сцена остановлена, всё в 0');
  await waitFor('после гашения — секвенсор', () => playback.dark !== 'transition' && playback.running.some((r) => r.sequenceId === 'seq1'), 4000);
  check(true, 'через 1 с гашения запустился секвенсор');

  // Коллизия: две записи в одну секунду — исполняется первая, о второй — в журнал.
  const t4 = hms(1500);
  setSchedules([
    { id: 's1', name: 'Основное', enabled: true, entries: [entry('sch4', t4, { type: 'scene', refId: 'sceneA' })] },
    { id: 's2', name: 'Второе', enabled: true, entries: [entry('sch5', t4, { type: 'stopAll' })] },
  ]);
  await waitFor('коллизия разобрана', () => playback.activeSceneId === 'sceneA' && !playback.running.some((r) => r.sequenceId === 'seq1'), 5000);
  await new Promise((r) => setTimeout(r, 300));
  check(playback.dark !== 'off', 'коллизия: сработала только первая запись');
  check(
    logEvents.some((e) => e.source === 'schedule' && e.level === 'warn' && e.message.includes('не исполнена')),
    'коллизия: о второй записи — предупреждение в журнале',
  );

  // Неактивное расписание не срабатывает.
  const t5 = hms(1500);
  setSchedules([{ id: 's1', name: 'Основное', enabled: false, entries: [entry('sch6', t5, { type: 'stopAll' })] }]);
  await new Promise((r) => setTimeout(r, 2500));
  check(playback.dark !== 'off' && playback.activeSceneId === 'sceneA', 'выключенное расписание не срабатывает');

  // После перезапуска движка: что должно идти сейчас.
  scheduler.stop();
  send({ type: 'stopAllPlayback' });
  await waitFor('всё остановлено', () => playback.activeSceneId === null && playback.running.length === 0);
  setSchedules([
    {
      id: 's1',
      name: 'Основное',
      enabled: true,
      entries: [
        entry('sch7', hms(-2 * 3600_000), { type: 'scene', refId: 'sceneA' }),
        entry('sch8', hms(-3600_000), { type: 'sequence', refId: 'seq1' }),
      ],
    },
  ]);
  await waitFor('расписание сохранено', () => store.project.schedules[0]?.entries.length === 2);
  scheduler.catchUp(new Date());
  await waitFor('восстановлено', () => playback.running.some((r) => r.sequenceId === 'seq1'), 3000);
  check(playback.activeSceneId === null, 'после запуска движка включено то, что по расписанию идёт сейчас (последняя запись), а не всё подряд');

  // Старый объект с одним списком schedule открывается как одно расписание.
  const migrated = sanitizeProject({ ...demo, schedules: undefined, schedule: [entry('old', '21:00', { type: 'stopAll' })] } as never);
  check(
    migrated.schedules.length === 1 && migrated.schedules[0]!.enabled && migrated.schedules[0]!.entries[0]?.action.type === 'stopAll',
    'старый объект: прежние записи — в расписании «Основное», оно активно',
  );
  const oldKinds = sanitizeProject({
    ...demo,
    schedules: [{ id: 'x', name: 'x', enabled: true, entries: [entry('p', '10:00', { type: 'pause' }), entry('o', '11:00', { type: 'off' })] }],
  } as never);
  check(
    oldKinds.schedules[0]!.entries.every((e) => e.action.type === 'stopAll'),
    'записи «Пауза» и «Выключить» (были один день) открываются как «Стоп»',
  );
  send({ type: 'stopAllPlayback' });
  await waitFor('сцена снята', () => ch(1) === 0);

  console.log('— Калибровка min/max (0 остаётся 0, 1–255 → min–max) —');
  send({
    type: 'updateProject',
    project: {
      ...demo,
      devices: demo.devices.map((d) => (d.id === 'pump1' ? { ...d, trim: [{ min: 50, max: 200 }] } : d)),
    },
  });
  send({ type: 'setScene', sceneId: 'sceneA' });
  // Сцена даёт насосу 200 → калибровка: 50 + 200·150/255 = 168.
  await waitFor('калиброванный выход', () => ch(1) === 168 && ch(2) === 255);
  check(true, 'насос 200 → 168 по калибровке 50–200; клапан без калибровки — 255');
  send({ type: 'setScene', sceneId: null });
  await waitFor('ноль остаётся нулём', () => ch(1) === 0);
  check(true, 'выключенный канал не поднимается до min');

  console.log('— Переадресация (хелперы патча) —');
  const swapped = swapDeviceAddresses(demo, 'pump1', 'rgb1');
  check(
    swapped.devices.find((d) => d.id === 'pump1')!.address === 10 &&
      swapped.devices.find((d) => d.id === 'rgb1')!.address === 1,
    'swapDeviceAddresses: насос и RGB поменялись адресами',
  );
  const shifted = shiftDeviceAddresses(demo, ['pump1', 'valve1'], 5);
  check(
    shifted.devices.find((d) => d.id === 'pump1')!.address === 6 &&
      shifted.devices.find((d) => d.id === 'valve1')!.address === 7 &&
      shifted.devices.find((d) => d.id === 'rgb1')!.address === 10,
    'shiftDeviceAddresses: выбранные +5, остальные на месте',
  );

  console.log('— 3D-схема и DXF —');
  const layoutRaw = {
    bowls: [{ id: 'bowl1', name: 'Чаша', shape: 'circle', x: 0, y: 0, radius: 5, width: 10, length: 10, height: 0.3 }],
    nozzles: [
      { id: 'noz1', name: 'Ф1', kind: 'straight', x: 1, y: 2, z: 0, tiltDeg: 0, headingDeg: 0, maxHeightM: 5, riseMs: 800, fallMs: 1100, pumpDeviceId: 'pump1', valveDeviceId: 'нет-такого', lightDeviceId: 'rgb1' },
      { id: 'noz2', name: 'Ф2', kind: 'не-тип', x: 9999, y: 0, z: 0, tiltDeg: 200 },
    ],
    lights: [{ id: 'lt1', name: 'П1', x: 0, y: 1, z: -0.2, deviceId: 'rgb1' }],
    nozzleGroups: [{ id: 'grp1', name: 'Контур 1', nozzleIds: ['noz1', 'нет-такой-форсунки'] }],
  };
  const sanitized = sanitizeProject({ ...demo, layout: layoutRaw });
  const noz1 = sanitized.layout.nozzles.find((n) => n.id === 'noz1')!;
  const noz2 = sanitized.layout.nozzles.find((n) => n.id === 'noz2')!;
  check(
    sanitized.layout.bowls.length === 1 &&
      noz1.pumpDeviceId === 'pump1' &&
      noz1.valveDeviceId === null &&
      noz1.lightDeviceId === 'rgb1' &&
      noz2.kind === 'straight' &&
      noz2.x === 1000 &&
      // Наклон теперь допускается в обе стороны: предел ±90°, а не 0…85°.
      noz2.tiltDeg === 90 &&
      sanitized.layout.lights[0]!.deviceId === 'rgb1',
    'sanitizeLayout: битые ссылки и значения приведены, элементы сохранены',
  );
  check(
    sanitized.layout.nozzleGroups.length === 1 &&
      sanitized.layout.nozzleGroups[0]!.nozzleIds.length === 1 &&
      sanitized.layout.nozzleGroups[0]!.nozzleIds[0] === 'noz1',
    'sanitizeLayout: контур сохранён, ссылка на несуществующую форсунку в группе отброшена',
  );
  const ring = ringPositions(4, 2);
  check(
    ring.length === 4 &&
      Math.abs(ring[0]!.x - 2) < 1e-9 &&
      Math.abs(ring[1]!.y - 2) < 1e-9 &&
      Math.abs(ring[2]!.x + 2) < 1e-9,
    'ringPositions: 4 точки по кольцу радиуса 2',
  );
  const dxfText = [
    '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'POINT', '8', 'FORSUNKI', '10', '1000', '20', '2000',
    '0', 'CIRCLE', '8', 'CHASHA', '10', '0', '20', '0', '40', '5000',
    '0', 'INSERT', '8', 'SVET', '2', 'LAMP', '10', '3000', '20', '0',
    '0', 'LWPOLYLINE', '8', 'BORT', '70', '1', '90', '4',
    '10', '-1000', '20', '-1000', '10', '1000', '20', '-1000', '10', '1000', '20', '1000', '10', '-1000', '20', '1000',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const dxf = parseDxf(dxfText);
  check(
    dxf.insunits === 4 &&
      dxf.points.length === 3 &&
      dxf.polylines.length === 1 &&
      dxf.polylines[0]!.closed &&
      dxf.layers.join(',') === 'BORT,CHASHA,FORSUNKI,SVET',
    'parseDxf: точки, окружность, вставка, полилиния и $INSUNITS разобраны',
  );
  const imported = layoutFromDxf(dxf, {
    unitScale: insunitsToMeters(dxf.insunits),
    layerRoles: { FORSUNKI: 'nozzle', SVET: 'light', CHASHA: 'bowl', BORT: 'bowl' },
    center: false,
  });
  check(
    imported.nozzles.length === 1 &&
      Math.abs(imported.nozzles[0]!.x - 1) < 1e-9 &&
      Math.abs(imported.nozzles[0]!.y - 2) < 1e-9 &&
      imported.lights.length === 1 &&
      imported.bowls.length === 2 &&
      imported.bowls.find((b) => b.shape === 'circle')!.radius === 5 &&
      imported.bowls.find((b) => b.shape === 'rect')!.width === 2,
    'layoutFromDxf: мм → метры, слои разложены по ролям, чаши из круга и контура',
  );

  console.log('— Контуры: геометрия группы форсунок (§27 доработки) —');
  {
    const base = (id: string, x: number, y: number, headingDeg = 0) => ({
      id,
      name: id,
      kind: 'straight' as const,
      x,
      y,
      z: 0,
      tiltDeg: 0,
      headingDeg,
      maxHeightM: 3,
      widthM: 0.03,
      coneAngleDeg: 25,
      rotationSpeedDegPerSec: 60,
      riseMs: 500,
      fallMs: 500,
      pumpDeviceId: null,
      pump2DeviceId: null,
      valveDeviceId: null,
      extraPumpDeviceIds: [],
      extraValveDeviceIds: [],
      extraLightDeviceIds: [],
      extraPump2DeviceIds: [],
      modelFile: null,
      modelScale: 1,
      sprayFactor: 0.3,
      lightDeviceId: null,
    });
    const geomNozzles = [base('a', 0, 0), base('b', 2, 0), base('outside', 100, 100)];
    const members = ['a', 'b'];

    const c = nozzleGroupCentroid(geomNozzles, members);
    check(Math.abs(c.x - 1) < 1e-9 && Math.abs(c.y - 0) < 1e-9, `nozzleGroupCentroid: центр (0,0)-(2,0) = (1,0) (получено ${c.x},${c.y})`);

    const rotated = rotateNozzleGroup(geomNozzles, members, 90);
    const ra = rotated.find((n) => n.id === 'a')!;
    const rb = rotated.find((n) => n.id === 'b')!;
    const rOut = rotated.find((n) => n.id === 'outside')!;
    check(
      Math.abs(ra.x - 1) < 1e-6 && Math.abs(ra.y - -1) < 1e-6 && Math.abs(rb.x - 1) < 1e-6 && Math.abs(rb.y - 1) < 1e-6,
      `rotateNozzleGroup: поворот на 90° вокруг (1,0) — a→(1,-1), b→(1,1) (получено a=(${ra.x},${ra.y}), b=(${rb.x},${rb.y}))`,
    );
    check(ra.headingDeg === 90 && rb.headingDeg === 90, 'rotateNozzleGroup: азимут форсунок сдвинут на тот же угол');
    check(rOut.x === 100 && rOut.y === 100, 'rotateNozzleGroup: форсунка вне группы не тронута');

    const moved = translateNozzleGroup(geomNozzles, members, 5, -3);
    const ma = moved.find((n) => n.id === 'a')!;
    const mb = moved.find((n) => n.id === 'b')!;
    const mOut = moved.find((n) => n.id === 'outside')!;
    check(
      ma.x === 5 && ma.y === -3 && mb.x === 7 && mb.y === -3,
      `translateNozzleGroup: сдвиг (+5,-3) — a→(5,-3), b→(7,-3) (получено a=(${ma.x},${ma.y}), b=(${mb.x},${mb.y}))`,
    );
    check(mOut.x === 100 && mOut.y === 100, 'translateNozzleGroup: форсунка вне группы не тронута');
  }

  console.log('— Генераторы сцен от геометрии (§17 п.2–3) —');
  const genActors = ringPositions(4, 2).map((p, i) => ({ deviceId: `gp${i + 1}`, x: p.x, y: p.y }));
  const genLayout = {
    bowls: [],
    lights: [],
    nozzleGroups: [],
    nozzles: genActors.map((a, i) => ({
      id: `noz${i}`,
      name: `Форсунка ${i}`,
      kind: 'straight' as const,
      x: a.x,
      y: a.y,
      z: 0,
      tiltDeg: 0,
      headingDeg: 0,
      maxHeightM: 3,
      widthM: 0.03,
      coneAngleDeg: 25,
      rotationSpeedDegPerSec: 60,
      riseMs: 500,
      fallMs: 500,
      pumpDeviceId: a.deviceId,
      pump2DeviceId: null,
      valveDeviceId: null,
      extraPumpDeviceIds: [],
      extraValveDeviceIds: [],
      extraLightDeviceIds: [],
      extraPump2DeviceIds: [],
      modelFile: null,
      modelScale: 1,
      sprayFactor: 0.3,
      lightDeviceId: null,
    })),
  };
  check(
    JSON.stringify(layoutActors(genLayout, 'pump').map((a) => a.deviceId)) ===
      JSON.stringify(genActors.map((a) => a.deviceId)),
    'layoutActors: насосы собраны с форсунок схемы в порядке форсунок',
  );

  const genProfiles = profileMap(emptyProject());
  const genDevices: Project['devices'] = genActors.map((a) => ({
    id: a.deviceId,
    name: a.deviceId,
    profileId: 'pump',
    universe: 1,
    address: 1,
  }));
  const wave = radialWaveScene(genActors, genDevices, genProfiles, { cycles: 1 });
  check(
    wave.values['gp2']?.[0] === 255 && wave.values['gp4']?.[0] === 0,
    'radialWaveScene: волна по кольцу — максимум на 90°, минимум на 270° (детерминированно от геометрии)',
  );
  const waveSeq = radialWaveSequenceScenes(genActors, genDevices, genProfiles, 4, {});
  check(
    waveSeq.length === 4 && waveSeq[0]!.values['gp2']![0] !== waveSeq[1]!.values['gp2']![0],
    'radialWaveSequenceScenes: 4 сцены с фазовым сдвигом — секвенсор из них даст бегущую волну',
  );

  // Линейный фонтан: 5 насосов вдоль наклонной прямой — фазы 0..1 по порядку на линии.
  const lineActors = Array.from({ length: 5 }, (_, i) => ({ deviceId: `ln${i}`, x: i * 2, y: i * 1 }));
  const linePhases = actorPhases(lineActors, 'line');
  check(
    Math.abs(linePhases.get('ln0')! - 0) < 1e-9 &&
      Math.abs(linePhases.get('ln2')! - 0.5) < 1e-9 &&
      Math.abs(linePhases.get('ln4')! - 1) < 1e-9,
    'actorPhases(line): фазы 0/0.5/1 вдоль наклонной линии (главная ось найдена)',
  );
  // Вытянутый прямоугольник (широкий и низкий): по углу вокруг центра вершины
  // клюются неравномерно (короткие стороны рядом по углу), а по обходу контура
  // фаза идёт пропорционально пройденному расстоянию — длинные стороны дают
  // большие скачки фазы, короткие — маленькие. Проверяем именно это различие.
  const rectActors = [
    { deviceId: 'qA', x: 10, y: 1 },
    { deviceId: 'qB', x: 10, y: -1 },
    { deviceId: 'qC', x: -10, y: -1 },
    { deviceId: 'qD', x: -10, y: 1 },
  ];
  const pathPhases = actorPhases(rectActors, 'path');
  check(pathPhases.size === 4, 'actorPhases(path): фаза посчитана для всех актёров');
  const sortedByPhase = [...pathPhases.entries()].sort((a, b) => a[1] - b[1]);
  const gaps: number[] = [];
  for (let i = 0; i < sortedByPhase.length; i++) {
    const next = sortedByPhase[(i + 1) % sortedByPhase.length]![1];
    const cur = sortedByPhase[i]![1];
    gaps.push(next > cur ? next - cur : next - cur + 1); // с учётом замыкания через 0
  }
  const minGap = Math.min(...gaps);
  const maxGap = Math.max(...gaps);
  check(
    maxGap / minGap > 5,
    `actorPhases(path): для вытянутого прямоугольника скачки фазы разные (короткая/длинная сторона), отношение ${(maxGap / minGap).toFixed(1)}`,
  );

  const invScene: Scene = { id: 'sX', name: 'Тест', values: { gp1: [200], gp2: [0] } };
  const inv = invertScene(invScene);
  check(inv.values['gp1']?.[0] === 55 && inv.values['gp2']?.[0] === 255, 'invertScene: 255-v по каждому каналу');

  const mirScene: Scene = { id: 'sY', name: 'Тест', values: { gp1: [10], gp2: [20], gp3: [30], gp4: [40] } };
  const mirrored = mirrorScene(mirScene, genActors, 'x');
  check(
    mirrored.values['gp1']?.[0] === 30 &&
      mirrored.values['gp3']?.[0] === 10 &&
      mirrored.values['gp2']?.[0] === 20 &&
      mirrored.values['gp4']?.[0] === 40,
    'mirrorScene: лево-право по оси X — gp1↔gp3 поменялись, gp2/gp4 на оси остались собой',
  );

  console.log('— Библиотека эффектов-генераторов: радуга/дыхание/каскад/салют (§27 п.15) —');
  {
    const rgbDevices: Project['devices'] = genActors.map((a) => ({
      id: a.deviceId,
      name: a.deviceId,
      profileId: 'rgb',
      universe: 1,
      address: 1,
    }));
    const rainbow = rainbowSequenceScenes(genActors, rgbDevices, genProfiles, 4, { mode: 'angle' });
    check(
      rainbow.length === 4 &&
        JSON.stringify(rainbow[0]!.values['gp1']) === JSON.stringify([255, 0, 0]) &&
        JSON.stringify(rainbow[0]!.values['gp3']) === JSON.stringify([0, 255, 255]),
      `rainbowSequenceScenes: на шаге 0 — gp1 (0°) красный, gp3 (180°) циан (${JSON.stringify(rainbow[0]!.values['gp1'])}, ${JSON.stringify(rainbow[0]!.values['gp3'])})`,
    );

    const breathing = breathingSequenceScenes(genActors, genDevices, genProfiles, 4, {});
    check(
      breathing[0]!.values['gp1']![0] === 0 &&
        breathing[2]!.values['gp1']![0] === 255 &&
        breathing[1]!.values['gp1']![0] === breathing[3]!.values['gp1']![0],
      `breathingSequenceScenes: единый пульс на все актёры — мин на шаге 0, макс на шаге 2, симметрия 1/3 (${breathing.map((s) => s.values['gp1']![0]).join(',')})`,
    );

    const cascade = cascadeSequenceScenes(genActors, genDevices, genProfiles, 4, { mode: 'angle', windowFrac: 0.1 });
    check(
      cascade.every((s, i) => {
        const litIds = Object.entries(s.values)
          .filter(([, v]) => v[0] === 255)
          .map(([id]) => id);
        return litIds.length === 1 && litIds[0] === `gp${i + 1}`;
      }),
      'cascadeSequenceScenes: на каждом шаге зажжён ровно один актёр — тот, чья фаза совпала с окном',
    );

    const salute1 = saluteSequenceScenes(genActors, genDevices, genProfiles, 5, { seed: 42, burstSize: 1 });
    const salute2 = saluteSequenceScenes(genActors, genDevices, genProfiles, 5, { seed: 42, burstSize: 1 });
    check(
      // id — случайный uid() на каждый вызов, сравниваем только сами значения каналов.
      JSON.stringify(salute1.map((s) => s.values)) === JSON.stringify(salute2.map((s) => s.values)),
      'saluteSequenceScenes: одинаковый seed → одинаковый результат (воспроизводимо, не Math.random)',
    );
    check(
      salute1.every((s) => Object.values(s.values).filter((v) => v[0] === 255).length === 1),
      'saluteSequenceScenes: burstSize=1 — на каждом шаге вспыхивает ровно один актёр',
    );
  }

  console.log('— Огибающая: прореживание и сглаживание живой записи (§27 доработки, УХ п.17б) —');
  {
    // Три точки ровно на прямой y=x/2 — среднюю точку RDP должен выбросить
    // (расстояние до прямой между концами ровно 0).
    const collinear = [
      { tMs: 0, value: 0 },
      { tMs: 100, value: 50 },
      { tMs: 200, value: 100 },
    ];
    const decCollinear = decimateEnvelope(collinear, 1);
    check(
      decCollinear.length === 2 && decCollinear[0]!.tMs === 0 && decCollinear[1]!.tMs === 200,
      `decimateEnvelope: три точки на прямой → средняя выброшена, остались концы (осталось ${decCollinear.length})`,
    );

    // Треугольник — средняя точка реальный пик, должна остаться.
    const spike = [
      { tMs: 0, value: 0 },
      { tMs: 100, value: 50 },
      { tMs: 200, value: 0 },
    ];
    const decSpike = decimateEnvelope(spike, 1);
    check(
      decSpike.length === 3,
      `decimateEnvelope: настоящий пик не выбрасывается, даже с малым допуском (осталось ${decSpike.length})`,
    );

    // Одиночный всплеск на ровном фоне: треугольное окно 300 мс (±150 мс) —
    // значения на t=100 и t=200 посчитаны вручную (см. комментарий выше по коду).
    const noisy = [
      { tMs: 0, value: 0 },
      { tMs: 100, value: 0 },
      { tMs: 200, value: 100 },
      { tMs: 300, value: 0 },
      { tMs: 400, value: 0 },
    ];
    const smoothed = smoothEnvelopeValues(noisy, 300);
    check(
      smoothed.length === 5 && smoothed[1]!.value === 20 && smoothed[2]!.value === 60,
      `smoothEnvelopeValues: всплеск 0-0-100-0-0 при окне 300мс → 20/60 на соседях/пике (получено ${smoothed[1]!.value}/${smoothed[2]!.value})`,
    );
    check(
      smoothed.every((p, i) => p.tMs === noisy[i]!.tMs),
      'smoothEnvelopeValues: время точек не сдвигается, меняется только value',
    );
    const identity = smoothEnvelopeValues(noisy, 0);
    check(
      JSON.stringify(identity) === JSON.stringify(noisy),
      'smoothEnvelopeValues: окно 0 — точки не меняются (тождественное преобразование)',
    );
  }

  console.log('— EMA-джиттер тик-планировщика: устойчивость к одиночному сбою —');
  // Раньше avgJitterMs был «сумма/n» за всё время жизни движка: headless-процесс
  // живёт сутками (§9, §18), и один сбой (сон Windows, зависание антивируса —
  // что угодно, остановившее event loop) навсегда портил показание, потому что
  // разбавить один гигантский сэмпл миллионами последующих нечем. Проверяем,
  // что EMA-версия отходит от катастрофического выброса за разумное число тиков.
  let ema = -1;
  for (let i = 0; i < 200; i++) ema = emaStep(ema, 1, 0.01); // нормальная работа, ~1 мс джиттера
  check(Math.abs(ema - 1) < 0.05, `emaStep: сходится к стабильному уровню шума (${ema.toFixed(3)} мс)`);
  ema = emaStep(ema, 30_000_000, 0.01); // один катастрофический сбой (напр. сон ОС на часы)
  const peakAfterStall = ema;
  check(peakAfterStall > 100_000, 'emaStep: одиночный выброс сразу поднимает среднее — инцидент не прячется');
  for (let i = 0; i < 500; i++) ema = emaStep(ema, 1, 0.01); // снова нормальная работа, 500 тиков ≈ 25 с
  check(
    ema < peakAfterStall * 0.01,
    `emaStep: за 500 тиков (≈25 с) после сбоя среднее упало более чем в 100 раз (${peakAfterStall.toFixed(0)} → ${ema.toFixed(1)} мс) — со старым «сумма/n» оно осталось бы отравлено буквально годами`,
  );
  for (let i = 0; i < 600; i++) ema = emaStep(ema, 1, 0.01); // ещё ~30 с — полное восстановление к норме
  check(ema < 10, `emaStep: ещё ~30 с — среднее полностью в норме (${ema.toFixed(2)} мс)`);

  console.log('— Аудиоанализ трека (§17 п.5) —');
  // Синтетический клик-трек: короткие импульсы ровно 4 раза в секунду = 240 BPM,
  // затем 1 с тишины. Детерминированная проверка темпа, огибающей и тишины.
  const sr = 22050;
  const clickBpm = 120;
  const beatSamples = Math.round((sr * 60) / clickBpm);
  const totalSamples = sr * 5; // 4 с клики + 1 с тишина
  const sig = new Float32Array(totalSamples);
  for (let b = 0; b * beatSamples < sr * 4; b++) {
    const at = b * beatSamples;
    for (let i = 0; i < 200 && at + i < sig.length; i++) {
      // Затухающий импульс.
      sig[at + i] = Math.sin((i / sr) * 2 * Math.PI * 1000) * Math.exp(-i / 40);
    }
  }
  const tempo = estimateTempo(sig, sr, { minBpm: 70, maxBpm: 180 });
  // Автокорреляция может поймать кратный/дольный период — принимаем 120 или его октавы.
  check(
    [60, 120, 240].includes(tempo.bpm),
    `estimateTempo: клик-трек 120 BPM определён как ${tempo.bpm} BPM (допустимы октавы 60/120/240)`,
  );
  check(tempo.beatsMs.length >= 3, `estimateTempo: сетка долей построена (${tempo.beatsMs.length} долей)`);
  check(tempoCategory(120) === 'medium' && tempoCategory(150) === 'fast', 'tempoCategory: 120→medium, 150→fast');

  const env = energyEnvelope(sig, sr, 50);
  check(env.rms.length === Math.ceil(totalSamples / Math.round((sr * 50) / 1000)), 'energyEnvelope: число окон по hopMs');
  check(Math.max(...env.rms) === 1, 'energyEnvelope: пик нормирован к 1');
  const points = loudnessEnvelopePoints(env, { min: 0, max: 255 });
  check(
    points.length === env.rms.length && points.every((p) => p.value >= 0 && p.value <= 255),
    'loudnessEnvelopePoints: точки 0–255 по всей длине',
  );
  const silence = silenceRanges(env, { threshold: 0.05, minSilenceMs: 400 });
  check(
    silence.some((r) => r.startMs <= 4500 && r.endMs >= 4900),
    'silenceRanges: хвостовая тишина (после последнего клика до конца) найдена',
  );

  console.log('— Аудиоанализ v2: спектр, полосы, пики (§5 доработки) —');
  const peaks = peakEvents(env, { thresholdRatio: 1.3, minGapMs: 300 });
  check(
    peaks.length >= 5 && peaks.length <= 12,
    `peakEvents: ${peaks.length} всплесков громкости в клик-треке (ожидались клики ~120 BPM)`,
  );

  // Смена тона 100 Гц → 3000 Гц на середине сигнала: полосы должны честно
  // развести бас и верха по времени (каждая нормирована к своему пику).
  const srBand = 8000;
  const mixedSig = new Float32Array(srBand * 2);
  for (let i = 0; i < mixedSig.length; i++) {
    const t = i / srBand;
    const freq = t < 1 ? 100 : 3000;
    mixedSig[i] = Math.sin(2 * Math.PI * freq * t) * 0.8;
  }
  const bandsEnv = bandEnergyEnvelope(
    mixedSig,
    srBand,
    [
      { loHz: 20, hiHz: 250 },
      { loHz: 2000, hiHz: 4000 },
    ],
    100,
    512,
  );
  const bass = bandsEnv.bands[0]!;
  const treble = bandsEnv.bands[1]!;
  const lastIdx = bass.energy.length - 1;
  check(
    bass.energy[2]! > bass.energy[lastIdx]! && treble.energy[2]! < treble.energy[lastIdx]!,
    'bandEnergyEnvelope: бас громче в начале (тон 100 Гц), верха громче в конце (тон 3000 Гц) — полосы разделены честно',
  );
  const bandPoints = bandEnvelopePoints(bass, bandsEnv.hopMs, { min: 0, max: 255 });
  check(
    bandPoints.length === bass.energy.length && bandPoints.every((p) => p.value >= 0 && p.value <= 255),
    'bandEnvelopePoints: точки 0–255 по всей длине полосы',
  );

  // Спектральный центроид: чистый низкий тон даёт центроид у самого тона; высокий тон — заметно выше.
  const lowTone = new Float32Array(srBand);
  const highTone = new Float32Array(srBand);
  for (let i = 0; i < srBand; i++) {
    lowTone[i] = Math.sin((2 * Math.PI * 200 * i) / srBand);
    highTone[i] = Math.sin((2 * Math.PI * 3000 * i) / srBand);
  }
  const avg = (arr: number[]): number => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
  const lowCentroid = avg(spectralCentroidEnvelope(lowTone, srBand, 100, 512).centroidHz);
  const highCentroid = avg(spectralCentroidEnvelope(highTone, srBand, 100, 512).centroidHz);
  check(
    Math.abs(lowCentroid - 200) < 60,
    `spectralCentroidEnvelope: центроид чистого тона 200 Гц близок к самому тону (${lowCentroid.toFixed(0)} Гц)`,
  );
  check(
    highCentroid > lowCentroid * 5,
    `spectralCentroidEnvelope: центроид тона 3000 Гц (${highCentroid.toFixed(0)} Гц) заметно выше 200 Гц (${lowCentroid.toFixed(0)} Гц)`,
  );

  console.log('— Анализ видео: яркость/цвет по кадрам (§4 доработки — не ИИ, прозрачная эвристика) —');
  // RGBA-пиксели синтетических «кадров»: белый, чёрный, чистый красный.
  const whiteFrame = new Uint8ClampedArray(16).fill(255);
  const blackFrame = new Uint8ClampedArray(16).fill(0);
  const redFrame = new Uint8ClampedArray(16);
  for (let i = 0; i < redFrame.length; i += 4) {
    redFrame[i] = 255;
    redFrame[i + 1] = 0;
    redFrame[i + 2] = 0;
    redFrame[i + 3] = 255;
  }
  const whiteStats = sampleFrameStats(whiteFrame);
  const blackStats = sampleFrameStats(blackFrame);
  const redStats = sampleFrameStats(redFrame);
  check(
    Math.abs(whiteStats.brightness - 1) < 1e-6 && whiteStats.color.r === 255 && whiteStats.color.g === 255,
    'sampleFrameStats: белый кадр → яркость 1, цвет (255,255,255)',
  );
  check(blackStats.brightness === 0, 'sampleFrameStats: чёрный кадр → яркость 0');
  check(
    redStats.color.r === 255 && redStats.color.g === 0 && redStats.color.b === 0 && Math.abs(redStats.brightness - 0.2126) < 0.001,
    `sampleFrameStats: чистый красный → цвет (255,0,0), перцептивная яркость ${redStats.brightness.toFixed(4)} ≈ 0.2126 (Rec.709)`,
  );

  const videoSamples: VideoFrameSample[] = [
    { atMs: 0, brightness: blackStats.brightness, color: blackStats.color },
    { atMs: 250, brightness: 0.5, color: { r: 128, g: 128, b: 128 } },
    { atMs: 500, brightness: whiteStats.brightness, color: whiteStats.color },
    { atMs: 750, brightness: redStats.brightness, color: redStats.color }, // резкий скачок цвета — монтажная склейка
  ];
  const brightPoints = brightnessEnvelopePoints(videoSamples, { min: 0, max: 255 });
  check(
    brightPoints.length === 4 && brightPoints[0]!.value === 0 && brightPoints[2]!.value === 255,
    'brightnessEnvelopePoints: 0..255 по кадрам, чёрный→0, белый→255',
  );
  const rPoints = colorChannelEnvelopePoints(videoSamples, 'r');
  const bPoints = colorChannelEnvelopePoints(videoSamples, 'b');
  check(
    rPoints[3]!.value === 255 && bPoints[3]!.value === 0,
    'colorChannelEnvelopePoints: канал R/B по кадрам разобран верно (красный кадр → R=255, B=0)',
  );
  // Три плавных кадра, затем резкий скачок на красный — ровно одна склейка.
  const cutSamples: VideoFrameSample[] = [
    { atMs: 0, brightness: 0.5, color: { r: 100, g: 100, b: 100 } },
    { atMs: 250, brightness: 0.52, color: { r: 105, g: 102, b: 98 } },
    { atMs: 500, brightness: 0.48, color: { r: 98, g: 99, b: 103 } },
    { atMs: 750, brightness: redStats.brightness, color: redStats.color },
  ];
  const changes = colorChangeEvents(cutSamples, { thresholdDelta: 100 });
  check(
    changes.length === 1 && changes[0]!.tMs === 750,
    `colorChangeEvents: плавные кадры игнорируются, резкая склейка на 750 мс найдена (${changes.length} событие)`,
  );

  console.log('— Измерение периода цикла DMX (§17 п.1) —');
  // Синтетика: канал 5 бежит по циклу длиной 2000 мс, кадры каждые 100 мс, 20 с записи.
  const cycFrames = Array.from({ length: 200 }, (_, i) => {
    const data = new Uint8Array(512);
    data[5] = Math.round(((i % 20) / 19) * 255); // пила с периодом 20 кадров = 2000 мс
    data[6] = 42; // мёртвый канал — не должен мешать
    return { atMs: i * 100, data };
  });
  const cyc = measureCyclePeriodMs(cycFrames);
  check(
    cyc.periodMs !== null && Math.abs(cyc.periodMs - 2000) <= 100 && cyc.confidence > 0.5,
    `measureCyclePeriodMs: период пилы 2000 мс найден (${cyc.periodMs} мс, уверенность ${(cyc.confidence * 100).toFixed(0)}%)`,
  );
  const cycNone = measureCyclePeriodMs(cycFrames.slice(0, 5));
  check(cycNone.periodMs === null, 'measureCyclePeriodMs: на 0.5 с записи периода честно нет');

  console.log('— Мастер нового объекта: несколько строк, перелив по вселенным (§27 п.11) —');
  {
    const wizProject = emptyProject('Мастер-тест');
    const basic = planDeviceWizard(wizProject, [1], [
      { profileId: 'pump', count: 2, namePrefix: 'Насос', startUniverse: null, startAddress: null },
      { profileId: 'rgb', count: 2, namePrefix: 'Свет', startUniverse: null, startAddress: null },
    ]);
    check(
      basic.placements.length === 4 &&
        basic.placements[0]!.universe === 1 &&
        basic.placements[0]!.address === 1 &&
        basic.placements[1]!.address === 2 &&
        basic.placements[2]!.address === 3 && // rgb продолжает после насосов, не с адреса 1
        basic.placements[3]!.address === 6 && // rgb размером 3 канала — второй светильник после первого (3..5)
        basic.newUniverseIds.length === 0,
      `wizard: две строки подряд без перекрытия, вторая продолжает адресацию первой (${basic.placements.map((p) => `${p.name}=U${p.universe}:${p.address}`).join(', ')})`,
    );

    const withOverride = planDeviceWizard(wizProject, [1], [
      { profileId: 'pump', count: 1, namePrefix: 'Насос', startUniverse: null, startAddress: null },
      { profileId: 'valve', count: 1, namePrefix: 'Клапан', startUniverse: 1, startAddress: 100 },
    ]);
    check(
      withOverride.placements[1]!.universe === 1 && withOverride.placements[1]!.address === 100,
      'wizard: явный старт строки игнорирует автопродолжение и прыгает на указанный адрес',
    );

    const overflow = planDeviceWizard(wizProject, [1], [
      { profileId: 'pump', count: 5, namePrefix: 'П', startUniverse: 1, startAddress: 510 },
    ]);
    check(
      overflow.placements.length === 5 &&
        overflow.placements[2]!.universe === 1 &&
        overflow.placements[2]!.address === 512 &&
        overflow.placements[3]!.universe === 2 &&
        overflow.placements[3]!.address === 1 &&
        overflow.newUniverseIds.length === 1 &&
        overflow.newUniverseIds[0] === 2,
      `wizard: 5 приборов от адреса 510 — три помещаются в вселенную 1 (до 512), два переливаются в новую вселенную 2 (${overflow.placements.map((p) => `U${p.universe}:${p.address}`).join(', ')})`,
    );

    const occupiedProject: Project = {
      ...wizProject,
      devices: [{ id: 'existing', name: 'Насос существующий', profileId: 'pump', universe: 1, address: 1 }],
    };
    const respectsExisting = planDeviceWizard(occupiedProject, [1], [
      { profileId: 'pump', count: 1, namePrefix: 'Насос', startUniverse: 1, startAddress: 1 },
    ]);
    check(
      respectsExisting.placements[0]!.address === 2,
      `wizard: адрес 1 уже занят существующим прибором патча — новый встал на 2 (получил ${respectsExisting.placements[0]!.address})`,
    );
  }

  console.log('— Мониторинг сети (мок-нода Art-Net/RDM) —');
  await waitFor(
    'обнаружение ноды',
    () => networkState !== null && networkState.nodes.length === 1 && !networkState.nodes[0]!.lost,
    5000,
  );
  check(
    networkState!.nodes[0]!.shortName === 'MockNode' && networkState!.nodes[0]!.outputUniverses.join(',') === '0',
    'ArtPoll: нода найдена, имя и выходная вселенная разобраны',
  );
  await waitFor('TOD от ноды', () => networkState !== null && networkState.rdmDevices.length === 2, 5000);
  check(
    networkState!.rdmDevices.map((d) => d.uid).join(' ') === '4d4f:00000001 4d4f:00000002' &&
      networkState!.rdmDevices.every((d) => d.universe === 0 && !d.lost),
    'ArtTodRequest: 2 RDM-прибора с UID на вселенной 0',
  );
  check(
    networkState!.log.some((e) => e.text.includes('MockNode')) &&
      networkState!.log.some((e) => e.text.includes('4d4f:00000001')),
    'журнал: появление ноды и приборов записано',
  );

  console.log('— RDM: универсальные PID через ArtRdm (§3 доработки) —');
  const rdmUid = '4d4f:00000001';
  const devInfo = parseDeviceInfoResponse((await net.rdmRequest(rdmUid, CC_GET_COMMAND, PID_DEVICE_INFO)).paramData);
  check(
    devInfo !== null && devInfo.dmxFootprint === 3 && devInfo.dmxStartAddress === 5,
    `RDM DEVICE_INFO разобран: footprint=${devInfo?.dmxFootprint}, адрес=${devInfo?.dmxStartAddress}`,
  );
  const manufacturer = parseLabelResponse((await net.rdmRequest(rdmUid, CC_GET_COMMAND, PID_MANUFACTURER_LABEL)).paramData);
  check(manufacturer === 'Mock Manufacturer', `RDM MANUFACTURER_LABEL разобран: «${manufacturer}»`);

  const idBefore = parseIdentifyResponse((await net.rdmRequest(rdmUid, CC_GET_COMMAND, PID_IDENTIFY_DEVICE)).paramData);
  check(idBefore === false, 'RDM IDENTIFY_DEVICE: изначально выключен');
  await net.rdmRequest(rdmUid, CC_SET_COMMAND, PID_IDENTIFY_DEVICE, encodeIdentify(true));
  const idAfter = parseIdentifyResponse((await net.rdmRequest(rdmUid, CC_GET_COMMAND, PID_IDENTIFY_DEVICE)).paramData);
  check(idAfter === true, 'RDM SET IDENTIFY_DEVICE: включили мигание, GET подтвердил');

  const addrBefore = parseStartAddressResponse((await net.rdmRequest(rdmUid, CC_GET_COMMAND, PID_DMX_START_ADDRESS)).paramData);
  check(addrBefore === 5, 'RDM DMX_START_ADDRESS: изначально 5');
  await net.rdmRequest(rdmUid, CC_SET_COMMAND, PID_DMX_START_ADDRESS, encodeStartAddress(42));
  const addrAfter = parseStartAddressResponse((await net.rdmRequest(rdmUid, CC_GET_COMMAND, PID_DMX_START_ADDRESS)).paramData);
  check(addrAfter === 42, 'RDM SET DMX_START_ADDRESS: переставили на 42, GET подтвердил (удалённая переадресация)');

  await net.rdmRequest('4d4f:ffffffff', CC_GET_COMMAND, PID_DEVICE_INFO, undefined, 300).then(
    () => check(false, 'RDM: запрос к UID вне TOD должен был упасть, а не ответить'),
    (err) => check(err instanceof Error, 'RDM: запрос к UID вне TOD аккуратно завершается ошибкой, не виснет'),
  );

  mockNodeAlive = false; // нода «выдернута из сети»
  await waitFor(
    'потеря ноды по таймауту',
    () => networkState !== null && networkState.nodes[0]!.lost,
    5000,
  );
  check(
    networkState!.log.some((e) => e.text.includes('ПОТЕРЯН')),
    'умолкшая нода помечена потерянной, событие в журнале',
  );

  console.log('— Захват входящего ArtDMX (§17 п.1) —');
  // Мок-нода вместе с ArtPollReply слала кадры OpDmx (111/222 на адресах 1–2, 33 на 20).
  send({ type: 'getDmxCapture', universe: 1 });
  await waitFor('снимок захвата', () => dmxCaptureMsg !== null, 3000);
  const capFrame = new Uint8Array(Buffer.from(dmxCaptureMsg!.data, 'base64'));
  check(
    capFrame[0] === 111 && capFrame[1] === 222 && capFrame[19] === 33 && dmxCaptureMsg!.frames > 0,
    `getDmxCapture: кадр внешнего источника снят (адр.1=111, адр.2=222, адр.20=33; кадров ${dmxCaptureMsg!.frames})`,
  );
  send({ type: 'measureDmxCycle', universe: 1 });
  await waitFor('ответ measureDmxCycle', () => dmxCycleMsg !== null, 3000);
  check(
    dmxCycleMsg!.periodMs === null,
    'measureDmxCycle: на статичном коротком захвате периода честно нет (ответ пришёл)',
  );

  console.log('— DMX-in как триггер действий (§27 доработки, §4 п.4) —');
  {
    // Мок-нода умышленно «умолкла» в предыдущем тесте — вернём её в строй,
    // её собственный ArtPoll-ответ несёт кадр ArtDMX по уже проверенному
    // пути (this.socket движка), в отличие от прямой инъекции пакета в
    // MOCK_NODE_PORT (тот делят с NetworkMonitor.listenSocket через
    // reuseAddr — ненадёжно на Windows).
    mockNodeAlive = true;
    mockDmxOverride = {};
    send({
      type: 'updateProject',
      project: {
        ...store.project,
        dmxTriggers: [
          { id: 'trigA', universe: 1, address: 5, valueMin: 200, valueMax: 255, action: { type: 'scene', refId: 'sceneA' } },
        ],
      },
    });
    await waitFor('dmxTriggers применены', () => (projectEcho?.dmxTriggers.length ?? 0) === 1);
    send({ type: 'setScene', sceneId: null });
    await waitFor('сцена снята перед проверкой', () => playback.activeSceneId === null);

    mockDmxOverride = { 5: 50 }; // вне диапазона — не должно сработать
    await sleep(500); // несколько циклов опроса (150 мс) — даём осечься, если бы сработало
    check(playback.activeSceneId === null, 'dmxTrigger: значение вне диапазона не срабатывает (50 ∉ [200,255])');

    mockDmxOverride = { 5: 220 }; // вход в диапазон — фронт
    await waitFor('триггер сработал по фронту', () => playback.activeSceneId === 'sceneA', 3000);
    check(true, 'dmxTrigger: вход в диапазон (220 ∈ [200,255]) запускает действие');

    send({ type: 'setScene', sceneId: null });
    await waitFor('сцена снята вручную', () => playback.activeSceneId === null);
    await sleep(500); // значение 220 держится — не должно повторно сработать
    check(playback.activeSceneId === null, 'dmxTrigger: держащееся значение не спамит действие повторно (только фронт)');

    mockDmxOverride = { 5: 30 }; // выходим из диапазона — перевзводим фронт
    await sleep(300);
    mockDmxOverride = { 5: 210 }; // заходим снова — должен сработать ещё раз
    await waitFor('триггер сработал повторно после выхода из диапазона', () => playback.activeSceneId === 'sceneA', 3000);
    check(true, 'dmxTrigger: после выхода из диапазона и повторного входа фронт взводится заново');

    send({ type: 'setScene', sceneId: null });
    send({ type: 'updateProject', project: { ...store.project, dmxTriggers: [] } });
    await waitFor('триггеры убраны после теста', () => (projectEcho?.dmxTriggers.length ?? 0) === 0);
    mockDmxOverride = {};
    mockNodeAlive = false; // возвращаем как было — дальше по тесту это не важно, но не меняем чужое состояние
  }

  console.log('— Датчик ветра → безопасное снижение струй (§27 доработки, §4 п.1) —');
  {
    /*
     * Сглаживание показаний (19.09.2026). Ограничение струй нельзя дёргать
     * по каждому показанию: порыв на полсекунды уронил бы воду на глазах у
     * людей и через секунду поднял обратно. Рост догоняем быстро (это
     * безопасность), спад отпускаем медленно (между порывами ветер
     * проваливается почти в ноль).
     */
    /*
     * Здесь — только цепочка целиком. Подробный разбор состояния коррекции
     * (порог, выдержки, подтверждение, плавность, наклон сопла, борт чаши) —
     * в отдельной самопроверке: npm -w @fountain-studio/engine run wind-test.
     */
    const cfg = { ...defaultWindLimitConfig(), enabled: true };
    /** Прогон: держим показание raw секунд secs, возвращаем состояние. */
    const hold = (st: WindCorrectionState, raw: number, secs: number, step = 0.1): WindCorrectionState => {
      let cur = st;
      for (let t = 0; t < secs - 1e-9; t += step) cur = stepWindCorrection(cur, raw, step, cfg);
      return cur;
    };

    // Ниже порога не реагируем ВООБЩЕ: ветер 1–2 м/с на объекте постоянно.
    const quiet = hold(initialWindCorrectionState(), 1.9, 60);
    check(!quiet.active && quiet.fade === 0, 'ветер 1,9 м/с целую минуту — коррекции нет вовсе (порог 2 м/с)');

    // Порыв выше порога, но короче выдержки на включение — не включаемся.
    const gust = hold(initialWindCorrectionState(), 9, 5);
    check(!gust.active, 'порыв 9 м/с длиной 5 с коррекцию не включил (нужно 10 с подряд)');

    // Устойчивый ветер: те же 9 м/с, но 11 с — включились.
    const steady = hold(initialWindCorrectionState(), 9, 11);
    check(steady.active && steady.level > 8.5, `устойчивый ветер 11 с включил коррекцию (расчётные ${steady.level.toFixed(1)} м/с)`);

    // Затишье короче выдержки на снятие — коррекция держится.
    const lull = hold(steady, 0, 5);
    check(lull.active && lull.fade > 0.9, 'затишье 5 с коррекцию не сняло');

    // Настоящее затишье — сняли и вернули воду.
    const calm = hold(steady, 0, 40);
    check(!calm.active && calm.fade === 0 && calm.level === 0, 'затишье 40 с — коррекция снята полностью');

    // Мусор с датчика игнорируется целиком, а не «частично сглаживается».
    check(stepWindCorrection(steady, 900, 1, cfg) === steady, 'невозможное показание 900 м/с отброшено — состояние не изменилось');
    check(stepWindCorrection(steady, -3, 1, cfg) === steady, 'отрицательное показание отброшено');
  }
  {
    /**
     * Ограничение считается ПО ВЫСОТЕ струи: снос растёт линейно с высотой,
     * поэтому одна и та же скорость ветра для двухметрового фонтанчика
     * безобидна, а для пятнадцатиметровой струи уже недопустима.
     */
        // attack/release в тесте укорочены: сглаживание проверяем отдельно и
    // подробно (см. ниже), а здесь важна сама цепочка «показание → насос»,
    // и ждать по 15 секунд на каждый шаг ни к чему.
    const testCfg = {
      ...defaultWindLimitConfig(),
      enabled: true,
      marginM: 0.6,
      tauSec: 4,
      minPercent: 20,
      stopSpeed: 12,
      // Выдержки укорочены: здесь проверяется цепочка «показание → насос», а
      // сами выдержки — в wind-test. Ждать по десять секунд на каждый шаг ни
      // к чему: с заводскими значениями тест ждал бы минуту.
      activateHoldSec: 0.3,
      deactivateHoldSec: 0.3,
      adjustHoldSec: 0.1,
      fastHoldSec: 0.2,
      fadeInSec: 0.2,
      fadeOutSec: 0.2,
      levelFallPerSec: 50,
    };
    check(
      computeWindLimitPercent(0.5, testCfg, 6) === 100,
      'ветер: слабый ветер шестиметровую струю не трогает (100%)',
    );
    check(
      computeWindLimitPercent(4, testCfg, 2) === 100 && computeWindLimitPercent(4, testCfg, 15) < 70,
      'ветер: при 4 м/с низкая струя цела, высокая срезана заметно',
    );
    {
      const low = computeWindLimitPercent(4, testCfg, 2);
      const high = computeWindLimitPercent(4, testCfg, 15);
      check(high < low, `ветер: высокая струя режется сильнее низкой (15 м → ${high}%, 2 м → ${low}%)`);
    }
    check(
      computeWindLimitPercent(12, testCfg, 6) === 0,
      'ветер: выше stopSpeed фонтан глушится полностью (0%)',
    );
    check(
      computeWindLimitPercent(11.9, testCfg, 6) >= testCfg.minPercent,
      'ветер: до stopSpeed насос не опускается ниже заданного минимума',
    );

    // pump1 уже откалиброван (min:50,max:200) более ранним тестом — на время
    // этой проверки снимаем калибровку, чтобы считать round-числа без второго
    // слоя трансформации, и возвращаем её перед концом (её проверяет финальный
    // «Сохранение проекта»).
    const pump1TrimBefore = store.project.devices.find((d) => d.id === 'pump1')?.trim;
    send({
      type: 'updateProject',
      project: {
        ...store.project,
        windLimit: testCfg,
        devices: store.project.devices.map((d) => (d.id === 'pump1' ? { ...d, trim: undefined } : d)),
      },
    });
    await waitFor(
      'windLimit применён, калибровка pump1 временно снята',
      () => projectEcho?.windLimit.enabled === true && !projectEcho.devices.find((d) => d.id === 'pump1')?.trim,
    );

    send({ type: 'setChannel', universe: 1, channel: 1, value: 200 }); // pump1 — intensity насоса
    send({ type: 'setChannel', universe: 1, channel: 10, value: 200 }); // rgb1 R — не насос
    await waitFor('каналы выставлены без ветра', () => ch(1) === 200 && ch(10) === 200);
    check(true, 'без показания ветра — насос и свет на полном значении (200/200)');

    send({ type: 'setWindSpeed', speedMs: 15 }); // выше stopSpeed — полное глушение
    // Ждём с запасом: коррекция включается через выдержку и вводится плавно
    // (в этом тесте выдержки укорочены до десятых долей секунды). Проверяем
    // ЧТО заглушило, а не за сколько миллисекунд.
    await waitFor('насос заглушен ветром', () => ch(1) === 0, 5000);
    check(ch(10) === 200, 'ветер не трогает свет — канал R rgb1 остался 200');
    check(true, 'ветер 15 м/с (выше stopSpeed 12) → насос заглушен со 200 до 0');

    send({ type: 'setWindSpeed', speedMs: 3 }); // умеренный — снижение, но не стоп
    await waitFor('насос частично снижен', () => ch(1) > 0 && ch(1) < 200, 2000);
    check(true, `ветер 3 м/с → насос снижен со 200 до ${ch(1)} (по высоте своей струи)`);

    send({ type: 'setWindSpeed', speedMs: null }); // сброс показания
    await waitFor('ограничение снято', () => ch(1) === 200, 2000);
    check(true, 'сброс показания ветра — насос вернулся к 200 (ограничение снято)');

    send({
      type: 'updateProject',
      project: {
        ...store.project,
        windLimit: { ...testCfg, enabled: false },
        devices: store.project.devices.map((d) => (d.id === 'pump1' ? { ...d, trim: pump1TrimBefore } : d)),
      },
    });
    await waitFor(
      'калибровка pump1 восстановлена',
      () => projectEcho?.devices.find((d) => d.id === 'pump1')?.trim?.[0]?.min === 50,
    );
    send({ type: 'setChannel', universe: 1, channel: 1, value: 0 });
    send({ type: 'setChannel', universe: 1, channel: 10, value: 0 });
    await waitFor('каналы сброшены после теста', () => ch(1) === 0 && ch(10) === 0);
  }

  console.log('— Переадресация каналов —');
  {
    const frame = new Uint8Array(512);
    frame[0] = 10; // адрес 1
    frame[1] = 20; // адрес 2
    frame[2] = 30; // адрес 3
    frame[9] = 99; // адрес 10

    const same = applyAddressRemap(frame, undefined);
    check(same === frame, 'пустая переадресация возвращает тот же кадр, без копирования');

    const swapped = applyAddressRemap(frame, { 1: 2, 2: 1 });
    check(swapped[0] === 20 && swapped[1] === 10, 'обмен 1↔2: адреса поменялись значениями');
    check(frame[0] === 10 && frame[1] === 20, 'исходный кадр не изменился — переадресация не портит расчёт');
    check(swapped[2] === 30, 'не тронутые адреса остались как были');

    // Главное свойство «тянущего» направления: источники читаются из кадра ДО
    // переадресации, поэтому цепочек и петель не бывает.
    const chain = applyAddressRemap(frame, { 1: 2, 2: 3 });
    check(
      chain[0] === 20 && chain[1] === 30,
      'цепочки не возникает: 1 берёт исходное значение 2, а не уже переадресованное',
    );
    const loop = applyAddressRemap(frame, { 1: 1 + 0, 2: 2 });
    check(loop[0] === 10 && loop[1] === 20, 'тождественная запись ничего не меняет');

    const many = applyAddressRemap(frame, { 1: 10, 2: 10, 3: 10 });
    check(
      many[0] === 99 && many[1] === 99 && many[2] === 99,
      'многие к одному: три адреса повторяют один источник',
    );

    const bad = applyAddressRemap(frame, { 0: 5, 513: 5, 4: 0, 5: 513 });
    check(bad[3] === 0 && bad[4] === 0, 'адреса вне 1..512 игнорируются, кадр не портится');

    // Санитайзер: из проекта приходит текст, правленный руками.
    const clean = sanitizeAddressRemap({ 1: { '5': 7, '7': 7, '600': 3, '3': 900, x: 2 }, bad: { 1: 2 } });
    check(
      JSON.stringify(clean) === JSON.stringify({ 1: { 5: 7 } }),
      'sanitizeAddressRemap: оставлен только корректный переход, «сам в себя» и мусор отброшены',
    );
    const empty = sanitizeAddressRemap({ 1: { '4': 4 } });
    check(Object.keys(empty).length === 0, 'вселенная без реальных переходов в таблице не хранится');
  }

  console.log('— Служебное освещение по времени («Switches», §27 доработки) —');
  {
    const win = { enabled: true, deviceIds: [], always: false, onTime: '10:00', offTime: '14:00' };
    check(
      isUtilityLightOn(win, new Date(2026, 0, 1, 12, 0)) === true,
      'isUtilityLightOn: 12:00 внутри окна 10:00–14:00 — включено',
    );
    check(
      isUtilityLightOn(win, new Date(2026, 0, 1, 9, 0)) === false,
      'isUtilityLightOn: 09:00 до окна — выключено',
    );
    check(
      isUtilityLightOn(win, new Date(2026, 0, 1, 14, 0)) === false,
      'isUtilityLightOn: 14:00 — конец окна не включён (полуоткрытый интервал)',
    );
    const wrap = { ...win, onTime: '22:00', offTime: '06:00' };
    check(
      isUtilityLightOn(wrap, new Date(2026, 0, 1, 23, 0)) === true &&
        isUtilityLightOn(wrap, new Date(2026, 0, 1, 3, 0)) === true,
      'isUtilityLightOn: окно через полночь (22:00–06:00) — 23:00 и 03:00 внутри',
    );
    check(
      isUtilityLightOn(wrap, new Date(2026, 0, 1, 12, 0)) === false,
      'isUtilityLightOn: окно через полночь — полдень снаружи',
    );
    check(
      isUtilityLightOn({ ...win, always: true }, new Date(2026, 0, 1, 3, 0)) === true,
      'isUtilityLightOn: always=true — включено в любое время, окно не проверяется',
    );

    // Живая проверка на движке: always=true — независимо от текущего времени суток теста.
    send({
      type: 'updateProject',
      project: { ...store.project, utilityLight: { enabled: true, deviceIds: ['rgb1'], always: true, onTime: '00:00', offTime: '00:00' } },
    });
    await waitFor('утилитарный свет форсирует rgb1 на 255', () => ch(10) === 255 && ch(11) === 255 && ch(12) === 255, 2000);
    check(true, 'utilityLight always=true: rgb1 форсирован на максимум без сцены/ручного управления');

    send({
      type: 'updateProject',
      project: { ...store.project, utilityLight: { enabled: false, deviceIds: ['rgb1'], always: true, onTime: '00:00', offTime: '00:00' } },
    });
    await waitFor('выключение utilityLight снимает форсирование', () => ch(10) === 0 && ch(11) === 0 && ch(12) === 0, 2000);
    check(true, 'utilityLight enabled=false: форсирование снято, канал вернулся в 0');

    send({ type: 'updateProject', project: { ...store.project, utilityLight: defaultUtilityLightConfig() } });
    await waitFor('utilityLight сброшен к умолчанию', () => projectEcho?.utilityLight.enabled === false);
  }

  console.log('— Группы секвенсоров: синхронный/параллельный запуск (§27 доработки, «сделать правильно») —');
  {
    send({
      type: 'updateProject',
      project: {
        ...store.project,
        sequenceGroups: [{ id: 'grp1', name: 'Тест-группа', sequenceIds: ['seq1', 'seqEffect'] }],
      },
    });
    await waitFor('группа применена', () => (projectEcho?.sequenceGroups.length ?? 0) === 1);

    send({ type: 'startSequenceGroup', groupId: 'grp1' });
    await waitFor(
      'оба участника группы стартовали',
      () =>
        playback.running.some((r) => r.sequenceId === 'seq1') &&
        playback.running.some((r) => r.sequenceId === 'seqEffect'),
      2000,
    );
    check(true, 'startSequenceGroup: оба секвенсора-участника запущены одним действием');

    send({ type: 'pauseSequenceGroup', groupId: 'grp1' });
    await waitFor(
      'оба участника на паузе',
      () =>
        playback.running.find((r) => r.sequenceId === 'seq1')?.paused === true &&
        playback.running.find((r) => r.sequenceId === 'seqEffect')?.paused === true,
      2000,
    );
    check(true, 'pauseSequenceGroup: пауза применилась ко всем участникам сразу');

    send({ type: 'resumeSequenceGroup', groupId: 'grp1' });
    await waitFor(
      'оба участника сняты с паузы',
      () =>
        playback.running.find((r) => r.sequenceId === 'seq1')?.paused === false &&
        playback.running.find((r) => r.sequenceId === 'seqEffect')?.paused === false,
      2000,
    );
    check(true, 'resumeSequenceGroup: снятие с паузы применилось ко всем участникам сразу');

    send({ type: 'stopSequenceGroup', groupId: 'grp1' });
    await waitFor(
      'оба участника остановлены',
      () =>
        !playback.running.some((r) => r.sequenceId === 'seq1') &&
        !playback.running.some((r) => r.sequenceId === 'seqEffect'),
      2000,
    );
    check(true, 'stopSequenceGroup: остановка применилась ко всем участникам сразу');

    send({ type: 'updateProject', project: { ...store.project, sequenceGroups: [] } });
    await waitFor('тестовая группа убрана', () => (projectEcho?.sequenceGroups.length ?? 0) === 0);
    send({ type: 'stopAllPlayback' });
    await waitFor('всё остановлено после теста', () => playback.running.length === 0);
  }

  console.log('— Насос на Modbus TCP (мок-ПЧ, карта регистров Elhart EMD-PUMP) —');
  const pumpStatus = () => modbusState?.pumps.find((p) => p.deviceId === 'pump2');
  send({ type: 'setChannel', universe: 1, channel: 20, value: 200 });
  await waitFor(
    'уставка и пуск записаны в ПЧ',
    () => vfdRegs.get(8193) === 3922 && vfdRegs.get(8192) === 2,
    3000,
  );
  check(true, 'канал 200/255 → уставка 39.22 Гц (регистр 8193=3922, сотые Гц), команда ПУСК (8192=2)');
  await waitFor('статус насоса на связи', () => pumpStatus()?.connected === true, 2000);
  check(
    Math.abs((pumpStatus()?.lastFreqHz ?? -1) - 39.22) < 0.01,
    'ModbusState: lastFreqHz насоса 2 ≈ 39.22 Гц',
  );
  const writesBeforeKeepalive = vfdWrites.length;
  await sleep(1300); // keep-alive движка — раз в секунду даже без изменений (вотчдог связи ПЧ)
  check(
    vfdWrites.length > writesBeforeKeepalive,
    'keep-alive: уставка переслана повторно без изменений значения (вотчдог связи ПЧ)',
  );

  send({ type: 'setChannel', universe: 1, channel: 20, value: 0 });
  await waitFor(
    'команда СТОП и уставка 0 записаны в ПЧ',
    () => vfdRegs.get(8193) === 0 && vfdRegs.get(8192) === 1,
    3000,
  );
  check(true, 'канал 0 → уставка 0, команда СТОП (8192=1)');

  vfdRegs.set(10, 7); // мок-ПЧ сообщает аварию (код 7 по карте Elhart — «пониженное напряжение шины DC»)
  // Ждём с запасом: опрос аварий идёт раз в 3 с (HEALTH_POLL_MS), и если
  // регистр выставлен сразу после очередного опроса, ответ придёт только через
  // три секунды плюс обмен по TCP. С таймаутом 4 с проверка иногда падала на
  // загруженной машине, хотя движок работал верно — проверяем ДОШЛО ЛИ, а не
  // за сколько миллисекунд.
  await waitFor('авария обнаружена', () => pumpStatus()?.faultCode === 7, 9000);
  check(true, 'опрос аварии: код 7 из регистра F0.10 дошёл до UI-состояния насоса');

  await waitFor(
    'телеметрия прочитана',
    () => pumpStatus()?.currentA !== null && pumpStatus()?.speedRpm !== null && pumpStatus()?.tempC !== null,
    4000,
  );
  check(
    Math.abs((pumpStatus()?.currentA ?? -1) - 1.5) < 0.01,
    `телеметрия (§27 доработки, §4 п.2): ток 1.50 А из регистра 11 (сотые А) прочитан верно (${pumpStatus()?.currentA})`,
  );
  check(
    pumpStatus()?.speedRpm === 1450,
    `телеметрия: обороты 1450 об/мин из регистра 12 прочитаны верно (${pumpStatus()?.speedRpm})`,
  );
  check(
    Math.abs((pumpStatus()?.tempC ?? -1) - 45.2) < 0.01,
    `телеметрия: температура 45.2°C из регистра 13 (десятые °C) прочитана верно (${pumpStatus()?.tempC})`,
  );

  console.log('— Удалённое управление: OSC и MQTT (§1 доработки) —');
  mockNode.send(encodeOscMessage('/scene/a'), OSC_PORT, '127.0.0.1');
  await waitFor('OSC включил сцену A', () => playback.activeSceneId === 'sceneA', 3000);
  check(true, 'OSC: /scene/a → setScene(sceneA), действие пришло без участия редактора');

  await waitFor('MQTT подключён к мок-брокеру', () => remoteStatusMsg?.mqtt.connected === true, 3000);
  check(true, 'MqttController: CONNECT/CONNACK и подписка на брокере прошли');
  const mqttPub = createTcpConnection({ host: '127.0.0.1', port: MOCK_MQTT_PORT }, () => {
    mqttPub.write(encodeMqttPublish('test/cmd/stop-all', '1'));
  });
  await waitFor(
    'MQTT остановил всё',
    () => playback.activeSceneId === null && playback.running.length === 0,
    3000,
  );
  check(true, 'MQTT: публикация test/cmd/stop-all → stopAllPlayback(), команда с «внешнего» издателя дошла');
  mqttPub.end();

  console.log('— Внешние пульты: включение на ходу с вкладки —');
  const oscEvents = (): number => logEvents.filter((e) => e.source === 'osc' && e.message.includes('/scene/a')).length;
  send({
    type: 'setRemoteSettings',
    settings: {
      osc: { enabled: true, port: OSC_PORT_2 },
      mqtt: { enabled: false, host: '127.0.0.1', port: MOCK_MQTT_PORT, topicPrefix: 'test', username: '' },
    },
    mqttPassword: 'секрет-брокера',
  });
  await waitFor(
    'OSC переехал на второй порт, MQTT выключен',
    () =>
      remoteStatusMsg?.settings.osc.port === OSC_PORT_2 &&
      remoteStatusMsg.osc.listening &&
      !remoteStatusMsg.mqtt.enabled &&
      !remoteStatusMsg.mqtt.connected,
    3000,
  );
  check(true, 'setRemoteSettings: OSC открыл новый порт, MQTT отключился — без перезапуска движка');
  check(remoteStatusMsg?.mqttHasPassword === true, 'пароль брокера принят: в статусе «задан»');
  check(!JSON.stringify(remoteStatusMsg).includes('секрет-брокера'), 'сам пароль в редактор не уходит');
  send({ type: 'setScene', sceneId: null });
  const beforeNew = oscEvents();
  mockNode.send(encodeOscMessage('/scene/a'), OSC_PORT_2, '127.0.0.1');
  await waitFor('OSC на новом порту включил сцену', () => playback.activeSceneId === 'sceneA', 3000);
  check(oscEvents() === beforeNew + 1, 'команда на новый порт OSC исполнена');
  send({ type: 'setScene', sceneId: null });
  await waitFor('сцена снята', () => playback.activeSceneId === null, 2000);
  mockNode.send(encodeOscMessage('/scene/a'), OSC_PORT, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 400));
  check(playback.activeSceneId === null && oscEvents() === beforeNew + 1, 'старый порт OSC больше не слушается');
  const savedRemote = JSON.parse(fs.readFileSync(path.join(tmpDir, 'app-config.json'), 'utf8')) as {
    osc?: { enabled: boolean; port: number };
    mqtt?: { enabled: boolean; password?: string };
  };
  check(
    savedRemote.osc?.port === OSC_PORT_2 && savedRemote.mqtt?.enabled === false && savedRemote.mqtt?.password === 'секрет-брокера',
    'настройки пультов записаны в настройки программы — переживут перезапуск',
  );

  // Порт занят другой программой — сказать это словами, а не молчать.
  const squatter = dgram.createSocket('udp4');
  await new Promise<void>((r) => squatter.bind(15024, '0.0.0.0', () => r()));
  send({
    type: 'setRemoteSettings',
    settings: {
      osc: { enabled: true, port: 15024 },
      mqtt: { enabled: true, host: '127.0.0.1', port: MOCK_MQTT_PORT, topicPrefix: 'test', username: '' },
    },
  });
  await waitFor('занятый порт OSC замечен', () => (remoteStatusMsg?.osc.error ?? '').includes('занят'), 3000);
  check(!remoteStatusMsg!.osc.listening, `занятый порт: «${remoteStatusMsg!.osc.error}»`);
  await waitFor('MQTT снова подключён', () => remoteStatusMsg?.mqtt.connected === true, 3000);
  check(remoteStatusMsg?.mqttHasPassword === true, 'MQTT включён обратно, пароль не потерялся (поле пароля не присылали)');
  squatter.close();
  // Возвращаем как было: дальше смоук проверяет аварии в MQTT.
  send({
    type: 'setRemoteSettings',
    settings: {
      osc: { enabled: true, port: OSC_PORT },
      mqtt: { enabled: true, host: '127.0.0.1', port: MOCK_MQTT_PORT, topicPrefix: 'test', username: '' },
    },
    mqttPassword: '',
  });
  await waitFor(
    'пульты вернулись на исходные настройки',
    () => remoteStatusMsg?.settings.osc.port === OSC_PORT && remoteStatusMsg.osc.listening && remoteStatusMsg.mqtt.connected,
    3000,
  );
  check(remoteStatusMsg?.mqttHasPassword === false, 'пустой пароль — пароль убран');

  console.log('— Хранилище аудио —');
  const audioData = Buffer.from('НЕ-НАСТОЯЩИЙ-MP3: проверка хранилища').toString('base64');
  send({ type: 'uploadAudio', name: 'тест.mp3', dataBase64: audioData });
  send({ type: 'getAudio', name: 'тест.mp3' });
  await waitFor('ответ getAudio', () => audioMsg !== null);
  check(audioMsg!.name === 'тест.mp3' && audioMsg!.dataBase64 === audioData, 'аудиофайл сохранён и отдан байт в байт');

  console.log('— Экспорт/импорт проекта одним файлом (§27 доработки) —');
  {
    // Чистая проверка формата — без движка: create → read воспроизводит имена и байты точно.
    const zipEntries = [
      { name: 'project.json', data: Buffer.from('{"a":1}', 'utf8') },
      { name: 'audio/тест звук.mp3', data: Buffer.from('бинарные-не-очень-данные-mp3-имитация'.repeat(50), 'utf8') },
    ];
    const zipBuf = createZip(zipEntries);
    const readBack = readZip(zipBuf);
    check(
      readBack.length === 2 &&
        readBack.find((e) => e.name === 'project.json')?.data.toString('utf8') === '{"a":1}' &&
        readBack.find((e) => e.name.startsWith('audio/'))?.data.equals(zipEntries[1]!.data) === true,
      'createZip/readZip: круговой обход воспроизводит имена (в т.ч. кириллица) и байты файлов точно',
    );

    // Живая проверка через движок: экспорт текущего проекта → импорт того же архива обратно.
    send({ type: 'exportProject' });
    await waitFor('получен экспорт проекта', () => projectExportMsg !== null, 2000);
    check(
      projectExportMsg!.filename.endsWith('.fsproj.zip') && projectExportMsg!.dataBase64.length > 100,
      `exportProject: файл «${projectExportMsg!.filename}» получен (${projectExportMsg!.dataBase64.length} байт base64)`,
    );

    const exportedEntries = readZip(Buffer.from(projectExportMsg!.dataBase64, 'base64'));
    check(
      exportedEntries.some((e) => e.name === 'project.json') && exportedEntries.some((e) => e.name === 'audio/тест.mp3'),
      'exportProject: архив содержит project.json и файлы из папки audio/',
    );

    const nameBefore = store.project.name;
    importResultMsg = null;
    send({ type: 'importProject', dataBase64: projectExportMsg!.dataBase64 });
    await waitFor('импорт обработан', () => importResultMsg !== null, 2000);
    check(importResultMsg!.ok === true, `importProject: успешно (${importResultMsg!.message})`);
    await waitFor('проект после импорта совпадает с исходным', () => projectEcho?.name === nameBefore, 2000);
    check(true, 'importProject: повторный импорт того же архива не изменил содержимое (круговой обход корректен)');
  }

  console.log('— Демо-проект «из коробки» (§27 доработки, раздел «Продукт») —');
  {
    const demo = createDemoProject();
    const sanitized = sanitizeProject(demo);
    check(
      sanitized.devices.length === demo.devices.length &&
        sanitized.scenes.length === demo.scenes.length &&
        sanitized.sequences.length === demo.sequences.length &&
        sanitized.shows.length === 1 &&
        sanitized.layout.nozzles.length === 2 &&
        sanitized.layout.lights.length === 2,
      `createDemoProject: sanitizeProject не роняет ничего (${sanitized.devices.length} приборов, ${sanitized.scenes.length} сцен, ${sanitized.layout.nozzles.length} форсунки)`,
    );
    const show = sanitized.shows[0]!;
    check(
      show.audioFile === DEMO_AUDIO_FILE && show.durationMs > 0,
      `createDemoProject: демо-шоу ссылается на ${DEMO_AUDIO_FILE}, длительность ${show.durationMs} мс`,
    );
    const blocksTrack = show.tracks.find((t) => t.kind === 'blocks');
    const envTrack = show.tracks.find((t) => t.kind === 'envelope');
    check(
      blocksTrack?.kind === 'blocks' &&
        blocksTrack.blocks.length === 4 &&
        blocksTrack.blocks.every((b) => sanitized.scenes.some((s) => s.id === b.refId)),
      'createDemoProject: блоки шоу ссылаются на реально существующие сцены проекта',
    );
    check(
      envTrack?.kind === 'envelope' && envTrack.points.length > 0 && envTrack.deviceId === 'demo-pump1',
      `createDemoProject: огибающая пульса насоса построена (${envTrack?.kind === 'envelope' ? envTrack.points.length : 0} точек)`,
    );

    const wav = generateDemoWav();
    const riffOk = wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE';
    const sampleRate = wav.readUInt32LE(24);
    const dataSize = wav.readUInt32LE(40);
    const durationMs = Math.round((dataSize / 2 / sampleRate) * 1000);
    check(
      riffOk && sampleRate === 44100 && Math.abs(durationMs - show.durationMs) < 5,
      `generateDemoWav: валидный WAV (44.1 кГц), длительность ${durationMs} мс совпадает с demo-шоу (${show.durationMs} мс)`,
    );
  }

  console.log('— Автозапуск при входе в Windows (§27 доработки, §3 п.3) —');
  {
    // Только чтение (isAutostartEnabled → schtasks /Query, безопасно) — умышленно
    // НЕ вызываем setAutostart здесь: это создало/удалило бы реальную задачу
    // планировщика на машине, где выполняется тест.
    send({ type: 'getAutostart' });
    await waitFor('ответ getAutostart получен', () => autostartMsg !== null);
    check(
      autostartMsg!.supported === true,
      `autostart: репозиторий определён верно, платформа поддержана (supported=${autostartMsg!.supported})`,
    );
    check(autostartMsg!.enabled === false, 'autostart: задачи планировщика ещё нет на этой машине');
  }

  console.log('— Авто-бэкапы проекта (§27 доработки, УХ п.5) —');
  send({ type: 'listBackups' });
  await waitFor('исходный список бэкапов получен', () => backupListMsg !== null);
  check(backupConfigMsg !== null && backupConfigMsg.enabled === false, 'бэкапы выключены по умолчанию в тестовой конфигурации');
  send({ type: 'updateBackupConfig', enabled: true, intervalMin: 7 });
  await waitFor(
    'настройка бэкапов применена',
    () => backupConfigMsg?.enabled === true && backupConfigMsg.intervalMin === 7,
  );
  const nameBeforeSnapshot = store.project.name;
  backups.snapshot(); // не ждём реальный интервал — снимок вручную, как по таймеру
  send({ type: 'listBackups' });
  await waitFor('снимок появился в списке', () => (backupListMsg?.backups.length ?? 0) >= 1);
  const snapshotFile = backupListMsg!.backups[0]!.file;
  check(true, `снимок сохранён и виден в списке (${snapshotFile})`);
  send({ type: 'updateProject', project: { ...store.project, name: 'Испорчено по ошибке' } });
  await waitFor('проект испорчен для теста восстановления', () => projectEcho?.name === 'Испорчено по ошибке');
  send({ type: 'restoreBackup', file: snapshotFile });
  await waitFor('проект восстановлен из снимка', () => projectEcho?.name === nameBeforeSnapshot);
  check(true, 'restoreBackup вернул проект к состоянию на момент снимка (имя проекта совпало)');

  console.log('— Журнал событий (§27 доработки, §3 п.1) —');
  {
    check(
      logEvents.some((e) => e.source === 'schedule' && e.message.includes('→ сцена («sch1»')),
      'eventLog: срабатывание расписания попало в журнал',
    );
    check(
      logEvents.some((e) => e.source === 'osc' && e.message.includes('/scene/a')),
      'eventLog: команда OSC попала в журнал',
    );
    check(
      logEvents.some((e) => e.source === 'mqtt' && e.message.includes('stop-all')),
      'eventLog: команда MQTT попала в журнал',
    );
    check(
      logEvents.some((e) => e.source === 'net' && e.level === 'warn' && e.message.includes('ПОТЕРЯН')),
      'eventLog: потеря ноды помечена уровнем warn',
    );
    check(
      logEvents.some((e) => e.source === 'modbus' && e.level === 'error' && e.message.includes('код аварии 7')),
      'eventLog: авария насоса помечена уровнем error',
    );

    const before = logEvents.length;
    send({ type: 'clientEvent', source: 'key', message: 'KeyA → сцена «Тест»' });
    await waitFor('clientEvent дошёл как logEvent', () => logEvents.length > before);
    const last = logEvents[logEvents.length - 1]!;
    check(
      last.source === 'key' && last.message.includes('KeyA'),
      'eventLog: clientEvent от редактора (клавиша) попал в общий журнал',
    );

    // Уведомления об авариях (§27 доработки, §3 п.4): та же обёртка, что
    // index.ts включает в проде — публикует warn/error-события в MQTT.
    check(
      mqttAlarms.some((m) => {
        const p = JSON.parse(m.payload) as { source: string; level: string; message: string };
        return p.source === 'modbus' && p.level === 'error' && p.message.includes('код аварии 7');
      }),
      'уведомления об авариях: авария насоса опубликована в MQTT test/alarms',
    );
    check(
      mqttAlarms.some((m) => {
        const p = JSON.parse(m.payload) as { source: string; level: string; message: string };
        return p.source === 'net' && p.level === 'warn' && p.message.includes('ПОТЕРЯН');
      }),
      'уведомления об авариях: потеря ноды опубликована в MQTT test/alarms',
    );
    check(
      !mqttAlarms.some((m) => {
        const p = JSON.parse(m.payload) as { level: string };
        return p.level === 'info';
      }),
      'уведомления об авариях: info-события (не аварии) в MQTT не публикуются',
    );
  }

  console.log('— Лицензия (§27 доработки, «Продукт» — привязка к 1 ПК) —');
  {
    const myMachineId = machineFingerprint();
    check(myMachineId === machineFingerprint(), 'machineFingerprint(): стабилен между вызовами');
    check(
      licenseMsg !== null && licenseMsg.status.licensed === false && licenseMsg.status.machineId === myMachineId,
      'при подключении движок сразу присылает статус лицензии (не активирована, свой machineId)',
    );

    // Файл с чужой подписью — не тот ключ, что зашит в приложении (не должен активировать).
    const foreign = crypto.generateKeyPairSync('ed25519');
    const foreignPayload: LicensePayload = {
      licenseeName: 'Чужой',
      machineId: myMachineId,
      issuedAt: new Date().toISOString(),
      expiresAt: null,
    };
    const foreignFile: LicenseFile = {
      payload: foreignPayload,
      signature: crypto.sign(null, canonicalPayload(foreignPayload), foreign.privateKey).toString('base64'),
    };
    check(!verifyLicenseFile(foreignFile).valid, 'verifyLicenseFile(): подпись чужим ключом отклонена');

    send({ type: 'activateLicense', fileText: JSON.stringify(foreignFile) });
    await waitFor(
      'движок ответил на активацию (чужая подпись)',
      () => licenseMsg?.status.reason?.includes('одпись') === true,
    );
    check(licenseMsg?.status.licensed === false, 'activateLicense: файл с чужой подписью не активирует лицензию');

    send({ type: 'activateLicense', fileText: '{битый json' });
    await waitFor(
      'движок ответил на активацию (битый JSON)',
      () => licenseMsg?.status.reason?.includes('JSON') === true,
    );
    check(true, 'activateLicense: нечитаемый файл аккуратно отклонён с понятной причиной, без исключения');

    // Позитивный сценарий и «верная подпись, но…» требуют настоящего приватного
    // ключа — он только у вендора (license-keys/, в .gitignore). Если он есть
    // локально (как в этом окружении, где ключ был сгенерирован для теста
    // issue-license.ts), проверяем полный цикл; иначе — пропускаем с пометкой.
    const privateKeyFile = path.join(__dirname, '..', '..', 'license-keys', 'private.pem');
    if (fs.existsSync(privateKeyFile)) {
      const privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyFile, 'utf8'));
      const sign = (payload: LicensePayload): LicenseFile => ({
        payload,
        signature: crypto.sign(null, canonicalPayload(payload), privateKey).toString('base64'),
      });

      const wrongMachine = sign({
        licenseeName: 'Тест',
        machineId: 'не-этот-компьютер',
        issuedAt: new Date().toISOString(),
        expiresAt: null,
      });
      check(!verifyLicenseFile(wrongMachine).valid, 'verifyLicenseFile(): верная подпись, но чужой machineId — отклонено');

      /*
       * Просроченная на сутки — это ещё льготный период (GRACE_PERIOD_DAYS,
       * 18.09.2026): программа работает и просит оплатить. Отклоняется
       * только то, что вышло и за льготу.
       */
      const inGrace = sign({
        licenseeName: 'Тест',
        machineId: myMachineId,
        issuedAt: new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString(),
        expiresAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      });
      const graceCheck = verifyLicenseFile(inGrace);
      check(graceCheck.valid && graceCheck.grace === true, 'verifyLicenseFile(): просрочка на сутки — льготный период, доступ есть');

      const expired = sign({
        licenseeName: 'Тест',
        machineId: myMachineId,
        issuedAt: new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString(),
        expiresAt: new Date(Date.now() - (GRACE_PERIOD_DAYS + 1) * 24 * 3600 * 1000).toISOString(),
      });
      check(!verifyLicenseFile(expired).valid, 'verifyLicenseFile(): просроченная сверх льготы лицензия отклонена');

      const good = sign({
        licenseeName: 'Смоук-тест',
        machineId: myMachineId,
        issuedAt: new Date().toISOString(),
        expiresAt: null,
      });
      send({ type: 'activateLicense', fileText: JSON.stringify(good) });
      await waitFor('лицензия активирована', () => licenseMsg?.status.licensed === true, 2000);
      check(
        licenseMsg?.status.licensed === true && licenseMsg?.status.licenseeName === 'Смоук-тест',
        'activateLicense: верная лицензия для этого ПК активируется и статус рассылается всем клиентам',
      );
      check(
        fs.existsSync(path.join(tmpDir, 'fountain.license.json')),
        'файл лицензии сохранён рядом с проектом (fountain.license.json)',
      );
      check(
        loadLicenseStatus(tmpDir).licensed === true,
        'loadLicenseStatus(): подтверждает лицензию при перечитывании с диска',
      );
    } else {
      console.log('  (пропуск позитивного сценария — нет license-keys/private.pem у этого разработчика, это ожидаемо)');
    }
  }

  console.log('— Сохранение проекта —');
  /*
   * Автосохранение по умолчанию — раз в секунду (решение заказчика
   * 23.09.2026): правки теста уже на диске. Шапка редактора узнаёт о
   * несохранённом по projectDirty.
   */
  check(configMsg?.autosaveEnabled === true && configMsg.autosaveSec === 1, 'по умолчанию автосохранение включено, раз в секунду');
  await waitFor('автосохранение записало правки', () => !store.isDirty && dirtyMsg?.dirty === false, 3000);
  check(dirtyMsg?.savedAtMs !== null, 'время сохранения известно — его видно в Настройках');
  // Выключили — правка ждёт Ctrl+S.
  send({ type: 'setAutosave', enabled: false, seconds: 7 });
  await waitFor('автосохранение выключено', () => configMsg?.autosaveEnabled === false && configMsg.autosaveSec === 7);
  send({ type: 'updateProject', project: { ...store.project } });
  await waitFor('правка есть', () => dirtyMsg?.dirty === true);
  await sleep(1500);
  check(store.isDirty, 'без автосохранения правка ждёт Ctrl+S, на диск сама не уходит');
  send({ type: 'saveNow' });
  await waitFor('после Ctrl+S правок в памяти не осталось', () => dirtyMsg?.dirty === false);
  const appCfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'app-config.json'), 'utf8')) as { autosave?: { enabled: boolean; seconds: number } };
  check(appCfg.autosave?.enabled === false && appCfg.autosave.seconds === 7, 'настройка автосохранения записана в настройки программы');
  const saved = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as Project;
  check(
    saved.devices.length === 4 &&
      saved.sequences.length === 2 &&
      saved.shows.length === 4 &&
      saved.playlists.length === 1 &&
      saved.devices.find((d) => d.id === 'pump1')?.trim?.[0]?.min === 50,
    'fountain.project.json записан на диск (шоу, плейлисты, калибровка)',
  );

  console.log(failures.length === 0 ? '\nСМОУК-ТЕСТ ПРОЙДЕН' : `\nПРОВАЛОВ: ${failures.length}`);
}

main()
  .catch((err) => {
    console.error('✗', err instanceof Error ? err.message : err);
    failures.push('исключение');
  })
  .finally(() => {
    ws.close();
    wss.close();
    net.stop();
    void remote.stop();
    mockNode.close();
    vfdServer.close();
    mqttSub.destroy();
    mqttServer.close();
    backups.stop();
    engine.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(failures.length === 0 ? 0 : 1);
  });
