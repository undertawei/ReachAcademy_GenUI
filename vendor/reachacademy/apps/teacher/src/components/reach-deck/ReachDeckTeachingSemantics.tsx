'use client';

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import {
  pageAllowsCrossSectionObjectives,
  REACH_DECK_KNOWLEDGE_PLAN_SCHEMA_VERSION,
  type LessonPlan,
  type LessonKnowledgePlan,
  type PageOutline,
} from '@reachany/reach-deck-dsl';

import { usePortalI18n } from '@/src/components/PortalI18nProvider';

import styles from './ReachDeckTeachingSemantics.module.css';
import { LessonObjectiveChoices } from './ReachDeckLessonStructureEditor';

type Translate = ReturnType<typeof usePortalI18n>['t'];

export function pageReferenceErrors(
  page: PageOutline,
  plan: LessonPlan | undefined,
  t: Translate,
): string[] {
  if (plan === undefined) return [];
  const errors: string[] = [];
  const point = plan.knowledgePlan?.points.find(({ id }) => id === page.knowledgePointId);
  const section = plan.story?.sections.find(({ id }) => id === page.sectionId);
  if (plan.knowledgePlan !== undefined) {
    for (const id of [page.knowledgePointId, ...(page.summarizesKnowledgePointIds ?? [])]) {
      if (id !== undefined && !plan.knowledgePlan.points.some((entry) => entry.id === id)) {
        errors.push(t('reachDeck.semantics.unknownKnowledgePoint', { id }));
      }
    }
  }
  if (page.sectionId !== undefined && plan.story !== undefined && section === undefined) {
    errors.push(t('reachDeck.semantics.unknownSection', { id: page.sectionId }));
  }
  if (point !== undefined && page.sectionId !== undefined && point.sectionId !== page.sectionId) {
    errors.push(
      t('reachDeck.semantics.sectionMismatch', {
        point: point.title,
        section:
          plan.story?.sections.find(({ id }) => id === point.sectionId)?.title ?? point.sectionId,
      }),
    );
  }
  const objectiveIds =
    plan.objectives?.map(({ id }) => id) ??
    plan.story?.sections.flatMap((entry) => entry.objectiveIds);
  if (objectiveIds !== undefined) {
    for (const id of page.objectiveIds ?? []) {
      if (!objectiveIds.includes(id)) {
        errors.push(t('reachDeck.semantics.unknownObjective', { id }));
      }
    }
  }
  if (section !== undefined && !pageAllowsCrossSectionObjectives(page)) {
    for (const id of page.objectiveIds ?? []) {
      if (!section.objectiveIds.includes(id)) {
        errors.push(
          t('reachDeck.semantics.objectiveSectionMismatch', { id, section: section.title }),
        );
      }
    }
  }
  return [...new Set(errors)];
}

