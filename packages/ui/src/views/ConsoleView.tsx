import { useEffect, useMemo, useState } from 'react';
import {
  DMX_UNIVERSE_SIZE,
  profileMap,
  type ChannelRole,
  type DeviceKind,
  type DeviceProfile,
  type TestPatternMode,
} from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';
import { Fader } from '../components/Fader';
import { hexToRgb } from '../colorPresets';

/** Варианты числа адресов на странице; 512 — вся вселенная одной лентой. */
const PAGE_SIZES = [16, 32, 64, 128, 256, DMX_UNIVERSE_SIZE];

const PATTERNS: { mode: TestPatternMode; label: string }[] = [
  { mode: 'off', label: 'Выкл' },
  { mode: 'sine', label: 'Синус' },
  { mode: 'chase', label: 'Бегущая' },
  { mode: 'ramp', label: 'Пила' },
  { mode: 'strobe', label: 'Строб' },
  { mode: 'stairs', label: 'Ступени' },
  { mode: 'random', label: 'Шум' },
];

const PATTERN_HINT: Record<TestPatternMode, string> = {
  off: 'Выключить тест-генератор: линия возвращается к обычному управлению (сцены и ручные фейдеры продолжают работать)',
  sine: 'Плавная волна яркости по всем каналам со сдвигом фазы',
  chase: 'Бегущий огонёк: группа из 8 соседних адресов пробегает всю вселенную по кругу — проверка порядка адресов',
  ramp: 'Пила: все каналы одновременно плавно растут 0→255 и резко сбрасываются',
  strobe: 'Строб: все каналы разом мигают 0/255 (2 Гц) — проверка синхронности отклика',
  stairs: 'Ступени по возрастанию адреса с медленным сдвигом — виден порядок адресации на глаз',
  random: 'Псевдослучайный шум по каналам — стресс-тест, наглядно видно «залипшие» адреса',
};

/** Только чистые цвета — по требованию §27 доработки: R/G/B, их полные комбинации, белый и чёрный. */
const PURE_COLOR_PRESETS: { name: string; hex: string }[] = [
  { name: 'Красный', hex: '#ff0000' },
  { name: 'Зелёный', hex: '#00ff00' },
  { name: 'Синий', hex: '#0000ff' },
  { name: 'Жёлтый', hex: '#ffff00' },
  { name: 'Пурпурный', hex: '#ff00ff' },
  { name: 'Голубой', hex: '#00ffff' },
  { name: 'Белый', hex: '#ffffff' },
  { name: 'Чёрный', hex: '#000000' },
];

const ROLE_FADER_CLASS: Partial<Record<ChannelRole, string>> = {
  red: 'fader-red',
  green: 'fader-green',
  blue: 'fader-blue',
  white: 'fader-white',
};

/** Цвет полосы/цифры фейдера по виду прибора и роли канала (§27 доработки). */
function classifyChannel(kind: DeviceKind, role: ChannelRole): string {
  if (kind === 'pump') return 'fader-pump';
  if (kind === 'valve') return 'fader-valve';
  if (kind === 'lamp') return ROLE_FADER_CLASS[role] ?? 'fader-lamp';
  return 'fader-other';
}

