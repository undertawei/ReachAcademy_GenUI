import * as THREE from 'three';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT,
  type GeometryCamera,
  type GeometryEnvelope,
  type GeometryFreedom,
  type GeometryMeasurement,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  isGeometryItemVisible,
  type GeometryComputedState,
} from '@reachany/reach-deck-geometry/session';
import type { GeometryObjectState } from '@reachany/reach-deck-geometry';
import { COLORS } from './science-kit-runtime.shared';
import type { GeometryHit, GeometryView, Pixel, World } from './geometry-interaction';

type SpatialCamera = Extract<GeometryCamera, { kind: 'spatial' }>;
const vector = (point: World): THREE.Vector3 =>
  new THREE.Vector3(point[0], point[1], point[2] ?? 0);
const tuple = (point: THREE.Vector3): [number, number, number] => [point.x, point.y, point.z];
const finiteVector = (point: THREE.Vector3): boolean =>
  [point.x, point.y, point.z].every(Number.isFinite);

export interface GeometryLabelBox {
  readonly id: string;
  readonly anchor: Pixel;
  readonly width: number;
  readonly height: number;
}
export interface GeometryLabelPlacement extends GeometryLabelBox {
  readonly x: number;
  readonly y: number;
}

export function placeGeometryLabels(
  labels: readonly GeometryLabelBox[],
  width: number,
  height: number,
): GeometryLabelPlacement[] {
  const placed: GeometryLabelPlacement[] = [];
  const gap = 4,
    padding = 4;
  for (const label of labels) {
    if (label.width > width - padding * 2 || label.height > height - padding * 2) continue;
    const candidates: { x: number; y: number; score: number }[] = [];
    const add = (x: number, y: number) => {
      x = Math.min(width - label.width - padding, Math.max(padding, x));
      y = Math.min(height - label.height - padding, Math.max(padding, y));
      const dx = Math.max(x - label.anchor[0], 0, label.anchor[0] - x - label.width);
      const dy = Math.max(y - label.anchor[1], 0, label.anchor[1] - y - label.height);
      candidates.push({ x, y, score: dx * dx + dy * dy });
    };
    // Search every side of the anchor and occupied rectangles, including viewport edges.
    // Clamping only creates candidates; it never bypasses the collision test.
    for (const radius of [8, 24, 48, 80, 128, 192, 288]) {
      const [x, y] = label.anchor;
      add(x + radius, y - label.height - 5);
      add(x - label.width - radius, y - label.height - 5);
      add(x + radius, y + 5);
      add(x - label.width - radius, y + 5);
      add(x - label.width / 2, y - label.height - radius);
      add(x - label.width / 2, y + radius);
    }
    for (const box of placed) {
      add(box.x + box.width + gap, box.y);
      add(box.x - label.width - gap, box.y);
      add(box.x, box.y + box.height + gap);
      add(box.x, box.y - label.height - gap);
      add(box.x + box.width - label.width, box.y + box.height + gap);
      add(box.x + box.width - label.width, box.y - label.height - gap);
    }
    add(padding, padding);
    add(width - label.width - padding, padding);
    add(padding, height - label.height - padding);
    add(width - label.width - padding, height - label.height - padding);
    candidates.sort((a, b) => a.score - b.score);
    const location = candidates.find(
      ({ x, y }) =>
        !placed.some(
          (box) =>
            x < box.x + box.width + gap &&
            x + label.width + gap > box.x &&
            y < box.y + box.height + gap &&
            y + label.height + gap > box.y,
        ) &&
        !labels.some(
          ({ anchor }) =>
            anchor[0] > x - 4 &&
            anchor[0] < x + label.width + 4 &&
            anchor[1] > y - 4 &&
            anchor[1] < y + label.height + 4,
        ),
    );
    if (location) placed.push({ ...label, x: location.x, y: location.y });
  }
  return placed;
}

