/**
 * RDM (ANSI E1.20) — минимальный набор параметров (PID), одинаковых по спеке
 * для ЛЮБОГО RDM-прибора независимо от марки: IDENTIFY_DEVICE (мигнуть),
 * DMX_START_ADDRESS (прочитать/переставить адрес удалённо), DEVICE_INFO,
 * SOFTWARE_VERSION_LABEL, MANUFACTURER_LABEL, DEVICE_MODEL_DESCRIPTION.
 *
 * Сознательно НЕ трогаем опциональные PID конкретных производителей
 * (SENSOR_VALUE, STATUS_MESSAGES, LAMP_HOURS…) — их формат и сам факт
 * поддержки различаются прибор от прибора; светильники RDM в руках есть,
 * а какой конкретно RDM-контроллер/нода будет на объекте — нет, поэтому по
 * плану (§22) это отдельный шаг «когда появится железо». Разбор DEVICE_INFO
 * — по типовой раскладке E1.20, **не проверено на реальном приборе**.
 *
 * Транспорт — ArtRdm (Art-Net 4, OpCode 0x8300): та же обвязка, что уже
 * работает для ArtPoll/ArtTodRequest в netmonitor.ts (Net/Command/Address на
 * тех же смещениях).
 */

export const RDM_START_CODE = 0xcc;
export const RDM_SUB_START_CODE = 0x01;

export const CC_GET_COMMAND = 0x20;
export const CC_GET_COMMAND_RESPONSE = 0x21;
export const CC_SET_COMMAND = 0x30;
export const CC_SET_COMMAND_RESPONSE = 0x31;

export const PID_DEVICE_INFO = 0x0060;
export const PID_DEVICE_MODEL_DESCRIPTION = 0x0080;
export const PID_MANUFACTURER_LABEL = 0x0081;
export const PID_SOFTWARE_VERSION_LABEL = 0x00c0;
export const PID_DMX_START_ADDRESS = 0x00f0;
export const PID_IDENTIFY_DEVICE = 0x1000;

export const OP_RDM = 0x8300;

/**
 * UID нашего «контроллера» — у Fountain Studio нет регистрации ESTA
 * (Manufacturer ID выдаёт ESTA официальным производителям оборудования).
 * 0x7a70 — общеупотребимый в open-source RDM-инструментах диапазон для таких
 * случаев (в этом же диапазоне работает контроллер OLA — Open Lighting
 * Architecture); официальной регистрации это не заменяет, но для наших целей
 * (мы только опрашиваем чужие приборы, не выступаем управляемым устройством)
 * коллизий не создаёт.
 */
const CONTROLLER_UID = Buffer.from([0x7a, 0x70, 0x00, 0x00, 0x00, 0x01]);

function uidToBuffer(uid: string): Buffer {
  const [man, dev] = uid.split(':');
  const buf = Buffer.alloc(6);
  buf.writeUInt16BE(parseInt(man ?? '0', 16), 0);
  buf.writeUInt32BE(parseInt(dev ?? '0', 16), 2);
  return buf;
}

function bufferToUid(buf: Buffer, offset: number): string {
  const man = buf.readUInt16BE(offset).toString(16).padStart(4, '0');
  const dev = buf.readUInt32BE(offset + 2).toString(16).padStart(8, '0');
  return `${man}:${dev}`;
}

/** Собирает RDM-пакет (без Art-Net обёртки): GET/SET с необязательными данными параметра. */
export function buildRdmPacket(targetUid: string, cc: number, pid: number, transactionNum: number, paramData: Buffer = Buffer.alloc(0)): Buffer {
  const msgLength = 24 + paramData.length; // заголовок RDM (Start Code..ParamDataLen) + данные
  const pkt = Buffer.alloc(msgLength + 2); // + чек-сумма
  pkt.writeUInt8(RDM_START_CODE, 0);
  pkt.writeUInt8(RDM_SUB_START_CODE, 1);
  pkt.writeUInt8(msgLength, 2);
  uidToBuffer(targetUid).copy(pkt, 3);
  CONTROLLER_UID.copy(pkt, 9);
  pkt.writeUInt8(transactionNum & 0xff, 15);
  pkt.writeUInt8(0x01, 16); // PortID (в запросе — Port ID, обычно 1)
  pkt.writeUInt8(0x00, 17); // MessageCount (в запросе — 0)
  pkt.writeUInt16BE(0x0000, 18); // Sub-Device — корневое устройство
  pkt.writeUInt8(cc, 20);
  pkt.writeUInt16BE(pid, 21);
  pkt.writeUInt8(paramData.length, 23);
  paramData.copy(pkt, 24);
  let checksum = 0;
  for (let i = 0; i < msgLength; i++) checksum += pkt[i]!;
  pkt.writeUInt16BE(checksum & 0xffff, msgLength);
  return pkt;
}

