import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createPortalTranslator, getPortalDictionary } from '@/src/lib/i18n';
import { createTutorDiscussionTranslator } from './tutor-discussion-translator';

const sharedSource = readFileSync(
  new URL('../../../../../packages/tutor-ui/src/TutorDiscussion.tsx', import.meta.url),
  'utf8',
);
const sharedKeys = [
  ...new Set([...sharedSource.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)].map((match) => match[2]!)),
];

describe('teacher shared Tutor translation contract', () => {
  it('discovers the shared ordinary and fence translation surface', () => {
    expect(sharedKeys).toContain('fence.title');
    expect(sharedKeys).toContain('reachDeck.discussion.pageGroup');
    expect(sharedKeys).toContain('student.tutor.serviceUnavailable');
    expect(sharedKeys).not.toContain('other');
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'resolves every shared message through the actual teacher adapter in %s',
    (locale) => {
      const dictionary = getPortalDictionary(locale);
      const portalTranslate = createPortalTranslator(locale);
      const translate = createTutorDiscussionTranslator((key, values) => {
        expect(dictionary[key], key).toBeDefined();
        return portalTranslate(key, values);
      });
      for (const key of sharedKeys) {
        const message = translate(key, { page: 2, title: 'Biology', author: 'Reach Tutor' });
        expect(message.trim(), key).not.toBe('');
        expect(message, key).not.toBe(key);
        expect(message, key).not.toMatch(/\{(?:page|title|author)\}/);
      }
    },
  );
});
