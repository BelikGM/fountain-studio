/**
 * Незавершённая правка вселенных и такта — одна на всё приложение.
 *
 * ── От какой грабли это спасает ───────────────────────────────────────────
 * Заказчик добавил вселенную в «Настройках», ушёл на «Поток» посмотреть, как
 * между ними переключаться, вернулся — вселенной нет. Причина: правка жила в
 * состоянии самой вкладки, а вкладки в приложении не прячутся, а размонтируются
 * целиком. Уход с вкладки молча стирал черновик.
 *
 * Это починили (21.09), и сразу вылезла вторая половина той же беды: черновик
 * пережил уход, но на «Потоке» и в привязке приборов вселенной всё равно не
 * было — она не применена, и знала о ней только таблица в «Настройках», а
 * кнопка «Применить» стояла ниже трёх других панелей. Поэтому черновик теперь
 * виден ОТОВСЮДУ: пока он есть, на всех вкладках висит плашка «правки не
 * применены» с кнопкой «Применить» (см. LinesDraftBanner).
 *
 * Лечить предупреждением «вы точно хотите уйти?» неправильно: ходить между
 * вкладками во время настройки — нормально, как раз чтобы посмотреть результат.
 *
 * Именно в памяти, а не в localStorage: это НЕЗАВЕРШЁННАЯ правка. Пережить
 * перезапуск программы она не должна — иначе после перезагрузки человек увидит
 * вселенные, которых в движке нет, и не поймёт, почему фонтан молчит.
 *
 * ── «Применено» — только по ответу движка ────────────────────────────────
 * Раньше редактор писал «✔ применено и сохранено» сразу по нажатию. Если связи
 * в этот момент не было (движок перезапускался) или движок правку отклонил,
 * человек видел галочку, а вселенной не было нигде. Теперь черновик стирается
 * только тогда, когда движок ответил «применено»; отказ показывается его же
 * словами, и черновик остаётся — ничего не пропадает.
 */

import { useSyncExternalStore } from 'react';
import type { ClientMessage, ConfigUniverse } from '@fountain-studio/shared';

export interface SettingsDraft {
  tickMs: number;
  universes: ConfigUniverse[];
}

export interface DraftState {
  draft: SettingsDraft | null;
  /** idle — правится; pending — ушло в движок, ждём ответа; applied/error — ответ. */
  status: 'idle' | 'pending' | 'applied' | 'error';
  /** Ответ движка или причина, почему не применено. */
  message: string;
  /** Что именно поменялось — из ответа движка. */
  changes: string[];
}

/**
 * Сколько ждём ответа движка. Применение на ходу занимает миллисекунды; если
 * ответа нет за это время — связи нет, и честнее сказать об этом, чем крутить
 * «применяю…» бесконечно.
 */
const REPLY_TIMEOUT_MS = 5000;

let state: DraftState = { draft: null, status: 'idle', message: '', changes: [] };
const listeners = new Set<() => void>();
let replyTimer: ReturnType<typeof setTimeout> | null = null;

function set(next: DraftState): void {
  state = next;
  for (const l of listeners) l();
}

function copy(d: SettingsDraft): SettingsDraft {
  return {
    tickMs: d.tickMs,
    universes: d.universes.map((u) => ({ ...u, outputs: u.outputs.map((o) => ({ ...o })) })),
  };
}

/** Запомнить незавершённую правку (вызывается на каждое изменение). */
export function keepSettingsDraft(next: SettingsDraft): void {
  set({ draft: copy(next), status: 'idle', message: '', changes: [] });
}

/** Текущая правка; null — правок нет. */
export function takeSettingsDraft(): SettingsDraft | null {
  return state.draft;
}

/** Отказаться от правки — вернуться к тому, что работает в движке. */
export function clearSettingsDraft(): void {
  if (replyTimer) clearTimeout(replyTimer);
  replyTimer = null;
  set({ draft: null, status: 'idle', message: '', changes: [] });
}

/**
 * Отправить правку в движок. Черновик НЕ стирается: это сделает ответ
 * «применено» (см. onConfigResult). Нет связи — говорим сразу.
 */
export function applySettingsDraft(send: (msg: ClientMessage) => void, connected: boolean): void {
  const d = state.draft;
  if (!d) return;
  if (!connected) {
    set({
      ...state,
      status: 'error',
      message: 'Нет связи с движком — правки не применены. Они сохранены здесь: нажмите «Применить», когда связь появится.',
      changes: [],
    });
    return;
  }
  set({ ...state, status: 'pending', message: '', changes: [] });
  send({ type: 'updateConfig', tickMs: d.tickMs, universes: d.universes });
  if (replyTimer) clearTimeout(replyTimer);
  replyTimer = setTimeout(() => {
    replyTimer = null;
    if (state.status !== 'pending') return;
    set({
      ...state,
      status: 'error',
      message: 'Движок не ответил — неизвестно, применились ли правки. Они сохранены здесь: проверьте связь и нажмите «Применить» ещё раз.',
    });
  }, REPLY_TIMEOUT_MS);
}

/** Ответ движка на применение (сообщение configResult). */
export function onConfigResult(ok: boolean, message: string, changes: string[]): void {
  // Отвечают тому, кто отправлял; черновика нет — значит, это не наш ответ,
  // и трогать нечего. Поздний ответ после «движок не ответил» — наш: принимаем.
  // А если человек успел поправить что-то ещё, пока шёл ответ (status снова
  // idle), — новую правку не стираем: она ещё не отправлена.
  if (!state.draft || state.status === 'idle') return;
  if (replyTimer) clearTimeout(replyTimer);
  replyTimer = null;
  if (ok) set({ draft: null, status: 'applied', message, changes });
  else set({ ...state, status: 'error', message, changes: [] });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Правка и её судьба — для «Настроек» и для плашки на остальных вкладках. */
export function useSettingsDraft(): DraftState {
  return useSyncExternalStore(subscribe, () => state);
}
