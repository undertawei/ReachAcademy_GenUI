'use client';

import {
  Blend,
  Eye,
  Minus,
  EyeOff,
  MoveUp,
  Palette,
  Play,
  Plus,
  RotateCw,
  Scaling,
  Square,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ReachDeckAnimationV2 } from '@reachany/reach-deck-dsl';
import { translateReachDeck, type ReachDeckTranslate } from '@reachany/reach-deck-player';

type Effect = ReachDeckAnimationV2['effect'];
type Easing = NonNullable<ReachDeckAnimationV2['easing']>;

/** 与 PowerPoint 动画库同样按“进入 / 强调 / 退出”分组，组色只用于图标点缀。 */
const EFFECT_GROUPS: ReadonlyArray<{
  id: 'entrance' | 'emphasis' | 'exit';
  labelKey: string;
  fallback: string;
  effects: ReadonlyArray<{ effect: Effect; icon: LucideIcon; fallback: string }>;
}> = [
  {
    id: 'entrance',
    labelKey: 'reachDeck.editor.animation.group.entrance',
    fallback: '进入',
    effects: [
      { effect: 'appear', icon: Eye, fallback: '出现' },
      { effect: 'fade', icon: Blend, fallback: '淡入' },
      { effect: 'move', icon: MoveUp, fallback: '移动' },
      { effect: 'scale', icon: Scaling, fallback: '缩放' },
      { effect: 'rotate', icon: RotateCw, fallback: '旋转' },
    ],
  },
  {
    id: 'emphasis',
    labelKey: 'reachDeck.editor.animation.group.emphasis',
    fallback: '强调',
    effects: [{ effect: 'color', icon: Palette, fallback: '变色' }],
  },
  {
    id: 'exit',
    labelKey: 'reachDeck.editor.animation.group.exit',
    fallback: '退出',
    effects: [{ effect: 'disappear', icon: EyeOff, fallback: '消失' }],
  },
];

const EASINGS: ReadonlyArray<{ easing: Easing; key: string; fallback: string; path: string }> = [
  { easing: 'linear', key: 'linear', fallback: '线性', path: 'M4 20 L20 4' },
  { easing: 'ease-in', key: 'easeIn', fallback: '缓入', path: 'M4 20 C13 20 18 14 20 4' },
  { easing: 'ease-out', key: 'easeOut', fallback: '缓出', path: 'M4 20 C6 10 11 4 20 4' },
  { easing: 'ease-in-out', key: 'easeInOut', fallback: '缓入缓出', path: 'M4 20 C12 20 12 4 20 4' },
];

export interface AnimationPropertiesPanelProps {
  animation: ReachDeckAnimationV2;
  disabled?: boolean;
  /** 返回应用补丁后的动画；未能应用时返回 undefined。 */
  onChange: (patch: Partial<ReachDeckAnimationV2>) => ReachDeckAnimationV2 | undefined;
  /** 演示某个动画状态（更换效果/缓动后自动调用，也可手动预览）。 */
  onPreview: (animation: ReachDeckAnimationV2) => void;
  /** 正在演示时显示“停止”。 */
  previewing?: boolean;
  onStopPreview?: () => void;
  translate?: ReachDeckTranslate;
}

/**
 * 动画片段属性：效果与缓动平铺为图标磁贴（凸起=可选，凹陷=当前），时间用步进输入。
 * 更换效果或缓动后立即在画布上演示一遍起止，像 PowerPoint 动画库一样所见即所得。
 */
