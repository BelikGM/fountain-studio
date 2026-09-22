import { useMemo } from 'react';
import { scheduleSecondOfDay, whyQuiet, type QuietFacts, type QuietTab } from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';

/**
 * «Почему ничего не играет» — один экран с ответом.
 *
 * Причин с десяток, и раньше их искали по разным вкладкам: авария — на
 * «Диагностике», пауза — на «Отладке», стоп по расписанию — в строке внизу,
 * лицензия — под ключиком, а «объект не открыт» вообще нигде. На объекте это
 * выглядело как «программа сломалась». Сам разбор — в shared/whyquiet.ts,
 * здесь только показ и переходы на нужную вкладку.
 */
export function WhyQuietView({
  engine,
  onClose,
  onGo,
}: {
  engine: EngineConnection;
  onClose: () => void;
  onGo: (tab: QuietTab) => void;
}) {
  const facts = useMemo(() => collectFacts(engine), [engine]);
  const answer = whyQuiet(facts);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal why-modal" onClick={(e) => e.stopPropagation()}>
        <div className="form-row">
          <span className="panel-title" style={{ width: 'auto' }}>
            Почему ничего не играет
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Закрыть
          </button>
        </div>
        <p className={answer.items.length === 0 ? 'ok-text' : 'why-headline'}>
          {answer.items.length === 0 ? '✔ ' : ''}
          {answer.headline}
        </p>
        {answer.items.length === 0 ? (
          <p className="dim">
            Движку сейчас ничего не мешает. Если фонтан всё равно стоит — дело за программой: смотрите «Диагностику»
            (доходят ли кадры) и питание насосов.
          </p>
        ) : (
          <ol className="why-list">
            {answer.items.map((it, i) => (
              <li key={i}>
                {/* Заголовок уже сказал главное — второй раз теми же словами не повторяем. */}
                {!(i === 0 && it.what === answer.headline) && <b>{it.what}</b>}
                <div className="dim">{it.fix}</div>
                {it.tab && (
                  <button
                    className="btn btn-small"
                    onClick={() => {
                      onGo(it.tab!);
                      onClose();
                    }}
                  >
                    Перейти
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/** Ближайшая запись расписания сегодня — «21:00» или null. */
function nextEntryToday(engine: EngineConnection, nowSec: number): string | null {
  const day = new Date().getDay();
  let best: { sec: number; time: string } | null = null;
  for (const s of engine.project?.schedules ?? []) {
    if (!s.enabled) continue;
    for (const e of s.entries) {
      if (!e.enabled) continue;
      if (e.days.length > 0 && !e.days.includes(day)) continue;
      const sec = scheduleSecondOfDay(e.time);
      if (sec <= nowSec) continue;
      if (!best || sec < best.sec) best = { sec, time: e.time.slice(0, 5) };
    }
  }
  return best?.time ?? null;
}

function collectFacts(engine: EngineConnection): QuietFacts {
  const p = engine.project;
  const cfg = engine.engineConfig;
  const pb = engine.playback;
  const now = new Date();
  const universes = cfg?.universes ?? [];
  const schedules = p?.schedules ?? [];
  const net = engine.network;
  /*
   * «Доставляется ли» берём у мониторинга сети: он знает про потерянные ноды.
   * Пока данных нет (движок только поднялся) — null, и про выход молчим:
   * пугать человека тем, чего мы ещё не проверили, нельзя.
   */
  const lostNodes = net?.nodes.filter((n) => n.lost).length ?? 0;
  const outputsDelivering = net === null ? null : lostNodes === 0 ? true : false;

  return {
    connected: engine.connected,
    licensed: engine.licenseStatus?.licensed ?? true,
    licenseReason: engine.licenseStatus?.reason ?? '',
    projectOpen: engine.projects?.current !== null && p !== null,
    devices: p?.devices.length ?? 0,
    universes: universes.length,
    universesWithOutput: universes.filter((u) => u.outputs.length > 0).length,
    failsafe: { active: engine.failsafe?.active ?? false, reason: engine.failsafe?.reason ?? '' },
    pausedAll: pb.pausedAll,
    dark: pb.dark ?? null,
    sceneOn: pb.activeSceneId !== null,
    sequences: pb.running.length,
    showOn: pb.show !== null,
    playlistOn: pb.playlist !== null,
    idleSceneSet: (p?.idleSceneId ?? null) !== null,
    windLimitPercent: engine.windState?.limitPercent ?? 100,
    windCorrecting: engine.windState?.correcting ?? false,
    schedulesEnabled: schedules.filter((s) => s.enabled).length,
    scheduleEntriesEnabled: schedules.reduce((n, s) => n + s.entries.filter((e) => e.enabled).length, 0),
    nextEntryTime: nextEntryToday(engine, now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()),
    needsAudioPlayer:
      (cfg?.audioReady ?? true) === false &&
      ((p?.playlists.length ?? 0) > 0 ||
        schedules.some((s) => s.enabled && s.entries.some((e) => e.enabled && (e.action.type === 'playlist' || e.action.type === 'show')))),
    outputsDelivering,
  };
}