export function LessonKnowledgePoints({
  plan,
  knowledgePlan = plan.knowledgePlan,
  disabled = false,
  onChange,
}: {
  plan: LessonPlan;
  knowledgePlan?: LessonKnowledgePlan;
  disabled?: boolean;
  onChange?: (knowledgePlan: LessonKnowledgePlan) => void;
}) {
  const { t } = usePortalI18n();
  const editable = onChange !== undefined;
  const points = knowledgePlan?.points ?? [];
  const emit = (nextPoints: LessonKnowledgePlan['points']) =>
    onChange?.({ schemaVersion: REACH_DECK_KNOWLEDGE_PLAN_SCHEMA_VERSION, points: nextPoints });
  const updatePoint = (
    pointId: string,
    update: (point: LessonKnowledgePlan['points'][number]) => LessonKnowledgePlan['points'][number],
  ) => {
    if (onChange === undefined) return;
    emit(points.map((point) => (point.id === pointId ? update(point) : point)));
  };
  return (
    <div className={styles.knowledgeEditor}>
      <ol aria-label={t('reachDeck.lesson.tab.knowledge')} className={styles.knowledgePoints}>
        {points.map((point, index) => (
          <li className={styles.knowledgeCard} key={point.id}>
            <div className={styles.knowledgeCardHeader}>
              <div className={styles.knowledgeHeading}>
                <span aria-hidden="true" className={styles.knowledgeIndex}>
                  {String(index + 1).padStart(2, '0')}
                </span>
                {editable ? (
                  <label className={styles.knowledgeTitleField}>
                    <span>{t('reachDeck.semantics.knowledgePoint')}</span>
                    <input
                      aria-label={t('reachDeck.semantics.knowledgePoint')}
                      disabled={disabled}
                      onChange={(event) =>
                        updatePoint(point.id, (current) => ({
                          ...current,
                          title: event.target.value,
                        }))
                      }
                      value={point.title}
                    />
                  </label>
                ) : (
                  <h3>{point.title}</h3>
                )}
              </div>
              {editable ? (
                <div className={styles.pointActions}>
                  <button
                    aria-label={t('reachDeck.semantics.moveUp')}
                    disabled={disabled || index === 0}
                    onClick={() => {
                      const next = [...points];
                      [next[index - 1], next[index]] = [next[index], next[index - 1]];
                      emit(next);
                    }}
                    title={t('reachDeck.semantics.moveUp')}
                    type="button"
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    aria-label={t('reachDeck.semantics.moveDown')}
                    disabled={disabled || index === points.length - 1}
                    onClick={() => {
                      const next = [...points];
                      [next[index], next[index + 1]] = [next[index + 1], next[index]];
                      emit(next);
                    }}
                    title={t('reachDeck.semantics.moveDown')}
                    type="button"
                  >
                    <ArrowDown size={15} />
                  </button>
                  <button
                    aria-label={t('reachDeck.semantics.removePoint')}
                    disabled={disabled}
                    onClick={() => emit(points.filter((candidate) => candidate.id !== point.id))}
                    title={t('reachDeck.semantics.removePoint')}
                    type="button"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ) : null}
            </div>

            <div className={styles.knowledgeContextGrid}>
              <label className={styles.knowledgeField}>
                <span>{t('reachDeck.semantics.section')}</span>
                <select
                  aria-label={t('reachDeck.semantics.section')}
                  disabled={disabled || !editable}
                  value={point.sectionId}
                  onChange={(event) =>
                    updatePoint(point.id, (current) => ({
                      ...current,
                      sectionId: event.target.value,
                    }))
                  }
                >
                  <option value="">{t('reachDeck.step2.noSection')}</option>
                  {point.sectionId &&
                  !plan.story?.sections.some(({ id }) => id === point.sectionId) ? (
                    <option value={point.sectionId}>
                      {t('reachDeck.step2.unavailableSection')}
                    </option>
                  ) : null}
                  {plan.story?.sections.map((section, sectionIndex) => (
                    <option key={section.id} value={section.id}>
                      {section.title ||
                        t('reachDeck.step2.untitledSection', { index: sectionIndex + 1 })}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.knowledgeField}>
                <span>{t('reachDeck.step2.kind')}</span>
                <select
                  aria-label={t('reachDeck.step2.kind')}
                  disabled={disabled || !editable}
                  value={point.kind}
                  onChange={(event) =>
                    updatePoint(point.id, (current) => ({
                      ...current,
                      kind: event.target.value as typeof current.kind,
                    }))
                  }
                >
                  <option value="standard">{t('reachDeck.step2.kind.standard')}</option>
                  <option value="vocabulary_cluster">
                    {t('reachDeck.step2.kind.vocabulary_cluster')}
                  </option>
                </select>
              </label>
            </div>
            <LessonObjectiveChoices
              objectives={plan.objectives ?? []}
              value={point.objectiveIds}
              disabled={disabled || !editable}
              onChange={(objectiveIds) =>
                updatePoint(point.id, (current) => ({ ...current, objectiveIds }))
              }
            />

            <div className={styles.knowledgeField}>
              <span>{t('reachDeck.semantics.knowledgeItems')}</span>
              <div className={styles.knowledgeItems}>
                {point.items.map((item) => (
                  <div className={styles.knowledgeItem} key={item.id}>
                    {editable ? (
                      <textarea
                        aria-label={t('reachDeck.semantics.knowledgeItems')}
                        disabled={disabled}
                        onChange={(event) =>
                          updatePoint(point.id, (current) => ({
                            ...current,
                            items: current.items.map((candidate) =>
                              candidate.id === item.id
                                ? { ...candidate, content: event.target.value }
                                : candidate,
                            ),
                          }))
                        }
                        rows={2}
                        value={item.content}
                      />
                    ) : (
                      <p>{item.content}</p>
                    )}
                    {editable ? (
                      <button
                        aria-label={t('reachDeck.semantics.removeItem')}
                        disabled={disabled}
                        onClick={() =>
                          updatePoint(point.id, (current) => ({
                            ...current,
                            items: current.items.filter((candidate) => candidate.id !== item.id),
                          }))
                        }
                        title={t('reachDeck.semantics.removeItem')}
                        type="button"
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
              {editable ? (
                <button
                  className={styles.addAction}
                  disabled={disabled}
                  onClick={() =>
                    updatePoint(point.id, (current) => ({
                      ...current,
                      items: [...current.items, { id: `atom-${crypto.randomUUID()}`, content: '' }],
                    }))
                  }
                  type="button"
                >
                  <Plus size={14} />
                  {t('reachDeck.semantics.addItem')}
                </button>
              ) : null}
            </div>

            <div className={styles.knowledgeFieldGrid}>
              {(
                [
                  'prerequisite',
                  'targetUnderstanding',
                  'masteryEvidence',
                  'curiositySeed',
                  'learnerAttempt',
                  'reveal',
                ] as const
              ).map((field) =>
                editable || point[field] ? (
                  <label className={styles.knowledgeField} key={field}>
                    <span>{t(`reachDeck.semantics.${field}`)}</span>
                    {editable ? (
                      <textarea
                        aria-label={t(`reachDeck.semantics.${field}`)}
                        disabled={disabled}
                        onChange={(event) =>
                          updatePoint(point.id, (current) => ({
                            ...current,
                            [field]: event.target.value,
                          }))
                        }
                        rows={3}
                        value={point[field]}
                      />
                    ) : (
                      <p>{point[field]}</p>
                    )}
                  </label>
                ) : null,
              )}
            </div>
          </li>
        ))}
      </ol>
      {editable ? (
        <button
          className={styles.addAction}
          disabled={disabled}
          onClick={() =>
            emit([
              ...points,
              {
                id: `kp-${crypto.randomUUID()}`,
                sectionId: plan.story?.sections[0]?.id ?? '',
                title: '',
                kind: 'standard',
                items: [{ id: `atom-${crypto.randomUUID()}`, content: '' }],
                objectiveIds: plan.objectives?.[0] ? [plan.objectives[0].id] : [],
                prerequisite: '',
                targetUnderstanding: '',
                masteryEvidence: '',
                curiositySeed: '',
                learnerAttempt: '',
                reveal: '',
              },
            ])
          }
          type="button"
        >
          <Plus size={14} />
          {t('reachDeck.semantics.addPoint')}
        </button>
      ) : null}
    </div>
  );
}

export function PageTeachingSemantics({
  page,
  plan,
  validateReferences = true,
}: {
  page: PageOutline;
  plan?: LessonPlan;
  validateReferences?: boolean;
}) {
  const { t } = usePortalI18n();
  const knowledgePointLabel = (id: string) =>
    plan?.knowledgePlan?.points.find((point) => point.id === id)?.title ?? id;
  const rows: Array<[string, string | undefined]> = [
    [
      'section',
      page.sectionId === undefined
        ? undefined
        : (plan?.story?.sections.find(({ id }) => id === page.sectionId)?.title ?? page.sectionId),
    ],
    [
      'knowledgePoint',
      page.knowledgePointId === undefined ? undefined : knowledgePointLabel(page.knowledgePointId),
    ],
    ['summarizes', page.summarizesKnowledgePointIds?.map(knowledgePointLabel).join(' / ')],
    [
      'objectives',
      page.objectiveIds
        ?.map((id) => plan?.objectives?.find((objective) => objective.id === id)?.statement ?? id)
        .join(' / '),
    ],
    [
      'pageRole',
      page.pageRole === undefined ? undefined : t(`reachDeck.semantics.role.${page.pageRole}`),
    ],
    [
      'pageFunctions',
      page.pageFunctions?.map((role) => t(`reachDeck.semantics.role.${role}`)).join(' / '),
    ],
    ['pageJob', page.pageJob],
    [
      'microCycle',
      page.microCycleStages?.map((stage) => t(`reachDeck.semantics.cycle.${stage}`)).join(' / '),
    ],
    ['assessmentIntent', page.instructionalSpec?.assessmentIntent],
    ['assessmentEvidence', page.instructionalSpec?.assessmentEvidence],
    ['genUiIntent', page.instructionalSpec?.genUiIntent],
  ];
  const visibleRows = rows.filter((row): row is [string, string] => Boolean(row[1]));
  const errors = validateReferences ? pageReferenceErrors(page, plan, t) : [];
  if (visibleRows.length === 0 && errors.length === 0) return null;
  return (
    <section aria-label={t('reachDeck.semantics.label')} className={styles.pageSemantics}>
      <h3>{t('reachDeck.semantics.label')}</h3>
      <dl className={styles.details}>
        {visibleRows.map(([label, value]) => (
          <div className={styles.detailRow} key={label}>
            <dt>{t(`reachDeck.semantics.${label}`)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {errors.length > 0 ? (
        <ul className={styles.errors} role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
