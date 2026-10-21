'use client';

import { useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  PAGE_ROLES,
  VISIBLE_TITLE_MODES,
  type LessonPlan,
  type PageInstructionalSpec,
  type PageOutline,
  type PlannedVisualAsset,
} from '@reachany/reach-deck-dsl';
import { Select } from '@reachany/ui';

import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import styles from './ReachDeckAuthoringFlow.module.css';
import { legacySpecNote, ReachDeckLegacySpecField } from './ReachDeckLegacySpecFields';

/** Scene-specific fields edit one canonical spec. Hidden fields survive scene changes. */
export function ReachDeckPageSpecEditor({
  children,
  disabled,
  onChange,
  page,
  plan,
  spec,
}: {
  children?: ReactNode;
  disabled: boolean;
  onChange: (spec: PageInstructionalSpec) => void;
  page: PageOutline;
  plan?: LessonPlan;
  spec: PageInstructionalSpec;
}) {
  const { t } = usePortalI18n();
  const [assessmentOpen, setAssessmentOpen] = useState(Boolean(spec.assessmentEvidence));
  const setField = <K extends keyof PageInstructionalSpec>(
    field: K,
    value: PageInstructionalSpec[K],
  ) => onChange({ ...spec, [field]: value });
  const textField = (
    field: 'learningObjective' | 'pageJob' | 'assessmentEvidence' | 'visualDirection',
    label: string,
  ) => (
    <PlainField
      disabled={disabled}
      label={label}
      onChange={(value) => setField(field, value)}
      value={spec[field] ?? ''}
    />
  );
  const points = plan?.knowledgePlan?.points ?? [];
  const selectedIds = spec.knowledgePointIds ?? [];
  const pointOptions = [
    ...points.map((point) => ({ value: point.id, label: point.title })),
    ...selectedIds
      .filter((id) => !points.some((point) => point.id === id))
      .map((id, index) => ({
        value: id,
        label: t('reachDeck.outline.unavailableRelation', { index: index + 1 }),
      })),
  ];
  const brief = spec.interactionBrief ?? { learnerAction: '', experienceGoal: '' };
  const setBrief = (field: 'learnerAction' | 'experienceGoal', value: string) =>
    setField('interactionBrief', { ...brief, [field]: value });
  const notes = spec.keyPoints.map((text, index) => ({ index, note: legacySpecNote(text) }));
  const contentIndexes = notes.filter(({ note }) => !note).map(({ index }) => index);
  const supplements = notes.filter(({ note }) => note !== null);
  const jobMarker = /(?:^|\n\n)\[assessmentIntent\]\r?\n/.exec(spec.pageJob ?? '');
  const jobContent = jobMarker ? spec.pageJob!.slice(0, jobMarker.index) : (spec.pageJob ?? '');
  const jobSuffix = jobMarker ? spec.pageJob!.slice(jobMarker.index) : '';

  return (
    <section aria-label={t('reachDeck.outline.specSection')} className={styles.outlineSpecSection}>
      <span className={styles.outlineSpecTitle}>{t('reachDeck.outline.specSection')}</span>
      {textField('learningObjective', t('reachDeck.outline.learningObjective'))}
      <label className={styles.planField}>
        <span>{t('reachDeck.semantics.pageRole')}</span>
        <Select
          aria-label={t('reachDeck.semantics.pageRole')}
          disabled={disabled}
          onChange={(pageRole) => setField('pageRole', pageRole || undefined)}
          options={[
            { value: '' as const, label: t('reachDeck.outline.unspecified') },
            ...PAGE_ROLES.map((value) => ({
              value,
              label: t(`reachDeck.semantics.role.${value}`),
            })),
          ]}
          value={spec.pageRole ?? ''}
        />
      </label>
      <PlainField
        disabled={disabled}
        label={t('reachDeck.outline.pageJob')}
        value={jobContent}
        onChange={(value) =>
          setField('pageJob', value + (jobMarker?.index === 0 && value ? '\n\n' : '') + jobSuffix)
        }
      />
      <PlainList
        disabled={disabled}
        label={t('reachDeck.outline.keyPoints')}
        onChange={(keyPoints, edit) => {
          if (!edit) return;
          const sourceIndex = contentIndexes[edit.index];
          setField(
            'keyPoints',
            edit.action === 'add'
              ? [...spec.keyPoints, '']
              : edit.action === 'remove'
                ? spec.keyPoints.filter((_, index) => index !== sourceIndex)
                : spec.keyPoints.map((point, index) =>
                    index === sourceIndex ? keyPoints[edit.index]! : point,
                  ),
          );
        }}
        value={contentIndexes.map((index) => spec.keyPoints[index]!)}
      />
      {supplements.length > 0 || jobMarker ? (
        <details className={styles.outlineAdvanced}>
          <summary>{t('reachDeck.legacySpec.title')}</summary>
          {jobMarker ? (
            <ReachDeckLegacySpecField
              disabled={disabled}
              field="assessmentIntent"
              value={jobSuffix.slice(jobMarker[0].length)}
              onChange={(value) => setField('pageJob', jobContent + jobMarker[0] + value)}
            />
          ) : null}
          {supplements.map(({ index, note }) =>
            note ? (
              <div key={index} className={styles.planField}>
                <ReachDeckLegacySpecField
                  disabled={disabled}
                  field={note.field}
                  value={note.body}
                  onChange={(value) =>
                    setField(
                      'keyPoints',
                      spec.keyPoints.map((point, i) => (i === index ? note.prefix + value : point)),
                    )
                  }
                />
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    setField(
                      'keyPoints',
                      spec.keyPoints.filter((_, i) => i !== index),
                    )
                  }
                >
                  {t('reachDeck.legacySpec.remove')}
                </button>
              </div>
            ) : null,
          )}
        </details>
      ) : null}
      <div className={styles.planField}>
        <span>{t('reachDeck.semantics.knowledgePoints')}</span>
        <div
          aria-label={t('reachDeck.semantics.knowledgePoints')}
          className={styles.outlineChoices}
          role="group"
        >
          {pointOptions.length === 0 ? (
            <span>{t('reachDeck.outline.noAvailableRelations')}</span>
          ) : null}
          {pointOptions.map((point) => (
            <button
              aria-pressed={selectedIds.includes(point.value)}
              disabled={disabled}
              key={point.value}
              onClick={() =>
                setField(
                  'knowledgePointIds',
                  selectedIds.includes(point.value)
                    ? selectedIds.filter((id) => id !== point.value)
                    : [...selectedIds, point.value],
                )
              }
              type="button"
            >
              {point.label}
            </button>
          ))}
        </div>
      </div>

      {page.sceneType === 'slide' ? (
        <>
          {textField('visualDirection', t('reachDeck.outline.visualDirection'))}
          <VisualAssetSummary value={spec.visualAssets} />
          <details className={styles.outlineAdvanced}>
            <summary>{t('reachDeck.outline.presentation')}</summary>
            <div className={styles.outlineMeta}>
              <label>
                {t('reachDeck.outline.density')}
                <Select
                  aria-label={t('reachDeck.outline.density')}
                  disabled={disabled}
                  onChange={(density) => setField('density', density)}
                  options={(['low', 'medium', 'high'] as const).map((value) => ({
                    value,
                    label: t(`reachDeck.outline.density.${value}`),
                  }))}
                  value={spec.density}
                />
              </label>
              <label>
                {t('reachDeck.outline.visibleTitleMode')}
                <Select
                  aria-label={t('reachDeck.outline.visibleTitleMode')}
                  disabled={disabled}
                  onChange={(value) => setField('visibleTitleMode', value || undefined)}
                  options={[
                    { value: '' as const, label: t('reachDeck.outline.unspecified') },
                    ...VISIBLE_TITLE_MODES.map((value) => ({
                      value,
                      label: t(`reachDeck.outline.titleMode.${value}`),
                    })),
                  ]}
                  value={spec.visibleTitleMode ?? ''}
                />
              </label>
            </div>
            {children}
          </details>
        </>
      ) : page.sceneType === 'quiz' ? (
        textField('assessmentEvidence', t('reachDeck.outline.expectedEvidence'))
      ) : page.sceneType === 'interactive' ? (
        <>
          <PlainField
            disabled={disabled}
            label={t('reachDeck.outline.learnerAction')}
            onChange={(value) => setBrief('learnerAction', value)}
            value={brief.learnerAction}
          />
          <PlainField
            disabled={disabled}
            label={t('reachDeck.outline.experienceGoal')}
            onChange={(value) => setBrief('experienceGoal', value)}
            value={brief.experienceGoal}
          />
          <details className={styles.outlineAdvanced}>
            <summary>{t('reachDeck.outline.creativeSuggestions')}</summary>
            <p>{t('reachDeck.outline.creativeSuggestionsHint')}</p>
            <PlainList
              disabled={disabled}
              label={t('reachDeck.outline.approachHints')}
              onChange={(approachHints) =>
                setField('interactionBrief', { ...brief, approachHints })
              }
              value={brief.approachHints ?? []}
            />
            {textField('visualDirection', t('reachDeck.outline.visualDirection'))}
          </details>
          {assessmentOpen || Boolean(spec.assessmentEvidence) ? (
            <div className={styles.planField}>
              {textField('assessmentEvidence', t('reachDeck.outline.expectedEvidence'))}
              <button
                disabled={disabled}
                onClick={() => {
                  setField('assessmentEvidence', undefined);
                  setAssessmentOpen(false);
                }}
                type="button"
              >
                {t('reachDeck.outline.removeAssessment')}
              </button>
            </div>
          ) : (
            <button
              className={styles.secondaryAction}
              disabled={disabled}
              onClick={() => setAssessmentOpen(true)}
              type="button"
            >
              {t('reachDeck.outline.addAssessment')}
            </button>
          )}
        </>
      ) : null}
      {page.sceneType === 'quiz' && spec.visualDirection ? (
        <details className={styles.outlineAdvanced}>
          <summary>{t('reachDeck.outline.existingPresentation')}</summary>
          {textField('visualDirection', t('reachDeck.outline.visualDirection'))}
        </details>
      ) : null}
    </section>
  );
}

