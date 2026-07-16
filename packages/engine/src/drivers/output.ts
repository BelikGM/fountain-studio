/** Общий интерфейс выхода вселенной: получает готовый кадр 512 байт каждый тик. */
export interface UniverseOutput {
  send(frame: Uint8Array): void;
  describe(): string;
  close(): void;
}
