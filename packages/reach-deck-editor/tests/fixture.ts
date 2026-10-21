import type { ReachDeckDocument } from '@reachany/reach-deck-dsl';
import { richTextFromPlainText } from '@reachany/reach-deck-dsl';

export const createEditorDocument = (): ReachDeckDocument => ({
  schemaVersion: 'reach-deck-document/v2',
  id: 'deck-editor',
  title: 'Reach Deck editor fixture',
  stage: { width: 1600, height: 900, aspectRatio: '16:9' },
  theme: {
    name: 'Reach',
    background: '#fff',
    surface: '#fff',
    ink: '#172024',
    muted: '#647178',
    accent: '#2563eb',
    success: '#15803d',
    warning: '#b45309',
    fontDisplay: 'Inter',
    fontBody: 'Inter',
  },
  defaultThemeId: 'reach-default-theme',
  resources: {
    themes: [
      {
        id: 'reach-default-theme',
        name: 'Reach',
        colors: {
          background: '#fff',
          surface: '#fff',
          ink: '#172024',
          muted: '#647178',
          accent: '#2563eb',
          success: '#15803d',
          warning: '#b45309',
        },
        fonts: { display: 'Inter', body: 'Inter' },
      },
    ],
    masters: [],
    layouts: [],
    media: [],
  },
  metadata: {
    source: 'editor',
    language: 'zh-CN',
    generatedAt: '2026-07-18T00:00:00.000Z',
    contentDigest: 'sha256:test',
  },
  revisions: [],
  pages: [
    {
      pageId: 'page-1',
      order: 1,
      revision: 1,
      sceneType: 'slide',
      title: 'First page',
    },
  ],
  nativeSlides: [
    {
      pageId: 'page-1',
      slide: {
        schemaVersion: 'reach-deck-slide/v2',
        id: 'native-slide-1',
        title: 'First page',
        background: { kind: 'solid', color: { kind: 'srgb', value: '#FFFFFF' } },
        elements: [
          {
            id: 'title-1',
            type: 'textFrame',
            transform: { x: 80, y: 72, width: 1100, height: 120 },
            zIndex: 1,
            text: {
              margins: { left: 4, top: 4, right: 4, bottom: 4 },
              verticalAlignment: 'top',
              wrap: true,
              autofit: { mode: 'none' },
              doc: richTextFromPlainText('First page'),
              fontSubstitutions: [],
            },
          },
        ],
        animations: [],
        duration: 8,
      },
    },
  ],
});
