import { describe, expect, it } from 'vitest';
import {
  STATIC_DIAGRAM_PROMPT_VERSION,
  buildStaticDiagramPrompt,
} from '../../lib/reach-deck/prompts/static-diagram.js';
import { validateStaticDiagram } from '../../lib/reach-deck/diagram-renderer.js';

describe('static diagram source prompt', () => {
  it.each(['svg', 'html'] as const)(
    'keeps %s facts, safety and source shape in one contract',
    (kind) => {
      const prompt = buildStaticDiagramPrompt(kind);
      expect(STATIC_DIAGRAM_PROMPT_VERSION).toBe('diagram/v7');
      expect(prompt).toContain(`diagram as ${kind}`);
      expect(prompt).toContain('Return JSON {source}');
      expect(prompt).toContain('Preserve every supplied fact and invariant');
      expect(prompt).toContain('invent no numbers, measurements or claims');
      expect(prompt).toContain('Quantitative charts and functions use host engines');
      expect(prompt).toContain(
        'No JavaScript, external resources, links, images, animation or embedded data',
      );
      expect(prompt).toContain('explicit width, height and viewBox');
      expect(prompt).toContain('HTML requires a fixed-size root');
      expect(prompt).toContain('Keep the canvas transparent');
      expect(prompt).toContain('do not paint opaque plates behind free labels');
      expect(prompt).toContain('0.55–0.8');
      expect(prompt).toContain(
        'page formulas, derivations, conclusions and step lists are page text',
      );
      expect(prompt).toContain('small arc lies inside the angle');
      expect(prompt).toContain('only at the vertex whose angle is 90°');
      expect(prompt).toContain('one consistent oblique or isometric projection');
      expect(prompt).toContain('hidden edges are dashed');
      expect(prompt).not.toMatch(/85%|70%/);
    },
  );

  it('advertises only elements accepted by the existing static safety validator', () => {
    const prompt = buildStaticDiagramPrompt('svg');
    const advertised = /Allowed tags: ([^.]+)\./.exec(prompt)![1]!.split(' ');
    for (const tag of advertised) {
      expect(() => validateStaticDiagram(`<${tag}></${tag}>`)).not.toThrow();
    }
    expect(() => validateStaticDiagram('<script>alert(1)</script>')).toThrow();
    expect(() =>
      validateStaticDiagram('<svg><image href="https://example.com/a.png"/></svg>'),
    ).toThrow();
  });
});
