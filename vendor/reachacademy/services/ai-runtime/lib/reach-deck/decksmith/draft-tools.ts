import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ReachDeckMediaResourceV2 } from '@reachany/reach-deck-dsl';
import { Type } from 'typebox';

import {
  collectDecksmithDraftResourceIds,
  remapDecksmithDraftMediaReferences,
  type DecksmithHtmlDraft,
  type DecksmithHtmlDraftRegion,
} from './html-draft.js';
import { DecksmithSessionError, type DecksmithDocumentSession } from './session.js';
import { compactDecksmithNativeElements } from './slide-view.js';

/** Each draft is a full HTML generation plus a browser compile; keep one run bounded. */
export const DECKSMITH_HTML_DRAFT_LIMIT_PER_RUN = 3;

export interface DecksmithDraftToolDependencies {
  draft(input: {
    pageId: string;
    instruction: string;
    region?: DecksmithHtmlDraftRegion;
  }): Promise<DecksmithHtmlDraft>;
  /** Persist one compiler raster when a draft element using it is placed. */
  storeDraftMedia(input: {
    pageId: string;
    bytes: Buffer;
    contentType: string;
  }): Promise<ReachDeckMediaResourceV2>;
}

/**
 * The HTML brush as two tools: draw a draft (no document change), then place chosen draft
 * elements onto the page. Decksmith refines the placed elements with its ordinary edit tools.
 */
export function createDecksmithDraftTools(
  session: DecksmithDocumentSession,
  dependencies: DecksmithDraftToolDependencies,
): AgentTool[] {
  const drafts = new Map<string, { pageId: string; draft: DecksmithHtmlDraft }>();

  const draftLayout: AgentTool = {
    name: 'draft_layout_with_html',
    label: '用排版管线起草组件',
    description: [
      'Draw new or replacement components with the same HTML layout pipeline that generated the deck, compiled to native elements. It does NOT change the page; call place_draft_elements to use the result.',
      'Use it when the request changes structure: a different component (for example turning a list into a table, cards, a timeline or a comparison), a redesigned section, or a re-layout. Do not use it for text, color, or position tweaks.',
      'region (px on the 1600x900 stage) limits the drawing to that area: pass the combined bounds of the elements being replaced, or an empty area for a new component. Omit region only when the teacher asks to re-layout the whole page.',
      `instruction states what to draw and the exact content to keep. At most ${DECKSMITH_HTML_DRAFT_LIMIT_PER_RUN} drafts per request; each takes tens of seconds.`,
    ].join(' '),
    parameters: Type.Object({
      pageId: Type.String(),
      instruction: Type.String({ minLength: 1, maxLength: 4000 }),
      region: Type.Optional(
        Type.Object({
          x: Type.Number({ minimum: 0 }),
          y: Type.Number({ minimum: 0 }),
          width: Type.Number({ exclusiveMinimum: 0 }),
          height: Type.Number({ exclusiveMinimum: 0 }),
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        pageId: string;
        instruction: string;
        region?: DecksmithHtmlDraftRegion;
      };
      if (drafts.size >= DECKSMITH_HTML_DRAFT_LIMIT_PER_RUN) {
        throw new DecksmithSessionError(
          'Draft limit reached for this request. Place or refine an existing draft instead.',
        );
      }
      session.readNativeSlide(input.pageId);
      const draft = await dependencies.draft(input);
      if (draft.elements.length === 0) {
        throw new DecksmithSessionError(
          'The draft produced no elements in the region. Enlarge the region or make the instruction more specific.',
        );
      }
      const draftId = `draft-${drafts.size + 1}`;
      drafts.set(draftId, { pageId: input.pageId, draft });
      return textResult(
        JSON.stringify({
          draftId,
          pageId: input.pageId,
          elements: compactDecksmithNativeElements(draft.elements),
          ...(draft.outsideRegionElementIds.length === 0
            ? {}
            : { outsideRegionElementIds: draft.outsideRegionElementIds }),
          ...(draft.diagnostics.length === 0 ? {} : { diagnostics: draft.diagnostics }),
          next: 'Choose elements and call place_draft_elements; the page is unchanged until then.',
        }),
      );
    },
  };

  const placeDraft: AgentTool = {
    name: 'place_draft_elements',
    label: '放置起草的组件',
    description: [
      'Place elements from a draft_layout_with_html draft onto its page. elementIds picks draft elements (omit to place all);',
      'replaceElementIds removes existing top-level page elements the draft replaces. Placed elements get new stable ids, returned in the receipt, for further edits with the ordinary tools.',
      'The receipt lists overlaps with elements that stay on the page; resolve them by moving, resizing, or replacing elements.',
    ].join(' '),
    parameters: Type.Object({
      draftId: Type.String(),
      elementIds: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
      replaceElementIds: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        draftId: string;
        elementIds?: string[];
        replaceElementIds?: string[];
      };
      const entry = drafts.get(input.draftId);
      if (entry === undefined) throw new DecksmithSessionError(`Unknown draft ${input.draftId}.`);
      const selected =
        input.elementIds === undefined
          ? entry.draft.elements
          : input.elementIds.map((id) => {
              const element = entry.draft.elements.find((candidate) => candidate.id === id);
              if (element === undefined) {
                throw new DecksmithSessionError(`Draft ${input.draftId} has no element ${id}.`);
              }
              return element;
            });
      const usedPending = new Set(selected.flatMap(collectDecksmithDraftResourceIds));
      const pendingToStore = entry.draft.pendingMedia.filter((pending) =>
        usedPending.has(pending.resourceId),
      );
      const durable = entry.draft.resources.filter((resource) => usedPending.has(resource.id));
      const placement = {
        pageId: entry.pageId,
        removeElementIds: input.replaceElementIds ?? [],
      };
      // Validate the whole placement before any upload: generated media has no delete path, so a
      // placement that would fail (missing replace target, invalid element, changed page) must
      // not leave uploaded objects behind. Placeholders stand in for the not-yet-stored media.
      session.validateDraftPlacement({
        ...placement,
        elements: selected,
        resources: [
          ...durable,
          ...pendingToStore.map((pending) => ({
            id: pending.resourceId,
            objectKey: `pending/${pending.resourceId}`,
            contentType: pending.contentType,
            digest: 'pending',
          })),
        ],
      });
      // The page commits only after every upload succeeds. Generated media has no delete path, so
      // if one upload fails, earlier successes stay unreferenced unless the placement is retried
      // (the store is idempotent per run, page and content digest, so a retry reuses them).
      // Reclaiming them needs a generated-media orphan sweep in content-service.
      const stored = await Promise.all(
        pendingToStore.map((pending) =>
          dependencies.storeDraftMedia({
            pageId: entry.pageId,
            bytes: pending.bytes,
            contentType: pending.contentType,
          }),
        ),
      );
      const renamed = new Map(
        pendingToStore.map((pending, index) => [pending.resourceId, stored[index]!.id]),
      );
      const resources = [...durable];
      for (const resource of stored) {
        if (!resources.some((existing) => existing.id === resource.id)) resources.push(resource);
      }
      const outcome = session.placeDraftElements({
        ...placement,
        elements: selected.map((element) => remapDecksmithDraftMediaReferences(element, renamed)),
        resources,
      });
      return textResult(
        JSON.stringify({
          operation: 'place_draft_elements',
          pageId: entry.pageId,
          placedIds: outcome.placedIds,
          removedIds: input.replaceElementIds ?? [],
          ...(outcome.overlaps.length === 0 ? {} : { overlaps: outcome.overlaps }),
        }),
      );
    },
  };

  return [draftLayout, placeDraft];
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: undefined };
}
