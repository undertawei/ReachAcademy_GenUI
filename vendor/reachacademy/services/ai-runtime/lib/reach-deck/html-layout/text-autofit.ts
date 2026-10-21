import type { ReportLayoutDiagnostic } from './types';

/** Runs after fonts settle. Layout assistance is bounded and never rejects a page. */
export function autofitSlideText(root: HTMLElement, report: ReportLayoutDiagnostic): void {
  const document = root.ownerDocument;
  const view = document.defaultView!;
  const siblings = Array.from(root.children).filter(
    (node): node is HTMLElement => node instanceof view.HTMLElement,
  );
  const bounds = root.getBoundingClientRect();
  const rect = (node: HTMLElement) => node.getBoundingClientRect();
  const contains = (a: DOMRect, b: DOMRect) =>
    a.left <= b.left + 1 &&
    a.top <= b.top + 1 &&
    a.right >= b.right - 1 &&
    a.bottom >= b.bottom - 1;
  const area = (a: DOMRect, b: DOMRect) =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const visible = (node: HTMLElement) => {
    const style = view.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  };
  const backgrounds = siblings.filter((node) => {
    const style = view.getComputedStyle(node);
    const solidBackground =
      style.backgroundColor !== 'transparent' &&
      !/^rgba\([^)]*,\s*0\)$/.test(style.backgroundColor);
    const decorativeFigure =
      node.tagName === 'FIGURE' &&
      (solidBackground || /(?:linear|radial|conic)-gradient\(/.test(style.backgroundImage));
    return (
      visible(node) &&
      !node.textContent?.trim() &&
      !node.children.length &&
      (node.tagName === 'DIV' || decorativeFigure) &&
      !node.matches('[data-reach-asset],[data-reach-scientific-asset]') &&
      style.transform === 'none' &&
      (solidBackground || decorativeFigure)
    );
  });
  const texts = siblings.filter((node) => {
    const style = view.getComputedStyle(node);
    return (
      visible(node) &&
      !isFormulaOnly(node) &&
      /^(P|DIV|H[1-6])$/.test(node.tagName) &&
      node.textContent?.trim() &&
      !node.matches('[data-reach-asset],[data-reach-math-latex],[data-latex],.katex') &&
      !node.querySelector('[data-reach-math-display="true"],.katex-display') &&
      !Array.from(
        node.querySelectorAll(
          'div,p,h1,h2,h3,h4,h5,h6,figure,svg,img,table,math,.katex,[data-latex],[data-reach-math-latex]',
        ),
      ).some((child) => !child.closest('[data-reach-math-display="false"]')) &&
      style.position === 'absolute' &&
      style.transform === 'none' &&
      style.writingMode === 'horizontal-tb'
    );
  });
  const hasInlineMath = (node: HTMLElement) =>
    !!node.querySelector('[data-reach-math-display="false"]');
  const carrier = new Map<HTMLElement, HTMLElement>();
  for (const text of texts) {
    const candidates = backgrounds
      .filter((bg) => contains(rect(bg), rect(text)))
      .sort((a, b) => rect(a).width * rect(a).height - rect(b).width * rect(b).height);
    if (
      candidates[0] &&
      (!candidates[1] ||
        (contains(rect(candidates[1]), rect(candidates[0])) &&
          rect(candidates[1]).width * rect(candidates[1]).height >
            rect(candidates[0]).width * rect(candidates[0]).height + 1))
    )
      carrier.set(text, candidates[0]);
  }
  const safeChange = (
    node: HTMLElement,
    change: () => void,
    allowed: Set<HTMLElement> = new Set(),
  ) => {
    const old = rect(node);
    const previous = node.getAttribute('style');
    change();
    const next = rect(node);
    const safe =
      contains(bounds, next) &&
      siblings.every(
        (other) =>
          other === node ||
          allowed.has(other) ||
          !visible(other) ||
          area(next, rect(other)) <= area(old, rect(other)) + 1,
      );
    if (!safe) {
      if (previous === null) node.removeAttribute('style');
      else node.setAttribute('style', previous);
    }
    return safe;
  };
  const measure = (node: HTMLElement) => {
    const style = view.getComputedStyle(node);
    const box = rect(node);
    const walker = document.createTreeWalker(node, view.NodeFilter.SHOW_TEXT);
    const lines: Array<{ top: number; bottom: number; width: number }> = [];
    let right = box.left;
    let left = box.right;
    let bottom = box.top;
    const addRect = (r: DOMRect) => {
      if (!r.width || !r.height) return;
      const line = lines.find(
        (line) =>
          Math.min(line.bottom, r.bottom) - Math.max(line.top, r.top) >=
          Math.min(line.bottom - line.top, r.height) * 0.5,
      );
      if (line) line.width += r.width;
      else lines.push({ top: r.top, bottom: r.bottom, width: r.width });
      right = Math.max(right, r.right);
      left = Math.min(left, r.left);
      bottom = Math.max(bottom, r.bottom);
    };
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue;
      // KaTeX includes hidden MathML and vertically stacked glyphs. Measure the
      // visible inline formula as one box, not as several text lines.
      if (walker.currentNode.parentElement?.closest('[data-reach-math-display="false"]')) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const r of range.getClientRects()) addRect(r);
    }
    for (const math of node.querySelectorAll<HTMLElement>('[data-reach-math-display="false"]'))
      addRect((math.querySelector<HTMLElement>('.katex-html') ?? math).getBoundingClientRect());
    const px = (value: string) => parseFloat(value) || 0;
    const lineHeight = px(style.lineHeight) || px(style.fontSize) * 1.2;
    const height =
      Math.max(
        Math.max(lines.length, node.querySelectorAll('br').length + 1) * lineHeight,
        hasInlineMath(node) ? bottom - box.top : 0,
      ) +
      px(style.paddingTop) +
      px(style.paddingBottom) +
      px(style.borderTopWidth) +
      px(style.borderBottomWidth);
    return {
      height,
      overflow: height > box.height + 1 || right > box.right + 1 || left < box.left - 1,
      lineHeight,
      orphan: lines.length === 2 && lines[1].width <= px(style.fontSize) * 1.5,
    };
  };
  const audits = new Map<HTMLElement, { width: number; height: number; fontSize: number }>();
  const structural = new Map<HTMLElement, string[]>();
  const note = (node: HTMLElement, what: string) =>
    structural.set(node, [...(structural.get(node) ?? []), what]);
  for (const text of texts) {
    if (text.dataset.reachTextAutofit) continue;
    text.dataset.reachTextAutofit = 'v1';
    const before = rect(text);
    const style = view.getComputedStyle(text);
    const originalFont = parseFloat(style.fontSize);
    const inlineMath = hasInlineMath(text);
    audits.set(text, { width: before.width, height: before.height, fontSize: originalFont });
    const originalLineHeight = measure(text).lineHeight;
    const bg = carrier.get(text);
    const allowed = new Set(backgrounds.filter((candidate) => contains(rect(candidate), before)));
    const changes: string[] = [];
    const unintendedWrap = !text.querySelector('br') && measure(text).orphan;
    // A final CJK character can wrap without overflowing a two-line frame.
    if (unintendedWrap && !inlineMath) {
      const previous = text.getAttribute('style');
      const align = style.textAlign;
      const trackingOptions = [style.letterSpacing];
      if (parseFloat(style.letterSpacing) > 0) trackingOptions.push('0px');
      for (const tracking of trackingOptions) {
        text.style.letterSpacing = tracking;
        const wrap = text.style.whiteSpace;
        text.style.whiteSpace = 'nowrap';
        const range = document.createRange();
        range.selectNodeContents(text);
        const width = Math.ceil(
          range.getBoundingClientRect().width +
            (parseFloat(style.paddingLeft) || 0) +
            (parseFloat(style.paddingRight) || 0) +
            1,
        );
        text.style.whiteSpace = wrap;
        if (
          width <= before.width * 1.35 &&
          safeChange(
            text,
            () => {
              text.style.width = `${Math.max(before.width, width)}px`;
              const growth = Math.max(0, width - before.width);
              if (align === 'center' || align === 'right' || align === 'end')
                text.style.left = `${before.left - bounds.left - growth * (align === 'center' ? 0.5 : 1)}px`;
            },
            allowed,
          ) &&
          (!bg || contains(rect(bg), rect(text))) &&
          !measure(text).overflow &&
          !measure(text).orphan
        )
          break;
        if (previous === null) text.removeAttribute('style');
        else text.setAttribute('style', previous);
      }
    }
    if (measure(text).overflow) {
      const singleLine = !text.querySelector('br') && before.height <= originalLineHeight * 1.25;
      if (singleLine) {
        for (const fraction of [0.1, 0.2, 0.35]) {
          const width = Math.min(
            Math.ceil(before.width * (1 + fraction)),
            Math.floor(before.width * 1.35),
          );
          const previous = text.getAttribute('style');
          const previousBackground = bg?.getAttribute('style');
          if (bg) {
            const bgBox = rect(bg);
            const inset = Math.min(32, Math.max(0, before.left - bgBox.left));
            const requiredWidth = Math.ceil(before.left + width + inset - bgBox.left);
            if (inlineMath && before.left + width > bgBox.right) continue;
            if (
              !inlineMath &&
              requiredWidth > bgBox.width &&
              (requiredWidth > bgBox.width + 96 ||
                !safeChange(
                  bg,
                  () => {
                    bg.style.width = `${requiredWidth}px`;
                  },
                  new Set(siblings.filter((other) => other !== bg && contains(bgBox, rect(other)))),
                ))
            )
              continue;
          }
          if (
            safeChange(
              text,
              () => {
                text.style.width = `${width}px`;
              },
              allowed,
            ) &&
            !measure(text).overflow
          ) {
            changes.push('width');
            break;
          }
          if (previous === null) text.removeAttribute('style');
          else text.setAttribute('style', previous);
          if (bg) {
            if (previousBackground == null) bg.removeAttribute('style');
            else bg.setAttribute('style', previousBackground);
          }
        }
      }
      if (measure(text).overflow) {
        const targetHeight = Math.ceil(measure(text).height);
        if (
          targetHeight > rect(text).height &&
          targetHeight <= before.height + Math.max(96, before.height * 0.5) &&
          (!bg || before.top + targetHeight <= rect(bg).bottom + 1) &&
          safeChange(
            text,
            () => {
              text.style.height = `${targetHeight}px`;
            },
            allowed,
          ) &&
          !measure(text).overflow
        )
          changes.push('height');
      }
      // A heading with an authored <br> is often budgeted for one line. In order: drop a
      // redundant single break, push the blocks stacked directly below, then tighten.
      const heading = /^H[1-3]$/.test(text.tagName) || originalFont >= 28;
      const breaks = text.querySelectorAll('br');
      const authoredBreak = breaks.length > 0;
      if (heading && !inlineMath && breaks.length === 1 && measure(text).overflow) {
        const br = breaks[0]!;
        const previousChar = br.previousSibling?.textContent?.slice(-1) ?? '';
        const nextChar = br.nextSibling?.textContent?.charAt(0) ?? '';
        const cjk = /[⺀-鿿　-〿＀-￯]/;
        const joint = document.createTextNode(
          cjk.test(previousChar) || cjk.test(nextChar) ? '' : ' ',
        );
        br.replaceWith(joint);
        if (measure(text).overflow) joint.replaceWith(br);
        else {
          changes.push('line-break');
          note(text, 'removed redundant line break');
        }
      }
      if (heading && authoredBreak && measure(text).overflow) {
        const box = rect(text);
        const delta = Math.ceil(measure(text).height) - box.height;
        const overlapX = (r: DOMRect) => Math.min(r.right, box.right) - Math.max(r.left, box.left);
        const stacked = siblings.filter((other) => {
          const r = rect(other);
          return (
            other !== text &&
            visible(other) &&
            !allowed.has(other) &&
            r.top >= box.top + box.height / 2 &&
            r.top <= box.bottom + 32 &&
            overlapX(r) > 0 &&
            // Moving a carrier without its contents would detach them.
            !siblings.some((inner) => inner !== other && inner !== text && contains(r, rect(inner)))
          );
        });
        if (stacked.length && delta > 0 && delta <= Math.max(48, box.height * 0.6)) {
          const moved = [text, ...stacked];
          const oldRects = new Map(moved.map((node) => [node, rect(node)]));
          const oldStyles = new Map(moved.map((node) => [node, node.getAttribute('style')]));
          text.style.height = `${box.height + delta}px`;
          for (const other of stacked)
            other.style.top = `${oldRects.get(other)!.top - bounds.top + delta}px`;
          const safe =
            moved.every((node) => rect(node).bottom <= bounds.bottom - 24) &&
            moved.every((node) =>
              siblings.every(
                (other) =>
                  moved.includes(other) ||
                  allowed.has(other) ||
                  !visible(other) ||
                  area(rect(node), rect(other)) <= area(oldRects.get(node)!, rect(other)) + 1,
              ),
            ) &&
            !measure(text).overflow;
          if (safe) {
            changes.push('stacked-shift');
            note(text, `shifted ${stacked.map((node) => node.id).join(', ')} down ${delta}px`);
          } else
            for (const [node, previous] of oldStyles) {
              if (previous === null) node.removeAttribute('style');
              else node.setAttribute('style', previous);
            }
        }
      }
      const inlineRuns = Array.from(text.querySelectorAll<HTMLElement>('*'));
      const uniformRuns = inlineRuns.every((run) => {
        const runStyle = view.getComputedStyle(run);
        return (
          runStyle.display === 'inline' &&
          Math.abs(parseFloat(runStyle.fontSize) - originalFont) < 0.01
        );
      });
      if (heading && authoredBreak && !inlineMath && measure(text).overflow && uniformRuns) {
        // Headings tolerate tighter leading than body text; keep a legible floor.
        const previous = text.getAttribute('style');
        const floor = Math.max(24, originalFont * 0.8);
        for (const scale of [1, 0.95, 0.9, 0.85, 0.8]) {
          const size = originalFont * scale;
          if (size < floor - 0.01) continue;
          text.style.fontSize = `${size}px`;
          text.style.lineHeight = `${Math.min(originalLineHeight * scale, size * 1.15)}px`;
          if (
            inlineRuns.every(
              (run) => Math.abs(parseFloat(view.getComputedStyle(run).fontSize) - size) < 0.01,
            ) &&
            !measure(text).overflow
          ) {
            changes.push(scale === 1 ? 'line-height' : 'font-size');
            break;
          }
        }
        if (!changes.includes('line-height') && !changes.includes('font-size')) {
          if (previous === null) text.removeAttribute('style');
          else text.setAttribute('style', previous);
        }
      }
      if (!inlineMath && measure(text).overflow && originalFont > 18 && uniformRuns) {
        const previous = text.getAttribute('style');
        for (const scale of [0.95, 0.9]) {
          if (originalFont * scale < 18) continue;
          text.style.fontSize = `${originalFont * scale}px`;
          text.style.lineHeight = `${originalLineHeight * scale}px`;
          if (
            inlineRuns.every(
              (run) =>
                Math.abs(parseFloat(view.getComputedStyle(run).fontSize) - originalFont * scale) <
                0.01,
            ) &&
            !measure(text).overflow
          ) {
            changes.push('font-size');
            break;
          }
        }
        if (!changes.includes('font-size')) {
          if (previous === null) text.removeAttribute('style');
          else text.setAttribute('style', previous);
        }
      }
    }
  }
  // Sibling backgrounds have no DOM padding relationship. Infer only an unambiguous
  // containing surface, and preserve its existing top inset (bounded at 32px).
  for (const bg of backgrounds) {
    if (bg.dataset.reachTextAutofit) continue;
    const members = texts.filter((text) => carrier.get(text) === bg && !hasInlineMath(text));
    if (members.length < 2) continue;
    bg.dataset.reachTextAutofit = 'v1';
    const box = rect(bg);
    const inset = Math.min(
      32,
      Math.max(0, Math.min(...members.map((text) => rect(text).top)) - box.top),
    );
    if (inset < 12) continue;
    const bottom = Math.max(
      ...members.map((text) => rect(text).top + Math.max(rect(text).height, measure(text).height)),
    );
    const required = Math.ceil(bottom + inset - box.top);
    if (required <= box.height + 1) continue;
    const allowed = new Set(siblings.filter((other) => other !== bg && contains(box, rect(other))));
    const adjusted =
      required <= box.height + 64 &&
      safeChange(
        bg,
        () => {
          bg.style.height = `${required}px`;
        },
        allowed,
      );
    if (adjusted) {
      for (const text of members) {
        const height = Math.ceil(measure(text).height);
        if (height <= rect(text).height + 1) continue;
        const textAllowed = new Set(
          backgrounds.filter((candidate) => contains(rect(candidate), rect(text))),
        );
        safeChange(
          text,
          () => {
            text.style.height = `${height}px`;
          },
          textAllowed,
        );
      }
    }
    report(
      bg.id,
      `TEXT_AUTOFIT: ${bg.id} ${adjusted ? 'restored background bottom inset' : 'unresolved background bottom inset; unsafe expansion'} ${JSON.stringify({ beforeHeight: box.height, requestedHeight: required, inset })}`,
    );
  }
  for (const [text, before] of audits) {
    const after = {
      width: rect(text).width,
      height: rect(text).height,
      fontSize: parseFloat(view.getComputedStyle(text).fontSize),
    };
    const changed = (['width', 'height', 'fontSize'] as const).filter(
      (key) => Math.abs(after[key] - before[key]) > 0.01,
    );
    const unresolved = measure(text).overflow;
    const notes = structural.get(text) ?? [];
    if (changed.length || notes.length || unresolved)
      report(
        text.id,
        `TEXT_AUTOFIT: ${text.id} ${changed.length || notes.length ? `adjusted ${[...changed, ...notes].join(', ')}` : 'unresolved; safe space or legibility limit'} ${JSON.stringify({ before, after, unresolved })}`,
      );
  }
  autofitSlideMath(root, report);
}

