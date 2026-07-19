import { useRef, useState } from 'react';
import { DMX_MAX_VALUE } from '@fountain-studio/shared';

interface FaderProps {
  /** DMX-адрес 1..512 (для подписи). */
  channel: number;
  value: number;
  /** Владелец адреса из патча («Насос 1 · Мощность»); нет — адрес свободен. */
  owner?: string;
  onChange: (value: number) => void;
}

/** Вертикальный фейдер 0–255 с управлением мышью/тачем (pointer capture). */
export function Fader({ channel, value, owner, onChange }: FaderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragValue, setDragValue] = useState<number | null>(null);

  const shown = dragValue ?? value;

  const applyPointer = (clientY: number): void => {
    const rect = trackRef.current!.getBoundingClientRect();
    const ratio = 1 - (clientY - rect.top) / rect.height;
    const v = Math.max(0, Math.min(DMX_MAX_VALUE, Math.round(ratio * DMX_MAX_VALUE)));
    setDragValue(v);
    onChange(v);
  };

  return (
    <div className={owner ? 'fader fader-owned' : 'fader'} title={owner ?? `адрес ${channel} свободен`}>
      <div className="fader-value">{shown}</div>
      <div
        ref={trackRef}
        className="fader-track"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          applyPointer(e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) applyPointer(e.clientY);
        }}
        onPointerUp={() => setDragValue(null)}
      >
        <div className="fader-fill" style={{ height: `${(shown / DMX_MAX_VALUE) * 100}%` }} />
      </div>
      <div className="fader-channel">{channel}</div>
    </div>
  );
}