export function AnimationPropertiesPanel({
  animation,
  disabled = false,
  onChange,
  onPreview,
  previewing = false,
  onStopPreview,
  translate,
}: AnimationPropertiesPanelProps) {
  const text = (key: string, fallback: string, values?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, values);
  const effectRefs = useRef(new Map<Effect, HTMLButtonElement | null>());
  const easingRefs = useRef(new Map<Easing, HTMLButtonElement | null>());
  const easing = animation.easing ?? 'linear';
  const effects = EFFECT_GROUPS.flatMap((group) => group.effects.map((item) => item.effect));

  const applyAndPreview = (patch: Partial<ReachDeckAnimationV2>) => {
    if (disabled) return;
    const next = onChange(patch);
    if (next !== undefined) onPreview(next);
  };

  // 单选磁贴组：方向键在同组内移动并立即选中（与原生单选框一致），Tab 只停在当前项。
  const rovingKeyDown = <T extends string>(
    event: KeyboardEvent<HTMLButtonElement>,
    values: readonly T[],
    current: T,
    refs: Map<T, HTMLButtonElement | null>,
    select: (value: T) => void,
  ) => {
    const delta =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = values.indexOf(current);
    const next = values[(index + delta + values.length) % values.length]!;
    select(next);
    refs.get(next)?.focus();
  };

  return (
    <div
      aria-label={text('reachDeck.editor.timeline.animationProperties', '动画片段属性')}
      className="reach-deck-editor__animation-properties"
    >
      <div className="reach-deck-editor__animation-section">
        <div className="reach-deck-editor__animation-section-header">
          <span id="reach-deck-animation-effect-label">
            {text('reachDeck.editor.timeline.type', '类型')}
          </span>
          <button
            aria-label={
              previewing
                ? text('reachDeck.editor.animation.stopPreview', '停止预览')
                : text('reachDeck.editor.animation.preview', '预览动画')
            }
            className="reach-deck-editor__animation-preview"
            onClick={() => (previewing ? onStopPreview?.() : onPreview(animation))}
            type="button"
          >
            {previewing ? <Square aria-hidden size={12} /> : <Play aria-hidden size={12} />}
            {previewing
              ? text('reachDeck.editor.animation.stopPreview', '停止预览')
              : text('reachDeck.editor.animation.previewShort', '预览')}
          </button>
        </div>
        <div
          aria-labelledby="reach-deck-animation-effect-label"
          className="reach-deck-editor__animation-effects"
          role="radiogroup"
        >
          {EFFECT_GROUPS.map((group) => (
            <div
              className="reach-deck-editor__animation-effect-group"
              data-group={group.id}
              key={group.id}
            >
              <span aria-hidden className="reach-deck-editor__animation-group-label">
                {text(group.labelKey, group.fallback)}
              </span>
              <div className="reach-deck-editor__animation-tiles">
                {group.effects.map(({ effect, icon: Icon, fallback }) => {
                  const selected = animation.effect === effect;
                  const label = text(
                    `reachDeck.editor.timeline.animationEffect.${effect}`,
                    fallback,
                  );
                  return (
                    <button
                      aria-checked={selected}
                      className="reach-deck-editor__animation-tile"
                      disabled={disabled}
                      key={effect}
                      onClick={() => {
                        if (!selected) applyAndPreview({ effect });
                        else onPreview(animation);
                      }}
                      onKeyDown={(event) =>
                        rovingKeyDown(
                          event,
                          effects,
                          animation.effect,
                          effectRefs.current,
                          (value) => applyAndPreview({ effect: value }),
                        )
                      }
                      ref={(node) => {
                        effectRefs.current.set(effect, node);
                      }}
                      role="radio"
                      tabIndex={selected ? 0 : -1}
                      title={label}
                      type="button"
                    >
                      <Icon aria-hidden size={18} strokeWidth={1.8} />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="reach-deck-editor__animation-section">
        <span
          className="reach-deck-editor__animation-section-label"
          id="reach-deck-animation-easing-label"
        >
          {text('reachDeck.editor.timeline.easing', '缓动')}
        </span>
        <div
          aria-labelledby="reach-deck-animation-easing-label"
          className="reach-deck-editor__animation-tiles is-easing"
          role="radiogroup"
        >
          {EASINGS.map((option) => {
            const selected = easing === option.easing;
            const label = text(`reachDeck.editor.timeline.easing.${option.key}`, option.fallback);
            return (
              <button
                aria-checked={selected}
                className="reach-deck-editor__animation-tile"
                disabled={disabled}
                key={option.easing}
                onClick={() => {
                  if (!selected) applyAndPreview({ easing: option.easing });
                  else onPreview(animation);
                }}
                onKeyDown={(event) =>
                  rovingKeyDown(
                    event,
                    EASINGS.map((item) => item.easing),
                    easing,
                    easingRefs.current,
                    (value) => applyAndPreview({ easing: value }),
                  )
                }
                ref={(node) => {
                  easingRefs.current.set(option.easing, node);
                }}
                role="radio"
                tabIndex={selected ? 0 : -1}
                title={label}
                type="button"
              >
                <svg aria-hidden fill="none" height="22" viewBox="0 0 24 24" width="22">
                  <path className="is-axis" d="M4 4 V20 H20" />
                  <path className="is-curve" d={option.path} />
                </svg>
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="reach-deck-editor__animation-section reach-deck-editor__animation-timing">
        <SecondsField
          decrementLabel={text('reachDeck.editor.animation.decreaseStart', '提前 0.1 秒')}
          disabled={disabled}
          incrementLabel={text('reachDeck.editor.animation.increaseStart', '推后 0.1 秒')}
          inputLabel={text('reachDeck.editor.timeline.animationStart', '动画开始时间')}
          label={text('reachDeck.common.start', '开始')}
          min={0}
          onChange={(start) => onChange({ start })}
          unit={text('reachDeck.editor.animation.secondsUnit', '秒')}
          value={animation.start}
        />
        <SecondsField
          decrementLabel={text('reachDeck.editor.animation.decreaseDuration', '缩短 0.1 秒')}
          disabled={disabled}
          incrementLabel={text('reachDeck.editor.animation.increaseDuration', '延长 0.1 秒')}
          inputLabel={text('reachDeck.editor.timeline.animationDuration', '动画时长')}
          label={text('reachDeck.editor.timeline.duration', '时长')}
          min={0.1}
          onChange={(duration) => onChange({ duration })}
          unit={text('reachDeck.editor.animation.secondsUnit', '秒')}
          value={animation.duration}
        />
      </div>
    </div>
  );
}

const roundTenth = (value: number) => Math.round(value * 10) / 10;

/** 0.1 秒步进的秒数输入：减号 / 数值 / 单位 / 加号一体，输入中途的草稿不回写。 */
function SecondsField({
  decrementLabel,
  disabled,
  incrementLabel,
  inputLabel,
  label,
  min,
  onChange,
  unit,
  value,
}: {
  decrementLabel: string;
  disabled: boolean;
  incrementLabel: string;
  inputLabel: string;
  label: string;
  min: number;
  onChange: (value: number) => void;
  unit: string;
  value: number;
}) {
  const [draft, setDraft] = useState<string>();
  const shown = roundTenth(value).toFixed(1);
  useEffect(() => setDraft(undefined), [shown]);
  const commit = (next: number) => {
    if (!Number.isFinite(next)) return;
    const clamped = Math.max(min, roundTenth(next));
    if (clamped !== roundTenth(value)) onChange(clamped);
  };
  return (
    <div className="reach-deck-editor__animation-field">
      <span aria-hidden>{label}</span>
      <div className="reach-deck-editor__seconds-field" data-disabled={disabled || undefined}>
        <button
          aria-label={decrementLabel}
          disabled={disabled || roundTenth(value) <= min}
          onClick={() => commit(value - 0.1)}
          type="button"
        >
          <Minus aria-hidden size={12} />
        </button>
        <input
          aria-label={inputLabel}
          disabled={disabled}
          inputMode="decimal"
          onBlur={() => {
            if (draft !== undefined && draft !== '') commit(Number(draft));
            setDraft(undefined);
          }}
          // 输入过程只改草稿，失焦或回车再提交，避免“1.”这类中间态被格式化打断。
          onChange={(event) => setDraft(event.target.value.replace(/[^0-9.]/gu, ''))}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              commit(value + (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 1 : 0.1));
            } else if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
          type="text"
          value={draft ?? shown}
        />
        <span aria-hidden className="reach-deck-editor__seconds-unit">
          {unit}
        </span>
        <button
          aria-label={incrementLabel}
          disabled={disabled}
          onClick={() => commit(value + 0.1)}
          type="button"
        >
          <Plus aria-hidden size={12} />
        </button>
      </div>
    </div>
  );
}
