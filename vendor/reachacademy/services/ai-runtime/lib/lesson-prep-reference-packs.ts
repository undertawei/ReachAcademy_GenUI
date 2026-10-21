import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const LESSON_PREP_REFERENCE_PACKAGE_VERSION =
  'reachacademy-lesson-prep-reference-packs/1.0.1';
export const LESSON_PREP_REFERENCE_PACKS = [
  'assessment_author',
  'blueprint',
  'continuity_refiner',
  'cooperative',
  'creative',
  'direct_instruction',
  'foundation',
  'genui_author',
  'inquiry',
  'interaction_author',
  'lecture_author',
  'lesson_author',
  'method_router',
  'visual_asset_author',
] as const;
export type LessonPrepReferencePackId = (typeof LESSON_PREP_REFERENCE_PACKS)[number];
export type LessonPrepReferenceOwner =
  | 'resource_integration'
  | 'course_architecture'
  | 'pedagogical_design'
  | 'method_wisdom_alignment'
  | 'lesson_choreography'
  | 'module_orchestration'
  | 'lecture'
  | 'visual_media'
  | 'interaction'
  | 'group_activity'
  | 'mastery_assessment'
  | 'course_transition'
  | 'course_close'
  | 'disabled';

const BODY_SHA256: Record<LessonPrepReferencePackId, string> = {
  assessment_author: 'e281c53d26ba127c7922769b7784b7ccbc2bf46af23a4677eb6f0623cfb82566',
  blueprint: 'fd52317064266b353860a4e84ec0a53dbbea472d6ab9e3b314d945671edb901e',
  continuity_refiner: '03938411716043d208632fec22c13529e329c36b5ec0fa742d06202eb253b4d6',
  cooperative: '27d5f3bbfad5e5cff8ad3b7909ae8473ac9f5c4778b214562da6b8e6fc1ab9c8',
  creative: '925fbc026e37dde9d7d968a7a911548f8a6f51a488c49165cb201d60d542cc1a',
  direct_instruction: 'ae6f2aea64252172c202fc11710b9337a7f9cbf1892350d5dba38b4cd6e1cb39',
  foundation: 'ca1e7d0a4a6dc35d27a5e2f134959fef93b541ff83228a2e5f16ed3508866d9a',
  genui_author: 'b26ecb4731f6203ab3b40f3d04248421bccd165f130fab1cc3f3e42d1e7c0926',
  inquiry: 'd5d27b9cfd2a497e07af9e568410727d611a042bdf886215919af549b808ceb2',
  interaction_author: 'fcac2d59195106f119fe11cd400acb6a3ace4967b1310e6256edfc549937daa0',
  lecture_author: 'f9d2a0a3d954c74011e944b917db226405c62f5de69df271edf2c5effd808612',
  lesson_author: '1a55b5447f3f5d5704a34dae91de6bf2682a081b7c19db64b4ba5b4393b74c90',
  method_router: '4bbb0031e32a23e4363a2fe795f378889e9d6734a908775eb119d9e3dddaa619',
  visual_asset_author: '1f9e1771d4be494939f0a5dd2b32c8b67b4010b859ef962d855cb67fc1c5f072',
};

// Git's Linux checkout normalizes these tracked Markdown files to LF. Keep the corresponding
// hashes alongside the source-byte hashes so verification is invariant across worker platforms.
const BODY_SHA256_LF: Record<LessonPrepReferencePackId, string> = {
  assessment_author: 'beb8a624cd27fb611f9c710754b135e12a25190f4bc399aef18e2cb840129a68',
  blueprint: '878bb7f7e5ec1810c9b73acddae622b9b8f16a499a7ec412b2c6f654c9463c82',
  continuity_refiner: '36fc96b688cf3937038993861f00db71cd1fbd03fba7564a437ba00f0af8b7d3',
  cooperative: 'e75f9eef79c83aa056ef928d5a6a135e54f377d7139e38f670ee927b942ce923',
  creative: 'e413f7dc0a662077b40bf89658c364da7681fe48ef3615a5a7242e3dc1b45544',
  direct_instruction: 'a3d0b85be53c0408f78352828550b8fd2b0366167754ef0d600bf25fc12d2a9b',
  foundation: '092680d7c9187ec659be472bfe4567a0a4b1bce454b7ee7fc95116a98df65fad',
  genui_author: '2b1a2b5b10991c0438bcf1acbefd957dc8dc2b371801b2dec5db579b24de00aa',
  inquiry: 'dbf9b69e605d17efa9eed12af926b3e94c199021e187d66a64940dee48a3eefb',
  interaction_author: 'a7326703a282a649f1a5dcfec79b7ef6ec5a462170a8a9e12b9776554c495ba4',
  lecture_author: 'b2ea02b22dc07b0596fea0096280476c700d4587da85ca683908aa04dd3af8f0',
  lesson_author: '39322ef9c91b8d0cc0cd0d4c34019105cb16cb3f393ab2a70b07306ee0912e89',
  method_router: '1a05e175dda29baf062ec75e6e44387224cea4fa9a0a22554edae11ab4dcc87e',
  visual_asset_author: '0b58b1114e0de00985b7cf4fdcbca392fbbd3469cf02f431b06d3f17fa70db76',
};

