import { DMX_UNIVERSE_SIZE } from './dmx';
import { profileMap, type Project } from './project';

/**
 * Мастер нового объекта (§27 доработки, УХ п.11): несколько типов приборов
 * одним заходом, с общим порядком адресации между строками — каждая строка
 * продолжает адресацию с того места, где закончила предыдущая (в том числе
 * переливаясь в следующую вселенную), если сама не задаёт свой старт.
 * Не хватает вселенных — планировщик просит создать новые (см. newUniverseIds),
 * решение создавать их реально — за вызывающим кодом (сам он ничего не пишет).
 */

export interface WizardRow {
  profileId: string;
  count: number;
  namePrefix: string;
  /** null — продолжить оттуда, где закончила предыдущая строка. */
  startUniverse: number | null;
  startAddress: number | null;
}

export interface WizardPlacement {
  profileId: string;
  name: string;
  universe: number;
  address: number;
}

export interface WizardResult {
  placements: WizardPlacement[];
  /** Новых вселенных не хватило — их id по порядку (сразу после самой большой существующей). */
  newUniverseIds: number[];
}

export function planDeviceWizard(project: Project, existingUniverseIds: number[], rows: WizardRow[]): WizardResult {
  const profiles = profileMap(project);
  const occupied = new Map<number, Uint8Array>();
  const ensureUniverse = (id: number): Uint8Array => {
    let arr = occupied.get(id);
    if (!arr) {
      arr = new Uint8Array(DMX_UNIVERSE_SIZE + 1);
      for (const d of project.devices) {
        if (d.universe !== id) continue;
        const size = profiles.get(d.profileId)?.channels.length ?? 1;
        for (let a = d.address; a < d.address + size && a <= DMX_UNIVERSE_SIZE; a++) arr[a] = 1;
      }
      occupied.set(id, arr);
    }
    return arr;
  };

  const sortedExisting = [...new Set(existingUniverseIds)].sort((a, b) => a - b);
  const newUniverseIds: number[] = [];
  let nextNewId = Math.max(0, ...sortedExisting) + 1;
  const universeIdAt = (idx: number): number => {
    while (idx >= sortedExisting.length + newUniverseIds.length) {
      newUniverseIds.push(nextNewId++);
    }
    return idx < sortedExisting.length ? sortedExisting[idx]! : newUniverseIds[idx - sortedExisting.length]!;
  };
  const indexOfUniverse = (id: number): number => {
    const iExisting = sortedExisting.indexOf(id);
    if (iExisting >= 0) return iExisting;
    const iNew = newUniverseIds.indexOf(id);
    return iNew >= 0 ? sortedExisting.length + iNew : -1;
  };

  let cursorIdx = 0;
  let cursorAddr = 1;
  const placements: WizardPlacement[] = [];

  for (const row of rows) {
    const profile = profiles.get(row.profileId);
    if (!profile || row.count <= 0) continue;
    const size = Math.max(1, profile.channels.length);

    let idx = cursorIdx;
    let addr = cursorAddr;
    if (row.startUniverse !== null) {
      const found = indexOfUniverse(row.startUniverse);
      idx = found >= 0 ? found : idx;
      addr = row.startAddress ?? 1;
    }

    for (let i = 0; i < row.count; i++) {
      for (;;) {
        const uid = universeIdAt(idx);
        const arr = ensureUniverse(uid);
        const fits = addr + size - 1 <= DMX_UNIVERSE_SIZE;
        let free = fits;
        if (fits) {
          for (let a = addr; a < addr + size; a++) {
            if (arr[a]) {
              free = false;
              break;
            }
          }
        }
        if (free) {
          for (let a = addr; a < addr + size; a++) arr[a] = 1;
          placements.push({ profileId: row.profileId, name: `${row.namePrefix} ${i + 1}`, universe: uid, address: addr });
          addr += size;
          if (addr > DMX_UNIVERSE_SIZE) {
            idx++;
            addr = 1;
          }
          break;
        }
        addr++;
        if (addr + size - 1 > DMX_UNIVERSE_SIZE) {
          idx++;
          addr = 1;
        }
      }
    }
    cursorIdx = idx;
    cursorAddr = addr;
  }

  return { placements, newUniverseIds };
}
