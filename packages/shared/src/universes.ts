/**
 * Вселенные DMX: как их называть на экране, какой делать новую и как описать
 * человеку, что изменилось.
 *
 * ── Откуда взялся этот файл ──────────────────────────────────────────────
 * 22.09.2026 заказчик добавил вторую вселенную в «Настройках», ушёл на «Поток»
 * и в привязку приборов — и не нашёл её нигде: там были только «1» и «Все», а
 * в «Оборудовании» — «Линия 1». Вопросы были ровно такие: «Линия 1 — это первая
 * вселенная или что?» и «почему при добавлении вселенной она не появляется
 * везде, где есть выбор?».
 *
 * Причин было три, и все три тут:
 *  · одно и то же называлось по-разному — «вселенная» в настройках, «Линия N»
 *    в выпадающих списках, просто «1» в кнопках. Теперь название одно и
 *    строится в одном месте (universeTitle);
 *  · новую вселенную заводили в двух местах по-разному: в настройках — «как
 *    предыдущая», в мастере объекта — всегда Art-Net на 127.0.0.1. Теперь один
 *    рецепт (nextUniverse);
 *  · неприменённая правка нигде, кроме самой таблицы, не была видна.
 *    describeLinesChange даёт короткое «что изменилось» для плашки, которая
 *    висит на всех вкладках, пока правка не применена.
 */

import type { ConfigOutput, ConfigUniverse } from './messages';

/**
 * Имя, которое программа сама давала вселенной раньше: «Линия 3» у третьей,
 * «Вселенная 3» у третьей. Такое имя ничего не добавляет к номеру, и
 * показывать его рядом с номером — значит писать одно и то же дважды.
 *
 * Номер в имени должен СОВПАДАТЬ с номером вселенной: «Линия 3» у второй
 * вселенной — уже осмысленное имя (например, так подписан кабель на объекте),
 * и его надо показывать.
 */
function isAutoLabel(id: number, label: string): boolean {
  const m = /^\s*(?:линия|вселенная)\s*(\d+)\s*$/i.exec(label);
  return m !== null && Number(m[1]) === id;
}

/** Своё имя вселенной, если человек его дал; null — имени нет, только номер. */
export function universeCustomName(u: { id: number; label?: string | null }): string | null {
  const label = (u.label ?? '').trim();
  if (label === '' || isAutoLabel(u.id, label)) return null;
  return label;
}

/**
 * Как вселенная называется на экране — везде одинаково: «Вселенная 2» или
 * «Вселенная 2 · Северная чаша», если человек дал ей имя. Номер есть всегда:
 * по нему прибор привязан к вселенной, и по нему её ищут в других вкладках.
 */
export function universeTitle(u: { id: number; label?: string | null }): string {
  const name = universeCustomName(u);
  return name ? `Вселенная ${u.id} · ${name}` : `Вселенная ${u.id}`;
}

/**
 * Коротко — для кнопок, перед которыми уже написано «Вселенная:»: «2» или
 * «2 · Северная чаша». Полное название уходит в подсказку кнопки.
 */
export function universeShort(u: { id: number; label?: string | null }): string {
  const name = universeCustomName(u);
  return name ? `${u.id} · ${name}` : String(u.id);
}

/**
 * Какое имя хранить. Имя, которое программа дала сама («Линия 2» у второй),
 * хранить незачем: оно только расходится с тем, что написано на экране.
 * Пустая строка — «имени нет».
 */
export function storedUniverseLabel(u: { id: number; label?: string | null }): string {
  const label = (u.label ?? '').trim();
  // Выбрасываем только «Линия N» — так вселенные называла сама программа в
  // старых версиях. «Вселенная 1», вписанную человеком, храним как есть:
  // раньше она стиралась, и поле имени очищалось прямо под пальцами
  // (заказчик 24.09.2026: «пишу "Вселенная", жму 1 — поле пустое»).
  return /^линия\s*\d+$/i.test(label) && isAutoLabel(u.id, label) ? '' : label;
}

/**
 * Выход одной строкой — чтобы сравнивать «тот же ли это выход», не завися от
 * порядка полей в объекте. Порядок полей у сохранённого файла и у свежей правки
 * разный, и простое JSON.stringify считало бы одинаковые выходы разными.
 */
export function outputKey(o: ConfigOutput): string {
  return [
    o.type,
    o.host ?? '',
    o.port ?? '',
    o.universe,
    o.broadcast ? 'b' : '',
    o.priority ?? '',
    o.path ?? '',
    o.baudRate ?? '',
    o.musidoraOut ?? '',
  ].join('|');
}