/** A node whose whole content is one formula, written as either display or inline math. */
function isFormulaOnly(node: HTMLElement): boolean {
  if (node.querySelectorAll('[data-reach-math-latex]').length !== 1) return false;
  const plain = node.cloneNode(true) as HTMLElement;
  plain.querySelector('[data-reach-math-latex]')?.remove();
  return !plain.textContent?.trim();
}

/** Fit standalone formulas only; mixed prose keeps its original typography. */
function autofitSlideMath(root: HTMLElement, report: ReportLayoutDiagnostic): void {
  const view = root.ownerDocument.defaultView!;
  const siblings = Array.from(root.children) as HTMLElement[];
  for (const node of siblings) {
    const math = node.querySelector<HTMLElement>('[data-reach-math-latex]');
    if (!math || node.dataset.reachMathAutofit || !isFormulaOnly(node)) continue;
    const style = view.getComputedStyle(node);
    if (style.position !== 'absolute' || style.transform !== 'none') continue;
    const ink = math.querySelector<HTMLElement>('.katex-html');
    if (!ink) continue;
    node.dataset.reachMathAutofit = 'v1';
    const box = node.getBoundingClientRect();
    const originalFont = parseFloat(style.fontSize);
    const originalStyle = node.getAttribute('style');
    const originalLineHeight = parseFloat(style.lineHeight);
    const measure = () => {
      const b = node.getBoundingClientRect(),
        r = ink.getBoundingClientRect();
      // Inline fractions can rise above the line box; count ink on both sides of it.
      return {
        height:
          Math.max(math.getBoundingClientRect().bottom, r.bottom) -
          Math.min(b.top, r.top) +
          (parseFloat(view.getComputedStyle(math).marginBottom) || 0),
        width: r.width,
      };
    };
    let available = root.getBoundingClientRect().bottom - box.top;
    for (const other of siblings) {
      if (other === node) continue;
      const os = view.getComputedStyle(other),
        r = other.getBoundingClientRect();
      if (
        os.display === 'none' ||
        os.visibility === 'hidden' ||
        Number(os.opacity) === 0 ||
        r.right <= box.left ||
        r.left >= box.right
      )
        continue;
      const carrier =
        !other.textContent?.trim() &&
        r.left <= box.left &&
        r.right >= box.right &&
        r.top <= box.top &&
        r.bottom >= box.bottom;
      if (carrier) available = Math.min(available, r.bottom - box.top - 16);
      else if (r.top >= box.top) available = Math.min(available, r.top - box.top - 12);
    }
    const initial = measure();
    if (initial.height <= Math.min(box.height, available) && initial.width <= box.width) continue;
    // Bound growth to nearby free space; do not move unrelated slide elements.
    const target = Math.max(0, Math.min(available, Math.max(box.height, initial.height)));
    let font = originalFont;
    const floor = Math.min(originalFont, 24);
    for (let pass = 0; pass < 5; pass++) {
      const size = measure();
      if (size.height <= target && size.width <= box.width) break;
      font = Math.max(floor, font * Math.min(target / size.height, box.width / size.width) * 0.99);
      node.style.fontSize = `${font}px`;
      if (Number.isFinite(originalLineHeight))
        node.style.lineHeight = `${(originalLineHeight * font) / originalFont}px`;
    }
    const final = measure();
    const resolved = final.height <= target && final.width <= box.width;
    if (resolved)
      node.style.height = `${Math.ceil(Math.max(Math.min(box.height, target), final.height))}px`;
    else if (originalStyle === null) node.removeAttribute('style');
    else node.setAttribute('style', originalStyle);
    report(
      node.id,
      `MATH_AUTOFIT: ${node.id} ${resolved ? 'adjusted' : 'unresolved; legibility or safe space limit'} ${JSON.stringify({ originalFont, font: resolved ? font : originalFont, beforeHeight: box.height, measuredHeight: initial.height, availableHeight: available })}`,
    );
  }
}
