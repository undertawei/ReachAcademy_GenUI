import { createHash } from 'node:crypto';

import {
  resolveDeckDesignTheme,
  type PageOutline,
  type ReachDeckDesignContext,
  type ReachDeckDocumentV2,
  type ReachDeckMediaResourceV2,
  type ReachDeckNativeElementV2,
} from '@reachany/reach-deck-dsl';

import type { CompileHtmlLayoutInput, HtmlLayoutResult } from '../html-layout/types.js';
import { projectHtmlInstructionalSpec } from '../prompts/html-layout-input.js';
import {
  composeHtmlProductionPrompt,
  HTML_PRODUCTION_PROMPT_VERSION,
} from '../prompts/html-production.js';
import { buildReferenceTextColorPairs } from '../prompts/reference-design.js';
import { compactDecksmithNativeSlide } from './slide-view.js';

/**
 * Decksmith's "brush": draw components with the same HTML production prompt and compiler used for
 * generated slides, then hand the compiled native elements back to Decksmith. Nothing here changes
 * the document; Decksmith decides which drafted elements to place and edits them precisely.
 */

export const DECKSMITH_HTML_DRAFT_PROMPT_VERSION = `${HTML_PRODUCTION_PROMPT_VERSION}+decksmith-draft-v1`;

const CANVAS = { width: 1600, height: 900 } as const;
/** Compiled text boxes may round a few pixels past the requested edge. */
const REGION_TOLERANCE = 6;

export interface DecksmithHtmlDraftRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Generation-time design for the page, when the deck came from the generation workspace. */
export interface DecksmithHtmlDraftDesign {
  designContext?: ReachDeckDesignContext;
  themeName?: string;
  page?: PageOutline;
}

export interface DecksmithHtmlDraftDependencies {
  generateHtml(input: {
    pageId: string;
    prompt: string;
    promptVersion: string;
    payload: unknown;
  }): Promise<string>;
  compile(input: CompileHtmlLayoutInput): Promise<HtmlLayoutResult>;
}

/**
 * Raster media the compiler produced (for example SVG diagrams). It stays in memory with the draft
 * and is persisted only when a draft element that uses it is placed, so abandoned drafts and
 * elements dropped by the region filter never leave unreferenced objects in storage.
 */
export interface DecksmithHtmlDraftPendingMedia {
  resourceId: string;
  contentType: string;
  bytes: Buffer;
}

export interface DecksmithHtmlDraft {
  elements: ReachDeckNativeElementV2[];
  /** Already durable resources the compiler referenced; drafting itself uploads nothing. */
  resources: ReachDeckMediaResourceV2[];
  /** Not yet persisted; elements reference them by their temporary resourceId until placement. */
  pendingMedia: DecksmithHtmlDraftPendingMedia[];
  /** Drafted elements that stick out of the requested region (kept so Decksmith can decide). */
  outsideRegionElementIds: string[];
  diagnostics: string[];
}

export const DECKSMITH_HTML_DRAFT_ADDENDUM = `DECKSMITH COMPONENT DRAFT
You are drawing for an existing slide that a teacher is editing, not generating a fresh page. teacherPreference is the teacher's request.
drawMode "components": draw ONLY the component(s) teacherPreference asks for, positioned entirely inside drawRegion (absolute CSS px on the 1600x900 canvas). Keep the rest of section#slide empty: no page title, eyebrow, background panels, decorations, footers or any other content outside drawRegion. Size fonts and spacing to fit drawRegion without overflow.
drawMode "page": draw the whole slide again, reorganizing existingElements' content as teacherPreference asks while keeping every fact, formula and wording that the teacher did not ask to change.
existingElements lists what is currently on the slide (id, type, geometry, text, dominant style). In components mode it is read-only context: match its colors, fonts, sizes and spacing so the new component looks like part of the same page, and never redraw it.
Keep section#slide background a plain StyleSpec.background. No images or data-reach-asset slots are supplied; draw with HTML, CSS and inline SVG only.`;

