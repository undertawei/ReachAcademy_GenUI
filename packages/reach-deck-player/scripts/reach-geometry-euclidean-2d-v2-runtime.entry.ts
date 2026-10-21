import { registerScienceKit } from './science-kit-runtime.shared';
import { createPlanarViewV2, geometryMountV2 } from './geometry-runtime-v2';

registerScienceKit('geometry-euclidean-2d-v2', geometryMountV2(createPlanarViewV2));
