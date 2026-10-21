import { registerScienceKit } from './science-kit-runtime.shared';
import { geometryMount } from './geometry-runtime';

registerScienceKit(
  'geometry-euclidean-2d',
  geometryMount((_scene, _envelope, engine) => {
    const presentation = engine.planarPresentation;
    if (!presentation) throw new Error('Native planar presentation is unavailable');
    return {
      paint: (state) => presentation.paint(state),
      resize: (width, height) => presentation.resize(width, height),
      pick: (pixel, type) => presentation.pick(pixel, type),
      project: (point) => presentation.project([point[0], point[1]]),
      dragPoint: (pixel) => presentation.unproject(pixel),
      orbit: (camera) => camera,
      dispose: () => {},
    };
  }),
);