export async function draftDecksmithHtmlComponents(
  input: {
    document: ReachDeckDocumentV2;
    pageId: string;
    instruction: string;
    region?: DecksmithHtmlDraftRegion;
    design?: DecksmithHtmlDraftDesign;
    signal?: AbortSignal;
  },
  dependencies: DecksmithHtmlDraftDependencies,
): Promise<DecksmithHtmlDraft> {
  const binding = input.document.nativeSlides.find((item) => item.pageId === input.pageId);
  const page = input.document.pages.find((item) => item.pageId === input.pageId);
  if (binding === undefined || page === undefined) {
    throw new Error(`Page ${input.pageId} has no native slide to draft for.`);
  }
  const region = input.region === undefined ? undefined : clampRegion(input.region);
  const designContext = input.design?.designContext;
  const theme = resolveDeckDesignTheme(input.design?.themeName, designContext);
  const outline = input.design?.page;
  const html = await dependencies.generateHtml({
    pageId: input.pageId,
    prompt: [
      composeHtmlProductionPrompt(designContext?.resolvedColors),
      DECKSMITH_HTML_DRAFT_ADDENDUM,
    ].join('\n\n'),
    promptVersion: DECKSMITH_HTML_DRAFT_PROMPT_VERSION,
    payload: {
      pageId: input.pageId,
      pageTitle: page.title,
      drawMode: region === undefined ? 'page' : 'components',
      drawRegion: region ?? { x: 0, y: 0, ...CANVAS },
      teacherPreference: input.instruction,
      existingElements: compactDecksmithNativeSlide(binding.slide).elements,
      ...(outline === undefined
        ? {}
        : {
            page: {
              id: outline.id,
              sceneType: outline.sceneType,
              title: outline.title,
              pageRole: outline.pageRole,
              pageFunctions: outline.pageFunctions,
              pageJob: outline.pageJob,
              continuity: outline.continuity,
              visibleTitleMode: outline.visibleTitleMode,
            },
            visibleTitleMode: outline.visibleTitleMode,
            instructionalSpec: projectHtmlInstructionalSpec(outline.instructionalSpec),
          }),
      StyleSpec: {
        name: theme.name,
        background: theme.background,
        ink: theme.ink,
        accent: theme.accent,
        fontDisplay: theme.fontDisplay,
        fontBody: theme.fontBody,
        ...(designContext === undefined
          ? {}
          : {
              resolvedColors: designContext.resolvedColors,
              textColorPairs: buildReferenceTextColorPairs(designContext.resolvedColors),
            }),
      },
    },
  });
  const compiled = await dependencies.compile({
    html,
    pageId: input.pageId,
    themeName: input.design?.themeName ?? theme.name,
    ...(designContext === undefined ? {} : { designContext }),
    assets: [],
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const elements = compiled.slide.elements.filter(
    (element) => region === undefined || intersects(element, region),
  );
  const outsideRegionElementIds =
    region === undefined
      ? []
      : elements.filter((element) => !inside(element, region)).map((element) => element.id);
  const usedResourceIds = new Set(elements.flatMap(collectDecksmithDraftResourceIds));
  return {
    elements,
    resources: compiled.resources.filter((resource) => usedResourceIds.has(resource.id)),
    pendingMedia: compiled.pendingMedia
      .filter((pending) => usedResourceIds.has(pending.resourceId))
      .map((pending) => ({
        resourceId: pending.resourceId,
        contentType: pending.contentType,
        bytes: Buffer.from(pending.dataUrl.slice(pending.dataUrl.indexOf(',') + 1), 'base64'),
      })),
    outsideRegionElementIds,
    diagnostics: compiled.diagnostics.slice(0, 20),
  };
}

/** Stable id for a stored compiler raster, matching the generation pipeline's convention. */
export function decksmithDraftMediaResourceId(objectKey: string): string {
  return `html-media-${createHash('sha256').update(objectKey).digest('hex')}`;
}

function clampRegion(region: DecksmithHtmlDraftRegion): DecksmithHtmlDraftRegion {
  const x = Math.max(0, Math.min(CANVAS.width, region.x));
  const y = Math.max(0, Math.min(CANVAS.height, region.y));
  const width = Math.max(1, Math.min(CANVAS.width - x, region.width));
  const height = Math.max(1, Math.min(CANVAS.height - y, region.height));
  return { x, y, width, height };
}

function intersects(element: ReachDeckNativeElementV2, region: DecksmithHtmlDraftRegion): boolean {
  const t = element.transform;
  return (
    t.x < region.x + region.width &&
    t.x + t.width > region.x &&
    t.y < region.y + region.height &&
    t.y + t.height > region.y
  );
}

function inside(element: ReachDeckNativeElementV2, region: DecksmithHtmlDraftRegion): boolean {
  const t = element.transform;
  return (
    t.x >= region.x - REGION_TOLERANCE &&
    t.y >= region.y - REGION_TOLERANCE &&
    t.x + t.width <= region.x + region.width + REGION_TOLERANCE &&
    t.y + t.height <= region.y + region.height + REGION_TOLERANCE
  );
}

export function remapDecksmithDraftMediaReferences(
  element: ReachDeckNativeElementV2,
  renamed: ReadonlyMap<string, string>,
): ReachDeckNativeElementV2 {
  if (renamed.size === 0) return element;
  if (element.type === 'group') {
    return {
      ...element,
      children: element.children.map((child) => remapDecksmithDraftMediaReferences(child, renamed)),
    };
  }
  if (element.type === 'image') {
    return { ...element, resourceId: renamed.get(element.resourceId) ?? element.resourceId };
  }
  if (element.type === 'shape' && element.style.fill?.kind === 'image') {
    const fill = element.style.fill;
    return {
      ...element,
      style: {
        ...element.style,
        fill: { ...fill, resourceId: renamed.get(fill.resourceId) ?? fill.resourceId },
      },
    };
  }
  return element;
}

export function collectDecksmithDraftResourceIds(element: ReachDeckNativeElementV2): string[] {
  if (element.type === 'group') return element.children.flatMap(collectDecksmithDraftResourceIds);
  if (element.type === 'image') return [element.resourceId];
  if (element.type === 'shape' && element.style.fill?.kind === 'image') {
    return [element.style.fill.resourceId];
  }
  return [];
}
