import { describe, expect, it } from 'vitest';

import {
  judgeSlideStatic,
  resolveLayoutReferenceMatches,
  retrieveLayoutReferences,
} from '../src/index.js';
import { richTextFromPlainText } from '../src/richText.js';
import { slideMetadata, slideScene } from './generationFixtures.js';

describe('static slide layout judge', () => {
  it('passes a safe, readable slide without browser layout APIs', () => {
    expect(judgeSlideStatic(slideScene('page-1'))).toEqual({ status: 'pass', issues: [] });
  });

  it('reports deterministic bounds, overlap, and animation endpoint issues', () => {
    const slide = slideScene('page-1');
    slide.elements.push({
      id: 'body',
      type: 'text',
      frame: { x: 100, y: 80, width: 600, height: 100 },
      layer: 1,
      doc: richTextFromPlainText('Overlapping text'),
      variant: 'body',
    });
    slide.elements.push({
      id: 'outside',
      type: 'text',
      frame: { x: -20, y: 400, width: 300, height: 100 },
      layer: 3,
      doc: richTextFromPlainText('Outside'),
      variant: 'body',
    });
    slide.animations.push({
      id: 'leave-stage',
      type: 'move',
      targetId: 'body',
      start: 0,
      duration: 1,
      to: { x: 1500 },
    });
    const result = judgeSlideStatic(slide);
    expect(result.status).toBe('warning');
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['FRAME_OUT_OF_BOUNDS', 'ELEMENT_OVERLAP', 'ANIMATION_OUT_OF_BOUNDS']),
    );
  });

  it('judges the completed animation composition used by editor previews', () => {
    const slide = slideScene('animation-final');
    slide.elements.push({
      id: 'support',
      type: 'text',
      frame: { x: 900, y: 360, width: 400, height: 120 },
      layer: 1,
      doc: richTextFromPlainText('Supporting idea'),
      variant: 'body',
    });
    slide.animations.push({
      id: 'support-move',
      type: 'move',
      targetId: 'support',
      start: 0,
      duration: 1,
      to: { x: 100, y: 80 },
    });

    const result = judgeSlideStatic(slide);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'ELEMENT_OVERLAP',
        message: '动画完成后元素发生重叠',
      }),
    );
  });

  it('ignores intentional overlap between different visual layers', () => {
    const slide = slideScene('layered-overlap');
    slide.elements.push({
      id: 'foreground',
      type: 'text',
      frame: { ...slide.elements[0]!.frame },
      layer: slide.elements[0]!.layer + 1,
      doc: richTextFromPlainText('Foreground annotation'),
      variant: 'body',
    });

    expect(judgeSlideStatic(slide).issues).not.toContainEqual(
      expect.objectContaining({ code: 'ELEMENT_OVERLAP' }),
    );
  });

  it('ignores safe-area margin use and contained background shapes', () => {
    const slide = slideScene('background-containment');
    slide.elements.push(
      {
        id: 'margin-note',
        type: 'text',
        frame: { x: 20, y: 400, width: 300, height: 80 },
        layer: 3,
        doc: richTextFromPlainText('Still inside the actual canvas'),
        variant: 'caption',
      },
      {
        id: 'card-background',
        type: 'shape',
        frame: { x: 600, y: 240, width: 600, height: 320 },
        layer: 5,
        shape: 'roundRect',
        fillToken: 'surface',
      },
      {
        id: 'card-accent',
        type: 'shape',
        frame: { x: 640, y: 280, width: 240, height: 120 },
        layer: 5,
        shape: 'roundRect',
        fillToken: 'accentSoft',
      },
    );

    expect(judgeSlideStatic(slide).issues).not.toContainEqual(
      expect.objectContaining({ code: 'FRAME_OUT_OF_BOUNDS' }),
    );
    expect(judgeSlideStatic(slide).issues).not.toContainEqual(
      expect.objectContaining({ code: 'ELEMENT_OVERLAP' }),
    );
  });

  it('reports substantial foreground text overlap but ignores a tiny frame touch', () => {
    const severe = slideScene('severe-overlap');
    severe.elements.push(
      {
        id: 'copy-a',
        type: 'text',
        frame: { x: 500, y: 300, width: 500, height: 120 },
        layer: 5,
        doc: richTextFromPlainText('A clearly overlapping teaching sentence'),
        variant: 'body',
      },
      {
        id: 'copy-b',
        type: 'text',
        frame: { x: 520, y: 310, width: 500, height: 120 },
        layer: 5,
        doc: richTextFromPlainText('Another clearly overlapping teaching sentence'),
        variant: 'body',
      },
    );
    expect(judgeSlideStatic(severe).issues).toContainEqual(
      expect.objectContaining({ code: 'ELEMENT_OVERLAP' }),
    );

    const slight = slideScene('slight-overlap');
    slight.elements.push(
      {
        id: 'touch-a',
        type: 'text',
        frame: { x: 500, y: 300, width: 500, height: 120 },
        layer: 5,
        doc: richTextFromPlainText('Short label'),
        variant: 'body',
      },
      {
        id: 'touch-b',
        type: 'text',
        frame: { x: 992, y: 412, width: 400, height: 120 },
        layer: 5,
        doc: richTextFromPlainText('Another label'),
        variant: 'body',
      },
    );
    expect(judgeSlideStatic(slight).issues).not.toContainEqual(
      expect.objectContaining({ code: 'ELEMENT_OVERLAP' }),
    );
  });

  it('suppresses alignment and repeated-size design suggestions', () => {
    const slide = slideScene('repeated-row');
    for (let index = 0; index < 4; index += 1) {
      slide.elements.push({
        id: `peer-${index}`,
        type: 'shape',
        frame: {
          x: 80 + index * 340,
          y: index === 3 ? 244 : 220,
          width: index === 3 ? 210 : 300,
          height: 160,
        },
        layer: 5,
        shape: 'roundRect',
        fillToken: 'surface',
      });
    }

    const codes = judgeSlideStatic(slide).issues.map((issue) => issue.code);
    expect(codes).not.toEqual(
      expect.arrayContaining(['BROKEN_ALIGNMENT', 'REPEATED_COMPONENT_SIZING']),
    );
  });

  it('does not treat heterogeneous same-type regions as one repeated family', () => {
    const slide = slideScene('heterogeneous-regions');
    slide.elements.push(
      ...[220, 388, 556].map((y, index) => ({
        id: `cause-${index}`,
        type: 'shape' as const,
        frame: { x: 80, y, width: 480, height: 120 },
        layer: 5,
        shape: 'roundRect' as const,
        fillToken: 'surface' as const,
      })),
      {
        id: 'effect',
        type: 'shape',
        frame: { x: 880, y: 330, width: 640, height: 280 },
        layer: 5,
        shape: 'roundRect',
        fillToken: 'accentSoft',
      },
    );

    const codes = judgeSlideStatic(slide).issues.map((issue) => issue.code);
    expect(codes).not.toContain('BROKEN_ALIGNMENT');
    expect(codes).not.toContain('REPEATED_COMPONENT_SIZING');
  });

  it('allows readable three-up image sequences within the safe area', () => {
    const slide = slideScene('three-up-media');
    for (let index = 0; index < 3; index += 1) {
      slide.elements.push({
        id: `sequence-image-${index}`,
        type: 'image',
        frame: { x: 80 + index * 504, y: 240, width: 432, height: 324 },
        layer: 5,
        objectKey: `test/sequence-${index}.png`,
        alt: `Sequence stage ${index + 1}`,
        fit: 'contain',
      });
    }

    expect(
      judgeSlideStatic(slide).issues.filter(
        (issue) =>
          issue.code === 'ELEMENT_TOO_SMALL' && issue.elementIds[0]?.startsWith('sequence-image-'),
      ),
    ).toEqual([]);
  });

  it('allows relationship lines to branch from one shared endpoint', () => {
    const slide = slideScene('shared-line-endpoint');
    slide.elements.push(
      {
        id: 'branch-left',
        type: 'line',
        frame: { x: 400, y: 300, width: 400, height: 100 },
        layer: 2,
        start: { x: 800, y: 300 },
        end: { x: 400, y: 400 },
        role: 'connector',
        colorToken: 'accent',
      },
      {
        id: 'branch-right',
        type: 'line',
        frame: { x: 800, y: 300, width: 400, height: 100 },
        layer: 2,
        start: { x: 800, y: 300 },
        end: { x: 1200, y: 400 },
        role: 'connector',
        colorToken: 'accent',
      },
    );

    expect(
      judgeSlideStatic(slide).issues.filter(
        (issue) =>
          (issue.code === 'ELEMENT_GAP' || issue.code === 'ELEMENT_OVERLAP') &&
          issue.elementIds.includes('branch-left') &&
          issue.elementIds.includes('branch-right'),
      ),
    ).toEqual([]);
  });

  it('counts locally enlarged runs against capacity', () => {
    // 局部放大的文字要按比例多占容量，否则放大的几个字会静默溢出 ——
    // layoutJudge 是生成课件唯一的溢出保护（运行时没有自动缩放）。
    const base = 'AAAAAAAAAA';
    const frame = { x: 100, y: 200, width: 400, height: 60 };

    const plain = slideScene('capacity-plain');
    plain.elements.push({
      id: 'plain',
      type: 'text',
      frame,
      layer: 5,
      doc: richTextFromPlainText(base),
      variant: 'body',
    });

    const enlarged = slideScene('capacity-enlarged');
    enlarged.elements.push({
      id: 'enlarged',
      type: 'text',
      frame,
      layer: 5,
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                marks: [{ type: 'textStyle', attrs: { fontSize: 120 } }],
                text: base,
              },
            ],
          },
        ],
      },
      variant: 'body',
    });

    const capacityIssue = (slide: Parameters<typeof judgeSlideStatic>[0]) =>
      judgeSlideStatic(slide).issues.find((issue) => issue.code === 'TEXT_CAPACITY');

    expect(capacityIssue(plain)).toBeUndefined();
    expect(capacityIssue(enlarged)).toBeDefined();
  });

  it('安全容量边界内不报 TEXT_CAPACITY', () => {
    // Source Han Sans body 满宽（1440px）、8 个 51px 安全行盒，叠加 8% headroom 后容量为 345。
    const frame = { x: 0, y: 0, width: 1440, height: 408 };
    const slide = slideScene('capacity-within-tolerance');
    slide.elements.push({
      id: 'within-tolerance',
      type: 'text',
      frame,
      layer: 5,
      doc: richTextFromPlainText('测'.repeat(345)),
      variant: 'body',
    });

    const issue = judgeSlideStatic(slide).issues.find((item) => item.code === 'TEXT_CAPACITY');
    expect(issue).toBeUndefined();
  });

  it('超过安全容量一个字符即报 TEXT_CAPACITY', () => {
    // 容量表逐行留出一字后，再叠加 8% headroom；超过最终容量一个字即告警。
    const frame = { x: 0, y: 0, width: 1440, height: 408 };
    const slide = slideScene('capacity-beyond-tolerance');
    slide.elements.push({
      id: 'beyond-tolerance',
      type: 'text',
      frame,
      layer: 5,
      doc: richTextFromPlainText('测'.repeat(346)),
      variant: 'body',
    });

    const issue = judgeSlideStatic(slide).issues.find((item) => item.code === 'TEXT_CAPACITY');
    expect(issue).toBeDefined();
  });

  it('元素高度小于一个行高时 availableLines 为 0，容量降为 0，任何非空文字都触发 TEXT_CAPACITY', () => {
    // body 档安全行盒 = 51，frame.height 取 20（< 51）使
    // availableLines = floor(20 / 51) = 0，capacity = 0，
    // 只要 length > 0 就会触发——把这个边界行为钉死，避免未来改动悄悄放行零容量元素。
    const frame = { x: 0, y: 0, width: 1440, height: 20 };
    const slide = slideScene('capacity-zero-available-lines');
    slide.elements.push({
      id: 'zero-available-lines',
      type: 'text',
      frame,
      layer: 5,
      doc: richTextFromPlainText('测'),
      variant: 'body',
    });

    const issue = judgeSlideStatic(slide).issues.find((item) => item.code === 'TEXT_CAPACITY');
    expect(issue).toBeDefined();
    expect(issue?.details).toMatchObject({ capacity: 0 });
  });

  it('196×216 的多段落公式窄框触发容量告警并返回可定位的算术诊断', () => {
    const slide = slideScene('capacity-narrow-rich-text');
    slide.elements.push({
      id: 'narrow-rich-text',
      type: 'text',
      frame: { x: 100, y: 200, width: 196, height: 216 },
      layer: 5,
      doc: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '第一段说明' }] },
          { type: 'blockMath', attrs: { latex: 'y=x^2+1' } },
          { type: 'paragraph', content: [{ type: 'text', text: '第二段补充完整结论说明' }] },
        ],
      },
      variant: 'body',
    });

    const issue = judgeSlideStatic(slide).issues.find((item) => item.code === 'TEXT_CAPACITY');
    expect(issue).toBeDefined();
    expect(issue?.details).toMatchObject({
      frameWidth: 196,
      frameHeight: 216,
      safeLineBoxHeight: 51,
      availableLines: 4,
      violatedBudget: 'requiredLines<=availableLines',
    });
    expect(issue?.details.requiredLines).toBeGreaterThan(4);
    expect(issue?.details.requiredHeight).toBeGreaterThan(216);
  });

  it('does not promote semantic reference capacity to a layout warning', () => {
    const metadata = slideMetadata('page-1');
    const matches = retrieveLayoutReferences({ classification: metadata.classification });
    metadata.classification.itemCount = 20;
    const result = judgeSlideStatic(slideScene('page-1'), {
      generationMetadata: metadata,
      layoutReferences: resolveLayoutReferenceMatches(matches),
    });
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: 'REFERENCE_CAPACITY' }),
    );
  });

  it('does not promote sparse composition or fuzzy blueprint coverage to layout warnings', () => {
    const metadata = slideMetadata('sparse');
    metadata.blueprint.contentUnits.push(
      { id: 'evidence', role: 'evidence', text: 'Evidence', priority: 'supporting' },
      { id: 'example', role: 'example', text: 'Example', priority: 'supporting' },
    );
    metadata.classification = {
      ...metadata.classification,
      itemCount: 3,
      density: 'medium',
    };
    const references = resolveLayoutReferenceMatches(
      retrieveLayoutReferences({ classification: metadata.classification }),
    );

    const result = judgeSlideStatic(slideScene('sparse'), {
      generationMetadata: metadata,
      layoutReferences: references,
    });

    expect(result.issues).not.toContainEqual(expect.objectContaining({ code: 'CONTENT_COVERAGE' }));
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: 'BLUEPRINT_COVERAGE' }),
    );
  });

  it('does not promote whitespace balance suggestions to layout warnings', () => {
    const metadata = slideMetadata('imbalanced');
    metadata.classification = { ...metadata.classification, density: 'medium' };
    const slide = slideScene('imbalanced');
    slide.elements[0] = {
      ...slide.elements[0],
      frame: { x: 80, y: 64, width: 1440, height: 112 },
    };
    slide.elements.push({
      id: 'left-heavy',
      type: 'text',
      frame: { x: 80, y: 208, width: 620, height: 600 },
      layer: 2,
      doc: richTextFromPlainText('A deliberately left-heavy teaching region'),
      variant: 'body',
    });
    const references = resolveLayoutReferenceMatches(
      retrieveLayoutReferences({ classification: metadata.classification }),
    );

    expect(
      judgeSlideStatic(slide, { generationMetadata: metadata, layoutReferences: references })
        .issues,
    ).not.toContainEqual(expect.objectContaining({ code: 'WHITESPACE_IMBALANCE' }));
  });

  it('does not promote title-copy quality suggestions to layout warnings', () => {
    const metadata = slideMetadata('duplicated');
    const slide = slideScene('duplicated');
    slide.elements[0] = {
      id: 'duplicated-title',
      type: 'text',
      frame: { x: 80, y: 64, width: 1440, height: 112 },
      layer: 1,
      doc: richTextFromPlainText('资源瓶颈决定生存时间'),
      variant: 'title',
    };
    slide.elements.push({
      id: 'duplicate-body',
      type: 'text',
      frame: { x: 80, y: 208, width: 1440, height: 520 },
      layer: 2,
      doc: richTextFromPlainText('资源瓶颈决定生存时间'),
      variant: 'body',
    });
    const references = resolveLayoutReferenceMatches(
      retrieveLayoutReferences({ classification: metadata.classification }),
    );

    expect(
      judgeSlideStatic(slide, { generationMetadata: metadata, layoutReferences: references })
        .issues,
    ).not.toContainEqual(expect.objectContaining({ code: 'TITLE_BODY_DUPLICATION' }));
  });

  it('does not promote low estimated content occupancy to a layout warning', () => {
    const metadata = slideMetadata('occupancy');
    metadata.classification = { ...metadata.classification, density: 'medium', itemCount: 2 };
    metadata.blueprint.contentUnits.push({
      id: 'support',
      role: 'evidence',
      text: 'Support',
      priority: 'supporting',
    });
    const slide = slideScene('occupancy');
    slide.elements.push({
      id: 'huge-body-frame',
      type: 'text',
      frame: { x: 80, y: 208, width: 1440, height: 560 },
      layer: 2,
      doc: richTextFromPlainText('One short sentence.'),
      variant: 'body',
    });
    const references = resolveLayoutReferenceMatches(
      retrieveLayoutReferences({ classification: metadata.classification }),
    );
    expect(
      judgeSlideStatic(slide, { generationMetadata: metadata, layoutReferences: references })
        .issues,
    ).not.toContainEqual(expect.objectContaining({ code: 'CONTENT_COVERAGE' }));
  });

  it('suppresses caption semantics and minor shape-padding suggestions', () => {
    const metadata = slideMetadata('warnings');
    const slide = slideScene('warnings');
    slide.elements.push(
      {
        id: 'panel',
        type: 'shape',
        frame: { x: 80, y: 220, width: 500, height: 200 },
        layer: 1,
        shape: 'roundRect',
        fillToken: 'accentSoft',
      },
      {
        id: 'panel-text',
        type: 'text',
        frame: { x: 90, y: 230, width: 480, height: 180 },
        layer: 3,
        doc: richTextFromPlainText('结论必须使用 body 承载'),
        variant: 'caption',
      },
    );
    const references = resolveLayoutReferenceMatches(
      retrieveLayoutReferences({ classification: metadata.classification }),
    );
    const codes = judgeSlideStatic(slide, {
      generationMetadata: metadata,
      layoutReferences: references,
    }).issues.map((issue) => issue.code);
    expect(codes).not.toContain('CAPTION_MISUSE');
    expect(codes).not.toContain('SHAPE_INNER_PADDING');
  });

  it('does not expose blueprint fuzzy-match misses as layout warnings', () => {
    const metadata = slideMetadata('decorative-coverage');
    const slide = slideScene('decorative-coverage');
    slide.elements.push(
      {
        id: 'empty-panel',
        type: 'shape',
        frame: { x: 80, y: 220, width: 600, height: 420 },
        layer: 1,
        shape: 'roundRect',
        fillToken: 'accentSoft',
      },
      {
        id: 'decorative-divider',
        type: 'line',
        frame: { x: 720, y: 430, width: 400, height: 1 },
        layer: 2,
        start: { x: 720, y: 430 },
        end: { x: 1120, y: 430 },
        role: 'divider',
        colorToken: 'muted',
      },
    );
    const references = resolveLayoutReferenceMatches(
      retrieveLayoutReferences({ classification: metadata.classification }),
    );

    expect(
      judgeSlideStatic(slide, { generationMetadata: metadata, layoutReferences: references })
        .issues,
    ).not.toContainEqual(expect.objectContaining({ code: 'BLUEPRINT_COVERAGE' }));
  });

  it('does not expose caption copy semantics as a layout warning', () => {
    const metadata = slideMetadata('caption-conclusion');
    metadata.blueprint.keyMessage = '减少无效等待能提高整个流程的产出';
    metadata.blueprint.contentUnits = [
      {
        id: 'conclusion',
        role: 'takeaway',
        text: '减少无效等待能提高整个流程的产出',
        priority: 'primary',
      },
    ];
    const slide = slideScene('caption-conclusion');
    slide.elements.push(
      {
        id: 'example-image',
        type: 'image',
        frame: { x: 80, y: 220, width: 720, height: 405 },
        layer: 2,
        src: 'https://example.invalid/process.png',
        alt: '流程等待环节示意',
        fit: 'cover',
      },
      {
        id: 'teaching-caption',
        type: 'text',
        frame: { x: 80, y: 650, width: 720, height: 64 },
        layer: 3,
        doc: richTextFromPlainText('减少无效等待能提高整个流程的产出'),
        variant: 'caption',
      },
    );
    const references = resolveLayoutReferenceMatches(
      retrieveLayoutReferences({ classification: metadata.classification }),
    );

    expect(
      judgeSlideStatic(slide, { generationMetadata: metadata, layoutReferences: references })
        .issues,
    ).not.toContainEqual(expect.objectContaining({ code: 'CAPTION_MISUSE' }));
  });

  it('keeps a genuine source note as a valid caption', () => {
    const metadata = slideMetadata('source-caption');
    const slide = slideScene('source-caption');
    slide.elements.push({
      id: 'source-note',
      type: 'text',
      frame: { x: 80, y: 720, width: 800, height: 56 },
      layer: 3,
      doc: richTextFromPlainText('数据来源：课程提供的实验记录'),
      variant: 'caption',
    });
    const references = resolveLayoutReferenceMatches(
      retrieveLayoutReferences({ classification: metadata.classification }),
    );

    expect(
      judgeSlideStatic(slide, { generationMetadata: metadata, layoutReferences: references })
        .issues,
    ).not.toContainEqual(expect.objectContaining({ code: 'CAPTION_MISUSE' }));
  });

  it('suppresses small markers, connector proximity, and non-obscuring layer advice', () => {
    const slide = slideScene('primitive-warnings');
    slide.elements.push(
      {
        id: 'bad-panel',
        type: 'shape',
        frame: { x: 500, y: 300, width: 240, height: 140 },
        layer: 5,
        shape: 'rect',
        fillToken: 'surface',
      },
      {
        id: 'bad-line',
        type: 'line',
        frame: { x: 900, y: 500, width: 1, height: 1 },
        layer: 4,
        start: { x: 900, y: 500 },
        end: { x: 901, y: 500 },
        role: 'connector',
        colorToken: 'accent',
      },
      {
        id: 'bad-order-line',
        type: 'line',
        frame: { x: 500, y: 370, width: 240, height: 4 },
        layer: 4,
        start: { x: 500, y: 370 },
        end: { x: 740, y: 370 },
        role: 'divider',
        colorToken: 'muted',
      },
    );
    const codes = judgeSlideStatic(slide).issues.map((issue) => issue.code);
    expect(codes).not.toContain('ELEMENT_TOO_SMALL');
    expect(codes).not.toContain('DRAWING_CONNECTION');
    expect(codes).not.toContain('SEMANTIC_LAYER_ORDER');
  });

  it('warns when vertical arrows float beside otherwise aligned text steps', () => {
    const slide = slideScene('floating-arrow-rail');
    slide.elements.push(
      {
        id: 'step-one',
        type: 'text',
        frame: { x: 700, y: 260, width: 500, height: 56 },
        layer: 3,
        doc: richTextFromPlainText('第一步'),
        variant: 'body',
      },
      {
        id: 'step-two',
        type: 'text',
        frame: { x: 700, y: 380, width: 500, height: 56 },
        layer: 3,
        doc: richTextFromPlainText('第二步'),
        variant: 'body',
      },
      {
        id: 'floating-arrow',
        type: 'line',
        frame: { x: 672, y: 324, width: 1, height: 48 },
        layer: 2,
        start: { x: 672, y: 324 },
        end: { x: 672, y: 372 },
        role: 'arrow',
        colorToken: 'accent',
      },
    );

    expect(judgeSlideStatic(slide).issues).toContainEqual(
      expect.objectContaining({
        id: 'line-axis-floating%2Darrow',
        code: 'DRAWING_CONNECTION',
        elementIds: ['floating-arrow', 'step-one', 'step-two'],
      }),
    );
  });

  it('accepts a vertical arrow centered between aligned text steps', () => {
    const slide = slideScene('centered-arrow');
    slide.elements.push(
      {
        id: 'step-one',
        type: 'text',
        frame: { x: 700, y: 260, width: 500, height: 56 },
        layer: 3,
        doc: richTextFromPlainText('第一步'),
        variant: 'body',
      },
      {
        id: 'step-two',
        type: 'text',
        frame: { x: 700, y: 380, width: 500, height: 56 },
        layer: 3,
        doc: richTextFromPlainText('第二步'),
        variant: 'body',
      },
      {
        id: 'centered-arrow',
        type: 'line',
        frame: { x: 950, y: 324, width: 1, height: 48 },
        layer: 2,
        start: { x: 950, y: 324 },
        end: { x: 950, y: 372 },
        role: 'arrow',
        colorToken: 'accent',
      },
    );

    expect(judgeSlideStatic(slide).issues).not.toContainEqual(
      expect.objectContaining({ id: 'line-axis-centered%2Darrow' }),
    );
  });

  it('accepts a horizontal arrow centered between adjacent images', () => {
    const slide = slideScene('image-sequence-arrow');
    slide.elements.push(
      {
        id: 'stage-one-image',
        type: 'image',
        frame: { x: 80, y: 250, width: 432, height: 324 },
        layer: 3,
        objectKey: 'test/stage-one.png',
        alt: '第一阶段',
        fit: 'contain',
      },
      {
        id: 'stage-two-image',
        type: 'image',
        frame: { x: 584, y: 250, width: 432, height: 324 },
        layer: 3,
        objectKey: 'test/stage-two.png',
        alt: '第二阶段',
        fit: 'contain',
      },
      {
        id: 'stage-arrow',
        type: 'line',
        frame: { x: 520, y: 412, width: 56, height: 1 },
        layer: 2,
        start: { x: 520, y: 412 },
        end: { x: 576, y: 412 },
        role: 'arrow',
        colorToken: 'accent',
      },
    );

    expect(judgeSlideStatic(slide).issues).not.toContainEqual(
      expect.objectContaining({ id: 'line-axis-stage%2Darrow' }),
    );
  });
});