/** Одинаковы ли выходы вселенной: тогда при применении её не надо трогать вовсе. */
export function sameOutputs(a: ConfigOutput[], b: ConfigOutput[]): boolean {
  return a.length === b.length && a.every((o, i) => outputKey(o) === outputKey(b[i]!));
}

/**
 * Новая вселенная — такая же, как последняя.
 *
 * На объекте все вселенные обычно идут через одно и то же железо, и
 * заставлять переключать протокол у каждой — лишняя работа и лишний шанс
 * ошибиться. У интерфейса FountanPlay подставляется следующий разъём (их не
 * больше трёх), у Art-Net и sACN — следующий номер в протоколе.
 *
 * Если вселенных ещё нет вовсе — интерфейс FountanPlay: это то железо, что
 * стоит на объектах заказчика.
 */
export function nextUniverse(existing: ConfigUniverse[], id?: number): ConfigUniverse {
  const newId = id ?? Math.max(0, ...existing.map((u) => u.id)) + 1;
  const prev = existing[existing.length - 1]?.outputs[0];
  let out: ConfigOutput;
  if (prev?.type === 'musidora') {
    out = { type: 'musidora', universe: 0, path: prev.path ?? '', musidoraOut: Math.min(3, (prev.musidoraOut ?? 1) + 1) };
  } else if (prev?.type === 'artnet') {
    out = { type: 'artnet', host: prev.host ?? '127.0.0.1', universe: prev.universe + 1 };
    if (prev.broadcast) out.broadcast = true;
  } else if (prev?.type === 'sacn') {
    out = { type: 'sacn', universe: prev.universe + 1 };
    if (prev.host) out.host = prev.host;
  } else if (prev?.type === 'usb-dmx' || prev?.type === 'open-dmx') {
    // У USB-адаптера одна линия на коробку: вторая вселенная — это второй
    // адаптер, и его порт человек впишет сам. Угадывать порт нельзя.
    out = { type: prev.type, universe: 0, path: '' };
  } else {
    out = { type: 'musidora', universe: 0, path: '', musidoraOut: 1 };
  }
  return { id: newId, label: '', outputs: [out] };
}

/** Как называется протокол выхода на экране. */
function outputLabel(o: ConfigOutput | undefined): string {
  if (!o) return 'без выхода';
  switch (o.type) {
    case 'musidora':
      return `FountanPlay, выход ${o.musidoraOut ?? 1}`;
    case 'artnet':
      return `Art-Net${o.host ? ' ' + o.host : ''} №${o.universe}`;
    case 'sacn':
      return `sACN №${o.universe}`;
    case 'usb-dmx':
      return `ENTTEC PRO ${o.path || '(порт не задан)'}`;
    case 'open-dmx':
      return `Open DMX ${o.path || '(порт не задан)'}`;
    default:
      return 'выход';
  }
}

/** «вселенная 2» или «вселенная 2 «Северная чаша»» — внутри фразы, имя без изменения регистра. */
function lower(u: { id: number; label?: string | null }): string {
  const name = universeCustomName(u);
  return name ? `вселенная ${u.id} «${name}»` : `вселенная ${u.id}`;
}

export interface LinesConfig {
  tickMs: number;
  universes: ConfigUniverse[];
}

/**
 * Что изменилось между тем, что работает, и правкой — короткими фразами для
 * человека: «добавлена вселенная 2 (FountanPlay, выход 2)», «убрана вселенная
 * 3», «вселенная 1: выход изменён», «такт 50 → 40 мс». Пустой список — правка
 * совпадает с тем, что работает, и применять нечего.
 */
export function describeLinesChange(before: LinesConfig, after: LinesConfig): string[] {
  const out: string[] = [];
  const was = new Map(before.universes.map((u) => [u.id, u]));
  const now = new Map(after.universes.map((u) => [u.id, u]));
  for (const u of after.universes) {
    const old = was.get(u.id);
    if (!old) {
      out.push(`добавлена ${lower(u)} (${outputLabel(u.outputs[0])})`);
      continue;
    }
    if (!sameOutputs(old.outputs, u.outputs)) {
      out.push(`${lower(u)}: выход ${outputLabel(old.outputs[0])} → ${outputLabel(u.outputs[0])}`);
    }
    if (storedUniverseLabel(old) !== storedUniverseLabel(u)) {
      const name = universeCustomName(u);
      out.push(name ? `вселенная ${u.id} названа «${name}»` : `у вселенной ${u.id} убрано имя`);
    }
  }
  for (const u of before.universes) {
    if (!now.has(u.id)) out.push(`убрана ${lower(u)}`);
  }
  if (before.tickMs !== after.tickMs) out.push(`такт ${before.tickMs} → ${after.tickMs} мс`);
  return out;
}
