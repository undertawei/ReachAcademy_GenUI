import { registerScienceKit } from './science-kit-runtime.shared';
import { geometryMountV2 } from './geometry-runtime-v2';
import { createSpatialViewV2 } from './geometry-spatial-v2';

registerScienceKit('geometry-euclidean-3d-v2', geometryMountV2(createSpatialViewV2));
