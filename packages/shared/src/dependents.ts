import { nozzleLightIds, nozzlePump2Ids, nozzlePumpIds, nozzleValveIds } from './layout';
import type { Project } from './project';

/**
 * «Кто использует эту сущность» — для предупреждения перед удалением сцены/
 * секвенсора/шоу/плейлиста/прибора (§27 доработки, УХ п.2). Возвращает список
 * фраз вида «секвенсоры (2)» для показа в диалоге подтверждения; пустой массив —
 * сущность нигде не используется, подтверждение можно не спрашивать.
 */

type RefAction = 'scene' | 'sequence' | 'sequenceGroup' | 'show' | 'playlist';

function actionDependents(project: Project, type: RefAction, id: string): string[] {
  const out: string[] = [];
  const keys = project.keys.filter((k) => k.action.type === type && k.action.refId === id).length;
  if (keys > 0) out.push(`клавиши (${keys})`);
  const schedule = project.schedules
    .flatMap((sc) => sc.entries)
    .filter((e) => e.action.type === type && 'refId' in e.action && e.action.refId === id).length;
  if (schedule > 0) out.push(`расписание (${schedule})`);
  const osc = project.oscBindings.filter((b) => b.action.type === type && b.action.refId === id).length;
  if (osc > 0) out.push(`OSC (${osc})`);
  const mqtt = project.mqttBindings.filter((b) => b.action.type === type && b.action.refId === id).length;
  if (mqtt > 0) out.push(`MQTT (${mqtt})`);
  return out;
}

export function sceneDependents(project: Project, sceneId: string): string[] {
  const out: string[] = [];
  const sequences = project.sequences.filter((q) => q.steps.some((s) => s.sceneId === sceneId)).length;
  if (sequences > 0) out.push(`секвенсоры (${sequences})`);
  const shows = project.shows.filter((sh) =>
    sh.tracks.some((t) => t.kind === 'blocks' && t.blocks.some((b) => b.type === 'scene' && b.refId === sceneId)),
  ).length;
  if (shows > 0) out.push(`шоу (${shows})`);
  out.push(...actionDependents(project, 'scene', sceneId));
  return out;
}

export function sequenceDependents(project: Project, sequenceId: string): string[] {
  const out: string[] = [];
  const shows = project.shows.filter((sh) =>
    sh.tracks.some(
      (t) => t.kind === 'blocks' && t.blocks.some((b) => b.type === 'sequence' && b.refId === sequenceId),
    ),
  ).length;
  if (shows > 0) out.push(`шоу (${shows})`);
  const groups = project.sequenceGroups.filter((g) => g.sequenceIds.includes(sequenceId)).length;
  if (groups > 0) out.push(`группы секвенсоров (${groups})`);
  out.push(...actionDependents(project, 'sequence', sequenceId));
  return out;
}

export function sequenceGroupDependents(project: Project, groupId: string): string[] {
  return actionDependents(project, 'sequenceGroup', groupId);
}

export function showDependents(project: Project, showId: string): string[] {
  const out: string[] = [];
  const playlists = project.playlists.filter((p) => p.items.some((it) => it.showId === showId)).length;
  if (playlists > 0) out.push(`плейлисты (${playlists})`);
  out.push(...actionDependents(project, 'show', showId));
  return out;
}

export function playlistDependents(project: Project, playlistId: string): string[] {
  return actionDependents(project, 'playlist', playlistId);
}

export function deviceDependents(project: Project, deviceId: string): string[] {
  const out: string[] = [];
  const scenes = project.scenes.filter((s) => deviceId in s.values).length;
  if (scenes > 0) out.push(`сцены (${scenes})`);
  const envelopes = project.shows.filter((sh) =>
    sh.tracks.some((t) => t.kind === 'envelope' && t.deviceId === deviceId),
  ).length;
  if (envelopes > 0) out.push(`огибающие в шоу (${envelopes})`);
  const nozzles = project.layout.nozzles.filter(
    (n) =>
      // Учитываем и дополнительные привязки, иначе удаление устройства молча
      // оборвало бы связь, о которой пользователя не предупредили.
      nozzlePumpIds(n).includes(deviceId) ||
      nozzleValveIds(n).includes(deviceId) ||
      nozzleLightIds(n).includes(deviceId) ||
      nozzlePump2Ids(n).includes(deviceId),
  ).length;
  if (nozzles > 0) out.push(`форсунки на 3D-схеме (${nozzles})`);
  return out;
}