export function orbitGeometryCamera(
  camera: GeometryCamera,
  dx: number,
  dy: number,
): GeometryCamera {
  if (camera.kind !== 'spatial') return camera;
  const up = vector(camera.up).normalize();
  const rotateToY = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
  const offset = vector(camera.position).sub(vector(camera.target)).applyQuaternion(rotateToY);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.theta -= dx;
  spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi + dy));
  offset.setFromSpherical(spherical).applyQuaternion(rotateToY.invert()).add(vector(camera.target));
  return { ...camera, position: tuple(offset) };
}

export function createSpatialView(
  container: HTMLElement,
  envelope: GeometryEnvelope,
  failed: () => void,
): GeometryView {
  const spec = envelope.spec;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor('#f8fafc', 1);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  renderer.domElement.dataset.geometryCanvas = '';
  const labels = container.ownerDocument.createElement('div');
  labels.className = 'reach-geometry-labels';
  labels.setAttribute('aria-hidden', 'true');
  container.append(renderer.domElement, labels);
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  scene.add(group);
  const raycaster = new THREE.Raycaster();
  const perspective = new THREE.PerspectiveCamera(42, 1, 0.001, 10000);
  const orthographic = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.001, 10000);
  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = orthographic;
  let width = 1,
    height = 1,
    span = 10,
    disposed = false;
  let state: GeometryComputedState | undefined;
  let geometryKey = '';
  const meshes: THREE.Object3D[] = [];
  const points: { mesh: THREE.Mesh; point: THREE.Vector3 }[] = [];
  const labelNodes: { id: string; node: HTMLElement; point: THREE.Vector3 }[] = [];
  const leaders = container.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  leaders.setAttribute('aria-hidden', 'true');
  Object.assign(leaders.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  });
  labels.append(leaders);
  const objects = new Map(spec.objects.map((object) => [object.id, object]));
  const presentation = new Map(spec.presentation.objects.map((item) => [item.object, item]));
  const freedoms = new Map(
    spec.interaction.freedoms.map((freedom) => [freedom.object, freedom.id]),
  );
  const clear = () => {
    group.traverse((object) => {
      const rendered = object as THREE.Mesh;
      rendered.geometry?.dispose();
      const materials = rendered.material
        ? Array.isArray(rendered.material)
          ? rendered.material
          : [rendered.material]
        : [];
      materials.forEach((material) => material.dispose());
    });
    group.clear();
    meshes.length = 0;
    points.length = 0;
    labelNodes.length = 0;
    labels.replaceChildren(leaders);
    leaders.replaceChildren();
  };
  const selected = (id: string) =>
    state!.selection === id ||
    (state!.selection && state!.objects[state!.selection]?.faces?.includes(id));
  const color = (id: string) =>
    selected(id) ? '#c77708' : COLORS[presentation.get(id)?.colorToken ?? 'accent'];
  const opacity = (id: string, fallback: number) => presentation.get(id)?.opacity ?? fallback;
  const add = (object: THREE.Object3D, id: string, priority: number) => {
    object.userData.geometryId = id;
    object.userData.priority = priority;
    group.add(object);
    meshes.push(object);
  };
  const line = (vertices: readonly World[], id: string, hit = true) => {
    const geometry = new THREE.BufferGeometry().setFromPoints(vertices.map(vector));
    const style = presentation.get(id)?.lineStyle;
    const options = {
      color: color(id),
      transparent: true,
      opacity: opacity(id, 0.95),
      depthTest: true,
    };
    const material =
      style === 'dashed' || style === 'dotted'
        ? new THREE.LineDashedMaterial({
            ...options,
            dashSize: span * (style === 'dotted' ? 0.004 : 0.024),
            gapSize: span * 0.014,
          })
        : new THREE.LineBasicMaterial(options);
    const rendered = new THREE.Line(geometry, material);
    rendered.computeLineDistances();
    if (hit) add(rendered, id, 1);
    else group.add(rendered);
  };
  const surface = (
    vertices: readonly World[],
    frame: NonNullable<GeometryObjectState['frame']>,
    id: string,
    alpha: number,
  ) => {
    const origin = vector(frame.origin),
      u = vector(frame.u),
      v = vector(frame.v);
    const local = vertices.map((point) => {
      const p = vector(point).sub(origin);
      return new THREE.Vector2(p.dot(u), p.dot(v));
    });
    const triangles = THREE.ShapeUtils.triangulateShape(local, []);
    const geometry = new THREE.BufferGeometry().setFromPoints(vertices.map(vector));
    geometry.setIndex(triangles.flat());
    const material = new THREE.MeshBasicMaterial({
      color: color(id),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: opacity(id, alpha),
      depthWrite: false,
    });
    add(new THREE.Mesh(geometry, material), id, 2);
    line([...vertices, vertices[0]], id);
  };
  const label = (id: string, point: World) => {
    const text = presentation.get(id)?.label;
    if (!text) return;
    const node = container.ownerDocument.createElement('span');
    node.className = 'reach-geometry-label';
    node.textContent = text;
    node.style.color = color(id);
    node.dataset.geometryLabel = id;
    labels.append(node);
    node.style.width = 'max-content';
    labelNodes.push({ id, node, point: vector(point) });
  };
  const referenceForMarker = (
    measurement: GeometryMeasurement,
  ): { origin: THREE.Vector3; first: THREE.Vector3; second: THREE.Vector3 } | null => {
    const current = state!.objects;
    if (measurement.kind === 'threePointAngle') {
      const origin = current[measurement.vertex].coordinates,
        a = current[measurement.a].coordinates,
        b = current[measurement.b].coordinates;
      return origin && a && b
        ? {
            origin: vector(origin),
            first: vector(a).sub(vector(origin)),
            second: vector(b).sub(vector(origin)),
          }
        : null;
    }
    if (measurement.kind === 'dihedralAngle') {
      const edge = current[measurement.edge],
        q1 = current[measurement.q1].coordinates,
        q2 = current[measurement.q2].coordinates;
      if (!edge.origin || !edge.direction || !q1 || !q2) return null;
      const origin = vector(edge.origin),
        direction = vector(edge.direction).normalize();
      const first = vector(q1).sub(origin),
        second = vector(q2).sub(origin);
      first.addScaledVector(direction, -first.dot(direction));
      second.addScaledVector(direction, -second.dot(direction));
      return { origin, first, second };
    }
    if (measurement.kind === 'lineAngle') {
      const first = current[measurement.line1],
        second = current[measurement.line2];
      if (!first.origin || !first.direction || !second.origin || !second.direction) return null;
      const a = vector(first.origin),
        b = vector(second.origin),
        d = vector(first.direction).normalize(),
        e = vector(second.direction).normalize();
      // Only annotate a shared anchor; screen crossings never establish incidence.
      if (a.distanceTo(b) > 1e-9 + span * 1e-9) return null;
      return { origin: a, first: d, second: e };
    }
    if (measurement.kind === 'linePlaneAngle') {
      const line = current[measurement.line],
        plane = current[measurement.plane];
      if (!line.origin || !line.direction || !plane.frame) return null;
      const reference = spec.objects.find(
        (object) =>
          object.kind === 'intersectLinePlane' &&
          object.line === measurement.line &&
          object.plane === measurement.plane &&
          current[object.id].coordinates,
      );
      const origin = reference ? vector(current[reference.id].coordinates!) : vector(line.origin);
      const offset = origin.clone().sub(vector(plane.frame.origin));
      if (Math.abs(offset.dot(vector(plane.frame.n))) > 1e-9 + span * 1e-9) return null;
      return { origin, first: vector(line.direction), second: vector(plane.frame.u) };
    }
    if (measurement.kind === 'planeAngle') {
      const first = current[measurement.plane1].frame,
        second = current[measurement.plane2].frame;
      if (!first || !second) return null;
      const reference = spec.objects.find(
        (object) =>
          object.kind === 'intersectPlanes' &&
          ((object.plane1 === measurement.plane1 && object.plane2 === measurement.plane2) ||
            (object.plane2 === measurement.plane1 && object.plane1 === measurement.plane2)) &&
          current[object.id].origin,
      );
      const origin = reference ? vector(current[reference.id].origin!) : vector(first.origin);
      if (
        Math.abs(origin.clone().sub(vector(second.origin)).dot(vector(second.n))) >
        1e-9 + span * 1e-9
      )
        return null;
      const edge = vector(first.n).cross(vector(second.n)).normalize();
      return { origin, first: vector(first.n).cross(edge), second: vector(second.n).cross(edge) };
    }
    return null;
  };
  const rebuild = () => {
    clear();
    const extent = new THREE.Box3();
    for (const [id, object] of Object.entries(state!.objects))
      if (
        object.status === 'valid' &&
        object.coordinates &&
        isGeometryItemVisible(spec.presentation, state!.visibleGroups, 'object', id)
      )
        extent.expandByPoint(vector(object.coordinates));
    const size = extent.getSize(new THREE.Vector3());
    span = Math.max(1, size.length());
    if (!Number.isFinite(span)) span = 10;
    for (const [id, object] of Object.entries(state!.objects)) {
      if (
        object.status !== 'valid' ||
        !isGeometryItemVisible(spec.presentation, state!.visibleGroups, 'object', id) ||
        opacity(id, 1) === 0
      )
        continue;
      if (object.coordinates && object.radius === undefined) {
        const position = vector(object.coordinates);
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(1, 12, 8),
          new THREE.MeshBasicMaterial({
            color: color(id),
            transparent: opacity(id, 1) < 1,
            opacity: opacity(id, 1),
          }),
        );
        mesh.position.copy(position);
        add(mesh, id, 0);
        points.push({ mesh, point: position });
        label(id, object.coordinates);
      } else if (object.origin && object.direction) {
        const origin = vector(object.origin),
          direction = vector(object.direction),
          kind = object.kind;
        let a = origin.clone(),
          b = origin.clone().add(direction);
        if (kind !== 'segment') {
          const unit = direction.clone().normalize(),
            target = vector((state!.camera as SpatialCamera).target);
          const centerDistance = target.clone().sub(origin).dot(unit);
          const lower = kind === 'ray' ? Math.max(0, centerDistance - span) : centerDistance - span;
          const upper = Math.max(lower + span, centerDistance + span);
          a = origin.clone().addScaledVector(unit, lower);
          b = origin.clone().addScaledVector(unit, upper);
        }
        line([tuple(a), tuple(b)], id);
        label(id, tuple(a.clone().lerp(b, 0.55)));
      } else if (object.vertices && object.frame) {
        surface(object.vertices, object.frame, id, 0.15);
        label(
          id,
          tuple(
            object.vertices
              .map(vector)
              .reduce((sum, point) => sum.add(point), new THREE.Vector3())
              .multiplyScalar(1 / object.vertices.length),
          ),
        );
      } else if (object.frame) {
        const f = object.frame,
          o = vector(f.origin),
          u = vector(f.u),
          v = vector(f.v),
          radius = span * 0.4;
        const corners = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(([x, y]) =>
          tuple(
            o
              .clone()
              .addScaledVector(u, x * radius)
              .addScaledVector(v, y * radius),
          ),
        );
        surface(corners, f, id, 0.07);
        label(id, corners[2]);
      }
    }
    for (const marker of spec.presentation.rightAngles) {
      const measured = state!.measurements[marker.measurement];
      if (
        measured.status !== 'valid' ||
        Math.abs(measured.value! - 90) > EUCLIDEAN_GEOMETRY_CONTRACT.tolerances.angleDegrees ||
        !isGeometryItemVisible(
          spec.presentation,
          state!.visibleGroups,
          'measurement',
          marker.measurement,
        )
      )
        continue;
      const measurement = spec.measurements.find((item) => item.id === marker.measurement)!;
      const reference = referenceForMarker(measurement);
      if (!reference) continue;
      const { origin, first, second } = reference;
      first.normalize().multiplyScalar(span * 0.035);
      second.normalize().multiplyScalar(span * 0.035);
      line(
        [
          tuple(origin.clone().add(first)),
          tuple(origin.clone().add(first).add(second)),
          tuple(origin.clone().add(second)),
        ],
        marker.id,
        false,
      );
    }
  };
  const configureCamera = (value: SpatialCamera) => {
    camera = value.projection === 'perspective' ? perspective : orthographic;
    camera.position.copy(vector(value.position));
    camera.up.copy(vector(value.up));
    camera.lookAt(vector(value.target));
    camera.zoom = value.zoom;
    const distance = camera.position.distanceTo(vector(value.target));
    camera.near = Math.max(0.00001, distance / 10000);
    camera.far = Math.max(100, distance + span * 20);
    if (camera instanceof THREE.PerspectiveCamera) camera.aspect = width / height;
    else {
      const half = Math.max(0.01, distance * Math.tan((21 * Math.PI) / 180));
      camera.top = half;
      camera.bottom = -half;
      camera.left = (-half * width) / height;
      camera.right = (half * width) / height;
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  };
  const pixelsToWorld = (point: THREE.Vector3, pixels: number) => {
    if (camera instanceof THREE.OrthographicCamera)
      return (pixels * (camera.top - camera.bottom)) / (height * camera.zoom);
    const depth = Math.max(camera.near, -point.clone().applyMatrix4(camera.matrixWorldInverse).z);
    return (pixels * 2 * depth * Math.tan((camera.fov * Math.PI) / 360)) / (height * camera.zoom);
  };
  const project = (point: World): Pixel | null => {
    const projected = vector(point).project(camera);
    if (!finiteVector(projected) || projected.z < -1 || projected.z > 1) return null;
    return [((projected.x + 1) * width) / 2, ((1 - projected.y) * height) / 2];
  };
  const ray = (pixel: Pixel) => {
    raycaster.setFromCamera(
      new THREE.Vector2((pixel[0] / width) * 2 - 1, 1 - (pixel[1] / height) * 2),
      camera,
    );
    return raycaster.ray;
  };
  const lost = (event: Event) => {
    event.preventDefault();
    failed();
  };
  renderer.domElement.addEventListener('webglcontextlost', lost);
  return {
    paint(next) {
      if (disposed) return;
      state = next;
      const key = JSON.stringify([next.geometryRevision, next.selection, next.visibleGroups]);
      if (key !== geometryKey) {
        geometryKey = key;
        rebuild();
      }
      configureCamera(next.camera as SpatialCamera);
      for (const { mesh, point } of points)
        mesh.scale.setScalar(pixelsToWorld(point, selected(mesh.userData.geometryId) ? 6 : 4.5));
      group.updateMatrixWorld(true);
      renderer.render(scene, camera);
      const boxes: GeometryLabelBox[] = [];
      for (const { id, node, point } of labelNodes) {
        const pixel = project(tuple(point));
        if (!pixel || pixel[0] < 0 || pixel[0] > width || pixel[1] < 0 || pixel[1] > height) {
          node.hidden = true;
          continue;
        }
        node.hidden = false;
        node.style.maxWidth = `${Math.max(18, Math.min(160, width - 8))}px`;
        const bounds = node.getBoundingClientRect();
        boxes.push({
          id,
          anchor: pixel,
          width: Math.max(18, bounds.width),
          height: Math.max(18, bounds.height),
        });
      }
      boxes.sort((a, b) => Number(Boolean(selected(b.id))) - Number(Boolean(selected(a.id))));
      const placements = new Map(
        placeGeometryLabels(boxes, width, height).map((box) => [box.id, box]),
      );
      leaders.replaceChildren();
      leaders.setAttribute('viewBox', `0 0 ${width} ${height}`);
      for (const { id, node } of labelNodes) {
        const box = placements.get(id);
        node.hidden = !box;
        if (!box) continue;
        node.style.left = `${box.x}px`;
        node.style.top = `${box.y}px`;
        const x = Math.max(box.x, Math.min(box.x + box.width, box.anchor[0]));
        const y = Math.max(box.y, Math.min(box.y + box.height, box.anchor[1]));
        if (Math.hypot(x - box.anchor[0], y - box.anchor[1]) > 12) {
          const leader = container.ownerDocument.createElementNS(
            'http://www.w3.org/2000/svg',
            'line',
          );
          leader.setAttribute('x1', String(box.anchor[0]));
          leader.setAttribute('y1', String(box.anchor[1]));
          leader.setAttribute('x2', String(x));
          leader.setAttribute('y2', String(y));
          leader.setAttribute('stroke', color(id));
          leader.setAttribute('stroke-width', '0.8');
          leader.setAttribute('opacity', '0.5');
          leaders.append(leader);
        }
      }
    },
    resize(w, h) {
      if (disposed) return;
      width = Math.max(1, w);
      height = Math.max(1, h);
      renderer.setSize(width, height, false);
    },
    project,
    pick(pixel, pointerType): GeometryHit | null {
      if (!state || disposed) return null;
      ray(pixel);
      raycaster.params.Line = {
        threshold: pixelsToWorld(
          vector((state.camera as SpatialCamera).target),
          pointerType === 'touch' ? 14 : 6,
        ),
      };
      const hits = raycaster
        .intersectObjects(meshes, false)
        .sort(
          (a, b) =>
            a.object.userData.priority - b.object.userData.priority || a.distance - b.distance,
        );
      let id = hits[0]?.object.userData.geometryId as string | undefined;
      // Screen-space point hits preserve an accessible target at every zoom level.
      let best = pointerType === 'touch' ? 18 : 10;
      for (const { mesh, point } of points) {
        const p = project(tuple(point));
        if (!p) continue;
        const distance = Math.hypot(p[0] - pixel[0], p[1] - pixel[1]);
        if (distance < best) {
          best = distance;
          id = mesh.userData.geometryId;
        }
      }
      if (!id) return null;
      if (!spec.interaction.selectable.includes(id) && !freedoms.has(id)) {
        const parent = spec.objects.find(
          (object) =>
            object.kind === 'polyhedron' &&
            object.faces.includes(id!) &&
            spec.interaction.selectable.includes(object.id) &&
            isGeometryItemVisible(spec.presentation, state!.visibleGroups, 'object', object.id),
        );
        if (parent) id = parent.id;
      }
      return {
        objectId: id,
        freedomId: freedoms.get(id),
        selectable: spec.interaction.selectable.includes(id),
      };
    },
    dragPoint(pixel, freedom, current, anchor): World | null {
      if (disposed) return null;
      const r = ray(pixel),
        object = objects.get(freedom.object)!;
      if (freedom.kind === 'line' && object.kind === 'pointOnLine') {
        const line = current.objects[object.line];
        if (!line.origin || !line.direction || line.status !== 'valid') return null;
        const origin = vector(line.origin),
          direction = vector(line.direction).normalize(),
          offset = r.origin.clone().sub(origin);
        const parallel = r.direction.dot(direction),
          denominator = 1 - parallel * parallel;
        if (denominator < 1e-9) return null;
        const distance = (offset.dot(direction) - parallel * offset.dot(r.direction)) / denominator;
        const point = origin.addScaledVector(direction, distance);
        return finiteVector(point) ? tuple(point) : null;
      }
      let plane: THREE.Plane;
      if (freedom.kind === 'plane' && object.kind === 'pointOnPlane') {
        const frame = current.objects[object.plane].frame;
        if (!frame) return null;
        plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
          vector(frame.n),
          vector(frame.origin),
        );
      } else {
        if (!anchor) return null;
        plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
          camera.getWorldDirection(new THREE.Vector3()),
          vector(anchor),
        );
      }
      const point = r.intersectPlane(plane, new THREE.Vector3());
      return point && finiteVector(point) ? tuple(point) : null;
    },
    orbit: orbitGeometryCamera,
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      clear();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      labels.remove();
    },
  };
}
