'use client';

import type { DeckStoryPlan, LessonObjective, LessonPlan } from '@reachany/reach-deck-dsl';
import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import styles from './ReachDeckTeachingSemantics.module.css';

const objectValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const textValue = (value: unknown): string =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const arrayValue = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value == null ? [] : [value];
const textArray = (value: unknown): string[] => arrayValue(value).map(textValue);

/** Saved advisory edits may deliberately be incomplete; fill shapes, never old teaching text. */
export function editableSavedLessonPlan(
  fallback: LessonPlan | undefined,
  advisory: Record<string, unknown> | undefined,
): LessonPlan | undefined {
  if (advisory === undefined) return fallback;
  const rawStory = objectValue(advisory.story);
  const organizer = objectValue(rawStory.advanceOrganizer);
  const closing = objectValue(rawStory.closing);
  const rawKnowledge = objectValue(advisory.knowledgePlan);
  const story: DeckStoryPlan | undefined =
    advisory.story == null
      ? undefined
      : {
          schemaVersion: 'reach-deck-story/v1',
          coreQuestion: textValue(rawStory.coreQuestion),
          learnerPromise: textValue(rawStory.learnerPromise),
          opening: textValue(rawStory.opening),
          development: textValue(rawStory.development),
          advanceOrganizer: {
            coreQuestion: textValue(organizer.coreQuestion),
            priorKnowledge: textArray(organizer.priorKnowledge),
            learningRoute: textArray(organizer.learningRoute),
            successEvidence: textArray(organizer.successEvidence),
          },
          closing: {
            synthesis: textValue(closing.synthesis),
            returnToOpening: textValue(closing.returnToOpening),
            transfer: textValue(closing.transfer),
          },
          sections: arrayValue(rawStory.sections).map((value, index) => {
            const section = objectValue(value);
            return {
              id: textValue(section.id) || 'section-editor-' + (index + 1),
              title: textValue(section.title),
              question: textValue(section.question),
              entryCondition: textValue(section.entryCondition),
              exitOutcome: textValue(section.exitOutcome),
              objectiveIds: textArray(section.objectiveIds),
            };
          }),
        };
  const objectives = arrayValue(advisory.objectives).map((value, index) => {
    const objective = objectValue(value);
    return {
      id: textValue(objective.id) || 'objective-editor-' + (index + 1),
      statement: textValue(typeof value === 'string' ? value : objective.statement),
      evidence: textValue(objective.evidence),
    };
  });
  return {
    id: textValue(advisory.id) || fallback?.id || 'lesson-editor',
    title: textValue(advisory.title),
    audience: textValue(advisory.audience),
    durationMinutes:
      typeof advisory.durationMinutes === 'number'
        ? advisory.durationMinutes
        : (fallback?.durationMinutes ?? 1),
    teachingStrategy: textValue(advisory.teachingStrategy),
    narrative: textValue(advisory.narrative),
    keyTerms: textArray(advisory.keyTerms),
    learningObjectives: textArray(advisory.learningObjectives),
    objectives,
    assessmentPlan: textValue(advisory.assessmentPlan),
    ...(story === undefined ? {} : { story }),
    ...(advisory.knowledgePlan == null
      ? {}
      : {
          knowledgePlan: {
            schemaVersion: 'reach-deck-knowledge-plan/v1' as const,
            points: arrayValue(rawKnowledge.points).map((value, index) => {
              const point = objectValue(value);
              return {
                id: textValue(point.id) || 'point-editor-' + (index + 1),
                sectionId: textValue(point.sectionId),
                title: textValue(point.title),
                kind:
                  point.kind === 'vocabulary_cluster'
                    ? ('vocabulary_cluster' as const)
                    : ('standard' as const),
                objectiveIds: textArray(point.objectiveIds),
                items: arrayValue(point.items).map((value, at) => {
                  const item = objectValue(value);
                  return {
                    id: textValue(item.id) || 'atom-editor-' + (index + 1) + '-' + (at + 1),
                    content: textValue(typeof value === 'string' ? value : item.content),
                  };
                }),
                prerequisite: textValue(point.prerequisite),
                targetUnderstanding: textValue(point.targetUnderstanding),
                masteryEvidence: textValue(point.masteryEvidence),
                curiositySeed: textValue(point.curiositySeed),
                learnerAttempt: textValue(point.learnerAttempt),
                reveal: textValue(point.reveal),
              };
            }),
          },
        }),
    ...(typeof objectValue(advisory.presentationPreferences).includeTitlePage === 'boolean'
      ? {
          presentationPreferences: {
            includeTitlePage: objectValue(advisory.presentationPreferences)
              .includeTitlePage as boolean,
          },
        }
      : {}),
  };
}

