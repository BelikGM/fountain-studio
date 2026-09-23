import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BOWL_DEFAULTS,
  DMX_MAX_VALUE,
  LIGHT_DEFAULTS,
  NOZZLE_KINDS,
  type SearchRecord,
  insunitsToMeters,
  layoutFromDxf,
  nozzleDefaults,
  SPRAY_RANGE,
  clampSpray,
  nozzleGroupCentroid,
  nozzleLightIds,
  nozzlePump2Ids,
  nozzlePumpIds,
  nozzleValveIds,
  parseDxf,
  parseSvgPlan,
  sniffPlanFormat,
  profileMap,
  LAYOUT_SHAPES,
  ringPositions,
  shapePositions,
  snapShapeCount,
  rotateGroup,
  translateGroup,
  uid,
  type ChannelRole,
  type Bowl,
  type DxfDrawing,
  type DxfLayerRole,
  type FountainLayout,
  type LayoutLight,
  type Nozzle,
  type NozzleGroup,
  type LayoutShape,
  type NozzleKind,
  type Project,
  countOf,
  num,
} from '@fountain-studio/shared';
import { clipboardHasKind, copyToClipboard, pasteFromClipboard } from '../clipboard';
import { frameBus } from '../frameBus';
import { ManualBlocked } from '../components/ManualBlocked';
import { QuickAll } from '../components/QuickAll';
import { SmartSearch } from '../components/SmartSearch';
import { noteManual } from '../manualActivity';
import { hexToRgb } from '../colorPresets';
import { askConfirm, type ConfirmOptions } from '../components/ConfirmDialog';
import { PencilIcon, TrashIcon, WindIcon } from '../components/Icons';
import { H } from '../propHints';
import { comboFromEvent, getCombo } from '../hotkeys';
import type { EngineConnection } from '../useEngine';
import { FountainScene, type SelectedElement } from '../three/FountainScene';
import { buildDeviceIndex, createLiveHooks } from '../three/liveHooks';
import { modelCatalog, type ModelEntry, type ModelSlot } from '../three/models';

type ElKind = 'nozzle' | 'light' | 'bowl' | 'group';
type Selected = { type: ElKind; id: string } | null;
/** Набор для массовых операций: тип раздела, отмеченные id и якорь для Shift-диапазона. */
/**
 * Отметка элементов для массовых операций.
 *
 * Раньше выделение хранило ОДИН раздел: отметил все форсунки, полез отмечать
 * прожекторы — форсунки слетали. Теперь отмеченные хранятся по разделам и
 * живут независимо, а якорь для Shift-диапазона помнит, в каком разделе был
 * последний клик.
 */
type MultiSel = {
  ids: Record<ElKind, string[]>;
  anchor: { type: ElKind; id: string } | null;
};
const EMPTY_MULTI: MultiSel = { ids: { nozzle: [], light: [], bowl: [], group: [] }, anchor: null };
/** Сколько всего отмечено во всех разделах. */
const multiCount = (m: MultiSel): number =>
  m.ids.nozzle.length + m.ids.light.length + m.ids.bowl.length + m.ids.group.length;
/** Разделы, в которых что-то отмечено. */
const multiKinds = (m: MultiSel): ElKind[] =>
  (['nozzle', 'light', 'bowl', 'group'] as ElKind[]).filter((k) => m.ids[k].length > 0);
/** Заменить отметку одного раздела, не трогая остальные. */
const withKind = (m: MultiSel, type: ElKind, ids: string[], anchor: string | null): MultiSel => ({
  ids: { ...m.ids, [type]: ids },
  anchor: anchor ? { type, id: anchor } : m.anchor,
});
/** Подтверждение своим окном — прокидывается в панели свойств вместо window.confirm. */
type Ask = (text: string, options?: ConfirmOptions) => Promise<boolean>;

