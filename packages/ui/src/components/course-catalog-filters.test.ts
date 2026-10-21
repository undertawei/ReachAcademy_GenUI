import { describe, expect, it } from 'vitest';
import {
  defaultCourseCatalogFilters,
  filterAndSortCourseCatalog,
  type CourseCatalogFilterItem,
} from './course-catalog-filters';

const item = (
  name: string,
  values: Partial<CourseCatalogFilterItem> = {},
): CourseCatalogFilterItem => ({
  name,
  searchText: name,
  stage: '高中',
  grade: '高一',
  subject: '数学',
  customStage: false,
  customGrade: false,
  customSubject: false,
  sourceKinds: ['owner'],
  updatedAt: '2026-10-01T00:00:00Z',
  moduleCount: 1,
  starCount: 0,
  ...values,
});
const courses = [
  item('Zulu', {
    updatedAt: '2026-10-03T00:00:00Z',
    moduleCount: 3,
    starCount: 8,
    sourceKinds: ['owner', 'platform_opening'],
  }),
  item('Alpha', { moduleCount: 5, starCount: 2 }),
  item('Beta', { updatedAt: '2026-10-02T00:00:00Z', moduleCount: 5, starCount: 8 }),
];
const run = (patch = {}, values = courses) =>
  filterAndSortCourseCatalog(
    values,
    { ...defaultCourseCatalogFilters, ...patch },
    'en-US',
    (course) => course,
  );
describe('authorized catalog filtering and sorting', () => {
  it.each([
    ['updated', ['Zulu', 'Beta', 'Alpha']],
    ['name', ['Alpha', 'Beta', 'Zulu']],
    ['modules', ['Alpha', 'Beta', 'Zulu']],
    ['favorites', ['Beta', 'Zulu', 'Alpha']],
  ])('uses real %s data with name tie breaking without mutating the catalog', (sort, names) => {
    expect(run({ sort }).map((course) => course.name)).toEqual(names);
    expect(courses.map((course) => course.name)).toEqual(['Zulu', 'Alpha', 'Beta']);
  });
  it('combines search, all classifications and membership of multiple authorization sources', () => {
    expect(
      run({
        q: ' zUL ',
        stage: '高中',
        grade: '高一',
        subject: '数学',
        source: 'platform_opening',
      }),
    ).toEqual([courses[0]]);
    expect(run({ source: 'reuse_copy' })).toEqual([]);
  });
  it('distinguishes explicit custom modes from the same preset text in every dimension', () => {
    const custom = item('Custom', { customStage: true, customGrade: true, customSubject: true });
    const values = [courses[0], custom];
    for (const [field, preset] of [
      ['stage', '高中'],
      ['grade', '高一'],
      ['subject', '数学'],
    ]) {
      expect(run({ [field]: preset }, values)).toEqual([courses[0]]);
      expect(run({ [field]: '__custom__' }, values)).toEqual([custom]);
    }
  });
  it('keeps missing history visible for all and sorts invalid timestamps deterministically', () => {
    const missing = item('Missing', { stage: null, grade: null, subject: null, updatedAt: null });
    const invalid = item('Absent', { updatedAt: 'invalid' });
    expect(run({}, [missing, invalid]).map((course) => course.name)).toEqual(['Absent', 'Missing']);
    expect(run({ stage: '高中' }, [missing])).toEqual([]);
  });
});
