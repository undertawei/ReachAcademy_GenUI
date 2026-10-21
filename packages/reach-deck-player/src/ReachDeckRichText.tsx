import { type CSSProperties, type ReactNode } from 'react';
import {
  richTextMaximumFontSize,
  richTextGradientCss,
  type RichTextDocument,
  type RichTextNode,
} from '@reachany/reach-deck-dsl';
import { mathToPlainText, renderMathToString } from '@reachany/tiptap-mathlive/static';

import { translateReachDeck, type ReachDeckTranslate } from './i18n.js';

function explicitMaximumFontSize(root: RichTextNode): number | undefined {
  let maximum: number | undefined;
  const visit = (node: RichTextNode) => {
    const candidates = [
      node.attrs?.fontSize,
      node.marks?.find((mark) => mark.type === 'textStyle')?.attrs?.fontSize,
    ];
    for (const candidate of candidates) {
      const parsed = Number.parseFloat(String(candidate ?? ''));
      if (Number.isFinite(parsed) && parsed > 0) maximum = Math.max(maximum ?? 0, parsed);
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(root);
  return maximum;
}

const paragraphFontSize = (
  node: RichTextNode,
  defaultFontSize: number | undefined,
): number | undefined => {
  const explicit = node.attrs?.fontSize;
  // A paragraph's baseline strut can be smaller than its styled inline text.
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit;
  return defaultFontSize === undefined
    ? explicitMaximumFontSize(node)
    : richTextMaximumFontSize(node, defaultFontSize);
};

/** Keep the baseline strut aligned with uniformly styled generated HTML runs. */
function cssFontFamily(family: string): string {
  if (family === 'Noto Sans')
    return '"Noto Sans", "Noto Sans SC", ui-sans-serif, system-ui, sans-serif';
  if (family === 'Noto Serif') return '"Noto Serif", "Noto Serif SC", ui-serif, Georgia, serif';
  return `"${family.replaceAll('\\', '').replaceAll('"', '')}"`;
}

function commonTextRunFontFamily(node: RichTextNode): string | undefined {
  const families = new Set<string>();
  let unspecified = false;
  const visit = (child: RichTextNode) => {
    if (child.type === 'text' && child.text?.trim()) {
      const family = child.marks?.find((mark) => mark.type === 'textStyle')?.attrs?.fontFamily;
      if (typeof family === 'string' && family.trim()) families.add(family);
      else unspecified = true;
    } else if (child.type === 'inlineMath' || child.type === 'blockMath') unspecified = true;
    for (const nested of child.content ?? []) visit(nested);
  };
  visit(node);
  return !unspecified && families.size === 1 ? [...families][0] : undefined;
}

export function ReachDeckRichText({
  animationTextColor,
  defaultFontSize,
  document,
  mediaUrlsByObjectKey,
  pptxTextCompat = false,
  translate,
}: {
  animationTextColor?: string;
  defaultFontSize?: number;
  document: RichTextDocument;
  /**
   * 稳定 objectKey → 短时展示 URL。
   *
   * 授课内容里的图片节点只存 objectKey（易失 URL 进文档会打乱 revision token），
   * 渲染期在这里补上地址。学生作答的图片自带实时 `src`，映射缺失时仍按原样渲染。
   */
  mediaUrlsByObjectKey?: Readonly<Record<string, string>>;
  /**
   * PowerPoint line-box fidelity for native PPTX frames: no space-before on
   * the first paragraph, single spacing = 1.2em, and baselines anchored to the
   * line-box bottom (compressed spacing overflows above, CSS splits it evenly).
   */
  pptxTextCompat?: boolean;
  translate?: ReachDeckTranslate;
}) {
  return (
    <>
      {(document.content ?? []).map((node, index) => (
        <RichTextBlock
          animationTextColor={animationTextColor}
          defaultFontSize={defaultFontSize}
          key={index}
          mediaUrlsByObjectKey={mediaUrlsByObjectKey}
          node={node}
          pptxTextCompat={pptxTextCompat}
          suppressSpaceBefore={pptxTextCompat && index === 0}
          translate={translate}
        />
      ))}
    </>
  );
}

function MathNode({
  animationTextColor,
  defaultFontSize,
  displayMode,
  node,
}: {
  animationTextColor?: string;
  defaultFontSize?: number;
  displayMode: boolean;
  node: RichTextNode;
}) {
  const latex = typeof node.attrs?.latex === 'string' ? node.attrs.latex : '';
  const parsedFontSize = Number.parseFloat(String(node.attrs?.fontSize ?? ''));
  const fontSize =
    Number.isFinite(parsedFontSize) && parsedFontSize > 0 ? parsedFontSize : defaultFontSize;
  const parsedLineHeight = Number.parseFloat(String(node.attrs?.lineHeightPx ?? ''));
  const fontFamily = typeof node.attrs?.fontFamily === 'string' ? node.attrs.fontFamily : undefined;
  const color =
    animationTextColor ?? (typeof node.attrs?.color === 'string' ? node.attrs.color : undefined);
  const Element = displayMode ? 'div' : 'span';
  return (
    <Element
      aria-label={mathToPlainText(latex, displayMode)}
      className={`reachany-mathlive-node ${displayMode ? 'is-block' : 'is-inline'}`}
      data-latex={latex}
      data-mathlive-node={displayMode ? 'block-math' : 'inline-math'}
      role="math"
      style={{
        color,
        fontFamily:
          fontFamily === undefined
            ? undefined
            : `"${fontFamily.replaceAll('\\', '').replaceAll('"', '')}"`,
        fontSize: fontSize === undefined ? undefined : `${fontSize}px`,
        letterSpacing: 'normal',
        lineHeight:
          Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
            ? `${parsedLineHeight}px`
            : undefined,
      }}
    >
      <Element
        className="reachany-mathlive-static"
        dangerouslySetInnerHTML={{ __html: renderMathToString(latex, { displayMode }) }}
      />
    </Element>
  );
}

function RichTextBlock({
  animationTextColor,
  defaultFontSize,
  mediaUrlsByObjectKey,
  node,
  pptxTextCompat = false,
  suppressSpaceBefore = false,
  translate,
}: {
  animationTextColor?: string;
  defaultFontSize?: number;
  mediaUrlsByObjectKey?: Readonly<Record<string, string>>;
  node: RichTextNode;
  pptxTextCompat?: boolean;
  suppressSpaceBefore?: boolean;
  translate?: ReachDeckTranslate;
}) {
  if (node.type === 'hardBreak') return <br />;
  if (node.type === 'blockMath' || node.type === 'mathBlock') {
    return (
      <MathNode
        animationTextColor={animationTextColor}
        defaultFontSize={defaultFontSize}
        displayMode
        node={node}
      />
    );
  }
  if (node.type === 'image') {
    const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
    const objectKey = typeof node.attrs?.objectKey === 'string' ? node.attrs.objectKey : undefined;
    // 映射优先：作答图片里存下来的 `src` 可能已经过期，重签后的地址才是可用的。
    const mapped = objectKey === undefined ? undefined : mediaUrlsByObjectKey?.[objectKey];
    const src =
      mapped !== undefined && mapped.length > 0
        ? mapped
        : typeof node.attrs?.src === 'string'
          ? node.attrs.src
          : '';
    return src ? (
      <img alt={alt} data-object-key={objectKey} loading="lazy" src={src} />
    ) : (
      <span
        aria-label={alt || translateReachDeck(translate, 'reachDeck.player.richText.image', '图片')}
        data-object-key={objectKey}
        role="img"
      >
        {alt || translateReachDeck(translate, 'reachDeck.player.richText.image', '图片')}
      </span>
    );
  }
  if (node.type === 'bulletList' || node.type === 'orderedList') {
    const List = node.type === 'bulletList' ? 'ul' : 'ol';
    return (
      <List>
        {(node.content ?? []).map((child, index) => (
          <RichTextBlock
            animationTextColor={animationTextColor}
            defaultFontSize={defaultFontSize}
            key={index}
            mediaUrlsByObjectKey={mediaUrlsByObjectKey}
            node={child}
            pptxTextCompat={pptxTextCompat}
            translate={translate}
          />
        ))}
      </List>
    );
  }
  if (node.type === 'listItem') {
    return (
      <li>
        {(node.content ?? []).map((child, index) => (
          <RichTextBlock
            animationTextColor={animationTextColor}
            defaultFontSize={defaultFontSize}
            key={index}
            mediaUrlsByObjectKey={mediaUrlsByObjectKey}
            node={child}
            pptxTextCompat={pptxTextCompat}
            translate={translate}
          />
        ))}
      </li>
    );
  }
  if (node.type === 'blockquote') {
    return (
      <blockquote>
        {(node.content ?? []).map((child, index) => (
          <RichTextBlock
            animationTextColor={animationTextColor}
            defaultFontSize={defaultFontSize}
            key={index}
            mediaUrlsByObjectKey={mediaUrlsByObjectKey}
            node={child}
            pptxTextCompat={pptxTextCompat}
            translate={translate}
          />
        ))}
      </blockquote>
    );
  }
  // 表格只出现在文档语义字段（测验题干 / 解析）里；幻灯片文本框的 schema 没有这些节点。
  if (node.type === 'table' || node.type === 'tableRow') {
    const Element = node.type === 'table' ? 'table' : 'tr';
    const rows = (node.content ?? []).map((child, index) => (
      <RichTextBlock
        animationTextColor={animationTextColor}
        defaultFontSize={defaultFontSize}
        key={index}
        mediaUrlsByObjectKey={mediaUrlsByObjectKey}
        node={child}
        pptxTextCompat={pptxTextCompat}
        translate={translate}
      />
    ));
    return Element === 'table' ? (
      <table>
        <tbody>{rows}</tbody>
      </table>
    ) : (
      <tr>{rows}</tr>
    );
  }
  if (node.type === 'tableCell' || node.type === 'tableHeader') {
    const Cell = node.type === 'tableHeader' ? 'th' : 'td';
    const colSpan = typeof node.attrs?.colspan === 'number' ? node.attrs.colspan : undefined;
    const rowSpan = typeof node.attrs?.rowspan === 'number' ? node.attrs.rowspan : undefined;
    return (
      <Cell
        {...(colSpan === undefined || colSpan <= 1 ? {} : { colSpan })}
        {...(rowSpan === undefined || rowSpan <= 1 ? {} : { rowSpan })}
      >
        {(node.content ?? []).map((child, index) => (
          <RichTextBlock
            animationTextColor={animationTextColor}
            defaultFontSize={defaultFontSize}
            key={index}
            mediaUrlsByObjectKey={mediaUrlsByObjectKey}
            node={child}
            pptxTextCompat={pptxTextCompat}
            translate={translate}
          />
        ))}
      </Cell>
    );
  }
  if (node.type === 'codeBlock') {
    return (
      <pre>
        <code>{(node.content ?? []).map((child) => child.text ?? '').join('')}</code>
      </pre>
    );
  }
  if (node.type === 'horizontalRule') return <hr />;

  const rawAlign = node.attrs?.textAlign;
  const baselineFontFamily = pptxTextCompat ? undefined : commonTextRunFontFamily(node);
  const align =
    rawAlign === 'left' || rawAlign === 'center' || rawAlign === 'right' || rawAlign === 'justify'
      ? rawAlign
      : undefined;
  const declaredLineHeight =
    typeof node.attrs?.lineHeight === 'number' && node.attrs.lineHeight > 0
      ? node.attrs.lineHeight
      : undefined;
  // 绝对行距（PPTX spcPts,舞台 px)优先于相对倍数。
  const lineHeightPx =
    typeof node.attrs?.lineHeightPx === 'number' && node.attrs.lineHeightPx > 0
      ? node.attrs.lineHeightPx
      : undefined;
  // PowerPoint single spacing is 1.2em; CSS `normal` depends on the font.
  const lineHeight =
    lineHeightPx !== undefined
      ? undefined
      : (declaredLineHeight ?? (pptxTextCompat ? 1.2 : undefined));
  const fontSize = paragraphFontSize(node, defaultFontSize);
  // Compressed PPTX spacing takes the missing leading from above the line
  // (ink sits on the line-box bottom); CSS half-leading splits it evenly.
  // Shift the paragraph up by the other half so the first line lands where
  // PowerPoint puts it. Baseline-to-baseline distances are unaffected.
  const effectiveLineHeightPx =
    lineHeightPx ??
    (lineHeight === undefined || fontSize === undefined ? undefined : lineHeight * fontSize);
  const compatShift =
    pptxTextCompat &&
    fontSize !== undefined &&
    effectiveLineHeightPx !== undefined &&
    effectiveLineHeightPx < 1.2 * fontSize
      ? (1.2 * fontSize - effectiveLineHeightPx) / 2
      : 0;
  const spaceBefore =
    !suppressSpaceBefore &&
    typeof node.attrs?.spaceBefore === 'number' &&
    node.attrs.spaceBefore > 0
      ? node.attrs.spaceBefore
      : undefined;
  const spaceAfter =
    typeof node.attrs?.spaceAfter === 'number' && node.attrs.spaceAfter > 0
      ? node.attrs.spaceAfter
      : undefined;
  const leftIndent =
    typeof node.attrs?.leftIndent === 'number' && node.attrs.leftIndent > 0
      ? node.attrs.leftIndent
      : undefined;
  const rightIndent =
    typeof node.attrs?.rightIndent === 'number' && node.attrs.rightIndent > 0
      ? node.attrs.rightIndent
      : undefined;
  const firstLineIndent =
    typeof node.attrs?.firstLineIndent === 'number' && node.attrs.firstLineIndent !== 0
      ? node.attrs.firstLineIndent
      : undefined;
  const defaultLetterSpacing =
    typeof node.attrs?.defaultLetterSpacing === 'number' &&
    Number.isFinite(node.attrs.defaultLetterSpacing) &&
    node.attrs.defaultLetterSpacing !== 0
      ? node.attrs.defaultLetterSpacing
      : undefined;
  const children = (node.content ?? []).map((child, index) => (
    <RichTextInline
      animationTextColor={animationTextColor}
      defaultFontSize={fontSize}
      key={index}
      node={child}
      pptxTextCompat={pptxTextCompat}
    />
  ));

  const Block =
    node.type === 'heading' && typeof node.attrs?.level === 'number'
      ? (`h${Math.min(6, Math.max(1, node.attrs.level))}` as 'h1')
      : 'p';
  return (
    <Block
      className="text-element__paragraph"
      style={{
        ...(animationTextColor === undefined ? {} : { color: animationTextColor }),
        ...(baselineFontFamily === undefined
          ? {}
          : { fontFamily: cssFontFamily(baselineFontFamily) }),
        ...(fontSize === undefined ? {} : { fontSize: `${fontSize}px` }),
        ...(align ? { textAlign: align } : {}),
        ...(lineHeight === undefined ? {} : { lineHeight }),
        ...(lineHeightPx === undefined ? {} : { lineHeight: `${lineHeightPx}px` }),
        ...(spaceBefore === undefined && compatShift === 0
          ? {}
          : { marginTop: (spaceBefore ?? 0) - compatShift }),
        ...(spaceAfter === undefined ? {} : { marginBottom: spaceAfter }),
        ...(leftIndent === undefined ? {} : { marginLeft: leftIndent }),
        ...(rightIndent === undefined ? {} : { marginRight: rightIndent }),
        ...(firstLineIndent === undefined ? {} : { textIndent: firstLineIndent }),
        ...(defaultLetterSpacing === undefined
          ? {}
          : { letterSpacing: `${defaultLetterSpacing}px` }),
      }}
    >
      {children.length > 0 ? children : <br />}
    </Block>
  );
}

// PowerPoint 上下标只做基线偏移、不撑高父行盒;浏览器默认 sup/sub 的
// vertical-align 会扩大行盒,使导入文本的行距漂移(化学式最明显)。
const supCompatStyle: CSSProperties = {
  lineHeight: 0,
  position: 'relative',
  verticalAlign: 'baseline',
  top: '-0.35em',
};
const subCompatStyle: CSSProperties = {
  lineHeight: 0,
  position: 'relative',
  verticalAlign: 'baseline',
  top: '0.2em',
};

function RichTextInline({
  animationTextColor,
  defaultFontSize,
  node,
  pptxTextCompat = false,
}: {
  animationTextColor?: string;
  defaultFontSize?: number;
  node: RichTextNode;
  pptxTextCompat?: boolean;
}) {
  if (node.type === 'hardBreak') return <br />;
  if (node.type === 'inlineMath' || node.type === 'mathInline') {
    return (
      <MathNode
        animationTextColor={animationTextColor}
        defaultFontSize={defaultFontSize}
        displayMode={false}
        node={node}
      />
    );
  }
  if (node.type === 'quizBlank') {
    const blankIndex = Math.max(1, Math.trunc(Number(node.attrs?.blankIndex) || 1));
    return (
      <span className="quiz-scene__blank-marker" data-blank-id={node.attrs?.blankId}>
        {`____${blankIndex}____`}
      </span>
    );
  }
  if (node.content !== undefined) {
    return (
      <>
        {node.content.map((child, index) => (
          <RichTextInline
            animationTextColor={animationTextColor}
            defaultFontSize={defaultFontSize}
            key={index}
            node={child}
            pptxTextCompat={pptxTextCompat}
          />
        ))}
      </>
    );
  }
  if (typeof node.text !== 'string') return null;

  const style: CSSProperties = {};
  let content: ReactNode = node.text;
  let explicitFontWeight: number | undefined;

  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        style.fontWeight = 700;
        break;
      case 'code':
        content = <code>{content}</code>;
        break;
      case 'italic':
        style.fontStyle = 'italic';
        break;
      case 'underline':
        style.textDecoration = 'underline';
        break;
      case 'strike':
        style.textDecoration =
          style.textDecoration === 'underline' ? 'underline line-through' : 'line-through';
        break;
      case 'superscript':
        content = <sup style={pptxTextCompat ? supCompatStyle : undefined}>{content}</sup>;
        break;
      case 'subscript':
        content = <sub style={pptxTextCompat ? subCompatStyle : undefined}>{content}</sub>;
        break;
      case 'textStyle': {
        const {
          color,
          backgroundColor,
          fontFamily,
          fontSize,
          fontWeight,
          letterSpacing,
          lineHeightPx,
        } = mark.attrs ?? {};
        if (typeof lineHeightPx === 'number' && Number.isFinite(lineHeightPx) && lineHeightPx > 0) {
          style.lineHeight = `${lineHeightPx}px`;
        }
        const gradient = richTextGradientCss(mark.attrs?.textGradient);
        if (gradient && animationTextColor === undefined) {
          style.backgroundImage = gradient;
          style.backgroundClip = 'text';
          style.WebkitBackgroundClip = 'text';
          style.WebkitTextFillColor = 'transparent';
        }
        if (typeof color === 'string') style.color = color;
        if (typeof backgroundColor === 'string') style.backgroundColor = backgroundColor;
        if (typeof letterSpacing === 'number' && letterSpacing !== 0) {
          style.letterSpacing = `${letterSpacing}px`;
        }
        if (typeof fontFamily === 'string') {
          // Catalog families can contain spaces, digits and parentheses
          // ("Alibaba PuHuiTi 3.0", "Zhuque Fangsong (technical preview)");
          // unquoted they are invalid CSS and the declaration would be dropped.
          style.fontFamily = cssFontFamily(fontFamily);
        }
        if (fontSize !== undefined) {
          const size =
            typeof fontSize === 'number' ? fontSize : Number.parseFloat(String(fontSize));
          if (Number.isFinite(size) && size > 0) style.fontSize = `${size}px`;
        }
        if (fontWeight !== undefined) {
          const weight =
            typeof fontWeight === 'number' ? fontWeight : Number.parseInt(String(fontWeight), 10);
          if (Number.isFinite(weight) && weight >= 100 && weight <= 900) {
            explicitFontWeight = weight;
          }
        }
        break;
      }
      default:
        break;
    }
  }
  if (explicitFontWeight !== undefined) style.fontWeight = explicitFontWeight;
  if (animationTextColor !== undefined) style.color = animationTextColor;

  return Object.keys(style).length === 0 ? <>{content}</> : <span style={style}>{content}</span>;
}