/** Вкладка «3D»: схема фонтана, живая визуализация струй и света, импорт DXF. */
export function LayoutView({ engine }: { engine: EngineConnection }) {
  const { project, frames, send, updateProject, windState } = engine;
  const [selected, setSelected] = useState<Selected>(null);
  const [multi, setMulti] = useState<MultiSel>(EMPTY_MULTI);
  const multiRef = useRef(multi);
  multiRef.current = multi;
  // Расстояние камеры до центра — опрашиваем, а не подписываемся: OrbitControls
  // шлёт change на каждый кадр вращения, и обновлять состояние React так часто
  // незачем. Пять раз в секунду глазу более чем достаточно.
  const [camDist, setCamDist] = useState(0);
  /**
   * Ветер в 3D — не настройка объекта, а инструмент проверки: покрутил, увидел,
   * куда полетит вода. Поэтому живёт в состоянии экрана и в проект не пишется.
   */
  const [windSpeed, setWindSpeed] = useState(0);
  const [windDir, setWindDir] = useState(0);
  /**
   * Панель ветра свёрнута в значок и раскрывается при наведении — как поиск.
   * Места над сценой мало, а крутят ветер изредка; разложенная полоса
   * закрывала угол схемы постоянно.
   */
  const [windOpen, setWindOpen] = useState(false);
  const windBoxRef = useRef<HTMLDivElement | null>(null);
  /** Тянут ползунок — не сворачиваем, даже если мышь соскочила с панели. */
  const windDragRef = useRef(false);
  useEffect(() => {
    const up = (): void => {
      if (!windDragRef.current) return;
      windDragRef.current = false;
      if (!windBoxRef.current?.matches(':hover')) setWindOpen(false);
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);
  /**
   * Ветер в 3D и ветер движка — ОДИН, когда ветер учитывается. Раньше ползунок
   * здесь жил сам по себе: на «Отладке» ввели 8 м/с — насосы в 3D опустились,
   * а сноса в сторону не было, пока не покрутишь ещё и здесь. Теперь:
   *  · ветер не учитывается — ползунок только для картинки, как раньше;
   *  · ручной ввод — ползунок и есть ручной ввод: насосы реагируют;
   *  · датчик — показывает датчик, крутить нельзя; направление — от датчика,
   *    если он его даёт, иначе своё.
   */
  const windCfg = project?.windLimit;
  const windMode: 'local' | 'manual' | 'sensor' = !windCfg?.enabled
    ? 'local'
    : windCfg.source === 'manual'
      ? 'manual'
      : 'sensor';
  const shownSpeed = windMode === 'local' ? windSpeed : (windState?.speedMs ?? 0);
  const sensorDir = windMode === 'sensor' && windState?.directionDeg != null ? Math.round(windState.directionDeg) : null;
  const shownDir = sensorDir ?? windDir;
  const setSpeed = (v: number): void => {
    if (windMode === 'manual') send({ type: 'setWindSpeed', speedMs: v > 0 ? v : null });
    else if (windMode === 'local') setWindSpeed(v);
  };
  useEffect(() => {
    sceneRef.current?.setWind(shownSpeed, shownDir);
  }, [shownSpeed, shownDir]);
  const windHint =
    windMode === 'sensor'
      ? `Ветер с датчика: ${num(shownSpeed, 1)} м/с${sensorDir !== null ? `, дует с ${sensorDir}°` : ''}. Крутить нельзя — показывает датчик («Настройки» → «Ветер»).`
      : windMode === 'manual'
        ? shownSpeed > 0
          ? `Ветер ${num(shownSpeed, 1)} м/с, дует с ${shownDir}° — ручной ввод: насосы реагируют как на настоящий ветер. Наведите, чтобы изменить.`
          : 'Ветер — ручной ввод для проверки: насосы реагируют как на настоящий. Тот же, что поле на «Отладке».'
        : shownSpeed > 0
          ? `Ветер ${num(shownSpeed, 1)} м/с, дует с ${shownDir}° — только картинка: ветер не учитывается («Настройки» → «Ветер»), на насосы не влияет.`
          : 'Ветер в 3D: посмотреть, как сложит струи и куда понесёт воду. Ветер не учитывается («Настройки» → «Ветер») — на приборы не влияет.';

  // Данные для живого кадра сцены — через ref, чтобы rAF-цикл видел свежие
  // кадры без пересоздания сцены.
  // Сцена читает кадр ЛИНИИ: если адреса переадресованы, на объекте будет
  // именно он. Отладка ниже по-прежнему работает с расчётными адресами —
  // там вы управляете своим прибором, а не смотрите на результат.
  //
  // Кадры берём из шины (frameBus), а не из состояния React: в шину они
  // попадают сразу, как пришли от движка, а состояние обновляется редко
  // (см. useEngine.ts). Раньше плавность 3D зависела от частоты перерисовок
  // приложения — теперь rAF-цикл сцены читает свежий кадр сам.
  const framesRef = useRef(frameBus.wire);
  const deviceIndex = useMemo(() => (project ? buildDeviceIndex(project) : new Map()), [project]);
  const deviceIndexRef = useRef(deviceIndex);
  deviceIndexRef.current = deviceIndex;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<FountainScene | null>(null);
  // Свежие проект и выделение для сцены, создаваемой позже разметки.
  const projectRef = useRef(project);
  projectRef.current = project;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  /**
   * Одно правило выбора и для списка слева, и для клика по схеме.
   *
   * Так это устроено во всех редакторах, где выделяют наборы (проводник,
   * Blender, таблицы): у набора есть СОСТАВ и есть АКТИВНЫЙ элемент.
   *  · клик по элементу ВНЕ набора — начать выделение заново с него;
   *  · клик по элементу ВНУТРИ набора — только сделать его активным, состав не
   *    трогать.
   *
   * Второе правило и было главной пропажей: выбрал группу, нажал на любую
   * форсунку — и групповое выделение слетало, хотя человек просто хотел
   * посмотреть, что у этой форсунки внутри.
   */
  const pickRef = useRef((_sel: { type: ElKind; id: string }) => {});
  pickRef.current = (sel) => {
    const cur = multiRef.current;
    if (cur.ids[sel.type].includes(sel.id) && multiCount(cur) > 1) {
      setMulti({ ...cur, anchor: sel });
      setSelected(sel);
      return;
    }
    setMulti(withKind(EMPTY_MULTI, sel.type, [sel.id], sel.id));
    setSelected(sel);
  };

  const hooksRef = useRef({
    onSelect: (sel: SelectedElement) => {
      if (!sel) {
        setSelected(null);
        return;
      }
      pickRef.current(sel);
    },
    /** Ctrl-клик по элементу на схеме — то же, что Ctrl-клик в списке слева. */
    onToggleMark: (sel: { type: ElKind; id: string }) => {
      const cur = multiRef.current;
      const same = cur.ids[sel.type];
      const next = same.includes(sel.id) ? same.filter((x) => x !== sel.id) : [...same, sel.id];
      setMulti(withKind(cur, sel.type, next, sel.id));
      setSelected(sel);
    },
    /** Рамка на схеме: без Ctrl заменяет отметку, с Ctrl добавляет к прежней. */
    onMarkArea: (items: { type: ElKind; id: string }[], add: boolean) => {
      const base = add ? multiRef.current : EMPTY_MULTI;
      const next: MultiSel = { ids: { ...base.ids }, anchor: base.anchor };
      for (const k of ['nozzle', 'light', 'bowl'] as ElKind[]) {
        const got = items.filter((i) => i.type === k).map((i) => i.id);
        if (got.length === 0) continue;
        next.ids[k] = [...new Set([...(add ? next.ids[k] : []), ...got])];
      }
      setMulti(next);
      const first = items[0];
      if (first) setSelected(first);
    },
    onMoveEnd: (type: 'nozzle' | 'light', id: string, x: number, y: number, z: number) => {
      moveElementRef.current(type, id, x, y, z);
    },
  });

  const moveElementRef = useRef(
    (_t: 'nozzle' | 'light', _id: string, _x: number, _y: number, _z: number) => {},
  );
  // Высота тоже приходит из сцены: её меняют вертикальной стрелкой у выбранного
  // прибора, а не только полем в свойствах.
  moveElementRef.current = (type, id, x, y, z) => {
    if (!project) return;
    const layout = project.layout;
    const next: FountainLayout =
      type === 'nozzle'
        ? { ...layout, nozzles: layout.nozzles.map((n) => (n.id === id ? { ...n, x, y, z } : n)) }
        : { ...layout, lights: layout.lights.map((l) => (l.id === id ? { ...l, x, y, z } : l)) };
    updateProject({ ...project, layout: next });
  };

  /**
   * Сцена создаётся в момент, когда контейнер РЕАЛЬНО появился в разметке.
   *
   * Раньше это был обычный эффект с пустыми зависимостями — он срабатывал один
   * раз при монтировании. Но пока движок не прислал проект, вместо схемы
   * рисуется «Жду данные объекта от движка…», контейнера ещё нет, эффект уходит
   * ни с чем и больше не повторяется. Пока вкладка не запоминалась, это не
   * всплывало: на «3D» переходили руками, уже с проектом на руках. Стоило
   * приложению открываться сразу на «3D» — и вкладка оставалась пустой.
   */
  const attachCanvas = useCallback((node: HTMLDivElement | null) => {
    if (containerRef.current === node) return;
    if (sceneRef.current) {
      sceneRef.current.dispose();
      sceneRef.current = null;
    }
    containerRef.current = node;
    if (!node) return;
    const scene = new FountainScene(node, {
      onSelect: (sel) => hooksRef.current.onSelect(sel),
      onToggleMark: (sel) => hooksRef.current.onToggleMark(sel),
      onMarkArea: (items, add) => hooksRef.current.onMarkArea(items, add),
      onMove: () => {},
      onMoveEnd: (t, id, x, y, z) => hooksRef.current.onMoveEnd(t, id, x, y, z),
      live: createLiveHooks(deviceIndexRef, framesRef),
    });
    sceneRef.current = scene;
    // Эффекты синхронизации уже отработали к этому моменту и сами не
    // повторятся — отдаём сцене текущее состояние сразу.
    const p = projectRef.current;
    if (p) scene.syncLayout(p.layout);
    const sel = selectedRef.current;
    if (sel && sel.type !== 'group') scene.setSelected({ type: sel.type, id: sel.id });
  }, []);

  useEffect(() => {
    if (project) sceneRef.current?.syncLayout(project.layout);
  }, [project?.layout]);

  useEffect(() => {
    const t = window.setInterval(() => {
      const d = sceneRef.current?.cameraDistanceM();
      if (d !== undefined) setCamDist(d);
    }, 200);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    sceneRef.current?.setSelected(
      // «Контур» — это набор форсунок, отдельного тела в сцене у него нет;
      // остальные три вида подсвечиваются в 3D.
      selected && selected.type !== 'group' ? { type: selected.type, id: selected.id } : null,
    );
  }, [selected]);

  /**
   * Отмеченные элементы уходят в сцену: без этого групповое выделение было
   * видно только в списке слева, а на схеме горел один активный — и казалось,
   * что рамка ничего не выделила.
   *
   * У контура своего тела в сцене нет, зато есть входящие в него форсунки и
   * прожекторы — их и подсвечиваем, иначе выбранный контур на схеме никак не
   * читается.
   */
  useEffect(() => {
    const keys: string[] = [];
    for (const k of ['nozzle', 'light', 'bowl'] as const) {
      for (const id of multi.ids[k]) keys.push(k + ':' + id);
    }
    for (const gid of multi.ids.group) {
      const g = project?.layout.nozzleGroups.find((x) => x.id === gid);
      if (!g) continue;
      for (const id of g.nozzleIds) keys.push('nozzle:' + id);
      for (const id of g.lightIds) keys.push('light:' + id);
    }
    if (selected?.type === 'group') {
      const g = project?.layout.nozzleGroups.find((x) => x.id === selected.id);
      if (g) {
        for (const id of g.nozzleIds) keys.push('nozzle:' + id);
        for (const id of g.lightIds) keys.push('light:' + id);
      }
    }
    sceneRef.current?.setMarked(keys);
  }, [multi, selected, project?.layout.nozzleGroups]);

  // Горячие клавиши редактора на выбранном элементе (§27 доработки, УХ п.6,
  // копирование — п.13): дублировать/удалить/снять выделение/сдвинуть
  // стрелками/копировать/вставить. Тот же эффект, что и одноимённые кнопки в
  // панели свойств справа — просто с клавиатуры. Paste не требует выделения
  // (можно вставить, когда ничего не выбрано), остальные действия — требуют.
  const NUDGE_STEP = 0.1;
  useEffect(() => {
    if (!project) return;
    const layout = project.layout;
    const pasteClipboard = (): void => {
      if (clipboardHasKind('nozzle')) {
        const n = pasteFromClipboard<Nozzle>('nozzle');
        if (!n) return;
        const copy: Nozzle = { ...n, id: uid(), name: `${n.name} (копия)`, x: n.x + 0.5 };
        updateProject({ ...project, layout: { ...layout, nozzles: [...layout.nozzles, copy] } });
        setSelected({ type: 'nozzle', id: copy.id });
      } else if (clipboardHasKind('light')) {
        const l = pasteFromClipboard<LayoutLight>('light');
        if (!l) return;
        const copy: LayoutLight = { ...l, id: uid(), name: `${l.name} (копия)`, x: l.x + 0.5 };
        updateProject({ ...project, layout: { ...layout, lights: [...layout.lights, copy] } });
        setSelected({ type: 'light', id: copy.id });
      } else if (clipboardHasKind('bowl')) {
        const b = pasteFromClipboard<Bowl>('bowl');
        if (!b) return;
        const copy: Bowl = { ...b, id: uid(), name: `${b.name} (копия)`, x: b.x + 0.5 };
        updateProject({ ...project, layout: { ...layout, bowls: [...layout.bowls, copy] } });
        setSelected({ type: 'bowl', id: copy.id });
      }
    };
    if (!selected) {
      const onKeyIdle = (e: KeyboardEvent): void => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (comboFromEvent(e) === getCombo('paste')) {
          e.preventDefault();
          pasteClipboard();
        }
      };
      window.addEventListener('keydown', onKeyIdle);
      return () => window.removeEventListener('keydown', onKeyIdle);
    }
    const copySelected = (): void => {
      if (selected.type === 'nozzle') {
        const n = layout.nozzles.find((x) => x.id === selected.id);
        if (n) copyToClipboard('nozzle', n);
      } else if (selected.type === 'light') {
        const l = layout.lights.find((x) => x.id === selected.id);
        if (l) copyToClipboard('light', l);
      } else {
        const b = layout.bowls.find((x) => x.id === selected.id);
        if (b) copyToClipboard('bowl', b);
      }
    };
    const duplicateSelected = (): void => {
      if (selected.type === 'nozzle') {
        const n = layout.nozzles.find((x) => x.id === selected.id);
        if (!n) return;
        const copy: Nozzle = { ...n, id: uid(), name: `${n.name} (копия)`, x: n.x + 0.5 };
        updateProject({ ...project, layout: { ...layout, nozzles: [...layout.nozzles, copy] } });
        setSelected({ type: 'nozzle', id: copy.id });
      } else if (selected.type === 'light') {
        const l = layout.lights.find((x) => x.id === selected.id);
        if (!l) return;
        const copy: LayoutLight = { ...l, id: uid(), name: `${l.name} (копия)`, x: l.x + 0.5 };
        updateProject({ ...project, layout: { ...layout, lights: [...layout.lights, copy] } });
        setSelected({ type: 'light', id: copy.id });
      } else {
        const b = layout.bowls.find((x) => x.id === selected.id);
        if (!b) return;
        const copy: Bowl = { ...b, id: uid(), name: `${b.name} (копия)`, x: b.x + 0.5 };
        updateProject({ ...project, layout: { ...layout, bowls: [...layout.bowls, copy] } });
        setSelected({ type: 'bowl', id: copy.id });
      }
    };
    const deleteSelected = (): void => {
      const next: FountainLayout =
        selected.type === 'nozzle'
          ? { ...layout, nozzles: layout.nozzles.filter((n) => n.id !== selected.id) }
          : selected.type === 'light'
            ? { ...layout, lights: layout.lights.filter((l) => l.id !== selected.id) }
            : { ...layout, bowls: layout.bowls.filter((b) => b.id !== selected.id) };
      updateProject({ ...project, layout: next });
      setSelected(null);
    };
    const nudge = (dx: number, dy: number): void => {
      const next: FountainLayout =
        selected.type === 'nozzle'
          ? { ...layout, nozzles: layout.nozzles.map((n) => (n.id === selected.id ? { ...n, x: n.x + dx, y: n.y + dy } : n)) }
          : selected.type === 'light'
            ? { ...layout, lights: layout.lights.map((l) => (l.id === selected.id ? { ...l, x: l.x + dx, y: l.y + dy } : l)) }
            : { ...layout, bowls: layout.bowls.map((b) => (b.id === selected.id ? { ...b, x: b.x + dx, y: b.y + dy } : b)) };
      updateProject({ ...project, layout: next });
    };
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const combo = comboFromEvent(e);
      if (combo === getCombo('copy')) {
        e.preventDefault();
        copySelected();
      } else if (combo === getCombo('paste')) {
        e.preventDefault();
        pasteClipboard();
      } else if (combo === getCombo('duplicate')) {
        e.preventDefault();
        duplicateSelected();
      } else if (combo === getCombo('delete')) {
        if (e.repeat) return;
        e.preventDefault();
        deleteSelected();
      } else if (combo === getCombo('deselect')) {
        e.preventDefault();
        setSelected(null);
      } else if (combo === getCombo('nudgeUp')) {
        e.preventDefault();
        nudge(0, NUDGE_STEP);
      } else if (combo === getCombo('nudgeDown')) {
        e.preventDefault();
        nudge(0, -NUDGE_STEP);
      } else if (combo === getCombo('nudgeLeft')) {
        e.preventDefault();
        nudge(-NUDGE_STEP, 0);
      } else if (combo === getCombo('nudgeRight')) {
        e.preventDefault();
        nudge(NUDGE_STEP, 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, selected, updateProject]);

  if (!project) return <main className="view">Жду данные объекта от движка…</main>;
  const layout = project.layout;
  const setLayout = (next: FountainLayout): void => updateProject({ ...project, layout: next });

  return (
    <>
      {/*
        Та же полоса, что на «Отладке»: пока идёт аварийное гашение или выход не
        доставляет кадры, ползунки прибора в панели справа ни на что не влияют —
        и человек должен видеть ПОЧЕМУ здесь же, а не искать по вкладкам.
      */}
      <ManualBlocked engine={engine} />
      <main className="view view-split">
      <aside className="sidebar">
        <ElementList
          layout={layout}
          selected={selected}
          onSelect={setSelected}
          setLayout={setLayout}
          multi={multi}
          onMulti={setMulti}
          ask={askConfirm}
        />
        <AddTools project={project} setLayout={setLayout} onSelect={setSelected} />
        <BindTools project={project} setLayout={setLayout} />
        <DxfImport project={project} setLayout={setLayout} />
      </aside>
      <div className="content content-3d">
        <div className="canvas3d" ref={attachCanvas} />
        <button
          className="btn btn-small canvas3d-reset"
          data-hint="Вернуть камеру к исходному положению"
          onClick={() => sceneRef.current?.resetCamera()}
        >
          ⟲ Камера
        </button>
        {/* Свёрнуто — только значок; дует ветер — значок и скорость, чтобы было
            понятно, почему струи сносит. Наведение раскрывает полосу целиком. */}
        <div
          className={'canvas3d-wind' + (windOpen ? ' open' : '') + (shownSpeed > 0 ? ' active' : '')}
          ref={windBoxRef}
          onMouseEnter={() => setWindOpen(true)}
          onMouseLeave={() => {
            if (!windDragRef.current) setWindOpen(false);
          }}
          onPointerDown={() => {
            windDragRef.current = true;
          }}
          data-hint={windOpen ? undefined : windHint}
        >
          <span className="canvas3d-wind-icon">
            <WindIcon />
          </span>
          {!windOpen && shownSpeed > 0 && <b className="canvas3d-wind-now">{num(shownSpeed, 1)} м/с</b>}
          <div className="canvas3d-wind-body" aria-hidden={!windOpen}>
            <input
              type="range"
              min={0}
              max={15}
              step={0.5}
              value={Math.min(15, shownSpeed)}
              tabIndex={windOpen ? 0 : -1}
              disabled={windMode === 'sensor'}
              onChange={(e) => setSpeed(Number(e.target.value))}
              data-hint={
                windMode === 'sensor'
                  ? 'Скорость с датчика — крутить нельзя'
                  : windMode === 'manual'
                    ? 'Скорость ветра, м/с — насосы реагируют как на настоящий ветер'
                    : 'Скорость ветра, м/с — только картинка'
              }
            />
            <b className="canvas3d-wind-val">{num(shownSpeed, 1)} м/с</b>
            <input
              type="range"
              min={0}
              max={359}
              step={5}
              value={shownDir}
              tabIndex={windOpen ? 0 : -1}
              disabled={shownSpeed <= 0 || sensorDir !== null}
              onChange={(e) => setWindDir(Number(e.target.value))}
              data-hint="Откуда дует, ° — как в сводке погоды: 0 с севера, 90 с востока"
            />
            <b className="canvas3d-wind-val canvas3d-wind-deg">{shownDir}°</b>
            <button
              className="btn btn-small"
              tabIndex={windOpen ? 0 : -1}
              disabled={shownSpeed <= 0 || windMode === 'sensor'}
              data-hint="Убрать ветер"
              onClick={() => setSpeed(0)}
            >
              ✕
            </button>
          </div>
        </div>
        <div className="canvas3d-hint dim">
          Щелчок — выбрать, тянуть — двигать по земле · у выбранного сверху синяя стрелка — ею поднимают и
          опускают · Ctrl+щелчок — отметить несколько · Shift и тянуть по пустому — рамка · колесо — ближе и дальше ·
          правая кнопка — сдвинуть вид ·{' '}
          <span className="canvas3d-dist">камера: {num(camDist, 1)} м от центра</span>
        </div>
      </div>
      <aside className="sidebar sidebar-props">
        {/* Отмечено больше одного — показываем групповые свойства вместо свойств
            последнего кликнутого: правки и удаление относятся ко всему набору. */}
        {multiCount(multi) > 1 && (
          <MultiProps
            project={project}
            multi={multi}
            setLayout={setLayout}
            onSelect={setSelected}
            onMulti={setMulti}
            send={send}
            ask={askConfirm}
            frames={frames}
          />
        )}
        {/* Свойства АКТИВНОГО элемента. При наборе — в свёрнутом блоке под
            групповыми: так видно и общее, и отдельное, и ничего не отнято.
            Раньше при наборе отдельные свойства просто исчезали. */}
        <ActiveWrap grouped={multiCount(multi) > 1} label={activeLabel(layout, selected)}>
          <>
            {selected?.type === 'nozzle' && (
              <NozzleProps
                project={project}
                nozzle={layout.nozzles.find((n) => n.id === selected.id)}
                setLayout={setLayout}
                onSelect={setSelected}
                send={send}
                ask={askConfirm}
                frames={frames}
              />
            )}
            {selected?.type === 'light' && (
              <LightProps
                project={project}
                light={layout.lights.find((l) => l.id === selected.id)}
                setLayout={setLayout}
                onSelect={setSelected}
                send={send}
                ask={askConfirm}
                frames={frames}
              />
            )}
            {selected?.type === 'bowl' && (
              <BowlProps
                bowl={layout.bowls.find((b) => b.id === selected.id)}
                layout={layout}
                setLayout={setLayout}
                onSelect={setSelected}
                ask={askConfirm}
              />
            )}
            {selected?.type === 'group' && (
              <GroupProps
                group={layout.nozzleGroups.find((g) => g.id === selected.id)}
                project={project}
                layout={layout}
                setLayout={setLayout}
                onSelect={setSelected}
                send={send}
                frames={frames}
              />
            )}
            {!selected && multiCount(multi) <= 1 && (
              <section className="panel">
                <h2>3D-схема</h2>
                <p className="dim">
                  Выберите элемент в списке или кликните по нему в 3D. Струи и свет оживают от текущих
                  DMX-кадров движка — включите сцену, секвенсор или шоу.
                </p>
              </section>
            )}
          </>
        </ActiveWrap>
        {/*
          «Сразу все приборы одного вида» — та же панель, что на «Отладке».
          В 3D она нужна не меньше: здесь видно результат, и бегать на другую
          вкладку ради «поднять все насосы» незачем.
        */}
        <QuickAll project={project} send={send} where="layout" />
      </aside>
      </main>
    </>
  );
}

// ---------- Список элементов ----------

function ElementList({
  layout,
  selected,
  onSelect,
  setLayout,
  multi,
  onMulti,
  ask,
}: {
  layout: FountainLayout;
  selected: Selected;
  onSelect: (s: Selected) => void;
  setLayout: (l: FountainLayout) => void;
  multi: MultiSel;
  onMulti: (m: MultiSel) => void;
  ask: Ask;
}) {
  /**
   * Множественное выделение (§27 доработки по просьбе): Ctrl — добавить/убрать
   * один, Shift — диапазон от предыдущего клика до текущего внутри одного
   * списка. Обычный клик работает как раньше — выбирает один элемент и
   * открывает его свойства справа. Хранится отдельно от selected: панель
   * свойств рассчитана на один элемент, а массовые операции — на набор.
   */
  const [search, setSearch] = useState('');
  /** Подходит ли элемент под строку поиска — по любому из его полей. */
  const matches = (type: ElKind, id: string): boolean => {
    const q = search.trim().toLowerCase();
    if (q === '') return true;
    const rec = searchRecords.find((r) => r.id === type + ':' + id);
    return rec ? rec.fields.some((f: { value: string }) => f.value.toLowerCase().includes(q)) : false;
  };

  const rowClass = (type: ElKind, id: string): string => {
    const one = selected?.type === type && selected.id === id;
    const many = multi.ids[type].includes(id);
    return `list-item${one ? ' selected' : ''}${many ? ' marked' : ''}`;
  };
  const idsOf = (type: ElKind): string[] =>
    type === 'nozzle'
      ? layout.nozzles.map((n) => n.id)
      : type === 'light'
        ? layout.lights.map((l) => l.id)
        : type === 'bowl'
          ? layout.bowls.map((b) => b.id)
          : layout.nozzleGroups.map((g) => g.id);

  const click = (type: ElKind, id: string, e: React.MouseEvent): void => {
    if (e.shiftKey && multi.anchor?.type === type) {
      const all = idsOf(type);
      const a = all.indexOf(multi.anchor.id);
      const b = all.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [from, to] = a <= b ? [a, b] : [b, a];
        onMulti(withKind(multi, type, all.slice(from, to + 1), multi.anchor.id));
        onSelect({ type, id });
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      // Ctrl добавляет и убирает в СВОЁМ разделе, отметки в остальных остаются.
      const same = multi.ids[type];
      const next = same.includes(id) ? same.filter((x) => x !== id) : [...same, id];
      onMulti(withKind(multi, type, next, id));
      onSelect({ type, id });
      return;
    }
    // Клик по элементу, который УЖЕ в наборе, — не начать заново, а только
    // переключить активный: состав набора остаётся (см. pickRef в LayoutView).
    if (multi.ids[type].includes(id) && multiCount(multi) > 1) {
      onMulti({ ...multi, anchor: { type, id } });
      onSelect({ type, id });
      return;
    }
    // Обычный клик по неотмеченному — начать выделение заново с него.
    onMulti(withKind(EMPTY_MULTI, type, [id], id));
    onSelect({ type, id });
  };

  const item = (type: ElKind, id: string, label: string) => (
    <li key={id} className={rowClass(type, id)} onClick={(e) => click(type, id, e)}>
      {label}
    </li>
  );

  /**
   * Заголовок раздела с кнопкой «все» — переключателем: первое нажатие отмечает
   * весь раздел, повторное снимает отметку. Раньше кнопка только отмечала, и
   * снять выделение со ста форсунок было нечем.
   */
  const head = (type: ElKind, title: string, count: number) => {
    const all = idsOf(type);
    const allMarked = count > 0 && all.every((id) => multi.ids[type].includes(id));
    return (
      <h3 className="list-head">
        {title} ({count})
        {count > 0 && (
          <button
            className={allMarked ? 'btn btn-small state-on' : 'btn btn-small'}
            data-hint={allMarked ? 'Снять отметку с этого раздела' : 'Отметить весь раздел'}
            onClick={() => {
              // Трогаем только свой раздел: отметки в других остаются.
              onMulti(withKind(multi, type, allMarked ? [] : all, allMarked ? null : (all[0] ?? null)));
              if (!allMarked && all[0]) {
                onSelect({ type, id: all[0] });
              } else if (allMarked && selected?.type === type) {
                // Снимаем и «выбранный» элемент: иначе на нём оставалась
                // подсветка и казалось, что он всё ещё в наборе.
                onSelect(null);
              }
            }}
          >
            все
          </button>
        )}
      </h3>
    );
  };
  // Контуры (§27 доработки, по примеру прежнего приложения) — именованная
  // группа форсунок как живой объект, не разовый штамп: можно вернуться и
  // разом повернуть/сдвинуть/перекрасить весь набор (см. GroupProps).
  const addGroup = (): void => {
    const g: NozzleGroup = {
      id: uid(),
      name: `Контур ${layout.nozzleGroups.length + 1}`,
      nozzleIds: [],
      lightIds: [],
      rotationDeg: 0,
      offsetX: 0,
      offsetY: 0,
      offsetZ: 0,
    };
    setLayout({ ...layout, nozzleGroups: [...layout.nozzleGroups, g] });
    onSelect({ type: 'group', id: g.id });
  };

  /** Полная очистка схемы — отдельной кнопкой, тоже с подтверждением. */
  const clearAll = async (): Promise<void> => {
    const total = layout.nozzles.length + layout.lights.length + layout.bowls.length + layout.nozzleGroups.length;
    if (total === 0) return;
    const ok = await ask('Очистить схему полностью?', {
      detail: `Будет удалено элементов: ${total} — форсунки, прожекторы, чаши и контуры. Привязки к приборам пропадут вместе с ними.`,
      okLabel: 'Очистить',
    });
    if (!ok) return;
    setLayout({ bowls: [], nozzles: [], lights: [], nozzleGroups: [] });
    onMulti(EMPTY_MULTI);
    onSelect(null);
  };
  /**
   * Записи для поиска по схеме — всё, чем элемент может быть найден.
   *
   * На объекте сотни форсунок, и ищут их по-разному: по имени, по типу, по
   * координате. Каждое поле отдаём отдельно, чтобы находки в выдаче не
   * смешивались и было видно, ПОЧЕМУ элемент нашёлся.
   */
  const searchRecords: SearchRecord[] = [
    ...layout.nozzles.map((n) => ({
      id: 'nozzle:' + n.id,
      kind: 'Форсунка',
      label: n.name,
      fields: [
        { field: 'Имя', value: n.name },
        { field: 'Тип', value: 'Форсунка' },
        { field: 'Насадка', value: NOZZLE_KINDS.find((k) => k.id === n.kind)?.label ?? n.kind },
        { field: 'X', value: String(n.x) },
        { field: 'Y', value: String(n.y) },
        { field: 'Z', value: String(n.z) },
        { field: 'Высота струи', value: String(n.maxHeightM) },
      ],
    })),
    ...layout.lights.map((l) => ({
      id: 'light:' + l.id,
      kind: 'Прожектор',
      label: l.name,
      fields: [
        { field: 'Имя', value: l.name },
        { field: 'Тип', value: 'Прожектор' },
        { field: 'X', value: String(l.x) },
        { field: 'Y', value: String(l.y) },
        { field: 'Z', value: String(l.z) },
      ],
    })),
    ...layout.bowls.map((b) => ({
      id: 'bowl:' + b.id,
      kind: 'Чаша',
      label: b.name,
      fields: [
        { field: 'Имя', value: b.name },
        { field: 'Тип', value: 'Чаша' },
        { field: 'X', value: String(b.x) },
        { field: 'Y', value: String(b.y) },
      ],
    })),
    ...layout.nozzleGroups.map((g) => ({
      id: 'group:' + g.id,
      kind: 'Контур',
      label: g.name,
      fields: [
        { field: 'Имя', value: g.name },
        { field: 'Тип', value: 'Контур' },
      ],
    })),
  ];

  return (
    <section className="panel">
      {/* Заголовка «Схема» нет: вкладка и так называется 3D, а место в узкой
          колонке дороже. Остаётся одна лупа, раскрывающаяся при наведении. */}
      <h2 className="panel-head-search">
        <SmartSearch
          records={searchRecords}
          value={search}
          onValue={setSearch}
          hint="Поиск по всем свойствам элемента: имя, тип, X, Y, Z, высота струи. Находки разложены по тому полю, в котором совпало."
          onPick={(key: string) => {
            const at = key.indexOf(':');
            const type = key.slice(0, at) as ElKind;
            const id = key.slice(at + 1);
            onMulti(withKind(EMPTY_MULTI, type, [id], id));
            onSelect({ type, id });
          }}
        />
      </h2>
      {head('nozzle', 'Форсунки', layout.nozzles.length)}
      <ul className="list">
        {layout.nozzles.filter((n) => matches('nozzle', n.id)).map((n) => item('nozzle', n.id, n.name))}
      </ul>
      {head('light', 'Прожекторы', layout.lights.length)}
      <ul className="list">
        {layout.lights.filter((l) => matches('light', l.id)).map((l) => item('light', l.id, l.name))}
      </ul>
      {head('bowl', 'Чаши', layout.bowls.length)}
      <ul className="list">
        {layout.bowls.filter((b) => matches('bowl', b.id)).map((b) => item('bowl', b.id, b.name))}
      </ul>
      {head('group', 'Контуры', layout.nozzleGroups.length)}
      <ul className="list">
        {layout.nozzleGroups.filter((g) => matches('group', g.id)).map((g) => item('group', g.id, g.name))}
      </ul>
      {multiCount(multi) > 1 && (
        // Только счётчик: удаление и правки набора живут в панели свойств
        // справа, чтобы действие было там же, где видно, что именно меняется.
        <p className="dim">отмечено: {multiCount(multi)} — свойства и удаление справа</p>
      )}
      <div className="form-row form-row-spaced">
        <button className="btn btn-small" onClick={addGroup}>
          + Контур
        </button>
        <span className="spacer" />
        <button className="btn btn-small btn-danger" onClick={() => void clearAll()} data-hint="Удалить со схемы всё: форсунки, прожекторы, чаши и контуры">
          Очистить схему
        </button>
      </div>
    </section>
  );
}

// ---------- Добавление ----------

let addCursor = 0;

function AddTools({
  project,
  setLayout,
  onSelect,
}: {
  project: Project;
  setLayout: (l: FountainLayout) => void;
  onSelect: (s: Selected) => void;
}) {
  const layout = project.layout;
  const [shape, setShape] = useState<LayoutShape>('ring');
  const [ringCount, setRingCount] = useState(8);
  const [ringRadius, setRingRadius] = useState(3);
  /** Центр фигуры: раскладка строится вокруг него, а не всегда вокруг нуля. */
  const [shapeCenter, setShapeCenter] = useState({ x: 0, y: 0, z: 0 });
  const [aspect, setAspect] = useState(0.6);
  const [ringKind, setRingKind] = useState<NozzleKind>('straight');

  const newNozzle = (kind: NozzleKind, x: number, y: number, name: string, z = 0): Nozzle => ({
    id: uid(),
    name,
    kind,
    x,
    y,
    z,
    tiltDeg: 0,
    headingDeg: 0,
    ...nozzleDefaults(kind),
    pumpDeviceId: null,
    pump2DeviceId: null,
    valveDeviceId: null,

    extraPumpDeviceIds: [],

    extraValveDeviceIds: [],

    extraLightDeviceIds: [],

    extraPump2DeviceIds: [],

    sprayFactor: 0.3,
    lightDeviceId: null,
  });

  const addNozzle = (): void => {
    const spot = (addCursor++ % 9) - 4;
    const n = newNozzle('straight', spot, 0, `Ф${layout.nozzles.length + 1}`);
    setLayout({ ...layout, nozzles: [...layout.nozzles, n] });
    onSelect({ type: 'nozzle', id: n.id });
  };
  const addLight = (): void => {
    const spot = (addCursor++ % 9) - 4;
    const l: LayoutLight = { id: uid(), name: `П${layout.lights.length + 1}`, x: spot, y: -0.5, z: -0.1, deviceId: null, ...LIGHT_DEFAULTS };
    setLayout({ ...layout, lights: [...layout.lights, l] });
    onSelect({ type: 'light', id: l.id });
  };
  const addBowl = (): void => {
    const b: Bowl = {
      id: uid(),
      name: `Чаша ${layout.bowls.length + 1}`,
      shape: 'circle',
      x: 0,
      y: 0,
      radius: 5,
      width: 10,
      length: 6,
      height: 0.3,
      ...BOWL_DEFAULTS,
    };
    setLayout({ ...layout, bowls: [...layout.bowls, b] });
    onSelect({ type: 'bowl', id: b.id });
  };
  const shapeDef = LAYOUT_SHAPES.find((s) => s.id === shape)!;
  const addShape = (): void => {
    const base = layout.nozzles.length;
    const nozzles = shapePositions(
      shape,
      ringCount,
      ringRadius,
      shapeCenter.x,
      shapeCenter.y,
      0,
      aspect,
    ).map((p, i) =>
      newNozzle(
        ringKind,
        Math.round(p.x * 100) / 100,
        Math.round(p.y * 100) / 100,
        `Ф${base + i + 1}`,
        Math.round(shapeCenter.z * 100) / 100,
      ),
    );
    setLayout({ ...layout, nozzles: [...layout.nozzles, ...nozzles] });
  };

  return (
    <section className="panel">
      <h2>Добавить</h2>
      <div className="sidebar-actions">
        <button className="btn btn-small" onClick={addNozzle}>+ Форсунка</button>
        <button className="btn btn-small" onClick={addLight}>+ Прожектор</button>
        <button className="btn btn-small" onClick={addBowl}>+ Чаша</button>
      </div>
      <h3>Расставить фигурой</h3>
      <div className="field-grid">
        <label className="field">
          <FieldName label="Фигура" hint={H.shape} />{' '}
          <select
            className="input"
            value={shape}
            onChange={(e) => {
              const next = e.target.value as LayoutShape;
              setShape(next);
              // Подгоняем количество под фигуру: у звезды это кратное десяти,
              // у квадрата — четырёх, иначе форсунки не попадут на вершины.
              setRingCount(snapShapeCount(next, ringCount));
            }}
          >
            {LAYOUT_SHAPES.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <FieldName label="Штук" hint={H.shapeCount} />{' '}
          <input
            className="input input-num"
            type="number"
            min={shapeDef.min}
            max={200}
            value={ringCount}
            onChange={(e) => setRingCount(Math.max(1, Math.min(200, Math.round(Number(e.target.value) || 1))))}
          />
        </label>
        <div className="shape-presets">
          {shapeDef.nice.map((n) => (
            <button
              key={n}
              className={n === ringCount ? 'btn btn-small state-on' : 'btn btn-small'}
              data-hint="Количество, при котором форсунки встают ровно"
              onClick={() => setRingCount(n)}
            >
              {n}
            </button>
          ))}
        </div>
        <label className="field">
          <FieldName label={shape === 'ring' ? 'Радиус, м' : 'Размер, м'} hint={H.shapeSize(shape === 'ring')} />{' '}
          <input
            className="input input-num"
            type="number"
            step={0.5}
            min={0.5}
            value={ringRadius}
            onChange={(e) => setRingRadius(Math.max(0.1, Number(e.target.value) || 3))}
          />
        </label>
        {shape === 'rect' && (
          <label className="field">
            <FieldName label="Пропорция" hint={H.shapeAspect} />{' '}
            <input
              className="input input-num"
              type="number"
              step={0.1}
              min={0.1}
              max={5}
              value={aspect}
              onChange={(e) => setAspect(Math.min(5, Math.max(0.1, Number(e.target.value) || 0.6)))}
            />
          </label>
        )}
        {(
          [
            ['x', 'Центр X, м'],
            ['y', 'Центр Y, м'],
            ['z', 'Центр Z, м'],
          ] as const
        ).map(([axis, label]) => (
          <label className="field" key={axis}>
            <FieldName label={label} hint={H.shapeCenter(axis)} />{' '}
            <input
              className="input input-num"
              type="number"
              step={0.5}
              value={shapeCenter[axis]}
              onChange={(e) => setShapeCenter({ ...shapeCenter, [axis]: Number(e.target.value) || 0 })}
            />
          </label>
        ))}
        <label className="field">
          <FieldName label="Тип" hint={H.shapeKind} />{' '}
          <select className="input" value={ringKind} onChange={(e) => setRingKind(e.target.value as NozzleKind)}>
            {NOZZLE_KINDS.map((k) => (
              <option key={k.id} value={k.id}>{k.label}</option>
            ))}
          </select>
        </label>
      </div>
      <button className="btn btn-small" onClick={addShape}>
        Расставить · {ringCount} шт.
      </button>
    </section>
  );
}

// ---------- Массовая привязка к патчу ----------

/** Общее объяснение автопривязки — одно на заголовок и на все три кнопки. */
const AUTOBIND_HINT =
  'Проходит по форсункам сверху вниз и выдаёт каждой, у кого этого прибора ещё нет, свободный прибор нужного вида — по возрастанию DMX-адреса.\n\nУже привязанные форсунки и уже занятые приборы не трогаются, поэтому нажимать можно сколько угодно раз.\n\nЭто заготовка: любую привязку потом правят вручную в свойствах форсунки.';

function BindTools({ project, setLayout }: { project: Project; setLayout: (l: FountainLayout) => void }) {
  const layout = project.layout;
  const profiles = profileMap(project);
  const devicesOfKind = (kind: string): typeof project.devices =>
    project.devices
      .filter((d) => profiles.get(d.profileId)?.kind === kind)
      .sort((a, b) => a.universe - b.universe || a.address - b.address);

  const bind = (field: 'pumpDeviceId' | 'valveDeviceId' | 'lightDeviceId', kind: string): void => {
    const used = new Set(layout.nozzles.map((n) => n[field]).filter(Boolean));
    const avail = devicesOfKind(kind).filter((d) => !used.has(d.id));
    let i = 0;
    setLayout({
      ...layout,
      nozzles: layout.nozzles.map((n) => (n[field] === null && i < avail.length ? { ...n, [field]: avail[i++]!.id } : n)),
    });
  };

  return (
    <section className="panel">
      {/* Раздел НЕ про адреса: адреса живут в патче, здесь форсункам схемы
          назначаются уже существующие приборы. Длинное объяснение убрано в
          подсказку — в панели оно занимало пол-экрана. */}
      <h2 data-hint={AUTOBIND_HINT}>Назначить приборы форсункам</h2>
      <div className="sidebar-actions">
        <button
          className="btn btn-small"
          data-hint={'Каждой форсунке без подсветки — свободный светильник.\n\n' + AUTOBIND_HINT}
          onClick={() => bind('lightDeviceId', 'lamp')}
        >
          Свет
        </button>
        <button
          className="btn btn-small"
          data-hint={'Каждой форсунке без насоса — свободный насос.\n\n' + AUTOBIND_HINT}
          onClick={() => bind('pumpDeviceId', 'pump')}
        >
          Насосы
        </button>
        <button
          className="btn btn-small"
          data-hint={'Каждой форсунке без клапана — свободный клапан.\n\n' + AUTOBIND_HINT}
          onClick={() => bind('valveDeviceId', 'valve')}
        >
          Клапаны
        </button>
      </div>
    </section>
  );
}

// ---------- Импорт DXF ----------

interface DxfState {
  fileName: string;
  drawing: DxfDrawing;
  roles: Record<string, DxfLayerRole>;
  scale: number;
  center: boolean;
  /** Заменить схему целиком вместо добавления к существующей. */
  replace: boolean;
}

/** Догадка о роли слоя по имени (пользователь всегда может поменять). */
function guessRole(layer: string): DxfLayerRole {
  if (/свет|light|lamp|прожект|led/i.test(layer)) return 'light';
  if (/чаш|bowl|борт|контур|basin|pool/i.test(layer)) return 'bowl';
  if (/форсун|nozzle|jet|насос|pump|фонтан/i.test(layer)) return 'nozzle';
  return 'skip';
}

const ROLE_OPTIONS: { id: DxfLayerRole; label: string }[] = [
  { id: 'skip', label: '— пропустить' },
  { id: 'nozzle', label: 'Форсунки' },
  { id: 'light', label: 'Прожекторы' },
  { id: 'bowl', label: 'Чаши' },
];

function DxfImport({ project, setLayout }: { project: Project; setLayout: (l: FountainLayout) => void }) {
  const [state, setState] = useState<DxfState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File): Promise<void> => {
    setError(null);
    try {
      const text = await file.text();
      // Сначала определяем формат: иначе на DWG и двоичном DXF человек получал
      // «не удалось разобрать» и оставался без объяснения, что делать.
      const kind = sniffPlanFormat(text.slice(0, 64), file.name);
      if (kind === 'dwg') {
        setError(
          'Это DWG — закрытый двоичный формат AutoCAD, читать его мы не умеем. ' +
            'В AutoCAD: «Сохранить как» → DXF (любой версии), либо бесплатный ODA File Converter. ' +
            'Ещё принимается SVG.',
        );
        return;
      }
      if (kind === 'dxf-binary') {
        setError(
          'Это двоичный DXF. Пересохраните как ASCII DXF: в диалоге сохранения AutoCAD выберите ' +
            '«AutoCAD DXF», а не «Binary DXF».',
        );
        return;
      }
      const drawing = kind === 'svg' ? parseSvgPlan(text) : parseDxf(text);
      if (drawing.points.length === 0 && drawing.polylines.length === 0) {
        setError(
          kind === 'svg'
            ? 'В SVG не нашлось фигур: нужны окружности, прямоугольники или контуры.'
            : 'В файле не найдено сущностей (нужен ASCII DXF или SVG).',
        );
        return;
      }
      const roles: Record<string, DxfLayerRole> = {};
      for (const layer of drawing.layers) roles[layer] = guessRole(layer);
      setState({
        fileName: file.name,
        drawing,
        roles,
        scale: insunitsToMeters(drawing.insunits),
        center: true,
        replace: false,
      });
    } catch {
      setError('Не удалось разобрать файл. Принимаются ASCII DXF и SVG.');
    }
  };

  const doImport = async (): Promise<void> => {
    if (!state) return;
    const res = layoutFromDxf(state.drawing, {
      unitScale: state.scale,
      layerRoles: state.roles,
      center: state.center,
    });
    // Что делать с тем, что уже на схеме, решает человек. По умолчанию —
    // добавить: чертёж часто подгружают по частям (сначала чаши, потом ряд
    // форсунок), и молча стирать сделанное нельзя.
    const old = project.layout;
    const had = old.nozzles.length + old.lights.length + old.bowls.length;
    if (state.replace && had > 0) {
      const ok = await askConfirm('Заменить схему содержимым чертежа?', {
        detail: `Сейчас на схеме элементов: ${had}. Все они будут удалены вместе с привязками к приборам. Контуры тоже.`,
        okLabel: 'Заменить',
      });
      if (!ok) return;
    }
    const layout: FountainLayout = state.replace
      ? { bowls: [], nozzles: [], lights: [], nozzleGroups: [] }
      : old;
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    const baseN = layout.nozzles.length;
    const baseL = layout.lights.length;
    const def = nozzleDefaults('straight');
    setLayout({
      bowls: [...layout.bowls, ...res.bowls.map((b) => ({ ...b, id: uid(), x: r2(b.x), y: r2(b.y), radius: r2(b.radius), width: r2(b.width), length: r2(b.length) }))],
      nozzles: [
        ...layout.nozzles,
        ...res.nozzles.map((p, i) => ({
          id: uid(),
          name: `Ф${baseN + i + 1}`,
          kind: 'straight' as NozzleKind,
          x: r2(p.x),
          y: r2(p.y),
          z: 0,
          tiltDeg: 0,
          headingDeg: 0,
          ...def,
          pumpDeviceId: null,
          pump2DeviceId: null,
          valveDeviceId: null,
      
          extraPumpDeviceIds: [],

          extraValveDeviceIds: [],

          extraLightDeviceIds: [],

          extraPump2DeviceIds: [],

          sprayFactor: 0.3,
          lightDeviceId: null,
        })),
      ],
      lights: [
        ...layout.lights,
        ...res.lights.map((p, i) => ({ id: uid(), name: `П${baseL + i + 1}`, x: r2(p.x), y: r2(p.y), z: -0.1, deviceId: null, ...LIGHT_DEFAULTS })),
      ],
      nozzleGroups: layout.nozzleGroups,
    });
    setState(null);
  };

  const layerStats = (layer: string): string => {
    if (!state) return '';
    const pts = state.drawing.points.filter((p) => p.layer === layer).length;
    const pls = state.drawing.polylines.filter((p) => p.layer === layer).length;
    return [pts > 0 ? countOf(pts, 'точка', 'точки', 'точек') : '', pls > 0 ? countOf(pls, 'контур', 'контура', 'контуров') : '']
      .filter(Boolean)
      .join(', ');
  };

  return (
    <section className="panel">
      <h2>Импорт чертежа</h2>
      <p className="dim">
        ASCII DXF или SVG. Окружности, точки, блоки и контуры станут элементами схемы — что именно,
        задаётся по слоям ниже, так что можно загрузить хоть весь фонтан, хоть один ряд форсунок.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".dxf,.svg"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.target.value = '';
        }}
      />
      <button
        className="btn btn-small"
        data-hint={'Принимаются ASCII DXF и SVG.\n\nDWG — закрытый двоичный формат AutoCAD, его надо пересохранить в DXF («Сохранить как» → AutoCAD DXF) или прогнать через бесплатный ODA File Converter.'}
        onClick={() => fileRef.current?.click()}
      >
        Открыть чертёж…
      </button>
      {error && <p className="error-text">{error}</p>}
      {state && (
        <>
          <h3>{state.fileName}</h3>
          {state.drawing.layers.map((layer) => (
            <label key={layer} className="field">
              {layer} <span className="dim">({layerStats(layer)})</span>{' '}
              <select
                className="input"
                value={state.roles[layer]}
                onChange={(e) => setState({ ...state, roles: { ...state.roles, [layer]: e.target.value as DxfLayerRole } })}
              >
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </label>
          ))}
          <label className="field">
            Одна единица чертежа, м:{' '}
            <input
              className="input input-num"
              type="number"
              step={0.001}
              value={state.scale}
              onChange={(e) => setState({ ...state, scale: Number(e.target.value) || 1 })}
            />
          </label>
          <div className="form-row">
            <span className="quick-row-label">Что делать со схемой:</span>
            <button
              className={state.replace ? 'btn btn-small' : 'btn btn-small state-on'}
              data-hint={'Элементы чертежа добавятся к тому, что уже есть.\n\nТак чертёж можно грузить по частям: сначала чаши, потом ряды форсунок.'}
              onClick={() => setState({ ...state, replace: false })}
            >
              Добавить
            </button>
            <button
              className={state.replace ? 'btn btn-small state-on' : 'btn btn-small'}
              data-hint={'Всё, что сейчас на схеме, будет удалено вместе с привязками к приборам и контурами. Перед этим спросим.'}
              onClick={() => setState({ ...state, replace: true })}
            >
              Заменить схему
            </button>
          </div>
          <label className="field">
            <input
              type="checkbox"
              checked={state.center}
              onChange={(e) => setState({ ...state, center: e.target.checked })}
            />{' '}
            Центрировать схему
          </label>
          <div className="sidebar-actions">
            <button className="btn btn-small" onClick={() => void doImport()}>Импортировать</button>
            <button className="btn btn-small" onClick={() => setState(null)}>Отмена</button>
          </div>
        </>
      )}
    </section>
  );
}

// ---------- Свойства элементов ----------

/**
 * Числовое поле, которое даёт ДОПИСАТЬ число.
 *
 * Управляемое поле с value={число} нельзя заполнить с клавиатуры, если по
 * дороге получается незаконченное число: набрал «-» — Number('-') не число,
 * значение наверх не ушло, React перерисовал поле прежним «0», и минус исчез.
 * Поэтому пока поле правят, показываем НАБРАННЫЙ текст, а наверх отдаём только
 * когда он разбирается в число. Ушли из поля — снова показываем настоящее
 * значение из проекта.
 */
function NumField({
  label,
  value,
  step = 0.1,
  onChange,
  hint,
  min,
  max,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
  hint?: string;
  /** Пределы поля. Заданы — набранное за ними число подрезается сразу при вводе. */
  min?: number;
  max?: number;
}) {
  /**
   * Черновик набора нужен, чтобы можно было стереть поле, начать с минуса или
   * с точки: пока строка не число, наружу она не уходит.
   *
   * Но за пределами он вредит: набрал в «сопел в сборке» 35 — в модели честно
   * оказывалось 20, а в поле до ухода курсора висело 35, и выглядело так,
   * будто ограничение не сработало. Поэтому вышедшее за предел число
   * показываем уже подрезанным, не дожидаясь, пока человек щёлкнет мимо.
   */
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="field">
      <FieldName label={label} hint={hint} />{' '}
      <input
        className="input input-num"
        type="number"
        step={step}
        min={min}
        max={max}
        value={draft ?? String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const v = Number(raw);
          if (raw.trim() === '' || !Number.isFinite(v)) {
            setDraft(raw);
            return;
          }
          const lo = min ?? -Infinity;
          const hi = max ?? Infinity;
          const fixed = Math.min(hi, Math.max(lo, v));
          setDraft(fixed === v ? raw : String(fixed));
          onChange(fixed);
        }}
        onBlur={() => setDraft(null)}
      />
    </label>
  );
}

