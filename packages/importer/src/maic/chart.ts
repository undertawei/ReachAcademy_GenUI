import type { ReachDeckColorV2 } from '@reachany/reach-deck-dsl';

import { maicColor, maicCssColor } from './style.js';
import type { MaicDiagnostic, MaicDiagnosticLocation } from './types.js';

interface MaicLineChartData {
  categories: string[];
  series: Array<{ name: string; values: Array<number | null>; color?: ReachDeckColorV2 }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Only map the verified MAIC categorical line contract; never guess other chart encodings. */
export function readMaicLineChart(
  source: Readonly<Record<string, unknown>>,
  location: MaicDiagnosticLocation,
  diagnostics: MaicDiagnostic[],
): MaicLineChartData | undefined {
  const report = (code: string, severity: 'warning' | 'error', field: string, message: string) =>
    diagnostics.push({
      code: `maic.chart.${code}`,
      severity,
      feature: 'chart',
      message,
      location: { ...location, field },
    });
  if (source.chartType !== 'line') {
    report(
      'type_unsupported',
      'error',
      'chartType',
      'Only MAIC line charts can currently be imported as native charts.',
    );
    return undefined;
  }
  const data = source.data;
  if (!isRecord(data)) {
    report(
      'data_invalid',
      'error',
      'data',
      'MAIC chart data must contain labels, legends, and series.',
    );
    return undefined;
  }
  if (
    !Array.isArray(data.labels) ||
    data.labels.length === 0 ||
    !data.labels.every((value) => typeof value === 'string')
  ) {
    report(
      'data_invalid',
      'error',
      'data.labels',
      'MAIC chart labels must be a non-empty array of strings.',
    );
    return undefined;
  }
  if (!Array.isArray(data.series) || data.series.length === 0) {
    report('data_invalid', 'error', 'data.series', 'MAIC chart series must be a non-empty array.');
    return undefined;
  }
  if (
    !Array.isArray(data.legends) ||
    data.legends.length !== data.series.length ||
    !data.legends.every((value) => typeof value === 'string' && value.trim().length > 0)
  ) {
    report(
      'data_invalid',
      'error',
      'data.legends',
      'MAIC chart legends must contain one non-empty series name per data series.',
    );
    return undefined;
  }
  const series: MaicLineChartData['series'] = [];
  for (const [index, values] of data.series.entries()) {
    if (!Array.isArray(values) || values.length !== data.labels.length) {
      report(
        'data_invalid',
        'error',
        `data.series[${index}]`,
        'Each MAIC chart series must align exactly with its category labels.',
      );
      return undefined;
    }
    const invalid = values.findIndex(
      (value) => value !== null && (typeof value !== 'number' || !Number.isFinite(value)),
    );
    if (invalid !== -1) {
      report(
        'data_invalid',
        'error',
        `data.series[${index}][${invalid}]`,
        'MAIC chart values must be finite numbers or null.',
      );
      return undefined;
    }
    series.push({ name: data.legends[index] as string, values: [...values] });
  }
  if (source.themeColors !== undefined) {
    if (!Array.isArray(source.themeColors) || source.themeColors.length === 0) {
      report(
        'color_unsupported',
        'warning',
        'themeColors',
        'Malformed MAIC chart palette uses native default series colors.',
      );
    } else {
      const colors = source.themeColors.map((value, index) => {
        if (maicCssColor(value) !== undefined) return maicColor(value);
        report(
          'color_unsupported',
          'warning',
          `themeColors[${index}]`,
          'Unsupported MAIC chart color uses the native default series color.',
        );
        return undefined;
      });
      for (const [index, entry] of series.entries()) {
        const color = colors[index % colors.length];
        if (color !== undefined) entry.color = color;
      }
    }
  }
  if (source.options !== undefined) {
    if (!isRecord(source.options)) {
      report(
        'option_unsupported',
        'warning',
        'options',
        'Malformed MAIC chart options use native chart defaults.',
      );
    } else {
      for (const [key, value] of Object.entries(source.options)) {
        if (key === 'lineSmooth' && value === false) continue;
        report(
          'option_unsupported',
          'warning',
          `options.${key}`,
          key === 'lineSmooth'
            ? 'Smooth MAIC chart lines are displayed as straight segments; categories and values are preserved.'
            : `MAIC chart option ${key} is not supported; native chart defaults are used.`,
        );
      }
    }
  }
  const supported = new Set([
    'id',
    'type',
    'left',
    'top',
    'width',
    'height',
    'rotate',
    'flipH',
    'flipV',
    'opacity',
    'chartType',
    'data',
    'themeColors',
    'options',
  ]);
  for (const key of Object.keys(source)) {
    if (!supported.has(key))
      report(
        'option_unsupported',
        'warning',
        key,
        `MAIC chart property ${key} is not supported; native chart defaults are used.`,
      );
  }
  for (const key of Object.keys(data)) {
    if (!['labels', 'legends', 'series'].includes(key))
      report(
        'option_unsupported',
        'warning',
        `data.${key}`,
        `MAIC chart data property ${key} is not supported.`,
      );
  }
  return { categories: [...data.labels], series };
}
