import { describe, expect, it } from 'vitest';

import {
  createPptxCapabilityReport,
  hasBlockingPptxDiagnostics,
  sortPptxDiagnostics,
  type PptxDiagnostic,
} from '../src/pptx/index.js';

const diagnostics: PptxDiagnostic[] = [
  {
    code: 'pptx.feature.unsupported',
    severity: 'error',
    feature: 'diagram',
    message: 'SmartArt is not natively supported.',
    location: {
      partPath: '/ppt/slides/slide2.xml',
      slideId: '256',
      nodePath: '/p:sld/p:cSld/p:spTree/p:graphicFrame[2]',
    },
  },
  {
    code: 'pptx.font.substituted',
    severity: 'warning',
    feature: 'font-substitution',
    message: 'A requested font was substituted.',
    location: {
      partPath: '/ppt/slides/slide1.xml',
      slideId: '255',
      nodePath: '/p:sld/p:cSld/p:spTree/p:sp[1]',
    },
  },
];

describe('PPTX diagnostics', () => {
  it('sorts deterministically by source location and code without mutating the input', () => {
    const sorted = sortPptxDiagnostics(diagnostics);

    expect(sorted.map((diagnostic) => diagnostic.code)).toEqual([
      'pptx.font.substituted',
      'pptx.feature.unsupported',
    ]);
    expect(diagnostics[0]?.code).toBe('pptx.feature.unsupported');
  });

  it('treats errors and fatal diagnostics as blocking', () => {
    expect(hasBlockingPptxDiagnostics(diagnostics)).toBe(true);
    expect(hasBlockingPptxDiagnostics([diagnostics[1]!])).toBe(false);
  });

  it('builds a stable report and never treats representability as native support', () => {
    const report = createPptxCapabilityReport(
      [
        { feature: 'diagram', status: 'unsupported' },
        { feature: 'text-frame', status: 'native' },
        { feature: 'font-substitution', status: 'conditional' },
      ],
      diagnostics,
    );

    expect(report.entries.map((entry) => entry.feature)).toEqual([
      'diagram',
      'font-substitution',
      'text-frame',
    ]);
    expect(report.canApply).toBe(false);
    expect(report.schemaRepresentable).toBe(false);
  });
});
