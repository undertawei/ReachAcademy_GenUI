import { registerScienceKit } from './science-kit-runtime.shared';
import { geometryMount } from './geometry-runtime';
import { createSpatialView } from './geometry-spatial';

registerScienceKit(
  'geometry-euclidean-3d',
  geometryMount((scene, envelope, _engine, fail) => createSpatialView(scene, envelope, fail)),
);
