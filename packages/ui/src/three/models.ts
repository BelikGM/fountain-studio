import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Подключение собственных 3D-моделей (.glb/.gltf) вместо встроенной геометрии.
 *
 * В поставке есть свой набор моделей — форсунки, чаши и прожекторы, собранные
 * процедурно в Blender по каталожным пропорциям (см. packages/ui/public/models).
 * Готовых моделей фонтанной арматуры со свободной лицензией в открытых
 * библиотеках нет: на Poly Haven мебель и утварь, а на Sketchfab лицензия у
 * каждой модели своя. Поэтому набор собран сам, а рядом оставлен механизм, чтобы
 * подключить и чужие модели.
 *
 * Моделей две папки, и обе просматриваются:
 *
 *  · ВСТРОЕННАЯ — packages/ui/public/models в исходниках. Попадает внутрь
 *    собранного приложения и там доступна только на чтение: это набор,
 *    который поставляется вместе с программой.
 *  · ПОЛЬЗОВАТЕЛЬСКАЯ — «Документы\\Fountain Studio\\models», рядом с
 *    fountain.config.json и проектом. Её и надо наполнять на рабочем месте:
 *    установленное приложение туда пишет и читает, обновление программы её не
 *    трогает. В собранном приложении она отдаётся через схему usermodels://
 *    (см. packages/app/main.cjs); при работе через браузер по localhost этой
 *    схемы нет, и остаётся только встроенная папка.
 *
 * Имя файла у модели одно на обе папки: в проекте хранится именно имя, а не
 * путь, — проект должен открываться на другой машине.
 */

/** Что модель заменяет. */
export type ModelSlot = 'nozzle' | 'light' | 'bowl';

export interface ModelEntry {
  /** Имя файла (без путей). */
  file: string;
  /** Как называть в списке. */
  name: string;
  /**
   * Для чего модель. Если в index.json не указано или указано непонятное —
   * модель показывается во всех трёх списках: лучше предложить лишнее, чем
   * молча спрятать файл, который человек положил.
   */
  for: ModelSlot | 'any';
  /** Автор и лицензия — чтобы через год было понятно, что можно, а что нельзя. */
  credit?: string;
  license?: string;
}

/** Встроенная папка. base='./' в сборке — работает и с file:// в Electron. */
const BUILT_IN = './models/';
/** Пользовательская папка — только в собранном приложении. */
const USER = 'usermodels://local/';

/**
 * Имя файла безопасно: только имя, без путей и подъёма по дереву. Список
 * приходит из файла, который редактируется руками, а имя идёт прямо в адрес.
 */
export function safeModelFile(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const s = name.trim();
  if (!s || s.includes('/') || s.includes('\\') || s.includes('..')) return null;
  if (!/\.(glb|gltf)$/i.test(s)) return null;
  return s;
}

const SLOTS: readonly string[] = ['nozzle', 'light', 'bowl'];

function readDir(base: string): Promise<{ entry: ModelEntry; base: string }[]> {
  return fetch(base + 'index.json')
    .then((r) => (r.ok ? r.json() : { models: [] }))
    .then((j: { models?: Partial<ModelEntry>[] }) =>
      (j.models ?? [])
        .map((m) => {
          const file = safeModelFile(m.file);
          if (!file) return null;
          const slot = typeof m.for === 'string' && SLOTS.includes(m.for) ? (m.for as ModelSlot) : 'any';
          return { entry: { ...m, file, name: m.name || file, for: slot } as ModelEntry, base };
        })
        .filter((x): x is { entry: ModelEntry; base: string } => x !== null),
    )
    .catch(() => []);
}

let catalogPromise: Promise<{ entries: ModelEntry[]; base: Map<string, string> }> | null = null;

function catalog(): Promise<{ entries: ModelEntry[]; base: Map<string, string> }> {
  if (!catalogPromise) {
    // Пользовательская папка читается ВТОРОЙ и перекрывает встроенную: файл с
    // тем же именем, положенный на рабочем месте, важнее поставочного.
    catalogPromise = Promise.all([readDir(BUILT_IN), readDir(USER)]).then(([builtIn, user]) => {
      const base = new Map<string, string>();
      const byFile = new Map<string, ModelEntry>();
      for (const { entry, base: b } of [...builtIn, ...user]) {
        base.set(entry.file, b);
        byFile.set(entry.file, entry);
      }
      return { entries: [...byFile.values()], base };
    });
  }
  return catalogPromise;
}

/** Список доступных моделей. Пустой список — это норма. */
export function modelCatalog(): Promise<ModelEntry[]> {
  return catalog().then((c) => c.entries);
}

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Object3D>>();

/**
 * Загружает модель (с кэшем по имени файла) и возвращает ОБРАЗЕЦ — его нельзя
 * добавлять в сцену напрямую, для каждого элемента берётся clone().
 */
async function loadModel(file: string): Promise<THREE.Object3D> {
  let p = cache.get(file);
  if (!p) {
    p = catalog().then(
      (c) =>
        new Promise<THREE.Object3D>((res, rej) => {
          // Имени нет в каталоге — файл вписан в проект руками; пробуем в
          // пользовательской папке, потом во встроенной.
          const base = c.base.get(file);
          const fail = (): void => rej(new Error('модель не найдена: ' + file));
          const tryLoad = (b: string, onFail: () => void): void => {
            loader.load(b + file, (gltf) => res(gltf.scene), undefined, onFail);
          };
          if (base) tryLoad(base, fail);
          else tryLoad(USER, () => tryLoad(BUILT_IN, fail));
        }),
    );
    cache.set(file, p);
  }
  return p;
}

/**
 * Готовая копия модели, приведённая к нужному габариту и к системе координат
 * сцены.
 *
 * glTF по спецификации Y-вверх, а сцена здесь Z-вверх (так удобнее для плана
 * площадки), поэтому копия поворачивается на 90° вокруг X. Размер приводится к
 * заданному габариту по наибольшей стороне: модели рисуют в каких угодно
 * единицах, и без нормировки одна прилетает миллиметровой, другая с дом.
 */
export async function instantiateModel(
  file: string,
  /** Целевой наибольший габарит, м. */
  targetSizeM: number,
  /** Пользовательский множитель поверх нормировки. */
  scale: number,
): Promise<THREE.Object3D> {
  const src = await loadModel(file);
  const root = new THREE.Group();
  const obj = src.clone(true);
  // clone() копирует объекты, но материалы оставляет ОБЩИМИ на все копии. Для
  // подсветки выделения этого мало: покрасив одну форсунку, покрасили бы все с
  // такой же моделью. Даём каждому экземпляру свои материалы.
  obj.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((m) => m.clone())
      : mesh.material.clone();
  });
  // Y-вверх → Z-вверх.
  obj.rotation.x = Math.PI / 2;
  root.add(obj);

  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const largest = Math.max(size.x, size.y, size.z);
  const k = largest > 1e-6 ? (targetSizeM / largest) * Math.max(0.01, scale) : Math.max(0.01, scale);
  obj.scale.multiplyScalar(k);

  // Ставим модель на её собственный низ: у элементов сцены точка привязки —
  // основание, а у моделей начало координат бывает где угодно.
  root.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(root);
  obj.position.z -= box2.min.z;
  return root;
}
