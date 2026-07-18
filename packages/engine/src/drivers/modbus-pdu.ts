/**
 * Modbus: сборка/разбор PDU и CRC16, общее для TCP (MBAP-обрамление, modbus-tcp.ts)
 * и RTU (адрес+CRC16-обрамление, modbus-rtu.ts). Из всей карты функций проекту
 * нужны только запись уставки/команды и чтение статуса/аварии — держим минимум,
 * без остальных кодов функций Modbus (не полный клиент, см. обсуждение с пользователем:
 * простое управление, не конфигуратор параметров ПЧ).
 */

export const FC_READ_HOLDING_REGISTERS = 0x03;
export const FC_WRITE_SINGLE_REGISTER = 0x06;

export function pduWriteSingleRegister(address: number, value: number): Buffer {
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(FC_WRITE_SINGLE_REGISTER, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(value & 0xffff, 3);
  return pdu;
}

export function pduReadHoldingRegisters(address: number, count = 1): Buffer {
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(FC_READ_HOLDING_REGISTERS, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(count, 3);
  return pdu;
}

/** Бросает при Modbus-исключении (код функции в ответе с битом 0x80); иначе возвращает PDU как есть. */
export function checkException(pdu: Buffer, fc: number): Buffer {
  if (pdu.length > 0 && pdu.readUInt8(0) === (fc | 0x80)) {
    const code = pdu.length > 1 ? pdu.readUInt8(1) : -1;
    throw new Error(`Modbus-исключение от ПЧ, код ${code}`);
  }
  return pdu;
}

export function parseHoldingRegisters(pdu: Buffer): number[] {
  checkException(pdu, FC_READ_HOLDING_REGISTERS);
  const byteCount = pdu.readUInt8(1);
  const values: number[] = [];
  for (let i = 0; i + 1 < byteCount; i += 2) values.push(pdu.readUInt16BE(2 + i));
  return values;
}

/** CRC16-Modbus (полином 0xA001, в кадре передаётся little-endian). */
export function crc16Modbus(buf: Buffer): number {
  let crc = 0xffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc;
}
