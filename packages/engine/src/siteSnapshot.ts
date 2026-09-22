import { activeScheduleEntries, namesForRdm, normalizeRdmUid, type NetworkState, type Project, type ScheduleEntry } from '@fountain-studio/shared';
import type { BackupStore } from './backups';
import type { Engine } from './engine';
import { eventLog } from './eventlog';
import type { SiteSnapshot } from './telegramFormat';

/** Момент запуска движка — от него «работает без перезапуска». */
const STARTED_MS = Date.now();

const DAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function mmss(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function nameOf(list: { id: string; name: string }[], id: string): string {
  return list.find((x) => x.id === id)?.name ?? 'удалено из объекта';
}

/** Что делает запись расписания — словами, с именами из проекта. */
function actionText(p: Project, e: ScheduleEntry): string {
  const a = e.action;
  switch (a.type) {
    case 'playlist':
      return `плейлист «${nameOf(p.playlists, a.refId)}»`;
    case 'show':
      return `шоу «${nameOf(p.shows, a.refId)}»`;
    case 'sequence':
      return `секвенсор «${nameOf(p.sequences, a.refId)}»`;
    case 'sequenceGroup':
      return `группа секвенсоров «${nameOf(p.sequenceGroups, a.refId)}»`;
    case 'scene':
      return `сцена «${nameOf(p.scenes, a.refId)}»`;
    case 'pause':
      return 'пауза — картина замирает';
    case 'stopAll':
      return 'стоп — фонтан в покое';
    case 'off':
      return 'выключить — всё в 0';
  }
}

/** Ближайшая запись расписания после now — на неделю вперёд. */
function nextSchedule(p: Project, now: Date): string | null {
  let best: { at: Date; e: ScheduleEntry } | null = null;
  for (const { entry: e } of activeScheduleEntries(p.schedules)) {
    const [hh, mm, ss] = e.time.split(':').map(Number);
    for (let d = 0; d < 8; d++) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, hh ?? 0, mm ?? 0, ss ?? 0);
      if (at.getTime() <= now.getTime()) continue;
      if (e.days.length > 0 && !e.days.includes(at.getDay())) continue;
      if (!best || at < best.at) best = { at, e };
      break;
    }
  }
  if (!best) return null;
  const dayDiff = Math.round(
    (new Date(best.at.getFullYear(), best.at.getMonth(), best.at.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86400_000,
  );
  const day = dayDiff === 0 ? 'сегодня' : dayDiff === 1 ? 'завтра' : DAY_NAMES[best.at.getDay()];
  const hm = best.e.time.slice(0, 5);
  const label = best.e.name !== '' ? ` («${best.e.name}»)` : '';
  return `${day} в ${hm} — ${actionText(p, best.e)}${label}`;
}

/**
 * Живой снимок объекта для сообщений в Telegram.
 *
 * Собирается из того, что уже есть в движке, и называет всё ИМЕНАМИ из
 * проекта: «шоу «Вечернее»», «ПЧ «Насос 3»», а не идентификаторы — сообщение
 * читает человек на объекте, у него перед глазами проект, а не база.
 */
export function buildSiteSnapshot(deps: {
  engine: Engine;
  project: () => Project;
  net: () => NetworkState | undefined;
  backups: BackupStore;
}): SiteSnapshot {
  const p = deps.project();
  const now = Date.now();
  const pb = deps.engine.playbackState();

  let playNow: string | null = null;
  let detail: string | null = null;
  if (pb.playlist) {
    const pl = p.playlists.find((x) => x.id === pb.playlist!.playlistId);
    playNow = `плейлист «${pl?.name ?? 'без имени'}»`;
    detail = pb.playlist.inGap
      ? `пауза между шоу, дальше ${pb.playlist.itemIndex + 1}-е из ${pl?.items.length ?? '?'}`
      : `${pb.playlist.itemIndex + 1}-е шоу из ${pl?.items.length ?? '?'}`;
  }
  if (pb.show) {
    const show = p.shows.find((x) => x.id === pb.show!.showId);
    const showText = `шоу «${show?.name ?? 'без имени'}»`;
    const pos = `${mmss(pb.show.positionMs)} из ${mmss(show?.durationMs ?? 0)}${pb.show.playing ? '' : ', на паузе'}`;
    if (playNow) detail = `${detail}: ${showText}, ${pos}`;
    else {
      playNow = showText;
      detail = pos;
    }
  }
  if (!playNow && pb.running.length > 0) {
    playNow =
      pb.running.length === 1
        ? `секвенсор «${nameOf(p.sequences, pb.running[0]!.sequenceId)}»`
        : `секвенсоров: ${pb.running.length}`;
  }
  if (!playNow && pb.activeSceneId) playNow = `сцена «${nameOf(p.scenes, pb.activeSceneId)}»`;

  const stats = deps.engine.stats();
  const net = deps.net();
  // Имена приборов по RDM-UID из патча — чтобы в отчёте не было голых UID.
  const rdmNames = namesForRdm(deps.project().devices);
  const devName = (id: string): string => p.devices.find((d) => d.id === id)?.name ?? id;

  const modbus = deps.engine.modbusState();
  const pumps =
    modbus.pumps.length > 0
      ? {
          total: modbus.pumps.length,
          online: modbus.pumps.filter((x) => x.connected).length,
          faults: modbus.pumps
            .filter((x) => x.faultCode !== null && x.faultCode !== 0)
            .map((x) => ({ name: devName(x.deviceId), code: x.faultCode as number })),
          offline: modbus.pumps.filter((x) => !x.connected).map((x) => devName(x.deviceId)),
          hottest: modbus.pumps
            .filter((x) => x.tempC !== null)
            .reduce<{ name: string; tempC: number } | null>(
              (best, x) => (best && best.tempC >= (x.tempC as number) ? best : { name: devName(x.deviceId), tempC: x.tempC as number }),
              null,
            ),
        }
      : null;

  const wind = deps.engine.windState();
  const lastBackup = deps.backups.list().reduce((m, b) => Math.max(m, b.atMs), 0);

  // Журнал живёт в памяти с запуска: берём сутки или сколько есть.
  const since = Math.max(STARTED_MS, now - 24 * 3600_000);
  const grouped = new Map<string, SiteSnapshot['events'][number]>();
  for (const e of eventLog.list()) {
    if (e.level === 'info' || e.tsMs < since) continue;
    const key = `${e.level}|${e.message}`;
    const g = grouped.get(key);
    if (g) {
      g.count++;
      g.lastMs = Math.max(g.lastMs, e.tsMs);
    } else {
      grouped.set(key, { level: e.level, source: e.source, message: e.message, count: 1, lastMs: e.tsMs });
    }
  }

  return {
    site: p.name,
    atMs: now,
    playback: { now: playNow, detail, pausedAll: pb.pausedAll },
    nextSchedule: nextSchedule(p, new Date(now)),
    dmx: {
      universes: deps.engine.universeInfos().length,
      avgJitterMs: stats.avgJitterMs,
      maxJitterMs: stats.maxJitterMs,
    },
    artnet: net
      ? {
          online: net.nodes.filter((x) => !x.lost).length,
          total: net.nodes.length,
          lost: net.nodes.filter((x) => x.lost).map((x) => (x.shortName ? `${x.shortName} (${x.ip})` : x.ip)),
        }
      : null,
    rdm: net
      ? {
          total: net.rdmDevices.length,
          lost: net.rdmDevices
            .filter((x) => x.lost)
            .map((x) => {
              const name = rdmNames.get(normalizeRdmUid(x.uid));
              return `${name ? `${name} (${x.uid})` : x.uid}, вселенная ${x.universe}`;
            }),
        }
      : null,
    pumps,
    wind: { speedMs: wind.speedMs, limitPercent: wind.limitPercent, enabled: wind.config.enabled },
    uptimeSec: Math.round((now - STARTED_MS) / 1000),
    lastBackupAgoMin: lastBackup > 0 ? (now - lastBackup) / 60_000 : null,
    events: [...grouped.values()],
    eventsSinceMs: since,
  };
}
