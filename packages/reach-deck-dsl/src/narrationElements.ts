/**
 * 讲稿生成阶段的"页面内容 → 元素清单"序列化。
 *
 * 讲稿阶段的输入是**已定稿的页面元素**：模型只能引用清单里的元素 id 做 reveal 锚定
 * （schema enum 约束），并按各元素的纯文本摘要撰写贴合版面的讲稿。设计上 v1 scene 与
 * v2 native slide 各有一个 serializer 且输出同构；本文件是 v1 `DeckSlide` 入口，
 * v2 入口随 PPTX 路径接入时补齐（共用 `NarrationSlideElementSummary` 形状）。
 */

import { richTextToPlainText } from './richText.js';
import type { DeckSlide } from './types.js';
import type { ReachDeckMediaOrigin } from './mediaOrigin.js';

/** 讲稿阶段可引用的一个页面元素：id + 类型（+ 文本层级）+ 纯文本摘要。 */
export interface NarrationSlideElementSummary {
  id: string;
  type: 'text' | 'shape' | 'line' | 'image' | 'video' | 'scientificVisual' | 'table';
  /** 仅 text 元素携带：排版层级（title/body/...），帮助模型判断 reveal 顺序。 */
  variant?: string;
  /** 纯文本摘要：text 取富文本纯文本，image 取 alt，video 取标题。 */
  text: string;
  /** Route and selected source identity, never a prompt or temporary download URL. */
  origin?: Pick<ReachDeckMediaOrigin, 'route' | 'title' | 'description' | 'sourceUrl'>;
  /** Stable presentation anchors declared by one scientific visual; no seconds are model-authored. */
  scientificAnchors?: Array<{ id: string; description: string }>;
  /** Trusted grouping metadata persisted by HTML/native compilation. */
  revealGroupId?: string;
  decorative?: boolean;
}

/**
 * 把 v1 slide 的元素序列化成讲稿阶段的元素清单。
 *
 * 数据源：`DeckSlide.elements`（durable v1 可含五类元素；active slide/v16 暂不生成 video）。
 * 核心逻辑：逐元素取 id 与类型；text 元素的 `doc` 经 `richTextToPlainText` 摘要成
 * 纯文本并保留 variant，image 用 alt、video 用 title 充当可讲述的文本摘要。
 * 装饰性 shape/line 默认跳过；只有显式非空 ariaLabel 表明其本身具有教学语义时才进入。
 * 顺序保持元素数组原序（即版面声明序），确定性且无 I/O。
 */
export const summarizeDeckSlideElementsForNarration = (
  slide: DeckSlide,
): NarrationSlideElementSummary[] =>
  slide.elements.flatMap((element): NarrationSlideElementSummary[] => {
    switch (element.type) {
      case 'text':
        return [
          {
            id: element.id,
            type: 'text',
            variant: element.variant,
            text: richTextToPlainText(element.doc),
          },
        ];
      case 'shape':
      case 'line': {
        const label = element.ariaLabel?.trim();
        return label === undefined || label.length === 0
          ? []
          : [{ id: element.id, type: element.type, text: label }];
      }
      case 'image':
        return [{ id: element.id, type: 'image', text: element.alt }];
      case 'video':
        return [{ id: element.id, type: 'video', text: element.title }];
      case 'scientificVisual':
        return [
          {
            id: element.id,
            type: 'scientificVisual',
            text: element.manifest.textAlternative,
            scientificAnchors: element.manifest.anchors.map((anchor) => ({ ...anchor })),
          },
        ];
    }
  });