/**
 * Имя свойства — с подсказкой по наведению ИМЕННО на него.
 *
 * Раньше подсказка висела на всей строке, вместе с полем ввода: она вылезала,
 * пока человек целился в поле или крутил в нём цифры, и закрывала соседние
 * строки. На имени она появляется, только когда её ищут.
 */
function FieldName({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className={hint ? 'field-name has-hint' : 'field-name'} data-hint={hint}>
      {label}:
    </span>
  );
}

function DeviceSelect({
  project,
  kind,
  value,
  onChange,
}: {
  project: Project;
  kind: 'pump' | 'valve' | 'lamp';
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const profiles = profileMap(project);
  const options = project.devices
    .filter((d) => profiles.get(d.profileId)?.kind === kind)
    .sort((a, b) => a.universe - b.universe || a.address - b.address);
  /*
   * «U1:5» было записью для своих. Пишем словами, а номер вселенной — только
   * когда их больше одной: на объекте с одной вселенной он ничего не говорит и
   * лишь съедает ширину списка.
   */
  const manyUniverses = new Set(project.devices.map((d) => d.universe)).size > 1;
  return (
    <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>
      <option value="">— не привязан</option>
      {options.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name} ({manyUniverses ? `вселенная ${d.universe}, ` : ''}адрес {d.address})
        </option>
      ))}
    </select>
  );
}

