import { describe, expect, it } from 'vitest';

import * as importer from '../src/index.js';
import * as maic from '../src/maic/index.js';
import * as pptx from '../src/pptx/index.js';

describe('@reachany/importer public exports', () => {
  it('keeps the root runtime-neutral and exposes the PPTX contract', () => {
    expect(importer.pptx).toBe(pptx);
    expect(importer.pptx.PPTX_IR_SCHEMA_VERSION).toBe('pptx-presentation-ir/v1');
    expect(importer.maic).toBe(maic);
    expect(importer.maic.MAIC_IMPORTER_VERSION).toBe('0.3.5');
    expect(importer.maic.auditInteractiveTailwindAuthoringHtml).toBe(
      maic.auditInteractiveTailwindAuthoringHtml,
    );
  });
});
