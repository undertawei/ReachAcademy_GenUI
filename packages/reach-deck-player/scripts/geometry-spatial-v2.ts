import type { GeometryFreedom } from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  composeGeometryEnvelopeV2,
  type GeometryAuxiliaryStateV2,
  type GeometryEnvelopeV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import type { GeometryComputedStateV2 } from '@reachany/reach-deck-geometry/session-v2';
import { createSpatialView } from './geometry-spatial';
import type { GeometryView } from './geometry-interaction';

export type GeometryPixelV2 = readonly [number, number];
export type GeometryWorldV2 = readonly number[];

export interface GeometryViewV2 {
  paint(state: GeometryComputedStateV2): void;
  rebuild(state: GeometryComputedStateV2): void;
  resize(width: number, height: number): void;
  pickCandidates(pixel: GeometryPixelV2, pointerType: 'mouse' | 'touch'): readonly string[];
  project(point: GeometryWorldV2): GeometryPixelV2 | null;
  dragPoint(
    pixel: GeometryPixelV2,
    freedom: GeometryFreedom,
    state: GeometryComputedStateV2,
    anchor?: GeometryWorldV2,
  ): GeometryWorldV2 | null;
  orbit: GeometryView['orbit'];
  dispose(): void;
}

const pointDistance = (left: GeometryPixelV2, right: GeometryPixelV2): number =>
  Math.hypot(left[0] - right[0], left[1] - right[1]);

/**
 * The v2 adapter gets all coordinates from the v2 computed snapshot. The existing Three.js view
 * remains only a presentation implementation; its geometryRevision key rebuilds meshes whenever
 * the v2 session replaces the construction graph.
 */
export function createSpatialViewV2(
  scene: HTMLElement,
  envelope: GeometryEnvelopeV2,
  fail: () => void,
): GeometryViewV2 {
  let base: GeometryView | undefined;
  let current: GeometryComputedStateV2 | undefined;
  let hiddenKey = '';
  let width = 1;
  let height = 1;
  const presentationAuxiliary = (state: GeometryComputedStateV2): GeometryAuxiliaryStateV2 => {
    const hidden = new Set(state.hiddenAuxiliary);
    const objectStyles = new Map(
      state.auxiliary.presentation.objects.map((entry) => [entry.object, entry]),
    );
    const measurementStyles = new Map(
      state.auxiliary.presentation.measurements.map((entry) => [entry.measurement, entry]),
    );
    return {
      ...state.auxiliary,
      presentation: {
        ...state.auxiliary.presentation,
        objects: state.auxiliary.objects.map((object) => ({
          ...(objectStyles.get(object.id) ?? { object: object.id }),
          ...(hidden.has(object.id) ? { visible: false } : {}),
        })),
        measurements: state.auxiliary.measurements.map((measurement) => ({
          ...(measurementStyles.get(measurement.id) ?? { measurement: measurement.id }),
          ...(hidden.has(measurement.id) ? { visible: false } : {}),
        })),
      },
    };
  };
  const recreate = (state: GeometryComputedStateV2) => {
    base?.dispose();
    const composed = composeGeometryEnvelopeV2(envelope, presentationAuxiliary(state));
    base = createSpatialView(scene, composed.envelope, fail);
    base.resize(width, height);
    hiddenKey = JSON.stringify([...state.hiddenAuxiliary].sort());
  };
  const pickCandidates = (
    pixel: GeometryPixelV2,
    pointerType: 'mouse' | 'touch',
  ): readonly string[] => {
    if (!current) return [];
    const primary = base?.pick(pixel, pointerType)?.objectId;
    const radius = pointerType === 'touch' ? 20 : 11;
    const points = Object.entries(current.objects)
      .filter(
        ([id, object]) =>
          !current!.hiddenAuxiliary.includes(id) &&
          object.status === 'valid' &&
          object.coordinates !== null &&
          object.radius === undefined,
      )
      .flatMap(([id, object]) => {
        const projected = base?.project(object.coordinates!);
        return projected && pointDistance(projected, pixel) <= radius
          ? [{ id, distance: pointDistance(projected, pixel) }]
          : [];
      })
      .sort((left, right) => left.distance - right.distance || left.id.localeCompare(right.id))
      .map(({ id }) => id);
    return [...new Set([...(primary ? [primary] : []), ...points])];
  };
  return {
    paint(state) {
      current = state;
      const nextHiddenKey = JSON.stringify([...state.hiddenAuxiliary].sort());
      if (!base || hiddenKey !== nextHiddenKey) recreate(state);
      base!.paint(state as never);
    },
    rebuild(state) {
      current = state;
      recreate(state);
      base!.paint(state as never);
    },
    resize: (nextWidth, nextHeight) => {
      width = nextWidth;
      height = nextHeight;
      base?.resize(width, height);
    },
    pickCandidates,
    project: (point) => base?.project(point) ?? null,
    dragPoint: (pixel, freedom, state, anchor) =>
      base?.dragPoint(pixel, freedom, state as never, anchor) ?? null,
    orbit: (camera, dx, dy) => base?.orbit(camera, dx, dy) ?? camera,
    dispose: () => {
      base?.dispose();
      base = undefined;
    },
  };
}
