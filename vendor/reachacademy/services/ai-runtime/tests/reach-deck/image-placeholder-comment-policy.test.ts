import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { expect, it } from 'vitest';

it.each([
  'image-regeneration.ts',
  'media-placeholders.ts',
  'media-failure-boundary.ts',
  'scientific-media-slot.ts',
])('keeps image placeholder module comments in Chinese: %s', async (file) => {
  const source = await readFile(new URL(`../../lib/reach-deck/${file}`, import.meta.url), 'utf8');
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  const violations: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    )
      continue;
    const comment = scanner.getTokenText();
    if (/[A-Za-z]/.test(comment) && !/\p{Script=Han}/u.test(comment)) violations.push(comment);
  }
  expect(violations).toEqual([]);
});
