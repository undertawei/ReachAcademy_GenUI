'use client';

import { useEffect, useState } from 'react';
import { Save, Trash2 } from 'lucide-react';
import type { ReachDeckTranslate } from '@reachany/reach-deck-player';
import { translateReachDeck } from '@reachany/reach-deck-player';
import { EUCLIDEAN_GEOMETRY_CONTRACT } from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT_V2,
  type GeometryAuxiliaryMeasurementKindV2,
  type GeometryAuxiliaryObjectKindV2,
  type GeometryExplorationPolicyV2,
  type GeometryRelationV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';

import type {
  GeometryAuthoringInstance,
  GeometryAuthoringCategory,
  GeometryParameterAuthoringSetting,
  GeometryPresentationPatch,
} from './geometryAuthoring.js';

type EditableCategory = Extract<
  GeometryAuthoringCategory,
  'objects' | 'measurements' | 'relations'
>;

interface GeometryAuthoringPanelProps {
  instance: GeometryAuthoringInstance;
  mode: 'edit' | 'trial';
  disabled: boolean;
  selected?: { category: EditableCategory; id: string };
  canSetInitial: boolean;
  onDelete: (category: EditableCategory, id: string) => void;
  onModeChange: (mode: 'edit' | 'trial') => void;
  onParameterSettingsChange: (settings: readonly GeometryParameterAuthoringSetting[]) => void;
  onPolicyChange: (policy: GeometryExplorationPolicyV2) => void;
  onPresentationChange: (
    category: EditableCategory,
    id: string,
    patch: GeometryPresentationPatch,
  ) => void;
  onSelect: (selected: { category: EditableCategory; id: string } | undefined) => void;
  onSetInitial: () => void;
  translate?: ReachDeckTranslate;
}

const objectTools = [
  ['line', 'reachDeck.geometry.tool.line', '直线'],
  ['segment', 'reachDeck.geometry.tool.segment', '线段'],
  ['midpoint', 'reachDeck.geometry.tool.midpoint', '中点'],
  ['pointOnLine', 'reachDeck.geometry.tool.pointOnLine', '线上点'],
  ['parallelLine', 'reachDeck.geometry.tool.parallelLine', '平行线'],
  ['footToLine', 'reachDeck.geometry.tool.footToLine', '点到线垂足'],
  ['footToPlane', 'reachDeck.geometry.tool.footToPlane', '点到面垂足'],
] as const;
const measurementTools = [
  ['distance', 'reachDeck.geometry.tool.distance', '长度'],
  ['pointLineDistance', 'reachDeck.geometry.tool.pointLineDistance', '点线距离'],
  ['pointSegmentDistance', 'reachDeck.geometry.tool.pointSegmentDistance', '点到线段距离'],
  ['pointPlaneDistance', 'reachDeck.geometry.tool.pointPlaneDistance', '点面距离'],
  ['lineAngle', 'reachDeck.geometry.tool.lineAngle', '两线夹角'],
  ['linePlaneAngle', 'reachDeck.geometry.tool.linePlaneAngle', '线面角'],
] as const;
const relationTools = [
  ['lineLine', 'reachDeck.geometry.tool.lineLineRelation', '两线关系'],
  ['linePlane', 'reachDeck.geometry.tool.linePlaneRelation', '线面关系'],
] as const;

export function GeometryAuthoringModeControl({
  disabled = false,
  mode,
  onChange,
  translate,
}: {
  disabled?: boolean;
  mode: 'edit' | 'trial';
  onChange: (mode: 'edit' | 'trial') => void;
  translate?: ReachDeckTranslate;
}) {
  const text = (key: string, fallback: string) => translateReachDeck(translate, key, fallback);
  return (
    <div
      aria-label={text('reachDeck.geometry.authoring.mode', '几何模式')}
      className="reach-deck-editor__geometry-mode"
      role="group"
    >
      <button
        aria-pressed={mode === 'edit'}
        disabled={disabled}
        onClick={() => onChange('edit')}
        type="button"
      >
        {text('reachDeck.geometry.authoring.edit', '编辑')}
      </button>
      <button
        aria-pressed={mode === 'trial'}
        disabled={disabled}
        onClick={() => onChange('trial')}
        type="button"
      >
        {text('reachDeck.geometry.authoring.trial', '试用')}
      </button>
    </div>
  );
}

