import data from './membership.json' with { type: 'json' };

export const REFERENCE_LIBRARY_VERSION = data.libraryVersion;
export const REFERENCE_LIBRARY_SHA256 = data.librarySha256;
export type ReferenceCategory = keyof typeof data.categories;
export function isReferenceMember(category: ReferenceCategory, id: string): boolean {
  return data.categories[category].includes(id);
}