// The old list and structured objectives can contain independent teacher edits.
// Match only exact text: positional matching would attach unrelated evidence.
export function editableLessonObjectives(plan: LessonPlan): LessonObjective[] {
  const objectives = (plan.objectives ?? []).map((objective) => ({ ...objective }));
  for (const statement of plan.learningObjectives) {
    if (objectives.some((objective) => objective.statement === statement)) continue;
    let ordinal = objectives.length + 1;
    while (objectives.some(({ id }) => id === `objective-editor-${ordinal}`)) ordinal++;
    objectives.push({ id: `objective-editor-${ordinal}`, statement, evidence: '' });
  }
  return objectives;
}

export function LessonObjectiveChoices({
  objectives,
  value,
  onChange,
  disabled = false,
}: {
  objectives: LessonObjective[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = usePortalI18n();
  const choices = [
    ...objectives,
    ...value
      .filter((id) => !objectives.some((item) => item.id === id))
      .map((id) => ({ id, statement: t('reachDeck.step2.unavailableObjective'), evidence: '' })),
  ];
  return (
    <fieldset className={styles.objectiveChoices} disabled={disabled}>
      <legend>{t('reachDeck.step2.linkedObjectives')}</legend>
      {choices.map((objective, index) => (
        <label key={objective.id}>
          <input
            type="checkbox"
            checked={value.includes(objective.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, objective.id]
                  : value.filter((id) => id !== objective.id),
              )
            }
          />
          <span>
            {objective.statement || t('reachDeck.step2.untitledObjective', { index: index + 1 })}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function LessonObjectivesEditor({
  objectives,
  disabled,
  onChange,
}: {
  objectives: LessonObjective[];
  disabled: boolean;
  onChange: (objectives: LessonObjective[]) => void;
}) {
  const { t } = usePortalI18n();
  return (
    <div className={styles.knowledgePoints}>
      {objectives.map((objective, index) => (
        <section className={styles.knowledgeCard} key={objective.id}>
          <div className={styles.knowledgeCardHeader}>
            <strong>{t('reachDeck.step2.objectiveNumber', { index: index + 1 })}</strong>
            <button
              className={styles.addAction}
              disabled={disabled}
              type="button"
              onClick={() => onChange(objectives.filter((entry) => entry.id !== objective.id))}
            >
              {t('reachDeck.lesson.listRemove')}
            </button>
          </div>
          {(['statement', 'evidence'] as const).map((field) => (
            <label className={styles.knowledgeField} key={field}>
              <span>{t(`reachDeck.step2.objective.${field}`)}</span>
              <textarea
                aria-label={t(`reachDeck.step2.objective.${field}`)}
                rows={3}
                disabled={disabled}
                value={objective[field]}
                onChange={(event) =>
                  onChange(
                    objectives.map((entry) =>
                      entry.id === objective.id ? { ...entry, [field]: event.target.value } : entry,
                    ),
                  )
                }
              />
            </label>
          ))}
        </section>
      ))}
      <button
        className={styles.addAction}
        disabled={disabled}
        type="button"
        onClick={() =>
          onChange([
            ...objectives,
            { id: `objective-${crypto.randomUUID()}`, statement: '', evidence: '' },
          ])
        }
      >
        {t('reachDeck.lesson.listAdd')}
      </button>
    </div>
  );
}

export function LessonStoryEditor({
  story,
  objectives,
  disabled,
  onChange,
}: {
  story: DeckStoryPlan;
  objectives: LessonObjective[];
  disabled: boolean;
  onChange: (story: DeckStoryPlan) => void;
}) {
  const { t } = usePortalI18n();
  const field = (label: string, value: string, update: (value: string) => void) => (
    <label className={styles.knowledgeField} key={label}>
      <span>{t(`reachDeck.step2.story.${label}`)}</span>
      <textarea
        aria-label={t(`reachDeck.step2.story.${label}`)}
        disabled={disabled}
        rows={3}
        value={value}
        onChange={(event) => update(event.target.value)}
      />
    </label>
  );
  const list = (label: 'priorKnowledge' | 'learningRoute' | 'successEvidence') => (
    <div className={styles.knowledgeField} key={label}>
      <span>{t(`reachDeck.step2.story.${label}`)}</span>
      {story.advanceOrganizer[label].map((value, index) => (
        <div className={styles.knowledgeItem} key={index}>
          <textarea
            aria-label={t(`reachDeck.step2.story.${label}`)}
            disabled={disabled}
            rows={2}
            value={value}
            onChange={(event) =>
              onChange({
                ...story,
                advanceOrganizer: {
                  ...story.advanceOrganizer,
                  [label]: story.advanceOrganizer[label].map((item, at) =>
                    at === index ? event.target.value : item,
                  ),
                },
              })
            }
          />
          <button
            type="button"
            disabled={disabled}
            aria-label={t('reachDeck.lesson.listRemove')}
            onClick={() =>
              onChange({
                ...story,
                advanceOrganizer: {
                  ...story.advanceOrganizer,
                  [label]: story.advanceOrganizer[label].filter((_, at) => at !== index),
                },
              })
            }
          >
            ×
          </button>
        </div>
      ))}
      <button
        className={styles.addAction}
        type="button"
        disabled={disabled}
        onClick={() =>
          onChange({
            ...story,
            advanceOrganizer: {
              ...story.advanceOrganizer,
              [label]: [...story.advanceOrganizer[label], ''],
            },
          })
        }
      >
        {t('reachDeck.lesson.listAdd')}
      </button>
    </div>
  );
  return (
    <div className={styles.storyEditor}>
      <div className={styles.knowledgeFieldGrid}>
        {(['coreQuestion', 'learnerPromise', 'opening', 'development'] as const).map((key) =>
          field(key, story[key], (value) => onChange({ ...story, [key]: value })),
        )}
      </div>
      <details className={styles.storyGroup}>
        <summary>{t('reachDeck.step2.story.organizer')}</summary>
        <div className={styles.knowledgeFieldGrid}>
          {field('organizerQuestion', story.advanceOrganizer.coreQuestion, (value) =>
            onChange({
              ...story,
              advanceOrganizer: { ...story.advanceOrganizer, coreQuestion: value },
            }),
          )}
          {list('priorKnowledge')}
          {list('learningRoute')}
          {list('successEvidence')}
        </div>
      </details>
      <details className={styles.storyGroup}>
        <summary>{t('reachDeck.step2.story.closing')}</summary>
        <div className={styles.knowledgeFieldGrid}>
          {(['synthesis', 'returnToOpening', 'transfer'] as const).map((key) =>
            field(key, story.closing[key], (value) =>
              onChange({ ...story, closing: { ...story.closing, [key]: value } }),
            ),
          )}
        </div>
      </details>
      <details className={styles.storyGroup}>
        <summary>{t('reachDeck.step2.story.sections')}</summary>
        <div className={styles.knowledgePoints}>
          {story.sections.map((section) => (
            <section className={styles.knowledgeCard} key={section.id}>
              <div className={styles.knowledgeFieldGrid}>
                {(['title', 'question', 'entryCondition', 'exitOutcome'] as const).map((key) =>
                  field(key, section[key], (value) =>
                    onChange({
                      ...story,
                      sections: story.sections.map((entry) =>
                        entry.id === section.id ? { ...entry, [key]: value } : entry,
                      ),
                    }),
                  ),
                )}
              </div>
              <LessonObjectiveChoices
                disabled={disabled}
                objectives={objectives}
                value={section.objectiveIds}
                onChange={(objectiveIds) =>
                  onChange({
                    ...story,
                    sections: story.sections.map((entry) =>
                      entry.id === section.id ? { ...entry, objectiveIds } : entry,
                    ),
                  })
                }
              />
              <button
                className={styles.addAction}
                disabled={disabled}
                type="button"
                onClick={() =>
                  onChange({
                    ...story,
                    sections: story.sections.filter((entry) => entry.id !== section.id),
                  })
                }
              >
                {t('reachDeck.step2.removeSection')}
              </button>
            </section>
          ))}
          <button
            className={styles.addAction}
            disabled={disabled}
            type="button"
            onClick={() =>
              onChange({
                ...story,
                sections: [
                  ...story.sections,
                  {
                    id: `section-${crypto.randomUUID()}`,
                    title: '',
                    question: '',
                    entryCondition: '',
                    exitOutcome: '',
                    objectiveIds: [],
                  },
                ],
              })
            }
          >
            {t('reachDeck.step2.addSection')}
          </button>
        </div>
      </details>
    </div>
  );
}
