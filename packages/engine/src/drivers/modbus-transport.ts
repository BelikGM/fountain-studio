/**
 * Общий интерфейс Modbus-транспорта — реализуют ModbusTcpClient (TCP-шлюз RTU↔TCP,
 * MBAP) и ModbusRtuClient (RS-485 напрямую, serialport). PumpModbusManager работает
 * через этот интерфейс и не знает, какой физический транспорт выбран для конкретного
 * насоса (§12 п.9: оба варианта на выбор per-device).
 */
export interface ModbusTransport {
  writeSingleRegister(unitId: number, address: number, value: number): Promise<void>;
  readHoldingRegister(unitId: number, address: number): Promise<number>;
  readonly isConnected: boolean;
  close(): void;
}