/** Консоль прямого управления: фейдеры адресов, тест-генераторы, СТОП. */
export function ConsoleView({ engine }: { engine: EngineConnection }) {
  const { project, universes, stats, frames, playback, windState, send } = engine;
  const [universeId, setUniverseId] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState(32);
  const [page, setPage] = useState(0);
  const [customColor, setCustomColor] = useState<string | null>(null);

  const profiles = useMemo(
    () => (project ? profileMap(project) : new Map<string, DeviceProfile>()),
    [project],
  );

  // Пульт — экран наладки: если идёт воспроизведение (шоу по расписанию,
  // плейлист на публике), случайное нажатие СТОП не должно гасить фонтан
  // молча — сначала подтверждение с перечислением того, что остановится.
  const doBlackout = (): void => {
    const running: string[] = [];
    if (playback.show !== null) running.push('шоу');
    if (playback.playlist !== null) running.push('плейлист');
    if (playback.activeSceneId !== null) running.push('сцена');
    if (playback.running.length > 0) running.push(`секвенсоры (${playback.running.length})`);
    if (running.length > 0) {
      const ok = window.confirm(
        `Сейчас идёт воспроизведение: ${running.join(', ')}.\n\n` +
          'СТОП принудительно остановит ВСЁ и погасит все каналы всех вселенных.\n' +
          'Продолжить?',
      );
      if (!ok) return;
    }
    send({ type: 'blackout' });
  };

  // Пауза — в отличие от СТОП не гасит в 0, а замораживает текущую картину
  // (свет и воду) и таймеры воспроизведения; повторное нажатие продолжает с
  // того же места. Без подтверждения — действие безопасно обратимо.
  const togglePause = (): void => {
    send({ type: playback.pausedAll ? 'resumeAll' : 'pauseAll' });
  };

  // Массовое управление по типу прибора (§27 доработки, по примеру прежнего
  // приложения — «все насосы/клапаны/светильники разом», для пусконаладки).
  // Пишет во все подходящие адреса каналами setChannel — тот же путь, что и
  // обычный фейдер, просто циклом по устройствам нужного вида.
  const setAllOfKind = (kind: DeviceKind, roles: Partial<Record<string, number>>): void => {
    if (!project) return;
    for (const d of project.devices) {
      const profile = profiles.get(d.profileId);
      if (!profile || profile.kind !== kind) continue;
      profile.channels.forEach((c, i) => {
        const v = roles[c.role];
        if (v !== undefined) send({ type: 'setChannel', universe: d.universe, channel: d.address + i, value: v });
      });
    }
  };

  // Текущее агрегатное состояние клапанов — открыт кнопкой-тогглом, только
  // когда ВСЕ клапаны патча сейчас открыты (>= 128 на реальном выходе).
  const valveState = useMemo(() => {
    if (!project) return { has: false, allOpen: false };
    let has = false;
    let allOpen = true;
    for (const d of project.devices) {
      const profile = profiles.get(d.profileId);
      if (!profile || profile.kind !== 'valve') continue;
      const ci = profile.channels.findIndex((c) => c.role === 'open');
      if (ci < 0) continue;
      has = true;
      if ((frames[d.universe]?.[d.address - 1 + ci] ?? 0) < 128) allOpen = false;
    }
    return { has, allOpen: has && allOpen };
  }, [project, profiles, frames]);

  // При первом hello выбираем первую вселенную.
  useEffect(() => {
    if (universes.length > 0 && (universeId === null || !universes.some((u) => u.id === universeId))) {
      setUniverseId(universes[0]!.id);
    }
  }, [universes, universeId]);

  // адрес-1 → «Имя прибора · Канал» + цвет по роли (для фейдера).
  const owners = useMemo(() => {
    const map = new Map<number, { label: string; roleClass: string }>();
    if (!project || universeId === null) return map;
    for (const d of project.devices) {
      if (d.universe !== universeId) continue;
      const profile = profiles.get(d.profileId);
      if (!profile) continue;
      for (let k = 0; k < profile.channels.length; k++) {
        const idx = d.address - 1 + k;
        if (idx >= 0 && idx < DMX_UNIVERSE_SIZE) {
          map.set(idx, {
            label: `${d.name} · ${profile.channels[k]!.name}`,
            roleClass: classifyChannel(profile.kind, profile.channels[k]!.role),
          });
        }
      }
    }
    return map;
  }, [project, universeId, profiles]);

  // «Только занятые» — не показывать пустые адреса (обычно используется малая
  // часть из 512). Включено по умолчанию; если приборов нет — показываем все.
  // Состояние общее на все вселенные намеренно: переключение вселенной не
  // должно сбрасывать фильтр — только пересчитать список под неё.
  const [onlyUsed, setOnlyUsed] = useState(true);
  const usedChannels = useMemo(() => [...owners.keys()].sort((a, b) => a - b), [owners]);
  const filterActive = onlyUsed && usedChannels.length > 0;

  const frame = universeId !== null ? frames[universeId] : undefined;
  const pattern = stats?.pattern ?? 'off';
  const pageCount = Math.ceil(DMX_UNIVERSE_SIZE / pageSize);

  const changePageSize = (size: number): void => {
    // Сохраняем первый видимый адрес, чтобы страница «не уезжала» при смене размера.
    const startAddr = page * pageSize;
    setPageSize(size);
    setPage(Math.floor(startAddr / size));
  };

  return (
    <>
      <div className="toolbar">
        <div className="group">
          {universes.map((u) => (
            <button
              key={u.id}
              className={u.id === universeId ? 'btn active' : 'btn'}
              title={u.outputs.join('\n')}
              onClick={() => setUniverseId(u.id)}
            >
              {u.label}
            </button>
          ))}
        </div>

        <div className="group">
          <label className="field" title="Показывать только адреса, занятые приборами из патча — без пустых">
            <input
              type="checkbox"
              checked={onlyUsed}
              disabled={usedChannels.length === 0}
              onChange={(e) => setOnlyUsed(e.target.checked)}
            />{' '}
            только занятые{usedChannels.length === 0 ? ' (нет приборов)' : ` (${usedChannels.length})`}
          </label>
          <label
            className={filterActive ? 'dim' : undefined}
            title={filterActive ? 'Не влияет, пока включён фильтр «только занятые» — настройка сохраняется' : undefined}
          >
            По:{' '}
            <select disabled={filterActive} value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))}>
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {pageCount > 1 && (
            <label
              className={filterActive ? 'dim' : undefined}
              title={filterActive ? 'Не влияет, пока включён фильтр «только занятые» — настройка сохраняется' : undefined}
            >
              Адреса:{' '}
              <select disabled={filterActive} value={page} onChange={(e) => setPage(Number(e.target.value))}>
                {Array.from({ length: pageCount }, (_, p) => (
                  <option key={p} value={p}>
                    {p * pageSize + 1}–{Math.min(DMX_UNIVERSE_SIZE, (p + 1) * pageSize)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="group">
          <span className="group-label">Тест-генератор:</span>
          {PATTERNS.map((p) => (
            <button
              key={p.mode}
              className={
                pattern === p.mode ? (p.mode === 'off' ? 'btn btn-off-active' : 'btn active') : 'btn'
              }
              title={PATTERN_HINT[p.mode]}
              onClick={() => send({ type: 'testPattern', mode: p.mode })}
            >
              {p.label}
            </button>
          ))}
        </div>

        {project?.windLimit.enabled && (
          <div className="group">
            <label
              className="field"
              title="Ручной ввод — пока нет датчика по Modbus/MQTT. Пороги настраиваются на вкладке «Настройки»"
            >
              Ветер, м/с:{' '}
              <input
                className="input input-num"
                type="number"
                min={0}
                step={0.5}
                value={windState?.speedMs ?? ''}
                placeholder="—"
                onChange={(e) => {
                  const v = e.target.value.trim();
                  send({ type: 'setWindSpeed', speedMs: v === '' ? null : Number(v) });
                }}
              />
            </label>
            {windState && windState.limitPercent < 100 && (
              <span className="warn">⚠ струи ограничены до {windState.limitPercent}%</span>
            )}
          </div>
        )}

        <span className="spacer" />

        <div className="group">
          <button
            className={playback.pausedAll ? 'btn active' : 'btn btn-warn'}
            title={
              playback.pausedAll
                ? 'Продолжить: снять паузу и вернуть воспроизведение с той же точки'
                : 'Пауза: заморозить текущую картину света и воды как есть, без гашения в 0. Таймеры шоу/секвенсоров останавливаются до повторного нажатия'
            }
            onClick={togglePause}
          >
            {playback.pausedAll ? '▶ Продолжить' : '⏸ Пауза'}
          </button>
        </div>
        <button
          className="btn btn-danger btn-blackout"
          title="Полная остановка: гасит ВСЕ каналы всех вселенных и останавливает всё воспроизведение — сцены, секвенсоры, шоу, плейлист. Если сейчас что-то играет, сначала спросит подтверждения. Используйте в нештатной ситуации."
          onClick={doBlackout}
        >
          ■ СТОП
        </button>
      </div>

      <div className="quick-controls">
        <div className="quick-controls-title" title="Пишет сразу во все приборы этого вида из патча — для пусконаладки">
          Все приборы по типу
        </div>

        <div className="quick-row">
          <span className="quick-row-label">Свет:</span>
          <div className="color-presets">
            {PURE_COLOR_PRESETS.map((p) => (
              <button
                key={p.hex}
                type="button"
                className="color-swatch"
                style={{ background: p.hex }}
                title={p.name}
                onClick={() => {
                  const [r, g, b] = hexToRgb(p.hex);
                  setAllOfKind('lamp', { red: r, green: g, blue: b });
                }}
              />
            ))}
            <label
              className="color-swatch color-swatch-custom"
              style={customColor ? { background: customColor } : undefined}
              title="Свой цвет — нажмите, чтобы выбрать"
            >
              <input
                type="color"
                value={customColor ?? '#000000'}
                onChange={(e) => {
                  setCustomColor(e.target.value);
                  const [r, g, b] = hexToRgb(e.target.value);
                  setAllOfKind('lamp', { red: r, green: g, blue: b });
                }}
              />
            </label>
          </div>
        </div>

        <hr className="quick-divider" />

        <div className="quick-row">
          <span className="quick-row-label">Насосы:</span>
          <input
            type="range"
            min={0}
            max={255}
            defaultValue={0}
            onChange={(e) => setAllOfKind('pump', { intensity: Number(e.target.value) })}
          />
        </div>

        <hr className="quick-divider" />

        <div className="quick-row">
          <span className="quick-row-label">Клапана:</span>
          <button
            className={valveState.allOpen ? 'btn toggle-open' : 'btn toggle-closed'}
            disabled={!valveState.has}
            onClick={() => setAllOfKind('valve', { open: valveState.allOpen ? 0 : 255 })}
          >
            {valveState.allOpen ? 'ОТКРЫТЫ' : 'ЗАКРЫТЫ'}
          </button>
        </div>
      </div>

      <main className="faders">
        {(filterActive
          ? usedChannels.map((idx) => idx + 1)
          : Array.from(
              { length: Math.min(pageSize, DMX_UNIVERSE_SIZE - page * pageSize) },
              (_, i) => page * pageSize + i + 1,
            )
        ).map((channel) => (
          <Fader
            key={`${universeId}-${channel}`}
            channel={channel}
            value={frame?.[channel - 1] ?? 0}
            owner={owners.get(channel - 1)?.label}
            roleClass={owners.get(channel - 1)?.roleClass}
            onChange={(value) =>
              universeId !== null && send({ type: 'setChannel', universe: universeId, channel, value })
            }
          />
        ))}
      </main>
    </>
  );
}
