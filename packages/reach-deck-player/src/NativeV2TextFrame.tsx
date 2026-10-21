import type { CSSProperties, ReactNode } from 'react';
import { useLayoutEffect, useRef } from 'react';
import type { ReachDeckTextFrameV2 } from '@reachany/reach-deck-dsl';

import { ReachDeckRichText } from './ReachDeckRichText.js';

export interface NativeV2TextFrameProps {
  text: ReachDeckTextFrameV2;
  animationTextColor?: string;
  /** Missing keeps the historical imported-document rendering contract. */
  pptxTextCompat?: boolean;
  /** Optional replacement content (e.g. an inline editor) rendered with the same frame semantics. */
  children?: ReactNode;
  contentBackgroundStyle?: CSSProperties;
  /** 元素盒翻转时由渲染器传入的文字层补偿变换，让文字按 PowerPoint 语义显示。 */
  compensationTransform?: string;
}

const verticalJustification: Record<
  ReachDeckTextFrameV2['verticalAlignment'],
  CSSProperties['justifyContent']
> = {
  top: 'flex-start',
  middle: 'center',
  bottom: 'flex-end',
};

/** 渲染 QA 的正式溢出阈值:内容高出框体超过 2px 记为溢出。 */
const OVERFLOW_THRESHOLD_PX = 2;

/**
 * Native text frames render through the SAME shared rich-text renderer as v1
 * text elements — one text box kind everywhere. This wrapper only carries the
 * PPTX frame semantics (margins, vertical anchoring, wrap, autofit scaling).
 *
 * Overflow stays visible: PowerPoint never clips text at the shape bounds
 * (bodyPr overflow defaults to "overflow", and resize-shape autofit grows the
 * shape instead). Browser text metrics differ slightly from PowerPoint, so
 * clipping here would truncate real content. Measured overflow beyond 2px is
 * exposed as `data-native-v2-text-overflow` (px) for render QA.
 */
export function NativeV2TextFrame({
  animationTextColor,
  text,
  pptxTextCompat = true,
  children,
  contentBackgroundStyle,
  compensationTransform,
}: NativeV2TextFrameProps) {
  const scale = text.autofit.mode === 'shrink-text' ? (text.autofit.fontScale ?? 1) : 1;
  const lineSpacingScale =
    text.autofit.mode === 'shrink-text' ? 1 - (text.autofit.lineSpacingReduction ?? 0) : 1;
  const editing = children !== undefined && children !== null;
  const frameRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const overflow = frame.scrollHeight - frame.clientHeight;
    if (overflow > OVERFLOW_THRESHOLD_PX) {
      frame.setAttribute('data-native-v2-text-overflow', String(Math.round(overflow)));
    } else {
      frame.removeAttribute('data-native-v2-text-overflow');
    }
  });
  const content = editing ? (
    children
  ) : (
    <ReachDeckRichText
      animationTextColor={animationTextColor}
      document={text.doc}
      pptxTextCompat={pptxTextCompat}
    />
  );
  return (
    <div
      data-native-v2-text-frame
      ref={frameRef}
      style={{
        boxSizing: 'border-box',
        columnCount: text.columns,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        justifyContent: verticalJustification[text.verticalAlignment],
        overflow: 'visible',
        padding: `${text.margins.top}px ${text.margins.right}px ${text.margins.bottom}px ${text.margins.left}px`,
        whiteSpace: text.wrap ? 'pre-wrap' : 'pre',
        width: '100%',
        ...(compensationTransform === undefined ? {} : { transform: compensationTransform }),
        // PPTX bodyPr vert(eaVert 等)→ 东亚竖排:自上而下、行从右往左。
        ...(text.orientation === 'vertical' ? { writingMode: 'vertical-rl' } : {}),
        ...(scale === 1 && lineSpacingScale === 1
          ? {}
          : {
              // normAutofit font scaling applies to the whole frame content.
              fontSize: `${scale}em`,
              lineHeight: lineSpacingScale,
            }),
      }}
    >
      {contentBackgroundStyle === undefined ? (
        content
      ) : (
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <div
            aria-hidden="true"
            data-native-v2-content-background
            style={{
              ...contentBackgroundStyle,
              position: 'absolute',
              top: -text.margins.top,
              right: -text.margins.right,
              bottom: -text.margins.bottom,
              left: -text.margins.left,
              pointerEvents: 'none',
              // 补偿只属于文字：背景再叠一次同样的变换，填充仍随元素翻转。
              ...(compensationTransform === undefined ? {} : { transform: compensationTransform }),
            }}
          />
          <div style={{ position: 'relative' }}>{content}</div>
        </div>
      )}
    </div>
  );
}
