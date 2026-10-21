'use client';

import { useEffect, useState } from 'react';
import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import styles from './ReachDeckAuthoringFlow.module.css';

// These markers are produced by the compatibility adapter. They remain in the
// canonical text: this component is only an editable presentation of that text.
export function legacySpecNote(text: string) {
  const match = /^\[([A-Za-z][\w]*)\](\r?\n)([\s\S]*)$/.exec(text);
  return match ? { field: match[1]!, prefix: `[${match[1]}]${match[2]}`, body: match[3]! } : null;
}

const knownFields = new Set([
  'pageFunctions',
  'continuity',
  'continuesFrom',
  'handsOffTo',
  'sectionId',
  'objectiveIds',
  'interactionAssessmentPlan',
  'microCycleStages',
  'knowledgePointId',
  'summarizesKnowledgePointIds',
  'focusStatement',
  'genUiIntent',
  'teachingMove',
  'visualIntents',
  'supportingDetails',
  'keyPoints',
  'learningObjective',
  'pageJob',
  'pageRole',
  'assessmentIntent',
  'assessmentEvidence',
  'visualDirection',
  'density',
  'visibleTitleMode',
  'interactionBrief',
  'visualAssets',
  'fromPrevious',
  'learningAdvance',
  'toNext',
  'groupId',
  'plannedQuestionCount',
  'min',
  'max',
  'timeBudgetSeconds',
  'targets',
  'questionSlots',
  'coverage',
  'id',
  'statement',
  'action',
  'evidence',
  'required',
  'interactionRole',
  'targetIds',
  'evidenceType',
  'questionGranularity',
  'dependsOn',
  'requiredEvidence',
  'estimatedSeconds',
  'targetId',
  'slotIds',
  'requiredRoles',
]);

type TextLeaf = { path: (string | number)[]; start: number; end: number; value: unknown };

/** Locate leaves in valid JSON so editing one value leaves every other byte intact. */
function jsonLeaves(text: string): TextLeaf[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const tokens = [
      ...text.matchAll(
        /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g,
      ),
    ];
    let cursor = 0;
    const leaves: TextLeaf[] = [];
    const visit = (path: (string | number)[]) => {
      const first = tokens[cursor++]!;
      const token = first[0];
      if (token === '{' || token === '[') {
        const close = token === '{' ? '}' : ']';
        if (tokens[cursor]?.[0] === close) {
          const last = tokens[cursor++]!;
          leaves.push({
            path,
            start: first.index!,
            end: last.index! + 1,
            value: token === '{' ? {} : [],
          });
          return;
        }
        let index = 0;
        while (tokens[cursor]?.[0] !== close) {
          const key = token === '{' ? (JSON.parse(tokens[cursor++]![0]) as string) : index++;
          if (token === '{') cursor++; // colon
          visit([...path, key]);
          if (tokens[cursor]?.[0] === ',') cursor++;
        }
        cursor++;
      } else {
        leaves.push({
          path,
          start: first.index!,
          end: first.index! + token.length,
          value: JSON.parse(token),
        });
      }
    };
    visit([]);
    return leaves;
  } catch {
    return undefined;
  }
}

export function ReachDeckLegacySpecField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { t } = usePortalI18n();
  const labelFor = (key: string) =>
    knownFields.has(key)
      ? t(`reachDeck.legacySpec.field.${key}`)
      : t('reachDeck.legacySpec.otherField', { name: key });
  const label = labelFor(field);
  const leaves = jsonLeaves(value);
  return (
    <div
      className={styles.planField}
      role={leaves ? 'group' : undefined}
      aria-label={leaves ? label : undefined}
    >
      {leaves ? <span>{label}</span> : null}
      {(leaves ?? [{ path: [], start: 0, end: value.length, value }]).map((leaf, index) => {
        const leafLabel = [
          label,
          ...leaf.path.map((key) =>
            typeof key === 'number'
              ? t('reachDeck.legacySpec.item', { index: key + 1 })
              : labelFor(key),
          ),
        ].join(' / ');
        const update = (next: unknown) => {
          const replacement = leaves ? JSON.stringify(next) : String(next);
          onChange(value.slice(0, leaf.start) + replacement + value.slice(leaf.end));
        };
        return (
          <div className={styles.planField} key={JSON.stringify(leaf.path) + index}>
            <span>{leafLabel}</span>
            <LegacyLeafEditor
              value={leaf.value}
              label={leafLabel}
              disabled={disabled}
              onChange={update}
            />
          </div>
        );
      })}
    </div>
  );
}

function LegacyLeafEditor({
  value,
  label,
  disabled,
  onChange,
}: {
  value: unknown;
  label: string;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  // A number cleared to null must keep a numeric editor until this field unmounts.
  const [initialType] = useState(value === null ? 'null' : typeof value);
  if (typeof value === 'boolean')
    return (
      <input
        aria-label={label}
        type="checkbox"
        disabled={disabled}
        checked={value}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  if (typeof value === 'number' || (value === null && initialType === 'number'))
    return (
      <LegacyNumberField
        value={value as number | null}
        label={label}
        disabled={disabled}
        onChange={onChange}
      />
    );
  if (value !== null && typeof value === 'object')
    return (
      <LegacyContainerField value={value} label={label} disabled={disabled} onChange={onChange} />
    );
  return (
    <textarea
      aria-label={label}
      disabled={disabled}
      rows={2}
      value={value === null ? '' : String(value)}
      onChange={(event) =>
        onChange(
          (value === null || initialType === 'null') && event.target.value === ''
            ? null
            : event.target.value,
        )
      }
    />
  );
}

function LegacyNumberField({
  value,
  label,
  disabled,
  onChange,
}: {
  value: number | null;
  label: string;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);
  return (
    <input
      aria-label={label}
      type="number"
      disabled={disabled}
      value={draft}
      onBlur={() => {
        if (draft === '') onChange(null);
      }}
      onChange={(event) => {
        setDraft(event.target.value);
        if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber))
          onChange(event.target.valueAsNumber);
      }}
    />
  );
}

function LegacyContainerField({
  value,
  label,
  disabled,
  onChange,
}: {
  value: object;
  label: string;
  disabled: boolean;
  onChange: (value: object) => void;
}) {
  const { t } = usePortalI18n();
  const serialized = JSON.stringify(value);
  const [draft, setDraft] = useState(serialized);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(serialized);
    setInvalid(false);
  }, [serialized]);
  return (
    <>
      <span>{t('reachDeck.legacySpec.structureHint')}</span>
      <textarea
        aria-label={label}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        rows={2}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
      />
      {invalid ? <span role="alert">{t('reachDeck.legacySpec.structureInvalid')}</span> : null}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          try {
            const next: unknown = JSON.parse(draft);
            if (next === null || typeof next !== 'object') {
              setInvalid(true);
              return;
            }
            onChange(next);
          } catch {
            setInvalid(true);
          }
        }}
      >
        {t('reachDeck.legacySpec.applyStructure')}
      </button>
    </>
  );
}
