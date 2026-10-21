import type { ReachDeckDesignContext } from '@reachany/reach-deck-dsl';
import { composeCompactOutlinePrompt } from './compact-outline.js';

const colorLuminance = (hex: string) =>
  [1, 3, 5]
    .map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);

const contrastRatio = (foreground: string, background: string) => {
  const a = colorLuminance(foreground);
  const b = colorLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

const interpolateColor = (hex: string, target: number, factor: number) => {
  const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  return `#${rgb
    .map((channel) =>
      Math.round(channel + (target - channel) * factor)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
};

/**
 * Adjust only newly parsed run colors. Stored design snapshots remain untouched;
 * the returned context is a fresh value used for this generation request.
 */
export function ensureReferenceMutedContrast(
  context: ReachDeckDesignContext,
): ReachDeckDesignContext {
  const muted = context.resolvedColors.muted;
  const backgrounds = [context.resolvedColors.background, context.resolvedColors.surface];
  if (backgrounds.every((background) => contrastRatio(muted, background) >= 4.5)) return context;
  const candidates = [0, 255].map((target) => {
    if (
      !backgrounds.every(
        (background) => contrastRatio(target === 0 ? '#000000' : '#FFFFFF', background) >= 4.5,
      )
    )
      return;
    let lo = 0;
    let hi = 1;
    for (let pass = 0; pass < 24; pass++) {
      const factor = (lo + hi) / 2;
      const candidate = interpolateColor(muted, target, factor);
      if (backgrounds.every((background) => contrastRatio(candidate, background) >= 4.5))
        hi = factor;
      else lo = factor;
    }
    const factor = hi;
    return { color: interpolateColor(muted, target, factor), factor };
  });
  const adjusted = candidates
    .filter(
      (candidate) =>
        candidate &&
        backgrounds.every((background) => contrastRatio(candidate.color, background) >= 4.5),
    )
    .sort((a, b) => a!.factor - b!.factor)[0]?.color;
  if (!adjusted) return context;
  return {
    ...context,
    resolvedColors: { ...context.resolvedColors, muted: adjusted },
  };
}

/** Advisory opaque-color pairs; composited contrast remains the compiler's gate. */
export function buildReferenceTextColorPairs(colors: ReachDeckDesignContext['resolvedColors']) {
  const entries = Object.entries(colors).map(([token, color]) => ({
    token,
    luminance: colorLuminance(color),
  }));
  return entries.map((background) => {
    const pairs = entries.map((foreground) => ({
      token: foreground.token,
      ratio:
        (Math.max(background.luminance, foreground.luminance) + 0.05) /
        (Math.min(background.luminance, foreground.luminance) + 0.05),
    }));
    return {
      backgroundToken: background.token,
      normalText: pairs.filter(({ ratio }) => ratio >= 4.5).map(({ token }) => token),
      largeTextOnly: pairs
        .filter(({ ratio }) => ratio >= 3 && ratio < 4.5)
        .map(({ token }) => token),
    };
  });
}

/** Current reference outline contract, explicitly composed from the shared teaching body. */
export const REFERENCE_OUTLINE_PROMPT = {
  version: 'paged-outline/compact-reference-v11-solid-diagram-svg',
  text: composeCompactOutlinePrompt({
    rootFields: 'title, designContext and pages',
    designInstructions: `Select the deck design from the complete referenceIndex. References are advisory; never treat coordinates, slot counts, colors, or component counts as fixed templates. Preserve authoritative teaching content and allow original compositions.
Return designContext with the supplied libraryVersion/librarySha256/schemaVersion, one paletteReferenceId, originalDesign:false, compatible imageStyleReferenceIds, visualIntent, typographyProfile and all seven resolvedColors. typographyProfile is humanities for Chinese language and literature, classical texts and poetry, history, philosophy, ethics and the arts, where a serif-and-kai pairing fits the reading; otherwise general (mathematics, sciences, foreign languages, technology and mixed subjects). Colors may be adjusted for readability; preserve the selected reference ID. If no reference fits, set originalDesign:true and paletteReferenceId:"", and still supply all actual colors. Do not use a legacy theme default.
Every page designIntent states pageRole, focus, informationRelationship, layoutReferenceIds, componentReferenceIds and imageStyleReferenceIds. IDs must be exact members of the supplied category; empty arrays allow original designs. Quiz and interactive use overall colors and style, not static slide templates.
A native table page comfortably fits about 6 columns and 8 rows including the header; this is a readability guideline, not a hard limit. Keep the source table's fields, structure and orientation (never transpose fields into rows). Only when a wider or longer table would not fit the page readably, state in visualDirection which adjacent, closely related fields share one column; never drop a field.
Design choices must help initial pedagogical pagination. Once page identities are assigned, layout must not split or merge pages. Image briefs share the chosen visual language and specify aspect ratio and subject direction; reserve text-overlay space only for hero images when explicitly requested. Never add images to fill template slots.
Ensure text readability: normal/small text contrast at least 4.5:1, large text at least 3:1, informative graphics at least 3:1. Background photos/gradients require checking the actual local background. Do not bake body text into images.`,
  }),
};

export function buildReferenceAssetInstructions(
  colors?: Pick<ReachDeckDesignContext['resolvedColors'], 'accent' | 'surface'>,
): string {
  const accent = colors?.accent ?? '#555555';
  const surface = colors?.surface ?? '#FFFFFF';
  return `Trusted asset contract (reference HTML v8). Set font-family to StyleSpec.fontDisplay for titles and headings and to StyleSpec.fontBody for all other text; use no other families. Bind every supplied asset exactly once as an empty DIV directly under section#slide with data-reach-asset="assetId". Use the asset's exact ID; never add children/text, invent URLs, nest the slot, or redraw its content. Write complete absolute px geometry inline. Slots have border:0;border-radius:0;transform:none;filter:none;box-shadow:none;mask-image:none;clip-path:none. Use object-fit:contain for whole diagrams; preserve required subject evidence for photos and illustrations. Only a supplied registered data-reach-asset-mask="registeredMaskId" may mask a slot; do not mirror directional evidence.
Decoration and editable text are siblings of the slot. A rounded card background and its accent stripe, border and shadow form one decorative figure with a shared rounded boundary. For a left stripe, use that figure's own border-left or linear-gradient(to right,...), never a separate stripe element. Keep trusted slots and editable text outside that figure.
One illustrative 16:9 card fragment (all four nodes are direct slide children; adapt IDs, content and geometry):
<figure id="media-card" aria-label="图卡背景" style="position:absolute;left:880px;top:240px;width:624px;height:497px;border-radius:24px;background:linear-gradient(${accent} 0px,${accent} 8px,${surface} 8px);box-shadow:0 8px 24px rgba(0,0,0,.12)"></figure>
<p id="media-label" style="position:absolute;left:912px;top:268px;width:560px;height:30px">图示名称</p>
<div id="media-slot" data-reach-asset="assetId" style="position:absolute;left:912px;top:314px;width:560px;height:315px;border:0;border-radius:0;transform:none;filter:none;box-shadow:none;mask-image:none;clip-path:none;object-fit:contain"></div>
<p id="media-caption" style="position:absolute;left:912px;top:645px;width:560px;height:60px">第一行说明<br>第二行说明</p>
Budget: 28 + 30 + 16 + 315 + 16 + 60 + 32 = 497; slot height 560×9/16=315; caption bottom 705 plus 32px inset equals card bottom 737. Apply the core shadow/footer budget too. This is a geometry relationship example, not required page content, font sizes or a fixed template.`;
}

export const REFERENCE_ASSET_INSTRUCTIONS = buildReferenceAssetInstructions();

export const REFERENCE_HTML_INSTRUCTIONS = `Reference HTML contract v12 (design context schema v1). References are advisory relationships, reading order and proportions, not fixed templates. Layout slot frames use normalized 0–1 coordinates relative to the whole 1600×900 slide; adapt them to actual content and asset ratios. Component names suggest visual language, not required DOM decomposition. Cross-type references transfer composition only: preserve the authoritative teaching content and information relationship. Core scene and space-budget rules take precedence. Full-bleed background/media may reach the canvas edge; text still needs safe margins.
Use StyleSpec.resolvedColors as the visual system, allowing local readability adjustments. StyleSpec.textColorPairs lists foreground tokens for opaque backgrounds: normalText passes 4.5:1; largeTextOnly passes 3:1 and is only for text at least 24px regular or 18.67px bold. Small labels, captions, table cells and inline SPAN/STRONG emphasis must use normalText on their actual carrier. Missing pairs are not safe; if normalText is empty, choose another carrier or adjust the color. These pairs are advisory, not automatic recoloring. Photos, gradients, transparency and adjusted colors require the actual local contrast, not palette membership. Preserve content and asset identity rather than filling reference slots or generating extra assets.
The chosen palette is the source of truth: keep its hue range, saturation, contrast and color proportions. Do not mute, desaturate, beige-wash or neutralize it; readability adjustments change a local carrier, not the whole palette.
Emphasis budget: default to unmarked text. Emphasize only short words students must notice (a key term, condition, contrast or conclusion): at most 2 short emphasized phrases per paragraph or table cell and at most 6 per page. Never emphasize a whole title or paragraph, stack emphasis methods on the same words, or add marks to reach a quota. Never underline generated text, including titles, quotations and table cells.
Container budget: text does not need a box. Ordinary explanation, evidence, practice and closing pages normally use 0–2 text surfaces (card backgrounds behind text); a genuine comparison, sequence, classification or process may use up to 3 peer surfaces. Do not give every text frame its own card or add empty decorative rectangles to fill space.
Teaching diagrams: never shrink a supplied teaching diagram to fit, and never crop its labels. Give it its planned display size first, then reallocate space or reduce and shorten the surrounding text. If no arrangement shows the diagram legibly, keep the page text-only rather than a thumbnail.
Tables: use a native table only for real row/column data. Never fake a table with repeated rectangles and separate text boxes, never use a table merely as a card grid, and never shrink table text below the body tier to fit; use fewer rows, shorter cells or another composition instead.
Cover: place a large course title in a quiet area of the composition with clear hierarchy and generous space. The background or artwork must not compete with the focal visual or title. No mandatory torn-paper seam, fixed hue or repeated poster template; follow this course's chosen palette and composition.`;
