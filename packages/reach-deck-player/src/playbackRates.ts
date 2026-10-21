/** 讲稿倍速档位：幻灯片时间轴与 GenUI 讲稿条共用。 */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

/** 自定义倍速的取值范围与步长；服务端与学生端事件校验、覆盖率封顶都按这一口径。 */
export const MIN_PLAYBACK_RATE = 0.5;
export const MAX_PLAYBACK_RATE = 10;
export const PLAYBACK_RATE_STEP = 0.05;

/** 下拉里「自定义…」项的值；选中它时不改倍速，而是打开自定义气泡。 */
export const CUSTOM_PLAYBACK_RATE_VALUE = 'custom';

/** 档位超过分段控件的 5 项上限，用共享 Select（规范 03 §3.5）。 */
export const PLAYBACK_RATE_OPTIONS = PLAYBACK_RATES.map((rate) => ({
  label: formatPlaybackRate(rate),
  value: String(rate),
}));

export function formatPlaybackRate(rate: number): string {
  return `${rate}x`;
}

/** 合法倍速：在 [0.5, 10] 内且是 0.05 的整数倍（预设档位都满足）。 */
export function isPlaybackRate(value: number): boolean {
  if (!Number.isFinite(value) || value < MIN_PLAYBACK_RATE || value > MAX_PLAYBACK_RATE) {
    return false;
  }
  const steps = value / PLAYBACK_RATE_STEP;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

/** 把任意输入夹到合法范围并取到最近的 0.05 档；非有限数返回 undefined。 */
export function normalizePlaybackRate(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const clamped = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, value));
  return Number((Math.round(clamped / PLAYBACK_RATE_STEP) * PLAYBACK_RATE_STEP).toFixed(2));
}

/** 下拉选项：预设档位，当前是自定义倍速时按大小插入它，末尾一项「自定义…」。 */
export function playbackRateOptions(value: number, customLabel: string) {
  const options = [...PLAYBACK_RATE_OPTIONS];
  if (isPlaybackRate(value) && !options.some((option) => Number(option.value) === value)) {
    const index = options.findIndex((option) => Number(option.value) > value);
    options.splice(index === -1 ? options.length : index, 0, {
      label: formatPlaybackRate(value),
      value: String(value),
    });
  }
  return [...options, { label: customLabel, value: CUSTOM_PLAYBACK_RATE_VALUE }];
}
