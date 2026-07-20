/**
 * 3D-сцена фонтана (Three.js). Ось Z — вверх (план как на чертеже: X вправо, Y вглубь).
 *
 * Сцена рисует статичную схему (чаши, форсунки-конусы, прожекторы-сферы) и живые
 * струи: частицы с баллистикой (v0 из высоты струи, гравитация), значение насоса
 * проходит фильтр первого порядка (инерция давления riseMs/fallMs), клапан режет
 * струю быстро («дожим» ~150 мс). Цвет частиц — от привязанного прожектора.
 * Данные каждый кадр берутся из hooks.live — реакт-сторона читает их из DMX-кадров.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { FountainLayout, Nozzle, NozzleKind } from '@fountain-studio/shared';

export type SelectedElement = { type: 'nozzle' | 'light'; id: string } | null;

export interface SceneHooks {
  onSelect(sel: SelectedElement): void;
  /** Перетаскивание элемента по плану: во время движения и при отпускании. */
  onMove(type: 'nozzle' | 'light', id: string, x: number, y: number): void;
  onMoveEnd(type: 'nozzle' | 'light', id: string, x: number, y: number): void;
  live: {
    /** Цель струи 0..1 по DMX (насос+клапан); cut — клапан закрыт (резкий спад). */
    nozzleFlow(n: Nozzle): { flow: number; cut: boolean };
    /** Второй насос вариативной форсунки (kind='variable') — 0..1, раскрытие конуса. 0, если не привязан. */
    pump2Level(n: Nozzle): number;
    /** Цвет прожектора 0..1 или null, если не привязан/нет данных. */
    lightColor(deviceId: string | null): [number, number, number] | null;
  };
}

/** Поведение струи по типу форсунки. */
const KIND_PHYSICS: Record<
  NozzleKind,
  {
    /** Разброс конуса, градусы (для ring — толщина кольца). */
    spreadDeg: number;
    /** Частиц в секунду при полной струе. */
    rate: number;
    /** Кольцевая струя: полярный угол кольца от вертикали. */
    ringDeg?: number;
    /** Плоский веер: разброс в плоскости heading. */
    planar?: boolean;
    /** Плюс центральная струя (цветок). */
    central?: boolean;
    /** Белая пена вместо прозрачной воды. */
    foam?: boolean;
    /** Торможение воздухом (туман), 1/с. */
    drag?: number;
    /** Вращение направления, град/с. */
    rotateDegPerS?: number;
    /** Масштаб скорости вылета (вуаль ниже при той же высоте). */
    vScale?: number;
  }
> = {
  straight: { spreadDeg: 2, rate: 420 },
  laminar: { spreadDeg: 0.4, rate: 260 },
  fan: { spreadDeg: 55, rate: 520, planar: true },
  canopy: { spreadDeg: 4, rate: 520, ringDeg: 40 },
  flower: { spreadDeg: 4, rate: 520, ringDeg: 28, central: true },
  veil: { spreadDeg: 6, rate: 600, ringDeg: 55, vScale: 0.8 },
  mist: { spreadDeg: 30, rate: 650, drag: 2.6 },
  foam: { spreadDeg: 7, rate: 750, foam: true },
  // Скорость вращения — per-nozzle из n.rotationSpeedDegPerSec (см. simulate()), не константа типа.
  rotating: { spreadDeg: 3, rate: 420 },
  // spreadDeg (минимальный, «собранный») переопределяется вверх до n.coneAngleDeg
  // напором второго насоса (см. simulate()) — двухнасосная форсунка меняет раскрытие
  // конуса напором, не типом.
  variable: { spreadDeg: 2, rate: 480 },
};

const G = 9.81;
const MAX_PARTICLES = 24000;
/** Базовый цвет воды без подсветки (тускло-голубой). */
const WATER_DIM: [number, number, number] = [0.16, 0.22, 0.3];
/** Исходное положение камеры — и при старте, и при «сбросе камеры» (§27 доработки). */
const CAMERA_INITIAL = { position: new THREE.Vector3(10, -14, 9), target: new THREE.Vector3(0, 0, 1) };

