import { useEffect, useMemo, useState } from 'react';
import {
  DMX_MAX_VALUE,
  DMX_UNIVERSE_SIZE,
  DEFAULT_PATTERN_SPEED_SEC,
  STEP_PATTERNS,
  profileMap,
  type ChannelRole,
  type DeviceKind,
  type DeviceProfile,
  type TestPatternMode,
  type TestPatternScope,
} from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';
import { Fader } from '../components/Fader';
import { PauseIcon, PlayIcon, StopIcon } from '../components/Icons';
import { askConfirm } from '../components/ConfirmDialog';
import { noteManual } from '../manualActivity';
import { hexToRgb } from '../colorPresets';

/** Варианты числа адресов на странице; 512 — вся вселенная одной лентой. */
const PAGE_SIZES = [16, 32, 64, 128, 256, DMX_UNIVERSE_SIZE];

const PATTERNS: { mode: TestPatternMode; label: string }[] = [
  { mode: 'off', label: 'Выкл' },
  { mode: 'sine', label: 'Синус' },
  { mode: 'chase', label: 'Бегущая' },
  { mode: 'ramp', label: 'Подъём' },
  { mode: 'strobe', label: 'Строб' },
  { mode: 'stairs', label: 'Ступени' },
  { mode: 'oddeven', label: 'Чёт/нечёт' },
  { mode: 'solo', label: 'По очереди' },
];

/** Область применения генератора (§27 доработки) — см. TestPatternScope. */
const SCOPES: { scope: TestPatternScope; label: string }[] = [
  { scope: 'all', label: 'Всё' },
  { scope: 'pump', label: 'Насосы' },
  { scope: 'valve', label: 'Клапаны' },
  { scope: 'lamp', label: 'Свет' },
];

