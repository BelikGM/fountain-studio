/**
 * Смоук-тест воспроизведения: поднимает движок с WebSocket-сервером в этом же
 * процессе, подключается клиентом и проверяет: загрузку проекта, статическую
 * сцену, HTP-слияние с ручной консолью, секвенсор с фейдом и переходами шагов,
 * общий стоп, шоу-таймлайн (блоки, огибающие, опережение дорожек, транспорт),
 * монтажную арифметику вырезок, мониторинг сети Art-Net/RDM, насос на Modbus TCP
 * (мок-ПЧ), хранилище аудио и сохранение проекта на диск.
 *
 * Запуск: npm run smoke (или npm -w @fountain-studio/engine run smoke)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  actorPhases,
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
  parseDxf,
  peakEvents,
  planDeviceWizard,
  profileMap,
  radialWaveScene,
  radialWaveSequenceScenes,
  rainbowSequenceScenes,
  ringPositions,
  saluteSequenceScenes,
  sanitizeProject,
  shiftDeviceAddresses,
  silenceRanges,
  smoothEnvelopeValues,
  sourceToEditedMs,
  spectralCentroidEnvelope,
  swapDeviceAddresses,
  tempoCategory,
  brightnessEnvelopePoints,
  colorChangeEvents,
  colorChannelEnvelopePoints,
  computeWindLimitPercent,
  sampleFrameStats,
  type VideoFrameSample,
  type LogEvent,
  type ModbusState,
  type NetworkState,
  type PlaybackState,
  type Project,
  type Scene,
  type ClientMessage,
  type ServerMessage,
} from '@fountain-studio/shared';
import { wireAlarmNotifications } from '../alarms';
import { AudioStore } from '../audio';
import { BackupStore } from '../backups';
import dgram from 'node:dgram';
import { createServer as createTcpServer, createConnection as createTcpConnection } from 'node:net';
import { emaStep } from '../clock';
import { DmxCapture } from '../dmxcapture';
import { DmxTriggerWatcher } from '../dmxtriggers';
import { Engine } from '../engine';
import { MqttController } from '../mqttcontroller';
import { NetworkMonitor } from '../netmonitor';
import { OscServer } from '../oscserver';
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
  audio: { player: 'none', ffplayPath: 'ffplay' },
  universes: [{ id: 1, label: 'Тест', outputs: [{ type: 'artnet', host: '127.0.0.1', universe: 0 }] }],
  backup: { enabled: false, intervalMin: 10 }, // таймер выключен — снимки берём вручную в тесте
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
const osc = new OscServer(engine, OSC_PORT, () => store.project.oscBindings);
osc.start();
const mqtt = new MqttController(
  engine,
  { host: '127.0.0.1', port: MOCK_MQTT_PORT, topicPrefix: 'test' },
  () => store.project.mqttBindings,
);
// Та же обёртка, что index.ts включает в проде при активном MQTT — проверяем
// реальную функцию, не переписанную для теста копию.
wireAlarmNotifications(mqtt);

const wss = startServer(
  engine,
  store,
  new AudioStore(path.join(tmpDir, 'audio')),
  backups,
  net,
  dmxCapture,
  osc,
  mqtt,
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
      effect: { mode: 'rate', strength: 10 },
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
          effects: [{ id: 'fx1', mode: 'rate', strength: 10, startMs: 0, endMs: 5200 }],
        },
      ],
    },
  ],
  playlists: [
    {
      id: 'pl1',
      name: 'Вечерняя программа',
      mode: 'once',
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
  } else if (msg.type === 'audio') {
    audioMsg = { name: msg.name, dataBase64: msg.dataBase64 };
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
  check(playback.activeSceneId === 'sceneA', 'состояние воспроизведения: активна сцена A');

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

  console.log('— Расписание по системному времени —');
  const scheduler = new Scheduler(engine, () => store.project.schedule);
  scheduler.start();
  const at = new Date(Date.now() + 1500);
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  const ss = String(at.getSeconds()).padStart(2, '0');
  send({
    type: 'updateProject',
    project: {
      ...demo,
      schedule: [
        {
          id: 'sch1',
          name: 'Тестовый запуск',
          enabled: true,
          days: [],
          time: `${hh}:${mm}:${ss}`,
          action: { type: 'scene', refId: 'sceneA' },
        },
      ],
    },
  });
  await waitFor(
    'расписание сработало',
    () => playback.activeSceneId === 'sceneA' && ch(1) === 200,
    5000,
  );
  check(true, `запись «${hh}:${mm}:${ss} → сцена» сработала по системным часам`);
  scheduler.stop();
  send({ type: 'setScene', sceneId: null });
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
      noz2.tiltDeg === 85 &&
      sanitized.layout.lights[0]!.deviceId === 'rgb1',
    'sanitizeLayout: битые ссылки и значения приведены, элементы сохранены',
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

  console.log('— Генераторы сцен от геометрии (§17 п.2–3) —');
  const genActors = ringPositions(4, 2).map((p, i) => ({ deviceId: `gp${i + 1}`, x: p.x, y: p.y }));
  const genLayout = {
    bowls: [],
    lights: [],
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
    networkState!.log.some((e) => e.text.includes('ПОТЕРЯНА')),
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
    const testCfg = { enabled: true, warnSpeed: 8, maxSpeed: 15, minPercent: 20 };
    check(computeWindLimitPercent(5, testCfg) === 100, 'computeWindLimitPercent: ниже порога — 100% (без ограничения)');
    check(computeWindLimitPercent(15, testCfg) === 20, 'computeWindLimitPercent: на maxSpeed и выше — минимум (20%)');
    check(
      computeWindLimitPercent(11.5, testCfg) === 60,
      'computeWindLimitPercent: посередине диапазона — линейная интерполяция (60%)',
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

    send({ type: 'setWindSpeed', speedMs: 15 }); // полное ограничение (minPercent=20)
    await waitFor('насос снижен ветром', () => ch(1) === 40, 2000); // round(200×20/100)=40
    check(ch(10) === 200, 'ветер не трогает свет — канал R rgb1 остался 200');
    check(true, 'ветер 15 м/с (maxSpeed) → насос снижен со 200 до 40 (×20%)');

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
  await waitFor('авария обнаружена', () => pumpStatus()?.faultCode === 7, 4000);
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

  console.log('— Хранилище аудио —');
  const audioData = Buffer.from('НЕ-НАСТОЯЩИЙ-MP3: проверка хранилища').toString('base64');
  send({ type: 'uploadAudio', name: 'тест.mp3', dataBase64: audioData });
  send({ type: 'getAudio', name: 'тест.mp3' });
  await waitFor('ответ getAudio', () => audioMsg !== null);
  check(audioMsg!.name === 'тест.mp3' && audioMsg!.dataBase64 === audioData, 'аудиофайл сохранён и отдан байт в байт');

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
      logEvents.some((e) => e.source === 'schedule' && e.message.includes('Тестовый запуск')),
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
      logEvents.some((e) => e.source === 'net' && e.level === 'warn' && e.message.includes('ПОТЕРЯНА')),
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
        return p.source === 'net' && p.level === 'warn' && p.message.includes('ПОТЕРЯНА');
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

  console.log('— Сохранение проекта —');
  await sleep(700); // дебаунс записи 500 мс
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
    osc.stop();
    mqtt.stop();
    mockNode.close();
    vfdServer.close();
    mqttSub.destroy();
    mqttServer.close();
    backups.stop();
    engine.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(failures.length === 0 ? 0 : 1);
  });
