import sharp from 'sharp';
import {
  reachDeckCourseBackgroundVeilOpacity,
  type PageGenerationRequest,
  type ReachDeckCourseBackgroundSlot,
} from '@reachany/reach-deck-dsl';
import { getReferenceEntry } from '@reachany/reach-deck-dsl/reference-library';

/** Bump when the prompt, veil or output geometry changes so groups do not reuse old artwork. */
export const REACH_DECK_COURSE_BACKGROUND_VERSION = 'course-background/v1';
export const COURSE_BACKGROUND_WIDTH = 1600;
export const COURSE_BACKGROUND_HEIGHT = 900;

export interface ReachDeckCourseBackgroundAssetRequest {
  /** Requesting page; audit only. Storage is keyed by the group so every member shares one image. */
  pageId: string;
  /** The outline owns the group registry; group ids are only unique within one outline. */
  outlineId: string;
  groupId: string;
  slot: ReachDeckCourseBackgroundSlot;
  prompt: string;
  veil: { color: string; opacity: number };
}

/** Normalized reading region of the selected layout, kept visually quiet on the cover. */
export interface CourseBackgroundTextRegion {
  role: string;
  frame: unknown;
}

const SLOT_DIRECTION: Record<ReachDeckCourseBackgroundSlot, string> = {
  cover:
    'Course-opening artwork: one large, recognizable subject grounded in the lesson with intentional negative space. Keep the text regions listed below quiet and low-detail; keep faces, hands and focal objects outside them.',
  agenda:
    'Understated thematic environment with very low detail and a broad, even reading field for an agenda.',
  closing:
    'Contemplative closing image that supports one reflective thought, with a clear text-safe region and no inspirational-poster clichés.',
  body: 'Contextual course background shared by several teaching pages. Keep the whole central reading area quiet; confine sparse, source-derived motifs to the outer margins. Do not depict a specific worked example, diagram or teaching fact.',
};

/** Media segment for a group's artwork: never a page id, so page edits cannot orphan it. */
export function courseBackgroundMediaSegment(outlineId: string, groupId: string): string {
  return `course-background:${outlineId}:${groupId}`;
}

export function composeCourseBackgroundPrompt(
  request: PageGenerationRequest,
  slot: ReachDeckCourseBackgroundSlot,
  textRegions: readonly CourseBackgroundTextRegion[] = [],
): string {
  const design = request.pagedOutline.designContext;
  const styleIds = design?.imageStyleReferenceIds ?? [];
  const styles = styleIds.map((id) => {
    const style = getReferenceEntry('imageStyles', id);
    return {
      name: style.name,
      medium: style.medium,
      treatment: style.treatment,
      promptFragment: style.promptFragment,
      avoid: style.avoid,
    };
  });
  const keyPoints = request.page.instructionalSpec?.keyPoints ?? [];
  return [
    `Full-bleed 16:9 decorative background artwork for a course titled: ${request.pagedOutline.title}.`,
    SLOT_DIRECTION[slot],
    slot === 'cover' && textRegions.length > 0
      ? `Quiet text regions (normalized frames of the chosen layout): ${JSON.stringify(textRegions)}.`
      : '',
    slot === 'body'
      ? `Course theme: ${request.lessonPlan.title}.`
      : `This page: ${request.page.title}.${keyPoints.length ? ` Ground the imagery in: ${keyPoints.slice(0, 3).join(' / ')}.` : ''}`,
    design === undefined
      ? ''
      : `Deck visual direction: ${design.visualIntent}. Palette (use at its intended chroma): ${JSON.stringify(design.resolvedColors)}.`,
    styles.length ? `Image style guidance: ${JSON.stringify(styles)}.` : '',
    'A translucent layer and editable slide text are added separately: do not bake a veil, panel, frame or transparency into the image.',
    'Do not render any words, letters, numbers, formulas, labels, logos, watermarks, UI or charts.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function courseBackgroundVeil(
  request: PageGenerationRequest,
  slot: ReachDeckCourseBackgroundSlot,
): ReachDeckCourseBackgroundAssetRequest['veil'] {
  return {
    color: request.pagedOutline.designContext?.resolvedColors.background ?? '#FFFFFF',
    opacity: reachDeckCourseBackgroundVeilOpacity(slot),
  };
}

/**
 * Crop the artwork to the 16:9 stage and bake the theme veil into it. One stored image per group
 * keeps the slide background a single fill: nothing extra for teachers to select, reveal or move.
 */
export async function composeCourseBackgroundImage(
  bytes: Uint8Array,
  veil: ReachDeckCourseBackgroundAssetRequest['veil'],
): Promise<Buffer> {
  if (!/^#[0-9a-f]{6}$/i.test(veil.color) || !(veil.opacity >= 0 && veil.opacity <= 1))
    throw new Error('Invalid course background veil.');
  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${COURSE_BACKGROUND_WIDTH}" height="${COURSE_BACKGROUND_HEIGHT}"><rect width="100%" height="100%" fill="${veil.color}" fill-opacity="${veil.opacity}"/></svg>`,
  );
  return sharp(bytes)
    .rotate()
    .resize(COURSE_BACKGROUND_WIDTH, COURSE_BACKGROUND_HEIGHT, { fit: 'cover' })
    .composite([{ input: overlay }])
    .flatten({ background: veil.color })
    .jpeg({ quality: 86 })
    .toBuffer();
}