export class FountainScene {
  hooks: SceneHooks;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private container: HTMLElement;
  private resizeObserver: ResizeObserver;
  private raf = 0;
  private lastT = performance.now();

  private staticGroup = new THREE.Group();
  private nozzleMeshes = new Map<string, THREE.Mesh>();
  private lightMeshes = new Map<string, THREE.Mesh>();
  private layout: FountainLayout = { bowls: [], nozzles: [], lights: [] };
  private selected: SelectedElement = null;

  // Частицы: параллельные массивы, компактирование свопом с хвостом.
  private particles: THREE.Points;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private px = new Float32Array(MAX_PARTICLES);
  private py = new Float32Array(MAX_PARTICLES);
  private pz = new Float32Array(MAX_PARTICLES);
  private vx = new Float32Array(MAX_PARTICLES);
  private vy = new Float32Array(MAX_PARTICLES);
  private vz = new Float32Array(MAX_PARTICLES);
  private pr = new Float32Array(MAX_PARTICLES);
  private pg = new Float32Array(MAX_PARTICLES);
  private pb = new Float32Array(MAX_PARTICLES);
  private drag = new Float32Array(MAX_PARTICLES);
  private alive = 0;

  /** Сглаженное значение струи и накопитель эмиссии по id форсунки. */
  private smoothed = new Map<string, number>();
  private emitAcc = new Map<string, number>();
  private rotPhase = new Map<string, number>();

  private dragging: { type: 'nozzle' | 'light'; id: string } | null = null;
  private dragMoved = false;
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private raycaster = new THREE.Raycaster();

  constructor(container: HTMLElement, hooks: SceneHooks) {
    this.container = container;
    this.hooks = hooks;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.style.display = 'block';
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0b0e13);
    this.scene.fog = new THREE.Fog(0x0b0e13, 60, 160);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    this.camera.up.set(0, 0, 1);
    this.camera.position.copy(CAMERA_INITIAL.position);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(CAMERA_INITIAL.target);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 120;

