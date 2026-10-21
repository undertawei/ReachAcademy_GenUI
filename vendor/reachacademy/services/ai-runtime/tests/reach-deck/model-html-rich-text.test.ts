import { describe, expect, it } from 'vitest';
import { parseDeckSlideValue, richTextToPlainText } from '@reachany/reach-deck-dsl';

// 导入 generation-pipeline 会在模块加载时注册 tiptap HTML 解析器
// （installReachDeckRichTextParser），这里正是要验证那条注册生效。
import '../../lib/reach-deck/generation-pipeline.js';

const slideWithText = (text: string) => ({
  id: 'slide-1',
  title: 'HTML 富文本',
  layout: 'freeform' as const,
  duration: 8,
  background: '#ffffff',
  elements: [
    {
      id: 'title-1',
      type: 'text' as const,
      frame: { x: 80, y: 64, width: 900, height: 120 },
      layer: 1,
      text,
      variant: 'title' as const,
    },
  ],
  animations: [],
  voiceTimeline: [],
});

const firstTextElement = (slide: ReturnType<typeof parseDeckSlideValue>) => {
  const element = slide.elements[0];
  if (element?.type !== 'text') throw new Error('expected a text element');
  return element;
};

describe('model HTML output becomes rich text', () => {
  it('parses the emphasis subset into marks instead of literal tags', () => {
    const element = firstTextElement(
      parseDeckSlideValue(slideWithText('<p><strong>水足迹</strong>调查课</p>')),
    );

    expect(richTextToPlainText(element.doc)).toBe('水足迹调查课');
    // 关键:标签必须变成 mark,而不是留在文本里。
    expect(richTextToPlainText(element.doc)).not.toContain('<strong>');
    expect(element.doc.content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe('bold');
  });

  it('keeps span styling the toolbar can also produce', () => {
    const element = firstTextElement(
      parseDeckSlideValue(
        slideWithText('<p><span style="color: #ff0000; font-size: 48px">重点</span></p>'),
      ),
    );
    const marks = element.doc.content?.[0]?.content?.[0]?.marks ?? [];
    const textStyle = marks.find((mark) => mark.type === 'textStyle');
    expect(textStyle?.attrs?.color).toBe('#ff0000');
    expect(textStyle?.attrs?.fontSize).toBe('48px');
  });

  it('still accepts plain text without HTML tags', () => {
    const element = firstTextElement(parseDeckSlideValue(slideWithText('纯文本标题')));
    expect(richTextToPlainText(element.doc)).toBe('纯文本标题');
  });

  it('drops scripts and event handlers from model output', () => {
    // 生成侧的信任边界:模型输出可能带注入,schema 白名单负责丢弃。
    const element = firstTextElement(
      parseDeckSlideValue(slideWithText('<p onclick="x()">安全<script>alert(1)</script>文本</p>')),
    );
    const serialized = JSON.stringify(element.doc);
    expect(serialized).not.toContain('script');
    expect(serialized).not.toContain('onclick');
    expect(richTextToPlainText(element.doc)).toBe('安全文本');
  });

  it('is idempotent so re-parsing does not churn the revision digest', () => {
    const once = parseDeckSlideValue(slideWithText('<p><em>斜体</em></p>'));
    const twice = parseDeckSlideValue(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});