const PATTERN_HINT: Record<TestPatternMode, string> = {
  off: 'Выключить тест-генератор: линия возвращается к обычному управлению (сцены и ручные фейдеры продолжают работать)',
  sine: 'Плавная волна яркости со сдвигом фазы по приборам. Период — поле справа',
  chase: 'Бегущий огонёк: группа из 8 приборов подряд пробегает по кругу — проверка порядка адресов. Шаг — поле справа',
  ramp: 'Подъём: все приборы одновременно плавно растут 0→255 за период и сбрасываются. Видно, при каком значении насос трогается с места — это и есть min для калибровки. Клапаны открыты всё время, иначе нижней половины хода не увидеть',
  strobe: 'Строб: все каналы разом мигают 0/255 — проверка синхронности отклика. Период — поле справа',
  stairs:
    'Статичная лестница: первый прибор 0, последний 255, значение растёт строго по адресу — порядок адресации виден целиком и сразу. Картина неподвижна, темп ей не нужен. Клапаны открыты всё время',
  oddeven:
    'Приборы через одного, смена каждый шаг. Перепутанные местами или сдвинутые на единицу адреса видно сразу — «шахматка» ломается',
  solo: 'По одному прибору за раз, по порядку адресов — обход линии без беготни к щиту и без второго человека. Сколько держать каждый — поле справа',
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
  /** Область применения тест-генератора — местная, движку уходит вместе с режимом. */
  const [scope, setScope] = useState<TestPatternScope>('all');
  /** Темп текущего режима: шаг для шаговых, период для циклических. Хранится и уходит движку в секундах. */
  const [speedSec, setSpeedSec] = useState<number>(DEFAULT_PATTERN_SPEED_SEC.off);

  const profiles = useMemo(
    () => (project ? profileMap(project) : new Map<string, DeviceProfile>()),
    [project],
  );

  // Отладка — экран наладки: если идёт воспроизведение (шоу по расписанию,
  // плейлист на публике), случайное нажатие СТОП не должно гасить фонтан
  // молча — сначала подтверждение с перечислением того, что остановится.
  const doBlackout = async (): Promise<void> => {
    const running: string[] = [];
    if (playback.show !== null) running.push('шоу');
    if (playback.playlist !== null) running.push('плейлист');
    if (playback.activeSceneId !== null) running.push('сцена');
    if (playback.running.length > 0) running.push(`секвенсоры (${playback.running.length})`);
    if (running.length > 0) {
      const ok = await askConfirm('Остановить всё и погасить линию?', {
        detail: `Сейчас идёт воспроизведение: ${running.join(', ')}. СТОП остановит его и погасит все каналы всех вселенных.`,
        okLabel: 'СТОП',
      });
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

  // Есть ли в патче клапаны вообще — только чтобы не показывать мёртвую кнопку.
  // Раньше здесь ещё считалось «все ли клапаны сейчас открыты» по живым кадрам,
  // и подпись кнопки прыгала ОТКРЫТЫ/ЗАКРЫТЫ на каждом кадре тест-генератора:
  // кнопка выглядела индикатором, хотя это команда. Состояние линии показывают
  // сами фейдеры, кнопке оно не нужно.
  const hasValves = useMemo(() => {
    if (!project) return false;
    return project.devices.some((d) => {
      const profile = profiles.get(d.profileId);
      return !!profile && profile.kind === 'valve' && profile.channels.some((c) => c.role === 'open');
    });
  }, [project, profiles]);

  // Что сделает следующее нажатие. Это НЕ состояние линии: сцена, шоу или
  // тест-генератор могут двигать клапаны сами, и подстраиваться под них
  // кнопка-команда не должна — иначе снова начнёт прыгать.
  const [valveNextOpen, setValveNextOpen] = useState(true);

  // При первом hello выбираем первую вселенную.
  useEffect(() => {
    if (universes.length > 0 && (universeId === null || !universes.some((u) => u.id === universeId))) {
      setUniverseId(universes[0]!.id);
    }
  }, [universes, universeId]);

  // адрес-1 → «Имя прибора · Канал» + цвет по роли (для фейдера).
  const owners = useMemo(() => {
    const map = new Map<number, { label: string; roleClass: string; twoState: boolean }>();
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
            twoState: profile.twoState === true,
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
  // Единица показа. «Бегущая» живёт в сотых долях секунды — «0.1 с» читается
  // хуже, чем «100 мс», и требует возни с дробями в поле. Остальные режимы
  // считаются секундами. В движок в любом случае уходят секунды.
  const unit =
    pattern === 'chase'
      ? { label: 'мс', factor: 1000, min: 10, step: 10 }
      : { label: 'сек', factor: 1, min: 0.1, step: 0.5 };
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
              data-hint={u.outputs.join('\n')}
              onClick={() => setUniverseId(u.id)}
            >
              {u.label}
            </button>
          ))}
        </div>

        <div className="group">
          <label className="field" data-hint="Показывать только адреса, занятые приборами из патча — без пустых">
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
            data-hint={filterActive ? 'Не влияет, пока включён фильтр «только занятые» — настройка сохраняется' : undefined}
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
              data-hint={filterActive ? 'Не влияет, пока включён фильтр «только занятые» — настройка сохраняется' : undefined}
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
          <span className="group-label">Генератор:</span>
          <select
            value={scope}
            data-hint="К чему применять генератор. «Всё» подменяет собой весь кадр вселенной; остальные варианты трогают только приборы выбранного вида, а прочие продолжают играть сцену или шоу"
            onChange={(e) => {
              const next = e.target.value as TestPatternScope;
              setScope(next);
              // Генератор уже идёт — переключаем область на лету, не выключая.
              if (pattern !== 'off') send({ type: 'testPattern', mode: pattern, scope: next });
            }}
          >
            {SCOPES.map((s) => (
              <option key={s.scope} value={s.scope}>
                {s.label}
              </option>
            ))}
          </select>
          {/* Режимы списком, а не рядом кнопок: их стало девять, и кнопками
              они переносили строку — «Пауза» и «СТОП» уезжали на второй ряд. */}
          <select
            value={pattern}
            data-hint={PATTERN_HINT[pattern]}
            onChange={(e) => {
              const mode = e.target.value as TestPatternMode;
              const sec = DEFAULT_PATTERN_SPEED_SEC[mode];
              setSpeedSec(sec);
              send({ type: 'testPattern', mode, scope, speedSec: sec });
            }}
          >
            {PATTERNS.map((p) => (
              <option key={p.mode} value={p.mode}>
                {p.label}
              </option>
            ))}
          </select>
          <label
            className="field"
            data-hint={
              STEP_PATTERNS.includes(pattern)
                ? `Время одного шага: сколько держится каждый прибор перед переходом к следующему (${unit.label})`
                : `Длительность полного цикла генератора (${unit.label})`
            }
          >
            {STEP_PATTERNS.includes(pattern) ? 'шаг' : 'период'}
            <input
              className="input input-num input-speed"
              type="number"
              min={unit.min}
              step={unit.step}
              disabled={pattern === 'off' || pattern === 'stairs'}
              value={Math.round(speedSec * unit.factor * 1000) / 1000}
              onChange={(e) => {
                const shown = Number(e.target.value);
                const sec = shown / unit.factor;
                setSpeedSec(sec);
                if (pattern !== 'off' && sec > 0) send({ type: 'testPattern', mode: pattern, scope, speedSec: sec });
              }}
            />
            <span className="unit">{unit.label}</span>
          </label>
        </div>

        {project?.windLimit.enabled && (
          <div className="group">
            <label
              className="field"
              data-hint="Ручной ввод — пока нет датчика по Modbus/MQTT. Пороги настраиваются на вкладке «Настройки»"
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
          </div>
        )}
        {/*
          Состояние ветра — ОТДЕЛЬНОЙ группой, а не рядом с полем ввода: внутри
          группы перенос строки не делается, и длинная подпись выдавила бы
          панель за край окна. Между группами панель переносится сама.

          Три состояния, и путать их нельзя. Ветер введён, но коррекция ещё не
          началась — идёт выдержка: без этой подписи оператор решил бы, что
          ограничение не работает.
        */}
        {project?.windLimit.enabled && windState && (
          <div className="group">
            {windState.limitPercent < 100 && (
              <span className="warn">
                ⚠ струи ограничены до {windState.limitPercent}%
                {windState.calcSpeedMs !== null ? ` (расчётные ${windState.calcSpeedMs.toFixed(1)} м/с)` : ''}
              </span>
            )}
            {!windState.correcting &&
              windState.speedMs !== null &&
              windState.speedMs >= windState.config.deadbandSpeed && (
                <span className="dim">⏳ ждём {windState.config.activateHoldSec} с подряд — потом снизим</span>
              )}
            {windState.speedMs !== null && windState.speedMs < windState.config.deadbandSpeed && (
              <span className="dim">ниже порога {windState.config.deadbandSpeed} м/с — не реагируем</span>
            )}
          </div>
        )}

        <span className="spacer" />

        <div className="group">
          <button
            className={playback.pausedAll ? 'btn btn-icon active' : 'btn btn-icon btn-warn'}
            data-hint={
              playback.pausedAll
                ? 'Продолжить: снять паузу и вернуть воспроизведение с той же точки'
                : 'Пауза: заморозить текущую картину света и воды как есть, без гашения в 0. Таймеры шоу/секвенсоров останавливаются до повторного нажатия'
            }
            onClick={togglePause}
          >
            {playback.pausedAll ? (
              <>
                <PlayIcon />
                Продолжить
              </>
            ) : (
              <>
                <PauseIcon />
                Пауза
              </>
            )}
          </button>
        </div>
        <button
          className="btn btn-icon btn-danger btn-blackout"
          data-hint="Полная остановка: гасит ВСЕ каналы всех вселенных и останавливает всё воспроизведение — сцены, секвенсоры, шоу, плейлист. Если сейчас что-то играет, сначала спросит подтверждения. Используйте в нештатной ситуации."
          onClick={() => void doBlackout()}
        >
          <StopIcon />
          СТОП
        </button>
      </div>

      <div className="quick-controls">
        <div className="quick-controls-title" data-hint="Пишет сразу во все приборы этого вида из патча — для пусконаладки">
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
                data-hint={p.name}
                onClick={() => {
                  const [r, g, b] = hexToRgb(p.hex);
                  setAllOfKind('lamp', { red: r, green: g, blue: b });
                }}
              />
            ))}
            <label
              className="color-swatch color-swatch-custom"
              style={customColor ? { background: customColor } : undefined}
              data-hint="Свой цвет — нажмите, чтобы выбрать"
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
            className={valveNextOpen ? 'btn toggle-open' : 'btn toggle-closed'}
            disabled={!hasValves}
            data-hint="Команда всем клапанам патча разом. Подпись — что произойдёт по нажатию; текущее положение видно на фейдерах"
            onClick={() => {
              setAllOfKind('valve', { open: valveNextOpen ? DMX_MAX_VALUE : 0 });
              setValveNextOpen(!valveNextOpen);
            }}
          >
            {valveNextOpen ? 'Открыть' : 'Закрыть'}
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
            twoState={owners.get(channel - 1)?.twoState}
            onChange={(value) =>
              universeId !== null &&
              (noteManual('console', `адрес ${channel}`),
              send({ type: 'setChannel', universe: universeId, channel, value }))
            }
          />
        ))}
      </main>
    </>
  );
}