    // Свет для стандартных материалов (частицы — неосвещаемые Points).
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 0.7);
    sun.position.set(20, -30, 40);
    this.scene.add(sun);

    // Земля и сетка 1 м (GridHelper лежит в XZ — поворачиваем в план XY).
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(120, 64),
      new THREE.MeshStandardMaterial({ color: 0x11151c, roughness: 1 }),
    );
    this.scene.add(ground);
    const grid = new THREE.GridHelper(80, 80, 0x2a3442, 0x1a212c);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0.002;
    this.scene.add(grid);

    this.scene.add(this.staticGroup);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setDrawRange(0, 0);
    this.particles = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.09,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);

    this.raf = requestAnimationFrame(this.tick);
  }

  /** Вернуть камеру к исходному положению/цели (§27 доработки — «сброс камеры»). */
  resetCamera(): void {
    this.camera.position.copy(CAMERA_INITIAL.position);
    this.controls.target.copy(CAMERA_INITIAL.target);
    this.controls.update();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    this.renderer.dispose();
    this.container.removeChild(el);
  }

  /** Полная пересборка статичных мешей под новую схему (элементов немного — дёшево). */
  syncLayout(layout: FountainLayout): void {
    this.layout = layout;
    this.staticGroup.clear();
    this.nozzleMeshes.clear();
    this.lightMeshes.clear();

    for (const b of layout.bowls) {
      const wall = new THREE.MeshStandardMaterial({ color: 0x39424f, roughness: 0.8, side: THREE.DoubleSide });
      const water = new THREE.MeshStandardMaterial({
        color: 0x14283c,
        roughness: 0.15,
        metalness: 0.4,
        transparent: true,
        opacity: 0.92,
      });
      if (b.shape === 'circle') {
        const rim = new THREE.Mesh(new THREE.CylinderGeometry(b.radius, b.radius, b.height, 96, 1, true), wall);
        rim.rotation.x = Math.PI / 2;
        rim.position.set(b.x, b.y, b.height / 2);
        this.staticGroup.add(rim);
        const surf = new THREE.Mesh(new THREE.CircleGeometry(b.radius, 96), water);
        surf.position.set(b.x, b.y, 0.01);
        this.staticGroup.add(surf);
      } else {
        const rim = new THREE.Mesh(new THREE.BoxGeometry(b.width, b.length, b.height), wall);
        rim.position.set(b.x, b.y, b.height / 2);
        this.staticGroup.add(rim);
        const surf = new THREE.Mesh(new THREE.PlaneGeometry(b.width, b.length), water);
        surf.position.set(b.x, b.y, 0.011);
        this.staticGroup.add(surf);
      }
    }

    for (const n of layout.nozzles) {
      const mesh = new THREE.Mesh(
        new THREE.ConeGeometry(0.09, 0.28, 16),
        new THREE.MeshStandardMaterial({ color: 0x8a939f, roughness: 0.5, metalness: 0.6 }),
      );
      // Конус смотрит вверх (+Z) и наклоняется по tilt/heading.
      mesh.rotation.x = Math.PI / 2;
      const holder = new THREE.Group();
      holder.add(mesh);
      mesh.position.z = 0.14;
      this.orientHolder(holder, n.tiltDeg, n.headingDeg);
      holder.position.set(n.x, n.y, n.z);
      holder.userData = { type: 'nozzle', id: n.id };
      mesh.userData = holder.userData;
      this.staticGroup.add(holder);
      this.nozzleMeshes.set(n.id, mesh);
    }

    for (const l of layout.lights) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0x333940 }),
      );
      mesh.position.set(l.x, l.y, l.z);
      mesh.userData = { type: 'light', id: l.id };
      this.staticGroup.add(mesh);
      this.lightMeshes.set(l.id, mesh);
    }
    this.applySelection();
  }

  setSelected(sel: SelectedElement): void {
    this.selected = sel;
    this.applySelection();
  }

  private applySelection(): void {
    for (const [id, mesh] of this.nozzleMeshes) {
      const m = mesh.material as THREE.MeshStandardMaterial;
      const sel = this.selected?.type === 'nozzle' && this.selected.id === id;
      m.color.set(sel ? 0xffb347 : 0x8a939f);
      m.emissive.set(sel ? 0x5a3200 : 0x000000);
    }
    for (const [id, mesh] of this.lightMeshes) {
      const sel = this.selected?.type === 'light' && this.selected.id === id;
      mesh.scale.setScalar(sel ? 1.5 : 1);
    }
  }

  private orientHolder(holder: THREE.Object3D, tiltDeg: number, headingDeg: number): void {
    const tilt = (tiltDeg * Math.PI) / 180;
    const heading = (headingDeg * Math.PI) / 180;
    holder.rotation.set(0, 0, 0);
    holder.rotateZ(heading);
    holder.rotateY(tilt);
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------- Мышь: выбор и перетаскивание ----------

  private pointerRay(e: PointerEvent): THREE.Raycaster {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const ray = this.pointerRay(e);
    const targets = [...this.nozzleMeshes.values(), ...this.lightMeshes.values()];
    const hit = ray.intersectObjects(targets, false)[0];
    if (hit) {
      const { type, id } = hit.object.userData as { type: 'nozzle' | 'light'; id: string };
      this.dragging = { type, id };
      this.dragMoved = false;
      this.controls.enabled = false;
      this.renderer.domElement.setPointerCapture(e.pointerId);
      this.hooks.onSelect({ type, id });
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const ray = this.pointerRay(e);
    const pt = new THREE.Vector3();
    if (!ray.ray.intersectPlane(this.groundPlane, pt)) return;
    this.dragMoved = true;
    const x = Math.round(pt.x * 100) / 100;
    const y = Math.round(pt.y * 100) / 100;
    // Двигаем меш сразу (плавность), проект коммитим при отпускании.
    if (this.dragging.type === 'nozzle') {
      const mesh = this.nozzleMeshes.get(this.dragging.id);
      if (mesh?.parent) mesh.parent.position.set(x, y, mesh.parent.position.z);
    } else {
      const mesh = this.lightMeshes.get(this.dragging.id);
      if (mesh) mesh.position.set(x, y, mesh.position.z);
    }
    this.hooks.onMove(this.dragging.type, this.dragging.id, x, y);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const { type, id } = this.dragging;
    this.dragging = null;
    this.controls.enabled = true;
    if (this.dragMoved) {
      const obj = type === 'nozzle' ? this.nozzleMeshes.get(id)?.parent : this.lightMeshes.get(id);
      if (obj) this.hooks.onMoveEnd(type, id, obj.position.x, obj.position.y);
    }
    void e;
  };

  // ---------- Живой кадр ----------

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;

    this.controls.update();
    this.updateLights();
    this.simulate(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private updateLights(): void {
    for (const l of this.layout.lights) {
      const mesh = this.lightMeshes.get(l.id);
      if (!mesh) continue;
      const c = this.hooks.live.lightColor(l.deviceId);
      const m = mesh.material as THREE.MeshBasicMaterial;
      if (!c) m.color.setRGB(0.2, 0.22, 0.25);
      else m.color.setRGB(0.1 + c[0] * 0.9, 0.1 + c[1] * 0.9, 0.1 + c[2] * 0.9);
    }
  }

  private simulate(dt: number): void {
    // Эмиссия новых частиц по каждой форсунке.
    for (const n of this.layout.nozzles) {
      const phys = KIND_PHYSICS[n.kind];
      const { flow, cut } = this.hooks.live.nozzleFlow(n);
      const prev = this.smoothed.get(n.id) ?? 0;
      // Инерция давления: фильтр 1-го порядка; закрытый клапан — «дожим» ~150 мс.
      const rising = flow > prev;
      const tauMs = cut ? Math.min(150, n.fallMs || 150) : rising ? n.riseMs : n.fallMs;
      const k = tauMs <= 0 ? 1 : 1 - Math.exp((-dt * 1000) / tauMs);
      const cur = prev + (flow - prev) * k;
      this.smoothed.set(n.id, cur);
      if (cur < 0.02) continue;

      let heading = n.headingDeg;
      if (n.kind === 'rotating') {
        const phase = (this.rotPhase.get(n.id) ?? 0) + n.rotationSpeedDegPerSec * dt;
        this.rotPhase.set(n.id, phase % 360);
        heading += phase;
      }

      // Вариативная форсунка: конус раскрывается от «собранного» (phys.spreadDeg)
      // до n.coneAngleDeg напором второго насоса — не свойство типа, а живое DMX-значение.
      const spreadDeg =
        n.kind === 'variable'
          ? phys.spreadDeg + this.hooks.live.pump2Level(n) * (n.coneAngleDeg - phys.spreadDeg)
          : phys.spreadDeg;

      const acc = (this.emitAcc.get(n.id) ?? 0) + phys.rate * cur * dt;
      const count = Math.floor(acc);
      this.emitAcc.set(n.id, acc - count);

      const v0 = Math.sqrt(2 * G * n.maxHeightM) * cur * (phys.vScale ?? 1);
      const color = this.nozzleColor(n, phys.foam === true);
      for (let i = 0; i < count && this.alive < MAX_PARTICLES; i++) {
        this.spawn(n, phys, spreadDeg, heading, v0, color);
      }
    }

    // Интеграция: гравитация, торможение (туман), смерть под водой.
    let i = 0;
    while (i < this.alive) {
      this.vz[i]! -= G * dt;
      const d = this.drag[i]!;
      if (d > 0) {
        const f = Math.max(0, 1 - d * dt);
        this.vx[i]! *= f;
        this.vy[i]! *= f;
        this.vz[i]! *= f;
      }
      this.px[i]! += this.vx[i]! * dt;
      this.py[i]! += this.vy[i]! * dt;
      this.pz[i]! += this.vz[i]! * dt;
      if (this.pz[i]! < 0) {
        this.kill(i);
      } else {
        i++;
      }
    }

    // Заливка в атрибуты.
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    for (let j = 0; j < this.alive; j++) {
      pos[j * 3] = this.px[j]!;
      pos[j * 3 + 1] = this.py[j]!;
      pos[j * 3 + 2] = this.pz[j]!;
      col[j * 3] = this.pr[j]!;
      col[j * 3 + 1] = this.pg[j]!;
      col[j * 3 + 2] = this.pb[j]!;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.particles.geometry.setDrawRange(0, this.alive);
  }

  private nozzleColor(n: Nozzle, foam: boolean): [number, number, number] {
    const light = this.hooks.live.lightColor(n.lightDeviceId);
    if (light && (light[0] > 0.02 || light[1] > 0.02 || light[2] > 0.02)) {
      return [
        Math.min(1, WATER_DIM[0] * 0.5 + light[0]),
        Math.min(1, WATER_DIM[1] * 0.5 + light[1]),
        Math.min(1, WATER_DIM[2] * 0.5 + light[2]),
      ];
    }
    return foam ? [0.5, 0.55, 0.6] : WATER_DIM;
  }

  private spawn(
    n: Nozzle,
    phys: (typeof KIND_PHYSICS)[NozzleKind],
    spreadDeg: number,
    headingDeg: number,
    v0: number,
    color: [number, number, number],
  ): void {
    const i = this.alive++;
    // Диаметр сопла (n.widthM) — частицы стартуют не из точки, а с маленького пятна
    // у сопла: визуально читается как толщина струи у основания.
    const r = (n.widthM / 2) * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    this.px[i] = n.x + Math.cos(a) * r;
    this.py[i] = n.y + Math.sin(a) * r;
    this.pz[i] = Math.max(0.01, n.z);

    const tilt = (n.tiltDeg * Math.PI) / 180;
    const heading = (headingDeg * Math.PI) / 180;
    const spread = (spreadDeg * Math.PI) / 180;

    // Полярный угол от вертикали и азимут направления вылета.
    let polar: number;
    let azimuth: number;
    if (phys.ringDeg && !(phys.central && Math.random() < 0.25)) {
      polar = ((phys.ringDeg + (Math.random() - 0.5) * phys.spreadDeg * 2) * Math.PI) / 180;
      azimuth = Math.random() * Math.PI * 2;
    } else if (phys.planar) {
      polar = Math.abs((Math.random() - 0.5) * 2 * spread) + (Math.random() - 0.5) * 0.03;
      azimuth = heading + (Math.random() < 0.5 ? 0 : Math.PI) + (Math.random() - 0.5) * 0.06;
      polar = Math.max(0, polar);
    } else {
      // Конус вокруг вертикали (равномерно по площади пятна).
      polar = spread * Math.sqrt(Math.random());
      azimuth = Math.random() * Math.PI * 2;
    }

    // Базовое направление: вертикаль, наклонённая на tilt в сторону heading.
    const dir = new THREE.Vector3(
      Math.sin(polar) * Math.cos(azimuth),
      Math.sin(polar) * Math.sin(azimuth),
      Math.cos(polar),
    );
    if (tilt > 0) {
      const axis = new THREE.Vector3(-Math.sin(heading), Math.cos(heading), 0);
      dir.applyAxisAngle(axis, tilt);
    }

    const v = v0 * (0.94 + Math.random() * 0.12);
    this.vx[i] = dir.x * v;
    this.vy[i] = dir.y * v;
    this.vz[i] = dir.z * v;
    this.drag[i] = phys.drag ?? 0;
    this.pr[i] = color[0];
    this.pg[i] = color[1];
    this.pb[i] = color[2];
  }

  private kill(i: number): void {
    const last = --this.alive;
    if (i === last) return;
    this.px[i] = this.px[last]!;
    this.py[i] = this.py[last]!;
    this.pz[i] = this.pz[last]!;
    this.vx[i] = this.vx[last]!;
    this.vy[i] = this.vy[last]!;
    this.vz[i] = this.vz[last]!;
    this.pr[i] = this.pr[last]!;
    this.pg[i] = this.pg[last]!;
    this.pb[i] = this.pb[last]!;
    this.drag[i] = this.drag[last]!;
  }
}