function PlainField({
  disabled,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className={styles.planField}>
      <span>{label}</span>
      <textarea
        aria-label={label}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        rows={2}
        value={value}
      />
    </label>
  );
}

function PlainList({
  disabled,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  label: string;
  onChange: (
    value: string[],
    edit?: { index: number; action: 'replace' | 'remove' | 'add' },
  ) => void;
  value: string[];
}) {
  const { t } = usePortalI18n();
  return (
    <div aria-label={label} className={styles.planField} role="group">
      <span>{label}</span>
      {value.map((text, index) => (
        <div className={styles.outlineTextRow} key={index}>
          <textarea
            aria-label={`${label} ${index + 1}`}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                value.map((current, i) => (i === index ? event.target.value : current)),
                { index, action: 'replace' },
              )
            }
            rows={2}
            value={text}
          />
          <button
            aria-label={t('reachDeck.lesson.listRemove', { index: index + 1 })}
            disabled={disabled}
            onClick={() =>
              onChange(
                value.filter((_, i) => i !== index),
                { index, action: 'remove' },
              )
            }
            type="button"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        className={styles.secondaryAction}
        disabled={disabled}
        onClick={() => onChange([...value, ''], { index: value.length, action: 'add' })}
        type="button"
      >
        <Plus size={14} />
        {t('reachDeck.lesson.listAdd')}
      </button>
    </div>
  );
}

/**
 * The outline's visual plan is authoritative and produced exactly as planned, so Teacher shows it
 * read-only. Changing a visual goes through page regeneration with the teacher's request.
 */
function VisualAssetSummary({ value }: { value: readonly PlannedVisualAsset[] }) {
  const { t } = usePortalI18n();
  if (value.length === 0) return null;
  return (
    <section aria-label={t('reachDeck.outline.authoritativeVisualPlan')}>
      <span className={styles.outlineSpecTitle}>
        {t('reachDeck.outline.authoritativeVisualPlan')}
      </span>
      <ul>
        {value.map((asset, index) => (
          <li key={index}>
            {asset.purpose} — {asset.alt}
          </li>
        ))}
      </ul>
    </section>
  );
}