/**
 * Дополнительные привязки роли сверх основной. На объекте одну форсунку
 * нередко питают два насоса и подсвечивают несколько светильников — одного
 * выпадающего списка на роль не хватает. Основная привязка остаётся отдельной
 * строкой выше (на ней завязаны физика струи и генераторы), здесь — всё
 * остальное той же роли.
 */
function ExtraBindings({
  project,
  label,
  hint,
  kind,
  value,
  onValue,
  ids,
  onChange,
}: {
  project: Project;
  label: string;
  /** Что это за роль — подсказка на подписи. */
  hint?: string;
  kind: 'pump' | 'valve' | 'lamp';
  /** Основная привязка роли — она же первая строка. */
  value: string | null;
  onValue: (id: string | null) => void;
  /** Дополнительные привязки — строками ниже, без собственной подписи. */
  ids: string[];
  onChange: (ids: string[]) => void;
}) {
  const list = ids ?? [];
  return (
    <div className="bind-group">
      <div className="bind-row">
        <span className={hint ? 'bind-label has-hint' : 'bind-label'} data-hint={hint}>
          {label}:
        </span>
        <DeviceSelect project={project} kind={kind} value={value} onChange={onValue} />
        <button
          className="icon-btn"
          data-hint={`Добавить этой форсунке ещё один прибор того же назначения («${label.toLowerCase()}»)`}
          onClick={() => onChange([...list, ''])}
        >
          +
        </button>
      </div>
      {list.map((id, i) => (
        <div className="bind-row bind-row-extra" key={`${id}-${i}`}>
          <span className="bind-label" />
          <DeviceSelect
            project={project}
            kind={kind}
            value={id === '' ? null : id}
            onChange={(next) =>
              onChange(next === null ? list.filter((_, k) => k !== i) : list.map((v, k) => (k === i ? next : v)))
            }
          />
          <button
            className="icon-btn icon-btn-danger"
            data-hint="Убрать эту привязку"
            onClick={() => onChange(list.filter((_, k) => k !== i))}
          >
            <TrashIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Что значит групповой режим — одной подсказкой вместо абзацев в панели.
 *
 * Раньше это было написано текстом в двух местах: и что правки идут ко всем, и
 * что означает несовпадение значений. Текст занимал место в узкой колонке и
 * читался один раз, а потом только мешал — объяснение переехало в подсказку по
 * наведению на заголовок.
 */
const GROUP_HINT =
  "Значения применяются сразу ко всем отмеченным элементам. Прочерк в поле — у элементов значения разные; впишите своё, и оно раздастся всем. Клик по отмеченному переключает активный элемент, не снимая отметку; клик по неотмеченному начинает выделение заново.";
/** Знак «у отмеченных значения разные» — короткий прочерк, влезает в любое поле. */
const MIXED_MARK = '—';

/**
 * Свойства НАБОРА элементов (§27 доработки по просьбе). Раньше при отметке
 * нескольких справа показывались свойства последнего кликнутого, и «Удалить»
 * убирало только его — набор жил сам по себе, а панель сама по себе. Теперь
 * панель работает с набором целиком: правка поля применяется ко всем, удаление
 * удаляет всех.
 *
 * Поле показывает значение, только если оно ОДИНАКОВО у всех отмеченных; иначе
 * в нём стоит прочерк — но ввод в него всё равно раздаёт значение всем.
 * Свойства, уникальные для каждого элемента (имя), не показываем вовсе:
 * задать их набору нечем.
 */
/**
 * Числовые свойства НАБОРА форсунок. Один и тот же блок используют временное
 * выделение (Ctrl/Shift) и контур: свойства у них обязаны совпадать, иначе
 * непонятно, почему через выделение форсунке можно задать наклон, а через
 * контур — нет. Значения применяются сразу, отдельной кнопки «применить» нет:
 * поле показывает либо общее значение, либо прочерк, и ввод раздаёт его всем.
 */
function NozzleBulkFields({
  project,
  ids,
  setLayout,
}: {
  project: Project;
  ids: string[];
  setLayout: (l: FountainLayout) => void;
}) {
  const layout = project.layout;
  const idSet = new Set(ids);
  const members = layout.nozzles.filter((n) => idSet.has(n.id));
  const patchAll = (p: Partial<Nozzle>): void =>
    setLayout({ ...layout, nozzles: layout.nozzles.map((n) => (idSet.has(n.id) ? { ...n, ...p } : n)) });
  const sameKind = new Set(members.map((n) => n.kind)).size === 1;
  if (members.length === 0) return <p className="dim">Пока нет ни одной форсунки в наборе.</p>;
  return (
    <>
            <label className="field">
              <FieldName label="Тип" hint={H.nozzleKind} />{' '}
              <select
                className="input"
                value={sameKind ? members[0]!.kind : ''}
                onChange={(e) => {
                  const kind = e.target.value as NozzleKind;
                  if (!kind) return;
                  setLayout({
                    ...layout,
                    nozzles: layout.nozzles.map((n) => (idSet.has(n.id) ? { ...n, kind, ...nozzleDefaults(kind) } : n)),
                  });
                }}
              >
                {!sameKind && <option value="">{MIXED_MARK}</option>}
                {NOZZLE_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <MultiNumField label="X, м" hint={H.x('nozzle')} values={members.map((n) => n.x)} onChange={(x) => patchAll({ x })} />
            <MultiNumField label="Y, м" hint={H.y('nozzle')} values={members.map((n) => n.y)} onChange={(y) => patchAll({ y })} />
            <MultiNumField label="Z, м" hint={H.z('nozzle')} values={members.map((n) => n.z)} onChange={(z) => patchAll({ z })} />
            <MultiNumField label="Наклон, °" hint={H.tilt('nozzle', sameKind ? members[0]!.kind : undefined)} step={1} values={members.map((n) => n.tiltDeg)} onChange={(v) => patchAll({ tiltDeg: Math.max(-90, Math.min(90, v)) })} />
            <MultiNumField label="Азимут, °" hint={H.heading('nozzle')} step={5} values={members.map((n) => n.headingDeg)} onChange={(v) => patchAll({ headingDeg: ((v % 360) + 360) % 360 })} />
            <MultiNumField label="Высота струи, м" hint={H.height(sameKind ? members[0]!.kind : undefined)} step={0.5} values={members.map((n) => n.maxHeightM)} onChange={(v) => patchAll({ maxHeightM: Math.max(0.1, v) })} />
            <MultiNumField
              label="Диаметр струи, мм"
              hint={H.diameter(sameKind ? members[0]!.kind : undefined)}
              step={1}
              values={members.map((n) => Math.round(n.widthM * 1000))}
              onChange={(v) => patchAll({ widthM: Math.max(0.002, v / 1000) })}
            />
            <MultiNumField label="Время разгона, мс" hint={H.rise} step={100} values={members.map((n) => n.riseMs)} onChange={(v) => patchAll({ riseMs: Math.max(0, Math.round(v)) })} />
            <MultiNumField label="Время торможения, мс" hint={H.fall} step={100} values={members.map((n) => n.fallMs)} onChange={(v) => patchAll({ fallMs: Math.max(0, Math.round(v)) })} />
    </>
  );
}

/** Имя активного элемента — им подписан свёрнутый блок его свойств. */
function activeLabel(layout: FountainLayout, sel: Selected): string {
  if (!sel) return '—';
  const find = <T extends { id: string; name: string }>(a: T[]): string | undefined =>
    a.find((x) => x.id === sel.id)?.name;
  const name =
    sel.type === 'nozzle'
      ? find(layout.nozzles)
      : sel.type === 'light'
        ? find(layout.lights)
        : sel.type === 'bowl'
          ? find(layout.bowls)
          : find(layout.nozzleGroups);
  return name ?? '—';
}

/**
 * Свойства активного элемента: сами по себе, когда выбран один, и в свёрнутом
 * блоке, когда отмечен набор.
 */
function ActiveWrap({
  grouped,
  label,
  children,
}: {
  grouped: boolean;
  label: string;
  children: React.ReactNode;
}) {
  if (!grouped) return <>{children}</>;
  return (
    <details className="panel props-active">
      <summary data-hint="Правки здесь — только этому элементу. Общие для всего набора — в панели выше.">
        Свойства активного: <b>{label}</b>
      </summary>
      {children}
    </details>
  );
}

function MultiProps({
  project,
  multi,
  setLayout,
  onSelect,
  onMulti,
  send,
  ask,
  frames,
}: {
  project: Project;
  multi: MultiSel;
  setLayout: (l: FountainLayout) => void;
  onSelect: (s: Selected) => void;
  onMulti: (m: MultiSel) => void;
  send: EngineConnection['send'];
  ask: Ask;
  /** Живые кадры DMX — нужны отладке, чтобы показывать фактическое состояние приборов. */
  frames: Record<number, Uint8Array>;
}) {
  const layout = project.layout;
  const kinds = multiKinds(multi);
  // Один раздел — полный набор общих свойств. Несколько — только сводка и
  // удаление: у форсунки и чаши общих числовых полей нет, и делать вид, что
  // они есть, было бы враньём.
  const only: ElKind | null = kinds.length === 1 ? kinds[0]! : null;
  const idsOfKind = (k: ElKind): Set<string> => new Set(multi.ids[k]);
  const ids = idsOfKind(only ?? 'nozzle');
  const lights = only === 'light' ? layout.lights.filter((l) => ids.has(l.id)) : [];
  const bowls = only === 'bowl' ? layout.bowls.filter((b) => ids.has(b.id)) : [];
  const markedNozzles = only === 'nozzle' ? layout.nozzles.filter((n) => ids.has(n.id)) : [];
  const count = multiCount(multi);

  const KIND_NAMES: Record<ElKind, [string, string]> = {
    nozzle: ['Форсунки', 'форсунок'],
    light: ['Прожекторы', 'прожекторов'],
    bowl: ['Чаши', 'чаш'],
    group: ['Контуры', 'контуров'],
  };
  const title = only
    ? `${KIND_NAMES[only][0]}: ${count}`
    : `Отмечено: ${count}`;

  const patchLights = (p: Partial<LayoutLight>): void =>
    setLayout({ ...layout, lights: layout.lights.map((l) => (ids.has(l.id) ? { ...l, ...p } : l)) });
  const patchBowls = (p: Partial<Bowl>): void =>
    setLayout({ ...layout, bowls: layout.bowls.map((b) => (ids.has(b.id) ? { ...b, ...p } : b)) });

  const removeAll = async (): Promise<void> => {
    const parts = kinds.map((k) => `${KIND_NAMES[k][1]}: ${multi.ids[k].length}`);
    if (!(await ask(`Удалить отмеченное?`, { detail: parts.join(', '), okLabel: 'Удалить' }))) return;
    const noz = idsOfKind('nozzle');
    const lig = idsOfKind('light');
    const bow = idsOfKind('bowl');
    const grp = idsOfKind('group');
    setLayout({
      ...layout,
      nozzles: layout.nozzles.filter((n) => !noz.has(n.id)),
      lights: layout.lights.filter((l) => !lig.has(l.id)),
      bowls: layout.bowls.filter((b) => !bow.has(b.id)),
      // Удалённые элементы вычищаем и из контуров, иначе там останутся
      // ссылки в никуда.
      nozzleGroups: layout.nozzleGroups
        .filter((g) => !grp.has(g.id))
        .map((g) => ({
          ...g,
          nozzleIds: g.nozzleIds.filter((x) => !noz.has(x)),
          lightIds: g.lightIds.filter((x) => !lig.has(x)),
        })),
    });
    onMulti(EMPTY_MULTI);
    onSelect(null);
  };

  return (
    <section className="panel">
      <h2>{title}</h2>
      {only ? (
        <p className="dim group-mode" data-hint={GROUP_HINT}>
          Групповое редактирование
        </p>
      ) : (
        <p className="dim">
          Отмечены элементы разных видов ({kinds.map((k) => `${KIND_NAMES[k][1]} ${multi.ids[k].length}`).join(', ')}) — общих
          свойств у них нет, можно только удалить разом. Чтобы править свойства, оставьте отмеченным один вид.
        </p>
      )}
      <div className="field-grid">
        {only === 'nozzle' && <NozzleBulkFields project={project} ids={multi.ids.nozzle} setLayout={setLayout} />}
        {only === 'light' && (
          <>
            <MultiNumField label="X, м" hint={H.x('light')} values={lights.map((l) => l.x)} onChange={(x) => patchLights({ x })} />
            <MultiNumField label="Y, м" hint={H.y('light')} values={lights.map((l) => l.y)} onChange={(y) => patchLights({ y })} />
            <MultiNumField label="Z, м" hint={H.z('light')} values={lights.map((l) => l.z)} onChange={(z) => patchLights({ z })} />
            <MultiNumField label="Наклон, °" hint={H.tilt('light')} step={5} values={lights.map((l) => l.tiltDeg)} onChange={(v) => patchLights({ tiltDeg: Math.max(0, Math.min(180, v)) })} />
            <MultiNumField label="Азимут, °" hint={H.heading('light')} step={5} values={lights.map((l) => l.headingDeg)} onChange={(v) => patchLights({ headingDeg: ((v % 360) + 360) % 360 })} />
            <MultiNumField label="Угол луча, °" hint={H.beamAngle} step={5} values={lights.map((l) => l.beamAngleDeg)} onChange={(v) => patchLights({ beamAngleDeg: Math.max(1, Math.min(170, v)) })} />
            <MultiNumField label="Дальность, м" hint={H.beamRange} step={0.5} values={lights.map((l) => l.rangeM)} onChange={(v) => patchLights({ rangeM: Math.max(0.1, v) })} />
            <MultiNumField
              label="Размер корпуса, мм"
              hint={H.lightSize}
              step={10}
              values={lights.map((l) => Math.round((l.sizeM ?? 0.16) * 1000))}
              onChange={(v) => patchLights({ sizeM: Math.min(1, Math.max(0.03, v / 1000)) })}
            />
            <MultiNumField
              label="Плотность луча, %"
              hint={H.beamDensity}
              step={5}
              values={lights.map((l) => Math.round((l.beamDensity ?? LIGHT_DEFAULTS.beamDensity) * 100))}
              onChange={(v) => patchLights({ beamDensity: Math.min(1, Math.max(0, v / 100)) })}
            />
          </>
        )}
        {only === 'bowl' && (
          <>
            <MultiNumField label="X, м" hint={H.x('bowl')} values={bowls.map((b) => b.x)} onChange={(x) => patchBowls({ x })} />
            <MultiNumField label="Y, м" hint={H.y('bowl')} values={bowls.map((b) => b.y)} onChange={(y) => patchBowls({ y })} />
            <MultiNumField label="Высота борта, м" hint={H.bowlRim} step={0.1} values={bowls.map((b) => b.height)} onChange={(v) => patchBowls({ height: Math.max(0, v) })} />
          </>
        )}
        {only === 'group' && (
          <p className="dim">У контуров нет общих числовых свойств — доступно только удаление.</p>
        )}
      </div>
      {only === 'nozzle' && (
        <LiveDebug
          project={project}
          frames={frames}
          send={send}
          pumps={pumpFaders(markedNozzles)}
          valveIds={[...new Set(markedNozzles.flatMap(nozzleValveIds))]}
          lightIds={[...new Set(markedNozzles.flatMap(nozzleLightIds))]}
          hint="У отмеченных форсунок нет привязанных приборов."
        />
      )}
      <div className="sidebar-actions">
        <button className="btn btn-small" onClick={() => onMulti(EMPTY_MULTI)}>
          Снять отметку
        </button>
        <button className="btn btn-small btn-danger" onClick={() => void removeAll()}>
          Удалить
        </button>
      </div>
    </section>
  );
}

/**
 * Числовое поле набора. Значения у элементов разные — в поле прочерк.
 *
 * Слово «разные» в узкое числовое поле не помещалось и обрезалось рамкой. В
 * сильных редакторах на этот случай ставят короткий знак или оставляют поле
 * пустым: Figma пишет Mixed, Unity и CAD-пакеты — прочерк, Photoshop не пишет
 * ничего. Берём прочерк: он короткий, влезает в любое поле и ни с каким числом
 * не спутается.
 */
function MultiNumField({
  label,
  values,
  step = 0.1,
  onChange,
  hint,
}: {
  label: string;
  values: number[];
  step?: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  const same = values.length > 0 && values.every((v) => v === values[0]);
  // Тот же приём, что и в NumField: пока правят — показываем набранное, иначе
  // минус и другие незаконченные числа набрать невозможно.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="field">
      <FieldName label={label} hint={hint} />{' '}
      <input
        className="input input-num"
        type="number"
        step={step}
        value={draft ?? (same ? String(values[0]) : '')}
        placeholder={same ? '' : MIXED_MARK}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(v)) onChange(v);
        }}
        onBlur={() => setDraft(null)}
      />
    </label>
  );
}

/**
 * Отладка выбранного на схеме — те же команды setChannel, что шлёт фейдер
 * вкладки «Отладка», только адресованные устройствам этого элемента по ролям. Нужна,
 * чтобы не бегать на Отладку и обратно ради проверки «тот ли прибор привязан».
 * Один компонент на форсунку, набор форсунок и прожектор: набор ролей у них
 * разный, а поведение одинаковое.
 */
/**
 * Выбор своей 3D-модели для элемента.
 *
 * Встроенные форсунки, прожекторы и чаши нарисованы кодом. Готовых моделей
 * фонтанной арматуры со свободной лицензией в открытых библиотеках нет, поэтому
 * набора «из коробки» тут не будет — есть механизм: файл кладётся в
 * packages/ui/public/models и вписывается в index.json (там же README с
 * подробностями и ссылками, где искать модели).
 */
/**
 * Пояснение к выбору модели. Вынесено в подсказку, а не в текст панели: путь к
 * папке — сведение для того, кто ставит программу, а не для оператора, и
 * длинной строкой он только распирал панель свойств.
 */
const MODEL_HINT =
  'Вместо встроенной модели можно поставить свою — файл .glb или .gltf. ' +
  'В установленном приложении кладите файлы в «Документы\\Fountain Studio\\models» — ' +
  'обновление программы эту папку не трогает. ' +
  'В файле index.json рядом добавьте строчку с именем файла и тем, для чего он ' +
  '(форсунка, прожектор или чаша) — и модель появится в этом списке.';

/** Вариант «без своей модели» — то, что программа рисует сама. */
const BUILT_IN_LABEL = 'Стандартная';

function ModelSelect({
  slot,
  file,
  scale,
  onFile,
  onScale,
}: {
  slot: ModelSlot;
  file: string | null;
  scale: number;
  onFile: (f: string | null) => void;
  onScale: (v: number) => void;
}) {
  const [list, setList] = useState<ModelEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    void modelCatalog().then((l) => {
      if (alive) setList(l);
    });
    return () => {
      alive = false;
    };
  }, []);
  const mine = (list ?? []).filter((m) => m.for === slot);
  // Файл может быть вписан в проект руками, минуя каталог — не теряем его.
  const missing = file && !mine.some((m) => m.file === file);
  return (
    <>
      <label className="field">
        <FieldName label="3D-модель" hint={H.model} />{' '}
        <select value={file ?? ''} onChange={(e) => onFile(e.target.value || null)}>
          <option value="">{BUILT_IN_LABEL}</option>
          {mine.map((m) => (
            <option key={m.file} value={m.file}>
              {m.name}
            </option>
          ))}
          {missing && <option value={file}>{file} (нет в списке)</option>}
        </select>
      </label>
      {file && (
        <NumField label="Масштаб модели" hint={H.modelScale} value={scale ?? 1} step={0.1} onChange={(v) => onScale(Math.min(20, Math.max(0.05, v)))} />
      )}
      {list !== null && mine.length === 0 && !file && (
        <p className="dim" data-hint={MODEL_HINT}>
          Других моделей нет. Наведите, чтобы узнать, куда класть свои файлы.
        </p>
      )}
    </>
  );
}

/**
 * Подписи ползунков насосов. У обычной форсунки насос один и называется просто
 * «Насос» — раньше сюда попадал ещё и насос раскрытия конуса, и в отладке
 * висели два одинаковых ползунка «Насос 1». Насос раскрытия есть только у
 * вариативной форсунки и никак не связан с насосом подачи: это два разных
 * насоса, каждый со своим ползунком.
 */
function pumpFaders(nozzles: Nozzle[]): { id: string; label: string }[] {
  const feed = [...new Set(nozzles.flatMap(nozzlePumpIds))];
  const expand = [...new Set(nozzles.filter((n) => n.kind === 'variable').flatMap(nozzlePump2Ids))];
  const one = nozzles.length === 1;
  const feedName = one && expand.length === 0 ? 'Насос' : 'Насос прямой струи';
  return [
    ...feed.map((id, i) => ({ id, label: feed.length > 1 ? `${feedName} ${i + 1}` : feedName })),
    ...expand.map((id, i) => ({
      id,
      label: expand.length > 1 ? `Насос раскрытия конуса ${i + 1}` : 'Насос раскрытия конуса',
    })),
  ];
}

/**
 * Ползунок насоса в отладке прибора.
 *
 * Показывает то, что на линии, но ПОКА ТЯНУТ — своё положение. Раньше значение
 * бралось прямо из кадра, и ползунок вырывался из-под пальца: движок отвечает
 * своим кадром не мгновенно, а если работает аварийное гашение, то и вовсе
 * присылает нули. Выглядело это как «в 3D приборы не включаются» — при том что
 * команда уходила исправно.
 */
function PumpFader({
  label,
  deviceName,
  live,
  onChange,
}: {
  label: string;
  deviceName?: string;
  /** Значение с линии. */
  live: number;
  onChange: (value: number) => void;
}) {
  const [held, setHeld] = useState<number | null>(null);
  const shown = held ?? live;
  return (
    <div className="form-row">
      <span className="quick-row-label" data-hint={deviceName}>
        {label}:
      </span>
      <input
        type="range"
        min={0}
        max={DMX_MAX_VALUE}
        value={shown}
        onChange={(e) => {
          const v = Number(e.target.value);
          setHeld(v);
          onChange(v);
        }}
        // Отпустили — ещё полсекунды показываем своё, чтобы успел дойти кадр, и
        // только потом снова верим линии.
        onPointerUp={() => window.setTimeout(() => setHeld(null), 500)}
        onBlur={() => setHeld(null)}
      />
      <span className="dim">{shown}</span>
    </div>
  );
}

function LiveDebug({
  project,
  frames,
  send,
  pumps = [],
  valveIds = [],
  lightIds = [],
  hint,
}: {
  project: Project;
  /** Живые кадры DMX — по ним показываем ФАКТИЧЕСКОЕ состояние клапана и света. */
  frames: Record<number, Uint8Array>;
  send: EngineConnection['send'];
  pumps?: { id: string; label: string }[];
  valveIds?: string[];
  lightIds?: string[];
  hint?: string;
}) {
  const [light, setLight] = useState('#ffffff');
  const profiles = profileMap(project);
  const byId = new Map(project.devices.map((d) => [d.id, d]));

  /** Текущее значение первого канала указанной роли — «как оно есть на линии». */
  const readRole = (deviceId: string, role: ChannelRole): number => {
    const d = byId.get(deviceId);
    const pr = d && profiles.get(d.profileId);
    if (!d || !pr) return 0;
    const i = pr.channels.findIndex((c) => c.role === role);
    if (i < 0) return 0;
    return frames[d.universe]?.[d.address - 1 + i] ?? 0;
  };
  // noteManual — ОДИН раз на действие, а не на каждый канал каждого прибора:
  // отметку слушает строка состояния внизу, и в наборе из пятидесяти форсунок
  // полсотни отметок за одно движение мыши перерисовывали всё приложение
  // (см. manualActivity.ts).
  const write = (deviceIds: string[], role: ChannelRole, value: number): void => {
    let what = '';
    for (const id of deviceIds) {
      const d = byId.get(id);
      const pr = d && profiles.get(d.profileId);
      if (!d || !pr) continue;
      pr.channels.forEach((c, i) => {
        if (c.role === role) {
          what = what === '' ? d.name : `${deviceIds.length} прибора(ов)`;
          send({ type: 'setChannel', universe: d.universe, channel: d.address + i, value });
        }
      });
    }
    if (what !== '') noteManual('layout', what);
  };
  const setColor = (hex: string, keepSwatch = false): void => {
    if (!keepSwatch) setLight(hex);
    const [r, g, bb] = hexToRgb(hex);
    let what = '';
    for (const id of lightIds) {
      const d = byId.get(id);
      const pr = d && profiles.get(d.profileId);
      if (!d || !pr) continue;
      pr.channels.forEach((c, i) => {
        const v =
          c.role === 'red'
            ? r
            : c.role === 'green'
              ? g
              : c.role === 'blue'
                ? bb
                : c.role === 'intensity'
                  ? Math.max(r, g, bb)
                  : undefined;
        if (v !== undefined) {
          what = what === '' ? d.name : `свет, ${lightIds.length} прибора(ов)`;
          send({ type: 'setChannel', universe: d.universe, channel: d.address + i, value: v });
        }
      });
    }
    if (what !== '') noteManual('layout', what);
  };

  const nothing = pumps.length === 0 && valveIds.length === 0 && lightIds.length === 0;
  // Клапан открыт, если открыт хотя бы один: та же логика, что и в
  // визуализации струи (параллельные подводы).
  const valveOpen = valveIds.some((id) => readRole(id, 'open') >= 128);
  const lightOn = lightIds.some((id) =>
    ['red', 'green', 'blue', 'white', 'intensity'].some((r) => readRole(id, r as ChannelRole) > 0),
  );

  return (
    <div className="nozzle-live">
      <h3>Отладка</h3>
      {nothing ? (
        <p className="dim">{hint ?? 'Привяжите прибор выше — здесь появится управление им.'}</p>
      ) : (
        <>
          {/* Ползунок на каждый привязанный насос. У обычной форсунки он ОДИН и
              подписан просто «Насос»; второй появляется только если насос
              добавлен кнопкой «+». У вариативной их изначально два — это два
              независимых насоса: подачи и раскрытия конуса. */}
          {pumps.map(({ id, label }) => (
            <PumpFader
              key={id + label}
              label={label}
              deviceName={byId.get(id)?.name}
              live={readRole(id, 'intensity')}
              onChange={(v) => write([id], 'intensity', v)}
            />
          ))}
          {valveIds.length > 0 && (
            <div className="form-row">
              <span className="quick-row-label">Клапан{valveIds.length > 1 ? ` (${valveIds.length})` : ''}:</span>
              {/* Одна кнопка: показывает состояние и переключает его. */}
              <button
                className={valveOpen ? 'btn btn-small state-on' : 'btn btn-small state-off'}
                data-hint="Нажмите, чтобы переключить"
                onClick={() => write(valveIds, 'open', valveOpen ? 0 : DMX_MAX_VALUE)}
              >
                {valveOpen ? 'Открыт' : 'Закрыт'}
              </button>
            </div>
          )}
          {lightIds.length > 0 && (
            <div className="form-row">
              <span className="quick-row-label">Свет{lightIds.length > 1 ? ` (${lightIds.length})` : ''}:</span>
              <input type="color" value={light} onChange={(e) => setColor(e.target.value)} />
              <button
                className={lightOn ? 'btn btn-small state-on' : 'btn btn-small state-off'}
                data-hint="Нажмите, чтобы переключить"
                onClick={() => setColor(lightOn ? '#000000' : light, lightOn)}
              >
                {lightOn ? 'Горит' : 'Погашен'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NozzleProps({
  project,
  nozzle,
  setLayout,
  onSelect,
  send,
  ask,
  frames,
}: {
  project: Project;
  nozzle: Nozzle | undefined;
  setLayout: (l: FountainLayout) => void;
  onSelect: (s: Selected) => void;
  send: EngineConnection['send'];
  ask: Ask;
  /** Живые кадры DMX — нужны отладке, чтобы показывать фактическое состояние приборов. */
  frames: Record<number, Uint8Array>;
}) {
  if (!nozzle) return null;
  const layout = project.layout;
  const patch = (p: Partial<Nozzle>): void =>
    setLayout({ ...layout, nozzles: layout.nozzles.map((n) => (n.id === nozzle.id ? { ...n, ...p } : n)) });
  const duplicate = (): void => {
    const copy: Nozzle = { ...nozzle, id: uid(), name: `${nozzle.name} (копия)`, x: nozzle.x + 0.5 };
    setLayout({ ...layout, nozzles: [...layout.nozzles, copy] });
    onSelect({ type: 'nozzle', id: copy.id });
  };
  const remove = async (): Promise<void> => {
    if (!(await ask(`Удалить форсунку «${nozzle.name}»?`))) return;
    setLayout({ ...layout, nozzles: layout.nozzles.filter((n) => n.id !== nozzle.id) });
    onSelect(null);
  };
  return (
    <section className="panel">
      <h2>Форсунка</h2>
      <div className="field-grid">
        <label className="field">
          <FieldName label="Имя" hint={H.name('nozzle')} />{' '}
          <input className="input" value={nozzle.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="field">
          <FieldName label="Тип" hint={H.nozzleKind} />{' '}
          <select
            className="input"
            value={nozzle.kind}
            onChange={(e) => {
              const kind = e.target.value as NozzleKind;
              patch({ kind, ...nozzleDefaults(kind) });
            }}
          >
            {NOZZLE_KINDS.map((k) => (
              <option key={k.id} value={k.id}>{k.label}</option>
            ))}
          </select>
        </label>
        <NumField label="X, м" hint={H.x('nozzle')} value={nozzle.x} onChange={(x) => patch({ x })} />
        <NumField label="Y, м" hint={H.y('nozzle')} value={nozzle.y} onChange={(y) => patch({ y })} />
        <NumField label="Z, м" hint={H.z('nozzle')} value={nozzle.z} onChange={(z) => patch({ z })} />
        <NumField
          label="Наклон, °"
          hint={H.tilt('nozzle', nozzle.kind)}
          value={nozzle.tiltDeg}
          step={1}
          min={-90}
          max={90}
          onChange={(v) => patch({ tiltDeg: Math.max(-90, Math.min(90, v)) })}
        />
        <NumField label="Азимут, °" hint={H.heading('nozzle')} value={nozzle.headingDeg} step={5} onChange={(v) => patch({ headingDeg: ((v % 360) + 360) % 360 })} />
        <NumField label="Высота струи, м" hint={H.height(nozzle.kind)} value={nozzle.maxHeightM} step={0.5} onChange={(v) => patch({ maxHeightM: Math.max(0.1, v) })} />
        <NumField
          label="Диаметр струи, мм"
          hint={H.diameter(nozzle.kind)}
          value={Math.round(nozzle.widthM * 1000)}
          step={1}
          onChange={(v) => patch({ widthM: Math.max(0.002, v / 1000) })}
        />
        <label className="field">
          <FieldName label="Распыление, %" hint={H.spray(nozzle.kind)} />{' '}
          <input
            className="input input-num"
            type="number"
            min={Math.round(SPRAY_RANGE[nozzle.kind][0] * 100)}
            max={Math.round(SPRAY_RANGE[nozzle.kind][1] * 100)}
            step={5}
            value={Math.round(clampSpray(nozzle.kind, nozzle.sprayFactor ?? 0.3) * 100)}
            onChange={(e) => patch({ sprayFactor: clampSpray(nozzle.kind, Number(e.target.value) / 100) })}
          />
        </label>
        {nozzle.kind === 'variable' && (
          <NumField
            label="Угол раскрытия конуса, °"
            hint={H.coneAngle}
            value={nozzle.coneAngleDeg}
            step={1}
            onChange={(v) => patch({ coneAngleDeg: Math.max(1, Math.min(90, v)) })}
          />
        )}
        {nozzle.kind === 'orbit' && (
          <label className="field">
            <FieldName label="Сопло" hint={H.orbitFace} />{' '}
            <select
              className="input"
              value={nozzle.orbitFaceOut !== false ? 'turn' : 'fixed'}
              onChange={(e) => patch({ orbitFaceOut: e.target.value === 'turn' })}
            >
              <option value="fixed">Статичное</option>
              <option value="turn">Динамическое</option>
            </select>
          </label>
        )}
        {nozzle.kind === 'orbit' && (
          <NumField
            label="Радиус объезда, м"
            hint={H.orbitRadius}
            value={nozzle.orbitRadiusM ?? 0}
            step={0.1}
            min={0}
            max={50}
            onChange={(v) => patch({ orbitRadiusM: Math.max(0, Math.min(50, v)) })}
          />
        )}
        {(nozzle.kind === 'rotating' || nozzle.kind === 'orbit') && (
          <>
            <NumField
              label={nozzle.kind === 'orbit' ? 'Скорость объезда, °/с' : 'Скорость вращения, °/с'}
              hint={H.speed(nozzle.kind)}
              value={nozzle.rotationSpeedDegPerSec}
              step={5}
              min={0}
              max={720}
              onChange={(v) => patch({ rotationSpeedDegPerSec: Math.max(0, Math.min(720, Math.abs(v))) })}
            />
            <label className="field">
              <FieldName label="Направление" hint={H.spinDir} />{' '}
              <select
                className="input"
                value={nozzle.spinCcw ? 'ccw' : 'cw'}
                onChange={(e) => patch({ spinCcw: e.target.value === 'ccw' })}
              >
                <option value="cw">По часовой</option>
                <option value="ccw">Против часовой</option>
              </select>
            </label>
            <NumField
              label="Сопел в сборке, шт."
              hint={H.jetCount}
              value={nozzle.jetCount ?? 1}
              step={1}
              min={1}
              max={20}
              onChange={(v) => patch({ jetCount: Math.max(1, Math.min(20, Math.round(v))) })}
            />
          </>
        )}
        <NumField
          label="Время разгона, мс"
          hint={H.rise}
          value={nozzle.riseMs}
          step={100}
          onChange={(v) => patch({ riseMs: Math.max(0, Math.round(v)) })}
        />
        <NumField
          label="Время торможения, мс"
          hint={H.fall}
          value={nozzle.fallMs}
          step={100}
          onChange={(v) => patch({ fallMs: Math.max(0, Math.round(v)) })}
        />
        <h3>Привязка</h3>
        <ModelSelect
          slot="nozzle"
          file={nozzle.modelFile}
          scale={nozzle.modelScale}
          onFile={(f) => patch({ modelFile: f })}
          onScale={(v) => patch({ modelScale: v })}
        />
        <ExtraBindings
          project={project}
          label={nozzle.kind === 'variable' ? 'Насос прямой струи' : 'Насос'}
          hint={H.bindPump(nozzle.kind === 'variable')}
          kind="pump"
          value={nozzle.pumpDeviceId}
          onValue={(id) => patch({ pumpDeviceId: id })}
          ids={nozzle.extraPumpDeviceIds}
          onChange={(ids) => patch({ extraPumpDeviceIds: ids })}
        />
        {nozzle.kind === 'variable' &&
          nozzlePumpIds(nozzle).some((id) => nozzlePump2Ids(nozzle).includes(id)) && (
            <p className="warn">
              Один и тот же насос назначен и на прямую струю, и на раскрытие конуса. Это два независимых
              насоса: пока они привязаны к одному прибору, раскрытие будет меняться вместе с
              напором, и вариативная форсунка ведёт себя как обычная.
            </p>
          )}
        {nozzle.kind === 'variable' && (
          <ExtraBindings
            project={project}
            label="Насос раскрытия конуса"
            hint={H.bindPump2}
            kind="pump"
            value={nozzle.pump2DeviceId}
            onValue={(id) => patch({ pump2DeviceId: id })}
            ids={nozzle.extraPump2DeviceIds}
            onChange={(ids) => patch({ extraPump2DeviceIds: ids })}
          />
        )}
        <ExtraBindings
          project={project}
          label="Клапан"
          hint={H.bindValve}
          kind="valve"
          value={nozzle.valveDeviceId}
          onValue={(id) => patch({ valveDeviceId: id })}
          ids={nozzle.extraValveDeviceIds}
          onChange={(ids) => patch({ extraValveDeviceIds: ids })}
        />
        <ExtraBindings
          project={project}
          label="Подсветка"
          hint={H.bindLight}
          kind="lamp"
          value={nozzle.lightDeviceId}
          onValue={(id) => patch({ lightDeviceId: id })}
          ids={nozzle.extraLightDeviceIds}
          onChange={(ids) => patch({ extraLightDeviceIds: ids })}
        />
      </div>
      <LiveDebug
        project={project}
        frames={frames}
        send={send}
        pumps={pumpFaders([nozzle])}
        valveIds={nozzleValveIds(nozzle)}
        lightIds={nozzleLightIds(nozzle)}
        hint="Привяжите насос, клапан или светильник выше — здесь появится управление ими."
      />
      <div className="element-actions">
        <button className="btn btn-small" onClick={duplicate}>
          Дублировать
        </button>
        <button className="btn btn-small btn-danger" onClick={() => void remove()}>
          Удалить
        </button>
      </div>
    </section>
  );
}

function LightProps({
  project,
  light,
  setLayout,
  onSelect,
  send,
  ask,
  frames,
}: {
  project: Project;
  light: LayoutLight | undefined;
  setLayout: (l: FountainLayout) => void;
  onSelect: (s: Selected) => void;
  send: EngineConnection['send'];
  ask: Ask;
  /** Живые кадры DMX — нужны отладке, чтобы показывать фактическое состояние приборов. */
  frames: Record<number, Uint8Array>;
}) {
  if (!light) return null;
  const layout = project.layout;
  const patch = (p: Partial<LayoutLight>): void =>
    setLayout({ ...layout, lights: layout.lights.map((l) => (l.id === light.id ? { ...l, ...p } : l)) });
  return (
    <section className="panel">
      <h2>Прожектор</h2>
      <div className="field-grid">
        <label className="field">
          <FieldName label="Имя" hint={H.name('light')} />{' '}
          <input className="input" value={light.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <NumField label="X, м" hint={H.x('light')} value={light.x} onChange={(x) => patch({ x })} />
        <NumField label="Y, м" hint={H.y('light')} value={light.y} onChange={(y) => patch({ y })} />
        <NumField label="Z, м" hint={H.z('light')} value={light.z} onChange={(z) => patch({ z })} />
        <NumField
          label="Наклон, °"
          hint={H.tilt('light')}
          value={light.tiltDeg}
          step={5}
          onChange={(v) => patch({ tiltDeg: Math.max(0, Math.min(180, v)) })}
        />
        <NumField
          label="Азимут, °"
          hint={H.heading('light')}
          value={light.headingDeg}
          step={5}
          onChange={(v) => patch({ headingDeg: ((v % 360) + 360) % 360 })}
        />
        <NumField
          label="Угол луча, °"
          hint={H.beamAngle}
          value={light.beamAngleDeg}
          step={5}
          onChange={(v) => patch({ beamAngleDeg: Math.max(1, Math.min(170, v)) })}
        />
        <NumField
          label="Дальность, м"
          hint={H.beamRange}
          value={light.rangeM}
          step={0.5}
          onChange={(v) => patch({ rangeM: Math.max(0.1, v) })}
        />
        <NumField
          label="Размер корпуса, мм"
          hint={H.lightSize}
          value={Math.round((light.sizeM ?? 0.16) * 1000)}
          step={10}
          onChange={(v) => patch({ sizeM: Math.min(1, Math.max(0.03, v / 1000)) })}
        />
        <NumField
          label="Плотность луча, %"
          hint={H.beamDensity}
          value={Math.round((light.beamDensity ?? LIGHT_DEFAULTS.beamDensity) * 100)}
          step={5}
          onChange={(v) => patch({ beamDensity: Math.min(1, Math.max(0, v / 100)) })}
        />
        <ModelSelect
          slot="light"
          file={light.modelFile}
          scale={light.modelScale}
          onFile={(f) => patch({ modelFile: f })}
          onScale={(v) => patch({ modelScale: v })}
        />
        <label className="field">
          <FieldName label="Прибор" hint={H.lightDevice} />{' '}
          <DeviceSelect project={project} kind="lamp" value={light.deviceId} onChange={(id) => patch({ deviceId: id })} />
        </label>
      </div>
      <LiveDebug
        project={project}
        frames={frames}
        send={send}
        lightIds={light.deviceId ? [light.deviceId] : []}
        hint="Привяжите прибор выше — отсюда можно будет зажечь его и убедиться, что это тот самый светильник."
      />
      <div className="element-actions">
        <button
          className="btn btn-small"
          onClick={() => {
            const copy: LayoutLight = { ...light, id: uid(), name: `${light.name} (копия)`, x: light.x + 0.5 };
            setLayout({ ...layout, lights: [...layout.lights, copy] });
            onSelect({ type: 'light', id: copy.id });
          }}
        >
          Дублировать
        </button>
        <button
          className="btn btn-small btn-danger"
          onClick={() =>
            void (async () => {
              if (!(await ask(`Удалить прожектор «${light.name}»?`))) return;
              setLayout({ ...layout, lights: layout.lights.filter((l) => l.id !== light.id) });
              onSelect(null);
            })()
          }
        >
          Удалить
        </button>
      </div>
    </section>
  );
}

function BowlProps({
  bowl,
  layout,
  setLayout,
  onSelect,
  ask,
}: {
  bowl: Bowl | undefined;
  layout: FountainLayout;
  setLayout: (l: FountainLayout) => void;
  onSelect: (s: Selected) => void;
  ask: Ask;
}) {
  if (!bowl) return null;
  const patch = (p: Partial<Bowl>): void =>
    setLayout({ ...layout, bowls: layout.bowls.map((b) => (b.id === bowl.id ? { ...b, ...p } : b)) });
  return (
    <section className="panel">
      <h2>Чаша</h2>
      <div className="field-grid">
        <label className="field">
          <FieldName label="Имя" hint={H.name('bowl')} />{' '}
          <input className="input" value={bowl.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="field">
          <FieldName label="Форма" hint={H.bowlShape} />{' '}
          <select className="input" value={bowl.shape} onChange={(e) => patch({ shape: e.target.value as Bowl['shape'] })}>
            <option value="circle">Круглая</option>
            <option value="rect">Прямоугольная</option>
          </select>
        </label>
        <NumField label="X, м" hint={H.x('bowl')} value={bowl.x} onChange={(x) => patch({ x })} />
        <NumField label="Y, м" hint={H.y('bowl')} value={bowl.y} onChange={(y) => patch({ y })} />
        {bowl.shape === 'circle' ? (
          <NumField label="Радиус, м" hint={H.bowlRadius} value={bowl.radius} step={0.5} onChange={(v) => patch({ radius: Math.max(0.1, v) })} />
        ) : (
          <>
            <NumField label="Ширина (X), м" hint={H.bowlWidth} value={bowl.width} step={0.5} onChange={(v) => patch({ width: Math.max(0.1, v) })} />
            <NumField label="Длина (Y), м" hint={H.bowlLength} value={bowl.length} step={0.5} onChange={(v) => patch({ length: Math.max(0.1, v) })} />
          </>
        )}
        <NumField label="Борт, м" hint={H.bowlRim} value={bowl.height} step={0.1} onChange={(v) => patch({ height: Math.max(0, v) })} />
        <NumField
          label="Отметка дна, м"
          hint={H.bowlElevation}
          value={bowl.elevationM ?? 0}
          step={0.1}
          onChange={(v) => patch({ elevationM: v })}
        />
        <NumField
          label="Глубина воды, м"
          hint={H.bowlDepth}
          value={bowl.waterDepthM ?? 0.25}
          step={0.05}
          onChange={(v) => patch({ waterDepthM: Math.max(0, v) })}
        />
        {bowl.shape === 'rect' && (
          <NumField
            label="Скругление углов, м"
            hint={H.bowlCorner}
            value={bowl.cornerRadiusM ?? 0}
            step={0.1}
            onChange={(v) => patch({ cornerRadiusM: Math.max(0, v) })}
          />
        )}
        <ModelSelect
          slot="bowl"
          file={bowl.modelFile}
          scale={bowl.modelScale}
          onFile={(f) => patch({ modelFile: f })}
          onScale={(v) => patch({ modelScale: v })}
        />
        <h3>Что показывать</h3>
        <label className="field">
          <input type="checkbox" checked={bowl.showRim !== false} onChange={(e) => patch({ showRim: e.target.checked })} />{' '}
          <span className="field-name has-hint" data-hint={H.showRim}>Борт</span>
        </label>
        <label className="field">
          <input type="checkbox" checked={bowl.showWater !== false} onChange={(e) => patch({ showWater: e.target.checked })} />{' '}
          <span className="field-name has-hint" data-hint={H.showWater}>Зеркало воды</span>
        </label>
        <label className="field">
          <input type="checkbox" checked={bowl.showFloor !== false} onChange={(e) => patch({ showFloor: e.target.checked })} />{' '}
          <span className="field-name has-hint" data-hint={H.showFloor}>Дно</span>
        </label>
        <h3>Перелив</h3>
        <label className="field">
          <input type="checkbox" checked={bowl.spillover === true} onChange={(e) => patch({ spillover: e.target.checked })} />{' '}
          <span className="field-name has-hint" data-hint={H.spillover}>Перелив через борт</span>
        </label>
        {bowl.spillover && (
          <NumField
            label="Высота плёнки, м"
            hint={H.spillDrop}
            value={bowl.spilloverDropM ?? 0.6}
            step={0.1}
            onChange={(v) => patch({ spilloverDropM: Math.max(0.02, v) })}
          />
        )}
      </div>
      <div className="sidebar-actions">
        <button
          className="btn btn-small"
          onClick={() => {
            const copy: Bowl = { ...bowl, id: uid(), name: `${bowl.name} (копия)`, x: bowl.x + 0.5 };
            setLayout({ ...layout, bowls: [...layout.bowls, copy] });
            onSelect({ type: 'bowl', id: copy.id });
          }}
        >
          Дублировать
        </button>
        <button
          className="btn btn-small btn-danger"
          onClick={() =>
            void (async () => {
              if (!(await ask(`Удалить чашу «${bowl.name}»?`))) return;
              setLayout({ ...layout, bowls: layout.bowls.filter((b) => b.id !== bowl.id) });
              onSelect(null);
            })()
          }
        >
          Удалить
        </button>
      </div>
    </section>
  );
}

/**
 * Контур (§27 доработки) — панель массового редактирования группы форсунок:
 * общий тип/высота/диаметр, поворот и сдвиг всей группы разом. В отличие от
 * Мастера нового объекта (одноразовый штамп при создании), группа сохраняется
 * и позволяет вернуться к ней позже.
 */
function GroupProps({
  group,
  project,
  layout,
  setLayout,
  onSelect,
  send,
  frames,
}: {
  group: NozzleGroup | undefined;
  project: Project;
  layout: FountainLayout;
  setLayout: (l: FountainLayout) => void;
  onSelect: (s: Selected) => void;
  send: EngineConnection['send'];
  /** Живые кадры DMX — нужны отладке, чтобы показывать фактическое состояние приборов. */
  frames: Record<number, Uint8Array>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  // Форсунки контура — их свойства правятся общим блоком NozzleBulkFields,
  // тем же, что и у временного выделения: раньше здесь была отдельная секция
  // с полями-заготовками и кнопками «— всем», из-за чего набор свойств у
  // контура и у выделенных форсунок различался, а цифры в полях выглядели
  // рассинхроном с реальными значениями участников.
  const memberNozzles = layout.nozzles.filter((n) => group?.nozzleIds.includes(n.id));

  if (!group) return null;
  const patch = (p: Partial<NozzleGroup>): void =>
    setLayout({ ...layout, nozzleGroups: layout.nozzleGroups.map((g) => (g.id === group.id ? { ...g, ...p } : g)) });
  const toggleNozzle = (id: string): void => {
    const has = group.nozzleIds.includes(id);
    patch({ nozzleIds: has ? group.nozzleIds.filter((x) => x !== id) : [...group.nozzleIds, id] });
  };
  const toggleLight = (id: string): void => {
    const has = group.lightIds.includes(id);
    patch({ lightIds: has ? group.lightIds.filter((x) => x !== id) : [...group.lightIds, id] });
  };
  const allIn =
    layout.nozzles.length + layout.lights.length > 0 &&
    group.nozzleIds.length === layout.nozzles.length &&
    group.lightIds.length === layout.lights.length;
  const centroid = nozzleGroupCentroid(layout.nozzles, group.nozzleIds, layout.lights, group.lightIds);

  /**
   * Сдвиг контура. Поля показывают, на сколько он уже сдвинут от исходного
   * места, двигаем на разницу — поэтому кнопки «Сдвинуть» нет, контур едет
   * сразу при правке числа. Высота тоже двигается: ярус фонтана поднимают
   * целиком, а не по одной форсунке.
   */
  const setOffset = (axis: 'offsetX' | 'offsetY' | 'offsetZ', value: number): void => {
    const next = Math.round(value * 1000) / 1000;
    const delta = next - (group[axis] ?? 0);
    if (delta === 0) return;
    const moved = translateGroup(
      layout,
      group.nozzleIds,
      group.lightIds,
      axis === 'offsetX' ? delta : 0,
      axis === 'offsetY' ? delta : 0,
      axis === 'offsetZ' ? delta : 0,
    );
    setLayout({
      ...layout,
      nozzles: moved.nozzles,
      lights: moved.lights,
      nozzleGroups: layout.nozzleGroups.map((g) => (g.id === group.id ? { ...g, [axis]: next } : g)),
    });
  };

  /**
   * Поворот контура вокруг собственного центра. Поле показывает АБСОЛЮТНЫЙ
   * угол, а поворачиваем на разницу с прошлым значением — поэтому кнопка
   * «Повернуть» не нужна: набрал 30° вместо 15° — контур довернулся на 15°.
   */
  const setRotation = (deg: number): void => {
    const next = Math.round(deg);
    const delta = next - (group.rotationDeg ?? 0);
    const moved = delta === 0 ? { nozzles: layout.nozzles, lights: layout.lights } : rotateGroup(layout, group.nozzleIds, group.lightIds, delta);
    setLayout({
      ...layout,
      nozzles: moved.nozzles,
      lights: moved.lights,
      nozzleGroups: layout.nozzleGroups.map((g) => (g.id === group.id ? { ...g, rotationDeg: next } : g)),
    });
  };

  return (
    <section className="panel">
      <h2>Контур</h2>
      <div className="field-grid">
        <label className="field">
          <FieldName label="Имя" hint={H.name('group')} />{' '}
          {renaming ? (
            <input
              className="input"
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                if (nameDraft.trim()) patch({ name: nameDraft.trim() });
                setRenaming(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                else if (e.key === 'Escape') setRenaming(false);
              }}
            />
          ) : (
            <span className="input-title">{group.name}</span>
          )}
          <button
            className="icon-btn"
            data-hint="Переименовать"
            onClick={() => {
              setNameDraft(group.name);
              setRenaming(true);
            }}
          >
            <PencilIcon />
          </button>
        </label>
        <span className="dim">
          В контуре: форсунок {group.nozzleIds.length}, прожекторов {group.lightIds.length}; центр:{' '}
          {num(centroid.x, 2)}; {num(centroid.y, 2)} м
        </span>
      </div>

      <h3 className="list-head">
        <span className="field-name has-hint" data-hint={H.groupMembers}>
          Состав
        </span>
        <button
          className={allIn ? 'btn btn-small state-on' : 'btn btn-small'}
          data-hint={allIn ? 'Убрать из контура всё' : 'Включить в контур всё'}
          onClick={() =>
            allIn
              ? patch({ nozzleIds: [], lightIds: [] })
              : patch({ nozzleIds: layout.nozzles.map((n) => n.id), lightIds: layout.lights.map((l) => l.id) })
          }
        >
          {allIn ? 'снять все' : 'все'}
        </button>
      </h3>
      <div className="utility-device-list">
        {layout.nozzles.map((n) => (
          <label key={n.id} className="field">
            <input type="checkbox" checked={group.nozzleIds.includes(n.id)} onChange={() => toggleNozzle(n.id)} />{' '}
            {n.name}
          </label>
        ))}
        {layout.lights.map((l) => (
          <label key={l.id} className="field">
            <input type="checkbox" checked={group.lightIds.includes(l.id)} onChange={() => toggleLight(l.id)} />{' '}
            {l.name}
          </label>
        ))}
      </div>

      <h3>Общие свойства форсунок контура</h3>
      <div className="field-grid">
        <NozzleBulkFields project={project} ids={group.nozzleIds} setLayout={setLayout} />
      </div>

      <h3>
        <span className="field-name has-hint" data-hint={H.groupRotation}>
          Поворот контура вокруг своей оси
        </span>
      </h3>
      <div className="form-row">
        <input
          className="input input-num"
          type="number"
          step={5}
          value={group.rotationDeg ?? 0}
          disabled={group.nozzleIds.length + group.lightIds.length === 0}
          onChange={(e) => setRotation(Number(e.target.value) || 0)}
        />
        <span className="dim">°</span>
        <input
          type="range"
          min={0}
          max={360}
          step={1}
          value={((((group.rotationDeg ?? 0) % 360) + 360) % 360)}
          disabled={group.nozzleIds.length + group.lightIds.length === 0}
          onChange={(e) => setRotation(Number(e.target.value))}
        />
      </div>
      <h3>Сдвиг контура</h3>
      <div className="field-grid">
        {(
          [
            ['offsetX', 'X, м'],
            ['offsetY', 'Y, м'],
            ['offsetZ', 'Z, м'],
          ] as const
        ).map(([axis, label]) => (
          <label className="field" key={axis}>
            <FieldName label={label} hint={axis === 'offsetX' ? H.x('group') : axis === 'offsetY' ? H.y('group') : H.z('group')} />{' '}
            <input
              className="input input-num"
              type="number"
              step={0.1}
              value={group[axis] ?? 0}
              disabled={group.nozzleIds.length + group.lightIds.length === 0}
              onChange={(e) => setOffset(axis, Number(e.target.value) || 0)}
            />
          </label>
        ))}
      </div>

      <LiveDebug
        project={project}
        frames={frames}
        send={send}
        pumps={pumpFaders(memberNozzles)}
        valveIds={[...new Set(memberNozzles.flatMap(nozzleValveIds))]}
        lightIds={[...new Set(memberNozzles.flatMap(nozzleLightIds))]}
        hint="У форсунок контура нет привязанных приборов."
      />
      <div className="sidebar-actions">
        <button
          className="btn btn-small btn-danger"
          data-hint="Форсунки и прожекторы останутся на схеме"
          onClick={() => {
            void (async () => {
              const ok = await askConfirm(`Удалить контур «${group.name}»?`, {
                detail:
                  `Удалится только сам контур — группировка. Его элементы (форсунок ${group.nozzleIds.length}, ` +
                  `прожекторов ${group.lightIds.length}) останутся на схеме на своих местах.`,
                okLabel: 'Удалить контур',
              });
              if (!ok) return;
              setLayout({ ...layout, nozzleGroups: layout.nozzleGroups.filter((g) => g.id !== group.id) });
              onSelect(null);
            })();
          }}
        >
          Удалить контур
        </button>
      </div>
    </section>
  );
}
