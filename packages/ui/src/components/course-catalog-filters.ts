export const COURSE_CATALOG_OTHER = '__custom__';
export const courseCatalogSorts = ['updated', 'name', 'modules', 'favorites'] as const;
export type CourseCatalogSort = (typeof courseCatalogSorts)[number];
export type CourseCatalogFilterField = 'sort' | 'stage' | 'grade' | 'subject' | 'source';
export interface CourseCatalogFilterState {
  q: string;
  sort: CourseCatalogSort;
  stage: string;
  grade: string;
  subject: string;
  source: string;
}
export const defaultCourseCatalogFilters: CourseCatalogFilterState = {
  q: '',
  sort: 'updated',
  stage: 'all',
  grade: 'all',
  subject: 'all',
  source: 'all',
};
export function courseCatalogFilterFields(
  t: (key: string) => string,
  options: Record<'stage' | 'grade' | 'subject' | 'source', { value: string; label: string }[]>,
) {
  const field = (
    key: string,
    clear: string,
    all: string,
    values: { value: string; label: string }[],
  ) => ({
    label: t(key),
    clearLabel: t(clear),
    options: [{ value: 'all', label: t(all) }, ...values],
  });
  return {
    sort: {
      label: t('sort'),
      clearLabel: t('clearSort'),
      options: courseCatalogSorts.map((value) => ({ value, label: t(`sort.${value}`) })),
    },
    stage: field('stage', 'clearStage', 'filterAllStages', options.stage),
    grade: field('schoolYear', 'clearYear', 'filterAllSchoolYears', options.grade),
    subject: field('subject', 'clearSubject', 'filterAllSubjects', options.subject),
    source: field('source', 'clearSource', 'filterAllSources', options.source),
  };
}
export interface CourseCatalogFilterItem {
  name: string;
  searchText: string;
  stage: string | null;
  grade: string | null;
  subject: string | null;
  customStage: boolean;
  customGrade: boolean;
  customSubject: boolean;
  sourceKinds: readonly string[];
  updatedAt: string | null;
  moduleCount: number;
  starCount: number;
}

/** Filter only the supplied, already authorized collection; never mutate its order. */
export function filterAndSortCourseCatalog<T>(
  courses: readonly T[],
  state: CourseCatalogFilterState,
  locale: string,
  describe: (course: T) => CourseCatalogFilterItem,
): T[] {
  const query = state.q.trim().toLocaleLowerCase(locale);
  const matches = (filter: string, value: string | null, custom: boolean) =>
    filter === 'all' || (filter === COURSE_CATALOG_OTHER ? custom : !custom && value === filter);
  const timestamp = (value: string | null) => {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return courses
    .map((course) => ({ course, item: describe(course) }))
    .filter(
      ({ item }) =>
        (!query || item.searchText.toLocaleLowerCase(locale).includes(query)) &&
        matches(state.stage, item.stage, item.customStage) &&
        matches(state.grade, item.grade, item.customGrade) &&
        matches(state.subject, item.subject, item.customSubject) &&
        (state.source === 'all' || item.sourceKinds.includes(state.source)),
    )
    .sort(({ item: left }, { item: right }) => {
      const name = left.name.localeCompare(right.name, locale);
      if (state.sort === 'name') return name;
      if (state.sort === 'modules') return right.moduleCount - left.moduleCount || name;
      if (state.sort === 'favorites') return right.starCount - left.starCount || name;
      return timestamp(right.updatedAt) - timestamp(left.updatedAt) || name;
    })
    .map(({ course }) => course);
}
