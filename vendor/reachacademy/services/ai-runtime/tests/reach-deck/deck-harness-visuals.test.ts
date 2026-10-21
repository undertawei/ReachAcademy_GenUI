// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  FOUR_ROUTE_TEACHING_SAMPLE,
  PlannedVisualRoutes,
  plannedRouteSummaries,
  requestOutlinePage,
  summarizeMediaOrigin,
} from '../../scripts/reach-deck/deck-harness-visuals.js';

describe('workbench visual route evidence', () => {
  it('shows the actual planned routes and representations without deriving them from classification', () => {
    const page = {
      instructionalSpec: {
        visualAssets: [
          { kind: 'reference-image', purpose: '辨认实物' },
          { kind: 'diagram', representation: 'svg', purpose: '时间顺序' },
          { kind: 'scientific-visual', purpose: '随讲稿移动' },
          { kind: 'image', purpose: '学习氛围' },
        ],
      },
    };
    const html = renderToStaticMarkup(createElement(PlannedVisualRoutes, { page }));
    for (const route of ['reference-image', 'diagram', 'scientific-visual', 'image']) {
      expect(html).toContain(`data-visual-route="${route}"`);
    }
    expect(html).toContain('svg');
    expect(plannedRouteSummaries({ classification: { mediaType: 'image' } })).toEqual([]);
    expect(requestOutlinePage({ page })).toBe(page);
  });

  it('keeps the sample as teaching input without hardcoded planning assets', () => {
    expect(FOUR_ROUTE_TEACHING_SAMPLE).toContain('真实文物照片');
    expect(FOUR_ROUTE_TEACHING_SAMPLE).toContain('时间轴');
    expect(FOUR_ROUTE_TEACHING_SAMPLE).toContain('拖动播放头');
    expect(FOUR_ROUTE_TEACHING_SAMPLE).toContain('原创');
    expect(FOUR_ROUTE_TEACHING_SAMPLE).not.toContain('visualAssets');
  });

  it('shows source metadata without echoing transient download or source URLs', () => {
    const summary = summarizeMediaOrigin({
      schemaVersion: 'reach-deck-media-origin/v1',
      route: 'reference-image',
      provider: 'doubao',
      title: '司母戊鼎',
      sourceUrl: 'https://example.org/image?signature=private',
      downloadUrl: 'https://example.org/image?token=private',
      license: 'unknown',
    });
    expect(summary?.details).toContain('提供方：doubao');
    expect(summary?.details).toContain('许可：unknown');
    expect(JSON.stringify(summary)).not.toContain('private');
    expect(summarizeMediaOrigin({ route: 'image' })).toBeUndefined();
  });
});