export const LESSON_PREP_REFERENCE_ROUTE_TABLE = {
  assessment_author: {
    owner: 'mastery_assessment' as const,
    stage: 'module-orchestration',
    sectionId: 'document',
  },
  blueprint: {
    owner: 'course_architecture' as const,
    stage: 'course-architecture',
    sectionId: 'document',
  },
  continuity_refiner: {
    owner: 'course_transition' as const,
    stage: 'lesson-choreography',
    sectionId: 'document',
  },
  cooperative: {
    owner: 'group_activity' as const,
    stage: 'module-orchestration',
    sectionId: 'document',
  },
  creative: {
    owner: 'pedagogical_design' as const,
    stage: 'pedagogical-design',
    sectionId: 'document',
  },
  direct_instruction: {
    owner: 'pedagogical_design' as const,
    stage: 'pedagogical-design',
    sectionId: 'document',
  },
  foundation: {
    owner: 'course_architecture' as const,
    stage: 'course-architecture',
    sectionId: 'design-only',
  },
  genui_author: { owner: 'disabled' as const, stage: 'disabled', sectionId: 'disabled' },
  inquiry: {
    owner: 'pedagogical_design' as const,
    stage: 'pedagogical-design',
    sectionId: 'document',
  },
  interaction_author: {
    owner: 'interaction' as const,
    stage: 'module-orchestration',
    sectionId: 'document',
  },
  lecture_author: {
    owner: 'lecture' as const,
    stage: 'module-orchestration',
    sectionId: 'document',
  },
  lesson_author: {
    owner: 'lesson_choreography' as const,
    stage: 'lesson-choreography',
    sectionId: 'document',
  },
  method_router: {
    owner: 'method_wisdom_alignment' as const,
    stage: 'method-wisdom-alignment',
    sectionId: 'document',
  },
  visual_asset_author: {
    owner: 'visual_media' as const,
    stage: 'module-orchestration',
    sectionId: 'document',
  },
} as const;

export interface LessonPrepReferenceProjection {
  packageVersion: string;
  registrySha256: string;
  routeTableSha256: string;
  owner: LessonPrepReferenceOwner;
  sections: Array<{
    packId: LessonPrepReferencePackId;
    packVersion: string;
    sectionId: string;
    bodySha256: string;
    projectionSha256: string;
    projectionChars: number;
    projectionBytes: number;
    tokenEstimate: number;
    extractionRule: 'bounded-prefix-v1';
    bodyChars: number;
    coverage: 'bounded-prefix' | 'complete';
    text: string;
  }>;
}
export interface LessonPrepReferencePackCheckpoint {
  packageVersion: string;
  registrySha256: string;
  routeTableSha256: string;
  owner: LessonPrepReferenceOwner;
  sectionHashes: Record<string, string>;
  sectionCoverage: Record<
    string,
    {
      projectionChars: number;
      projectionBytes: number;
      tokenEstimate: number;
      bodyChars: number;
      extractionRule: 'bounded-prefix-v1';
      coverage: 'bounded-prefix' | 'complete';
    }
  >;
}
export interface LessonPrepReferenceReadBinding {
  organizationId: string;
  courseId: string;
  runId: string;
  actorAccountId: string;
  frozenInputHash: string;
}

export function referenceProjectionCheckpoint(
  projection: LessonPrepReferenceProjection,
): LessonPrepReferencePackCheckpoint {
  return {
    packageVersion: projection.packageVersion,
    registrySha256: projection.registrySha256,
    routeTableSha256: projection.routeTableSha256,
    owner: projection.owner,
    sectionHashes: Object.fromEntries(
      projection.sections.map((section) => [
        `${section.packId}:${section.sectionId}`,
        section.projectionSha256,
      ]),
    ),
    sectionCoverage: Object.fromEntries(
      projection.sections.map((section) => [
        `${section.packId}:${section.sectionId}`,
        {
          projectionChars: section.projectionChars,
          projectionBytes: section.projectionBytes,
          tokenEstimate: section.tokenEstimate,
          bodyChars: section.bodyChars,
          extractionRule: section.extractionRule,
          coverage: section.coverage,
        },
      ]),
    ),
  };
}

