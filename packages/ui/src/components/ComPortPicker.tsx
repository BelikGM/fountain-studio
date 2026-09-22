import { useEffect, useState } from 'react';
import type { UsbSerialPort } from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';

/**
 * Опрос COM-портов и USB-DMX на компьютере движка — один на всех, сколько бы
 * выборов порта ни было на экране. Без счётчика каждая строка таблицы и каждый
 * насос заводили бы свой таймер, и движок перебирал бы порты десятки раз в
 * секунду.
 */
let watchers = 0;
let timer: number | undefined;

export function useUsbScan(engine: EngineConnection, active: boolean): void {
  const { send, connected } = engine;
  useEffect(() => {
    if (!connected || !active) return;
    watchers++;
    if (watchers === 1) {
      send({ type: 'scanUsbDmx' });
      timer = window.setInterval(() => send({ type: 'scanUsbDmx' }), 2000);
    }
    return () => {
      watchers--;
      if (watchers === 0) window.clearInterval(timer);
    };
  }, [connected, active, send]);
}

/** Микросхема переходника по коду производителя — то, что написано в инструкции и в Диспетчере устройств. */
const CHIPS: Record<string, string> = {
  '0403': 'FTDI',
  '1a86': 'CH340',
  '10c4': 'CP210x',
  '067b': 'Prolific',
};

function portLabel(p: UsbSerialPort): string {
  const chip = CHIPS[p.vendorId.toLowerCase()];
  if (chip) return `${p.path} · ${chip}`;
  // Без кода производителя — встроенный порт материнской платы или Bluetooth:
  // переходник RS-485 или DMX таким не бывает, пусть это будет видно сразу.
  return p.vendorId ? `${p.path} · USB` : `${p.path} · не USB`;
}

/** COM3 раньше COM10 — как в Диспетчере устройств, а не по алфавиту. */
function portOrder(a: UsbSerialPort, b: UsbSerialPort): number {
  const n = (s: string): number => Number(/(\d+)$/.exec(s)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return n(a.path) - n(b.path) || a.path.localeCompare(b.path);
}

const MANUAL = '\u0000вручную';

/**
 * Выбор COM-порта списком найденных. Раньше было поле с подсказками: на
 * объекте его заполняли по памяти («COM3» с прошлого ПК), а у переходника
 * здесь другой номер — и датчик «не отвечал». Список показывает только то, что
 * есть, с микросхемой переходника; порт из настроек, которого сейчас нет,
 * остаётся в списке с пометкой «не подключён» — чтобы его не потеряли, выдернув
 * переходник на минуту. Вписать вручную всё равно можно: порт появится позже
 * или это виртуальный порт шлюза.
 */
export function ComPortPicker({
  engine,
  value,
  onChange,
  width = 185,
  hint,
}: {
  engine: EngineConnection;
  value: string;
  onChange: (path: string) => void;
  width?: number;
  hint?: string;
}) {
  useUsbScan(engine, true);
  const scan = engine.usbScan;
  const ports = [...(scan?.ports ?? [])].sort(portOrder);
  // «com3», вписанный руками, — тот же COM3: Windows регистр не различает.
  const match = ports.find((p) => p.path.toUpperCase() === value.toUpperCase());
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  if (manual) {
    // Вписали — сразу обратно к списку: там порт и покажется, найден он или
    // «не подключён». Поле, оставшееся открытым, читалось как «не сохранилось».
    const commit = (): void => {
      if (draft !== null && draft.trim() !== value) onChange(draft.trim());
      setDraft(null);
      setManual(false);
    };
    return (
      <span className="com-picker">
        <input
          className="input"
          style={{ width: width - 34 }}
          autoFocus
          value={draft ?? value}
          placeholder="COM5"
          data-hint="Номер порта — из Диспетчера устройств Windows, раздел «Порты (COM и LPT)»."
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(null);
              setManual(false);
            }
          }}
        />
        <button
          type="button"
          className="btn btn-small"
          data-hint="Вернуться к списку найденных портов"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
        >
          ▾
        </button>
      </span>
    );
  }

  return (
    <select
      style={{ width }}
      value={match?.path ?? value}
      data-hint={
        hint ??
        'COM-порты, найденные на компьютере движка. Список обновляется сам: подключили переходник — через пару секунд он здесь.\n' +
          'FTDI, CH340, CP210x — микросхема переходника (так же он назван в Диспетчере устройств). «не USB» — порт самого компьютера или Bluetooth, переходник таким не бывает.'
      }
      onChange={(e) => {
        if (e.target.value === MANUAL) setManual(true);
        else onChange(e.target.value);
      }}
    >
      {!value && <option value="">— выберите —</option>}
      {ports.map((p) => (
        <option key={p.path} value={p.path}>
          {portLabel(p)}
        </option>
      ))}
      {value && !match && <option value={value}>{`${value} · не подключён`}</option>}
      {scan && ports.length === 0 && (
        <option value="" disabled>
          портов не найдено
        </option>
      )}
      {!scan && (
        <option value="" disabled>
          ищем порты…
        </option>
      )}
      <option value={MANUAL}>вписать вручную…</option>
    </select>
  );
}
