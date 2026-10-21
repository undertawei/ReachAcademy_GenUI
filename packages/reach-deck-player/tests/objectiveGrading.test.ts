import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Question, QuestionAnswer } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  gradeObjectiveQuestion,
  normalizeGradingText,
  type ObjectiveGrade,
} from '../src/objectiveGrading';

interface FixtureCase {
  name: string;
  question: Question;
  response: QuestionAnswer | null;
  expected: ObjectiveGrade;
}

/** Shared with content-service ObjectiveGraderTest; both sides must grade every case identically. */
const fixtureDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../reach-deck-dsl/tests/fixtures/objective-grading',
);
const fixtureFiles = readdirSync(fixtureDirectory)
  .filter((file) => file.endsWith('.json'))
  .sort();

describe('gradeObjectiveQuestion shared fixtures', () => {
  it('loads every question-type fixture file', () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of fixtureFiles) {
    const { cases } = JSON.parse(readFileSync(join(fixtureDirectory, file), 'utf8')) as {
      cases: FixtureCase[];
    };
    describe(file, () => {
      it.each(cases.map((testCase) => [testCase.name, testCase] as const))(
        '%s',
        (_name, { question, response, expected }) => {
          expect(gradeObjectiveQuestion(question, response)).toEqual(expected);
        },
      );
    });
  }
});

describe('normalizeGradingText', () => {
  it('applies NFKC, collapses whitespace, and trims like the Java grader', () => {
    expect(normalizeGradingText('﻿  Ｈｅｌｌｏ　  Ｗｏｒｌｄ\n')).toBe('Hello World');
  });
});