const PACK_VERSION = 'external-ai-portable-v0.8';
const MAX_PROJECTION_CHARS = 12_000;
const MAX_PROJECTION_BYTES = 48_000;
const MAX_PROJECTION_TOKENS = 4_000;

const OWNER_PACKS: Record<
  Exclude<LessonPrepReferenceOwner, 'disabled'>,
  LessonPrepReferencePackId[]
> = {
  resource_integration: [],
  course_architecture: ['blueprint', 'foundation'],
  pedagogical_design: ['method_router', 'direct_instruction', 'inquiry', 'creative'],
  method_wisdom_alignment: ['method_router'],
  lesson_choreography: ['lesson_author', 'continuity_refiner'],
  module_orchestration: [
    'lecture_author',
    'visual_asset_author',
    'interaction_author',
    'assessment_author',
    'cooperative',
  ],
  lecture: ['lecture_author'],
  visual_media: ['visual_asset_author'],
  interaction: ['interaction_author'],
  group_activity: ['cooperative'],
  mastery_assessment: ['assessment_author'],
  course_transition: ['continuity_refiner'],
  course_close: ['continuity_refiner'],
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const registry = LESSON_PREP_REFERENCE_PACKS.map((packId) => ({
  packId,
  packVersion: PACK_VERSION,
  bodySha256: BODY_SHA256[packId],
  bodyBytes: {
    assessment_author: 54071,
    blueprint: 80143,
    continuity_refiner: 17479,
    cooperative: 66913,
    creative: 101376,
    direct_instruction: 48517,
    foundation: 58641,
    genui_author: 5270,
    inquiry: 81041,
    interaction_author: 49891,
    lecture_author: 36942,
    lesson_author: 118999,
    method_router: 54572,
    visual_asset_author: 4447,
  }[packId],
  bodyChars: {
    assessment_author: 24786,
    blueprint: 34919,
    continuity_refiner: 7677,
    cooperative: 36905,
    creative: 58408,
    direct_instruction: 26662,
    foundation: 25443,
    genui_author: 2018,
    inquiry: 45049,
    interaction_author: 23956,
    lecture_author: 16833,
    lesson_author: 54708,
    method_router: 31374,
    visual_asset_author: 1780,
  }[packId],
  sourcePath: `reference_packs/${packId}.md`,
  licenseStatus: 'user-authorized-redistribution',
  attribution: 'ReachAny external AI portable lesson-prep package',
}));

export const LESSON_PREP_REFERENCE_REGISTRY_SHA256 = sha256(
  canonicalJson({
    packageVersion: LESSON_PREP_REFERENCE_PACKAGE_VERSION,
    packs: registry,
  }),
);
export const LESSON_PREP_REFERENCE_ROUTE_TABLE_SHA256 = sha256(
  canonicalJson(LESSON_PREP_REFERENCE_ROUTE_TABLE),
);

function bodyPath(packId: LessonPrepReferencePackId): URL {
  return new URL(`../reference-packs/v1/${packId}.md`, import.meta.url);
}

function readVerifiedBody(packId: LessonPrepReferencePackId): string {
  const bytes = readFileSync(bodyPath(packId));
  // Git may materialize these source packs with LF or CRLF depending on the checkout platform.
  // Hash the canonical CRLF representation used by the external Windows source so the immutable
  // binding remains stable without allowing line-ending normalization to look like content drift.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const canonicalBytes = new TextEncoder().encode(text.replace(/\r?\n/g, '\r\n'));
  const lfBytes = new TextEncoder().encode(text.replace(/\r\n/g, '\n'));
  if (
    sha256(canonicalBytes) !== BODY_SHA256[packId] &&
    sha256(lfBytes) !== BODY_SHA256_LF[packId]
  ) {
    throw new Error('LESSON_PREP_REFERENCE_PACK_BODY_HASH_MISMATCH');
  }
  // Projections/checkpoints must be byte-stable after checkout; use LF for the returned authoring
  // text regardless of whether the worker filesystem supplied CRLF.
  const normalizedText = text.replace(/\r\n/g, '\n').normalize('NFC');
  if (
    /bearer|api[_ -]?key|access[_ -]?token|private[_ -]?endpoint|signed[_ -]?url|https?:\/\/|www\.|<script|python\.exe|\.bat\b/i.test(
      normalizedText,
    )
  ) {
    throw new Error('LESSON_PREP_REFERENCE_PACK_FORBIDDEN_TRANSPORT_CONTENT');
  }
  return normalizedText;
}

function loadLessonPrepReferenceProjection(
  owner: LessonPrepReferenceOwner,
  maxChars = MAX_PROJECTION_CHARS,
): LessonPrepReferenceProjection {
  if (
    owner === 'disabled' ||
    !Object.prototype.hasOwnProperty.call(OWNER_PACKS, owner) ||
    !Number.isSafeInteger(maxChars) ||
    maxChars < 1 ||
    maxChars > MAX_PROJECTION_CHARS
  ) {
    throw new Error('LESSON_PREP_REFERENCE_PROJECTION_CONTRACT_INVALID');
  }
  const sections: LessonPrepReferenceProjection['sections'] = [];
  let remaining = maxChars;
  const selected = owner === 'resource_integration' ? [] : OWNER_PACKS[owner];
  const perPackLimit = Math.ceil(maxChars / Math.max(1, selected.length));
  for (const packId of selected) {
    const body = readVerifiedBody(packId);
    const text = body.slice(0, Math.min(remaining, perPackLimit));
    if (!text) break;
    const projectionBytes = new TextEncoder().encode(text).byteLength;
    const tokenEstimate = Math.ceil(text.length / 4);
    if (projectionBytes > MAX_PROJECTION_BYTES || tokenEstimate > MAX_PROJECTION_TOKENS) {
      throw new Error('LESSON_PREP_REFERENCE_PROJECTION_BOUNDS_INVALID');
    }
    sections.push({
      packId,
      packVersion: PACK_VERSION,
      sectionId: LESSON_PREP_REFERENCE_ROUTE_TABLE[packId].sectionId,
      bodySha256: BODY_SHA256[packId],
      projectionSha256: sha256(text),
      projectionChars: text.length,
      projectionBytes,
      tokenEstimate,
      extractionRule: 'bounded-prefix-v1',
      bodyChars: body.length,
      coverage: text.length === body.length ? 'complete' : 'bounded-prefix',
      text,
    });
    remaining -= text.length;
  }
  return {
    packageVersion: LESSON_PREP_REFERENCE_PACKAGE_VERSION,
    registrySha256: LESSON_PREP_REFERENCE_REGISTRY_SHA256,
    routeTableSha256: LESSON_PREP_REFERENCE_ROUTE_TABLE_SHA256,
    owner,
    sections,
  };
}

/** Runtime-only adapter boundary: callers must bind every read to the active run. */
export function loadBoundLessonPrepReferenceProjection(
  owner: LessonPrepReferenceOwner,
  binding: LessonPrepReferenceReadBinding,
  maxChars = MAX_PROJECTION_CHARS,
): LessonPrepReferenceProjection {
  if (
    !binding ||
    !binding.organizationId ||
    !binding.courseId ||
    !binding.runId ||
    !binding.actorAccountId ||
    !/^[0-9a-f]{64}$/.test(binding.frozenInputHash)
  ) {
    throw new Error('LESSON_PREP_REFERENCE_READ_BINDING_INVALID');
  }
  return loadLessonPrepReferenceProjection(owner, maxChars);
}

export function referenceProjectionPrompt(projection: LessonPrepReferenceProjection): string {
  return projection.sections
    .map(
      (section) =>
        `BEGIN UNTRUSTED REFERENCE ${section.packId}/${section.sectionId} (${section.projectionSha256}; coverage=${section.coverage}; chars=${section.projectionChars}/${section.bodyChars})\n${section.text}\nEND UNTRUSTED REFERENCE ${section.packId}`,
    )
    .join('\n\n');
}

export function referencePackBindingMatches(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return (
    binding.packageVersion === LESSON_PREP_REFERENCE_PACKAGE_VERSION &&
    binding.registrySha256 === LESSON_PREP_REFERENCE_REGISTRY_SHA256 &&
    binding.routeTableSha256 === LESSON_PREP_REFERENCE_ROUTE_TABLE_SHA256 &&
    JSON.stringify(binding.packIds) === JSON.stringify([...LESSON_PREP_REFERENCE_PACKS])
  );
}