export interface RdmResponse {
  sourceUid: string;
  transactionNum: number;
  cc: number;
  pid: number;
  paramData: Buffer;
}

/** Разбирает и проверяет чек-сумму RDM-пакета (без Art-Net обёртки). null — битый/неполный/чужой пакет. */
export function parseRdmPacket(buf: Buffer): RdmResponse | null {
  if (buf.length < 26 || buf[0] !== RDM_START_CODE || buf[1] !== RDM_SUB_START_CODE) return null;
  const msgLength = buf.readUInt8(2);
  if (buf.length < msgLength + 2) return null;
  let checksum = 0;
  for (let i = 0; i < msgLength; i++) checksum += buf[i]!;
  if ((checksum & 0xffff) !== buf.readUInt16BE(msgLength)) return null;
  return {
    sourceUid: bufferToUid(buf, 9),
    transactionNum: buf.readUInt8(15),
    cc: buf.readUInt8(20),
    pid: buf.readUInt16BE(21),
    paramData: buf.subarray(24, 24 + buf.readUInt8(23)),
  };
}

/** Оборачивает готовый RDM-пакет в ArtRdm (тот же приём, что ArtTodRequest в netmonitor.ts). */
export function wrapArtRdm(rdmPacket: Buffer, net: number): Buffer {
  const pkt = Buffer.alloc(24 + rdmPacket.length);
  pkt.write('Art-Net\0', 0, 'latin1');
  pkt.writeUInt16LE(OP_RDM, 8);
  pkt.writeUInt8(0, 10); // ProtVerHi
  pkt.writeUInt8(14, 11); // ProtVerLo
  pkt.writeUInt8(0x01, 12); // RdmVer: STD V1.0
  pkt.writeUInt8(0, 13);
  pkt.writeUInt8(net & 0x7f, 21);
  pkt.writeUInt8(0x00, 22); // Command: Process RDM Packet
  pkt.writeUInt8(0, 23);
  rdmPacket.copy(pkt, 24);
  return pkt;
}

/** Достаёт RDM-пакет из ArtRdm; null — слишком короткий пакет. */
export function unwrapArtRdm(msg: Buffer): Buffer | null {
  return msg.length < 25 ? null : msg.subarray(24);
}

// ── Параметр-хелперы ─────────────────────────────────────────────────────────

export function encodeIdentify(on: boolean): Buffer {
  return Buffer.from([on ? 1 : 0]);
}
export function parseIdentifyResponse(data: Buffer): boolean {
  return data.length > 0 && data[0] !== 0;
}

export function encodeStartAddress(address: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(Math.max(1, Math.min(512, Math.round(address))), 0);
  return b;
}
export function parseStartAddressResponse(data: Buffer): number | null {
  return data.length >= 2 ? data.readUInt16BE(0) : null;
}

/** ASCII-строка с нулём или без — MANUFACTURER_LABEL/SOFTWARE_VERSION_LABEL/DEVICE_MODEL_DESCRIPTION. */
export function parseLabelResponse(data: Buffer): string {
  const nul = data.indexOf(0);
  return data.toString('ascii', 0, nul >= 0 ? nul : data.length).trim();
}

export interface RdmDeviceInfoParam {
  protocolVersion: string;
  deviceModelId: number;
  productCategory: number;
  softwareVersionId: number;
  dmxFootprint: number;
  dmxStartAddress: number;
  subDeviceCount: number;
  sensorCount: number;
}

/** Раскладка по E1.20 (19 байт) — не проверена на реальном приборе, см. комментарий вверху файла. */
export function parseDeviceInfoResponse(data: Buffer): RdmDeviceInfoParam | null {
  if (data.length < 19) return null;
  return {
    protocolVersion: `${data.readUInt8(0)}.${data.readUInt8(1)}`,
    deviceModelId: data.readUInt16BE(2),
    productCategory: data.readUInt16BE(4),
    softwareVersionId: data.readUInt32BE(6),
    dmxFootprint: data.readUInt16BE(10),
    dmxStartAddress: data.readUInt16BE(14),
    subDeviceCount: data.readUInt16BE(16),
    sensorCount: data.readUInt8(18),
  };
}