export function GeometryAuthoringReadOnlyNotice({
  invalid = false,
  translate,
}: {
  invalid?: boolean;
  translate?: ReachDeckTranslate;
}) {
  return (
    <p className="reach-deck-editor__geometry-notice" role="status">
      {translateReachDeck(
        translate,
        invalid ? 'reachDeck.geometry.authoring.invalid' : 'reachDeck.geometry.authoring.readOnly',
        invalid
          ? '几何标记无法安全编辑，请使用 Decksmith 修复。'
          : '此几何未声明直接编辑范围，请使用 Decksmith 修改。',
      )}
    </p>
  );
}

function replaceKind<T extends string>(
  values: readonly T[],
  kind: T,
  checked: boolean,
): readonly T[] {
  return checked ? [...new Set([...values, kind])] : values.filter((value) => value !== kind);
}

export function GeometryAuthoringPanel({
  instance,
  mode,
  disabled,
  selected,
  canSetInitial,
  onDelete,
  onModeChange,
  onParameterSettingsChange,
  onPolicyChange,
  onPresentationChange,
  onSelect,
  onSetInitial,
  translate,
}: GeometryAuthoringPanelProps) {
  const text = (key: string, fallback: string) => translateReachDeck(translate, key, fallback);
  const { envelope } = instance;
  const bindings = envelope.spec.authoring!;
  const policy = envelope.spec.interaction.exploration;
  const items = (['objects', 'measurements', 'relations'] as const).flatMap((category) =>
    bindings.editable[category].map((id) => ({ category, id })),
  );
  const selectedDefinition =
    selected === undefined
      ? undefined
      : envelope.spec[selected.category].find((entry) => entry.id === selected.id);
  const selectedPresentation =
    selected?.category === 'objects'
      ? envelope.spec.presentation.objects.find((entry) => entry.object === selected.id)
      : selected?.category === 'measurements'
        ? envelope.spec.presentation.measurements.find((entry) => entry.measurement === selected.id)
        : selected?.category === 'relations'
          ? envelope.spec.presentation.relations.find((entry) => entry.relation === selected.id)
          : undefined;
  const modeDisabled = disabled || mode === 'trial';
  const selectedColorToken =
    'colorToken' in (selectedPresentation ?? {})
      ? ((selectedPresentation as { colorToken?: string }).colorToken ?? 'ink')
      : 'ink';
  const persistedLabel = selectedPresentation?.label ?? '';
  const [labelDraft, setLabelDraft] = useState(persistedLabel);
  useEffect(() => {
    setLabelDraft(persistedLabel);
  }, [persistedLabel, selected?.category, selected?.id]);
  const commitLabel = () => {
    if (selected === undefined || labelDraft === persistedLabel) return;
    onPresentationChange(selected.category, selected.id, { label: labelDraft });
  };
  const supportedObjectTools = objectTools.filter(
    ([kind]) => envelope.spec.dimension === 3 || kind !== 'footToPlane',
  );
  const supportedMeasurementTools = measurementTools.filter(
    ([kind]) =>
      envelope.spec.dimension === 3 || (kind !== 'pointPlaneDistance' && kind !== 'linePlaneAngle'),
  );
  const supportedRelationTools = relationTools.filter(
    ([kind]) => envelope.spec.dimension === 3 || kind !== 'linePlane',
  );

  const patchPolicy = (patch: Partial<GeometryExplorationPolicyV2>) =>
    onPolicyChange({ ...policy, ...patch });

  return (
    <section
      aria-label={text('reachDeck.geometry.authoring.panel', '几何编辑')}
      className="reach-deck-editor__geometry-authoring"
    >
      <GeometryAuthoringModeControl
        disabled={disabled}
        mode={mode}
        onChange={onModeChange}
        translate={translate}
      />
      {mode === 'trial' ? (
        <p className="reach-deck-editor__geometry-notice" role="status">
          {text('reachDeck.geometry.authoring.trialStatus', '试用状态不会写入课件。')}
        </p>
      ) : null}

      <div className="reach-deck-editor__geometry-actions">
        <button disabled={modeDisabled || !canSetInitial} onClick={onSetInitial} type="button">
          <Save aria-hidden size={14} />
          {text('reachDeck.geometry.authoring.setInitial', '设为初始状态')}
        </button>
      </div>

      <fieldset disabled={modeDisabled}>
        <legend>{text('reachDeck.geometry.authoring.properties', '对象属性')}</legend>
        <label>
          <span>{text('reachDeck.geometry.authoring.item', '对象')}</span>
          <select
            aria-label={text('reachDeck.geometry.authoring.item', '对象')}
            onChange={(event) => {
              const [category, id] = event.target.value.split(':');
              onSelect(category && id ? { category: category as EditableCategory, id } : undefined);
            }}
            value={selected === undefined ? '' : `${selected.category}:${selected.id}`}
          >
            <option value="">{text('reachDeck.geometry.authoring.chooseItem', '选择对象')}</option>
            {items.map((item) => (
              <option key={`${item.category}:${item.id}`} value={`${item.category}:${item.id}`}>
                {item.id}
              </option>
            ))}
          </select>
        </label>
        {selected !== undefined && selectedDefinition !== undefined ? (
          <>
            <label>
              <span>{text('reachDeck.geometry.authoring.label', '标签')}</span>
              <input
                aria-label={text('reachDeck.geometry.authoring.label', '标签')}
                maxLength={EUCLIDEAN_GEOMETRY_CONTRACT_V2.limits.labelLength}
                onBlur={commitLabel}
                onChange={(event) => setLabelDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                value={labelDraft}
              />
            </label>
            {selected.category === 'objects' ? (
              <>
                <div className="reach-deck-editor__geometry-color">
                  <span>{text('reachDeck.geometry.authoring.color', '颜色')}</span>
                  <div
                    aria-label={text('reachDeck.geometry.authoring.color', '颜色')}
                    className="reach-deck-editor__geometry-swatches"
                    role="group"
                  >
                    {(['ink', 'muted', 'accent', 'success', 'warning'] as const).map((token) => (
                      <button
                        aria-label={text(`reachDeck.geometry.authoring.color.${token}`, token)}
                        aria-pressed={selectedColorToken === token}
                        data-color-token={token}
                        key={token}
                        onClick={() =>
                          onPresentationChange(selected.category, selected.id, {
                            colorToken: token,
                          })
                        }
                        title={text(`reachDeck.geometry.authoring.color.${token}`, token)}
                        type="button"
                      />
                    ))}
                  </div>
                </div>
                <label>
                  <span>{text('reachDeck.geometry.authoring.lineStyle', '线型')}</span>
                  <select
                    aria-label={text('reachDeck.geometry.authoring.lineStyle', '线型')}
                    onChange={(event) =>
                      onPresentationChange(selected.category, selected.id, {
                        lineStyle: event.target.value as GeometryPresentationPatch['lineStyle'],
                      })
                    }
                    value={
                      'lineStyle' in (selectedPresentation ?? {})
                        ? ((selectedPresentation as { lineStyle?: string }).lineStyle ?? 'solid')
                        : 'solid'
                    }
                  >
                    <option value="solid">
                      {text('reachDeck.geometry.authoring.solid', '实线')}
                    </option>
                    <option value="dashed">
                      {text('reachDeck.geometry.authoring.dashed', '虚线')}
                    </option>
                    <option value="dotted">
                      {text('reachDeck.geometry.authoring.dotted', '点线')}
                    </option>
                  </select>
                </label>
              </>
            ) : null}
            {selected.category === 'measurements' ? (
              <label>
                <span>{text('reachDeck.geometry.authoring.decimals', '小数位')}</span>
                <input
                  aria-label={text('reachDeck.geometry.authoring.decimals', '小数位')}
                  max={EUCLIDEAN_GEOMETRY_CONTRACT.presentationValues.decimals[1]}
                  min={EUCLIDEAN_GEOMETRY_CONTRACT.presentationValues.decimals[0]}
                  onChange={(event) =>
                    onPresentationChange(selected.category, selected.id, {
                      decimals: Number(event.target.value),
                    })
                  }
                  type="number"
                  value={
                    'decimals' in (selectedPresentation ?? {})
                      ? ((selectedPresentation as { decimals?: number }).decimals ?? 2)
                      : 2
                  }
                />
              </label>
            ) : null}
            <label className="reach-deck-editor__geometry-check">
              <input
                checked={
                  'visible' in (selectedPresentation ?? {})
                    ? (selectedPresentation as { visible?: boolean }).visible !== false
                    : true
                }
                onChange={(event) =>
                  onPresentationChange(selected.category, selected.id, {
                    visible: event.target.checked,
                  })
                }
                type="checkbox"
              />
              <span>{text('reachDeck.geometry.authoring.visible', '显示')}</span>
            </label>
            <button
              disabled={!bindings.deletable[selected.category].includes(selected.id)}
              onClick={() => onDelete(selected.category, selected.id)}
              type="button"
            >
              <Trash2 aria-hidden size={14} />
              {text('reachDeck.geometry.authoring.delete', '删除')}
            </button>
          </>
        ) : null}
      </fieldset>

      <fieldset disabled={modeDisabled}>
        <legend>{text('reachDeck.geometry.authoring.exploration', '学生探索')}</legend>
        <GeometryToolChecks
          checked={policy.objectKinds}
          label={text('reachDeck.geometry.authoring.constructions', '构造工具')}
          onChange={(kind, checked) =>
            patchPolicy({
              objectKinds: replaceKind(
                policy.objectKinds,
                kind as GeometryAuxiliaryObjectKindV2,
                checked,
              ),
            })
          }
          tools={supportedObjectTools}
          translate={translate}
        />
        <GeometryToolChecks
          checked={policy.measurementKinds}
          label={text('reachDeck.geometry.authoring.measurements', '测量工具')}
          onChange={(kind, checked) =>
            patchPolicy({
              measurementKinds: replaceKind(
                policy.measurementKinds,
                kind as GeometryAuxiliaryMeasurementKindV2,
                checked,
              ),
            })
          }
          tools={supportedMeasurementTools}
          translate={translate}
        />
        <GeometryToolChecks
          checked={policy.relationKinds}
          label={text('reachDeck.geometry.authoring.relations', '关系检查')}
          onChange={(kind, checked) =>
            patchPolicy({
              relationKinds: replaceKind(
                policy.relationKinds,
                kind as GeometryRelationV2['kind'],
                checked,
              ),
            })
          }
          tools={supportedRelationTools}
          translate={translate}
        />
        <div className="reach-deck-editor__geometry-check-grid">
          <strong>{text('reachDeck.geometry.authoring.referenceable', '可引用题设对象')}</strong>
          {envelope.spec.objects.map((object) => (
            <label className="reach-deck-editor__geometry-check" key={object.id}>
              <input
                checked={policy.referenceableObjects.includes(object.id)}
                onChange={(event) =>
                  patchPolicy({
                    referenceableObjects: replaceKind(
                      policy.referenceableObjects,
                      object.id,
                      event.target.checked,
                    ),
                  })
                }
                type="checkbox"
              />
              <span>{object.id}</span>
            </label>
          ))}
        </div>
        <div className="reach-deck-editor__geometry-parameters">
          <strong>{text('reachDeck.geometry.authoring.parameters', '可调参数与范围')}</strong>
          {envelope.spec.parameters.map((parameter) => (
            <div className="reach-deck-editor__geometry-parameter" key={parameter.id}>
              <label className="reach-deck-editor__geometry-check">
                <input
                  checked={envelope.spec.interaction.parameters.includes(parameter.id)}
                  disabled={!bindings.editable.parameters.includes(parameter.id)}
                  onChange={(event) =>
                    onParameterSettingsChange(
                      envelope.spec.parameters.map((entry) => ({
                        id: entry.id,
                        learnerEditable:
                          entry.id === parameter.id
                            ? event.target.checked
                            : envelope.spec.interaction.parameters.includes(entry.id),
                        min: entry.min,
                        max: entry.max,
                        step: entry.step,
                      })),
                    )
                  }
                  type="checkbox"
                />
                <span>{parameter.id}</span>
              </label>
              {(['min', 'max', 'step'] as const).map((field) => (
                <label key={`${field}:${parameter[field]}`}>
                  <span>
                    {text(
                      `reachDeck.geometry.authoring.range.${field}`,
                      { min: '最小值', max: '最大值', step: '步长' }[field],
                    )}
                  </span>
                  <input
                    aria-label={`${parameter.id} ${text(
                      `reachDeck.geometry.authoring.range.${field}`,
                      { min: '最小值', max: '最大值', step: '步长' }[field],
                    )}`}
                    defaultValue={parameter[field]}
                    disabled={!bindings.editable.parameters.includes(parameter.id)}
                    onBlur={(event) => {
                      const value = Number(event.target.value);
                      if (!Number.isFinite(value) || value === parameter[field]) return;
                      onParameterSettingsChange(
                        envelope.spec.parameters.map((entry) => ({
                          id: entry.id,
                          learnerEditable: envelope.spec.interaction.parameters.includes(entry.id),
                          min: entry.id === parameter.id && field === 'min' ? value : entry.min,
                          max: entry.id === parameter.id && field === 'max' ? value : entry.max,
                          step: entry.id === parameter.id && field === 'step' ? value : entry.step,
                        })),
                      );
                    }}
                    type="number"
                  />
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="reach-deck-editor__geometry-limits">
          <strong>{text('reachDeck.geometry.authoring.limits', '数量上限')}</strong>
          {(['objects', 'measurements', 'relations'] as const).map((field) => (
            <label key={field}>
              <span>{text(`reachDeck.geometry.authoring.limit.${field}`, field)}</span>
              <input
                aria-label={text(`reachDeck.geometry.authoring.limit.${field}`, field)}
                max={
                  EUCLIDEAN_GEOMETRY_CONTRACT_V2.limits[
                    field === 'objects'
                      ? 'auxiliaryObjects'
                      : field === 'measurements'
                        ? 'auxiliaryMeasurements'
                        : 'auxiliaryRelations'
                  ]
                }
                min={0}
                onChange={(event) =>
                  patchPolicy({
                    limits: { ...policy.limits, [field]: Number(event.target.value) },
                  })
                }
                type="number"
                value={policy.limits[field]}
              />
            </label>
          ))}
        </div>
        <label>
          <span>{text('reachDeck.geometry.authoring.feedback', '反馈方式')}</span>
          <select
            aria-label={text('reachDeck.geometry.authoring.feedback', '反馈方式')}
            onChange={(event) =>
              patchPolicy({
                feedback: event.target.value as GeometryExplorationPolicyV2['feedback'],
              })
            }
            value={policy.feedback}
          >
            <option value="immediate">
              {text('reachDeck.geometry.authoring.feedback.immediate', '即时反馈')}
            </option>
            <option value="onRequest">
              {text('reachDeck.geometry.authoring.feedback.onRequest', '主动检查')}
            </option>
            <option value="hidden">
              {text('reachDeck.geometry.authoring.feedback.hidden', '隐藏数值')}
            </option>
          </select>
        </label>
      </fieldset>
    </section>
  );
}

function GeometryToolChecks({
  checked,
  label,
  onChange,
  tools,
  translate,
}: {
  checked: readonly string[];
  label: string;
  onChange: (kind: string, checked: boolean) => void;
  tools: readonly (readonly [string, string, string])[];
  translate?: ReachDeckTranslate;
}) {
  return (
    <div className="reach-deck-editor__geometry-check-grid">
      <strong>{label}</strong>
      {tools.map(([kind, key, fallback]) => (
        <label className="reach-deck-editor__geometry-check" key={kind}>
          <input
            checked={checked.includes(kind)}
            onChange={(event) => onChange(kind, event.target.checked)}
            type="checkbox"
          />
          <span>{translateReachDeck(translate, key, fallback)}</span>
        </label>
      ))}
    </div>
  );
}
