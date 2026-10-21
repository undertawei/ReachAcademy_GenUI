import { writeFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';
import { REFERENCE_REGISTRY } from '../src/reference-library/index.js';
import { projectReferenceRegistryMarkdown } from '../src/referenceRegistry.js';

const destination = new URL(
  '../../../docs/plans/2026-09-20-reach-deck-reference-library-coverage.md',
  import.meta.url,
);
const config = await resolveConfig(destination);
await writeFile(
  destination,
  await format(projectReferenceRegistryMarkdown(REFERENCE_REGISTRY), {
    ...config,
    parser: 'markdown',
  }),
);
