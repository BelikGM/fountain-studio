import fs from 'node:fs';
import path from 'node:path';

/**
 * Отзыв офлайн-лицензии (§27 доработки, «Продукт»).
 *
 * Лицензия — подписанный файл, движок проверяет её без сети (см. license.ts).
 * Это осознанный выбор: объект может годами работать без интернета. Но из
 * этого следует, что отозвать лицензию НАПРЯМУЮ нельзя — файл с подписью не
 * перестанет быть подлинным. Поэтому отзыв сделан отдельным, необязательным
 * слоем поверх: издатель ведёт список отозванных ID компьютеров (см.
 * issue-license.ts revoke), публикует его как обычный JSON-файл по любому
 * URL, который сам выберет (Gist, свой сайт — не принципиально), а движок,
 * КОГДА у него есть интернет, этот список подтягивает и кэширует на диск.
 *
 * Из этого — два свойства, которые важно не сломать:
 *  1. Нет сети — работает последний известный список (или вообще ничего, если
 *     компьютер никогда не был в сети): отсутствие интернета никогда не
 *     превращается в отказ лицензии.
 *  2. Список подтягивается, только если издатель явно указал URL
 *     (revocationUrl в настройках программы) — без него слой полностью
 *     выключен, ничего никуда не стучится.
 */

const CACHE_FILE = 'revoked-cache.json';
/** Сеть может быть плохой (объект, спутниковый канал) — не подвешиваем старт. */
const FETCH_TIMEOUT_MS = 8000;

interface RevocationCache {
  revoked: string[];
  /** Когда список успешно обновлялся в последний раз — для диагностики. */
  fetchedAt: string;
}

function cacheFile(appDataDir: string): string {
  return path.join(appDataDir, CACHE_FILE);
}

function readCache(appDataDir: string): RevocationCache | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(appDataDir), 'utf8')) as Partial<RevocationCache>;
    return Array.isArray(raw.revoked) ? { revoked: raw.revoked.filter((x) => typeof x === 'string'), fetchedAt: raw.fetchedAt ?? '' } : null;
  } catch {
    return null;
  }
}

/** Отозван ли этот компьютер — по последнему успешно скачанному списку (если он вообще был). */
export function isMachineRevoked(appDataDir: string, machineId: string): boolean {
  return readCache(appDataDir)?.revoked.includes(machineId) ?? false;
}

/** Когда список в последний раз удалось обновить — для диагностики в интерфейсе. */
export function revocationCacheInfo(appDataDir: string): { checkedAt: string | null; count: number } {
  const c = readCache(appDataDir);
  return { checkedAt: c?.fetchedAt || null, count: c?.revoked.length ?? 0 };
}

/**
 * Скачивает список отозванных и обновляет кэш на диске.
 *
 * Ошибку (нет сети, сервер недоступен, битый JSON) не бросаем наружу —
 * вызывающий код зовёт это «на всякий случай» по таймеру, и разовая неудача
 * не должна ронять движок или засорять журнал тревогой: это ожидаемая
 * ситуация на объекте без интернета.
 */
export async function refreshRevocationList(appDataDir: string, url: string): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as unknown;
    const revoked = Array.isArray((data as { revoked?: unknown }).revoked)
      ? (data as { revoked: unknown[] }).revoked.filter((x): x is string => typeof x === 'string')
      : null;
    if (!revoked) return { ok: false, error: 'неверный формат списка (ожидался {"revoked": [...]})' };
    const cache: RevocationCache = { revoked, fetchedAt: new Date().toISOString() };
    fs.mkdirSync(appDataDir, { recursive: true });
    const tmp = `${cacheFile(appDataDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, cacheFile(appDataDir));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
