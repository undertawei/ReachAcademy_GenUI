import { createHash } from 'node:crypto';

import type { ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';

export type MaicSourceDigest = `sha256:${string}`;

const digest = (input: string | Uint8Array): MaicSourceDigest =>
  `sha256:${createHash('sha256').update(input).digest('hex')}`;

export const createMaicSourceDigest = (input: Uint8Array): MaicSourceDigest => digest(input);

export const createStableMaicId = (kind: string, components: readonly string[]): string => {
  if (!/^[a-z][a-z0-9-]*$/.test(kind) || components.length === 0 || components.some((x) => !x)) {
    throw new Error('MAIC identity requires a kebab-case kind and non-empty components.');
  }
  return `maic-${kind}-v1-${createHash('sha256')
    .update(JSON.stringify(['maic-source-identity/v1', kind, ...components]))
    .digest('hex')
    .slice(0, 32)}`;
};

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(',')}}`;
};

export const createMaicCandidateDigest = (document: ReachDeckDocumentV2): MaicSourceDigest =>
  digest(canonicalize(document));

export const createMaicProfileDigest = (profile: unknown): MaicSourceDigest =>
  digest(canonicalize(profile));
