import type {
  PageInstructionalSpec,
  ReachDeckDesignContext,
  PlannedVisualAsset,
  ReachDeckMediaOrigin,
} from '@reachany/reach-deck-dsl';
import type {
  ReferenceEntry,
  retrieveReferenceLayouts,
} from '@reachany/reach-deck-dsl/reference-library';

/** A stage-specific view; persisted plans and producer prompts remain intact. */
export function projectHtmlInstructionalSpec(spec: PageInstructionalSpec | undefined) {
  if (!spec) return undefined;
  return {
    learningObjective: spec.learningObjective,
    // v3 specs author pageRole/pageJob; teachingMove is only a derived compatibility projection.
    ...(spec.pageRole === undefined
      ? { teachingMove: spec.teachingMove }
      : { pageRole: spec.pageRole }),
    ...(spec.pageJob === undefined ? {} : { pageJob: spec.pageJob }),
    keyPoints: spec.keyPoints,
    assessmentEvidence: spec.assessmentEvidence,
    visualDirection: spec.visualDirection,
    density: spec.density,
  };
}

export function projectHtmlAsset(
  manifest: {
    assetId: string;
    kind: string;
    purpose: string;
    alt: string;
    placement: string;
    aspectRatio: string;
    origin?: ReachDeckMediaOrigin;
  },
  plan?: PlannedVisualAsset,
  dimensions?: { width: number; height: number },
  hasAlpha = false,
) {
  return {
    assetId: manifest.assetId,
    kind: manifest.kind,
    route: manifest.origin?.route ?? plan?.kind ?? manifest.kind,
    purpose: manifest.purpose,
    alt: manifest.alt,
    placement: manifest.placement,
    ratio: dimensions ? (dimensions.width / dimensions.height).toFixed(2) : manifest.aspectRatio,
    ...(hasAlpha
      ? { background: 'transparent', carrier: 'Use a light surface for transparent diagram ink.' }
      : {}),
    ...(plan && 'invariants' in plan ? { invariants: plan.invariants } : {}),
    ...(plan?.kind === 'reference-image'
      ? { requiredIdentityGroups: plan.requiredIdentityGroups }
      : {}),
    ...(manifest.origin
      ? {
          source: {
            route: manifest.origin.route,
            title: manifest.origin.title,
            description: manifest.origin.description,
          },
        }
      : {}),
  };
}

export function projectHtmlDesignContext(context: ReachDeckDesignContext) {
  return { visualIntent: context.visualIntent, originalDesign: context.originalDesign };
}

export function projectHtmlLayout(match: ReturnType<typeof retrieveReferenceLayouts>[number]) {
  const { reference } = match;
  return {
    reference: {
      id: reference.id,
      name: reference.name,
      readingPath: reference.readingPath,
      slots: reference.slots.map(({ role, frame, accepts }) => ({ role, frame, accepts })),
    },
    crossType: match.crossType,
    advisory: match.advisory,
    informationRelationship: match.informationRelationship,
    instruction: match.instruction,
  };
}

// The layout model never knows the page position, so a page-number component is reduced to the
// section progress it can truthfully show.
const PAGE_NUMBER_COMPONENT_NAMES: Readonly<Record<string, string>> = {
  'component.page-number-progress-rail-v1': '章节进度轨（不写页码）',
};

export function projectHtmlComponent(entry: ReferenceEntry<'components'>) {
  return {
    id: entry.id,
    name: PAGE_NUMBER_COMPONENT_NAMES[entry.id] ?? entry.name,
    compatibleZones: entry.compatibleZones,
  };
}

export function projectHtmlMask(entry: ReferenceEntry<'masks'>) {
  return {
    id: entry.id,
    name: entry.name,
    compatibleSlotRoles: entry.compatibleSlotRoles,
    fitModes: entry.fitModes,
  };
}
