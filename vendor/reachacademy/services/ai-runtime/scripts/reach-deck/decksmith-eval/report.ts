import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { EvalSampleRecord } from './run-sample.js';
import type { EvalCallRecord } from './transport.js';

/**
 * 评测报告：按案例汇总成功率、失败类别、延迟分位、token 与估算费用，写 JSON + Markdown。
 *
 * 数据源：各样本记录（run-sample.ts）与费率表（rates.json 或 --rates 指定的文件）。
 * 核心逻辑：
 * 1. token 以出站调用解析出的 provider usage 为准（主模型 + 子调用 + 真实图片编辑），同时给出
 *    runDecksmith usage 事件之和（job-runner 记账口径）作为对照；
 * 2. 费用 = (输入 - 缓存命中) × 输入单价 + 缓存命中 × 缓存单价 + 输出 × 输出单价，按每百万 token；
 *    网关在响应头报告了费用时另列，不混入估算；
 * 3. 报告只落在 tmp/ 下，不提交。
 */

export interface EvalRate {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
}

export interface EvalRateTable {
  readonly currency: string;
  readonly unit: string;
  readonly note?: string;
  readonly models: Readonly<Record<string, EvalRate>>;
}

export async function loadEvalRates(file: string): Promise<EvalRateTable> {
  const table = JSON.parse(await readFile(file, 'utf8')) as EvalRateTable;
  if (typeof table.models !== 'object' || table.models === null) {
    throw new Error(`rate table ${file} has no models`);
  }
  return table;
}

interface TokenTotals {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  reasoningTokens: number;
  calls: number;
  estimatedCost: number;
  gatewayReportedCost: number;
}

export interface EvalCaseSummary {
  readonly caseId: string;
  readonly summary: string;
  readonly samples: number;
  readonly passed: number;
  readonly passRate: number;
  readonly failureCategories: Readonly<Record<string, number>>;
  readonly latencyMs: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly avgModelTurns: number;
  readonly avgToolErrors: number;
  readonly tokens: TokenTotals;
  readonly tokensPerRun: number;
  readonly costPerRun: number;
}

export interface EvalReport {
  readonly schemaVersion: 'decksmith-eval-report/v1';
  readonly layer: 2 | 3;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly model: string;
  readonly promptContract: string;
  readonly imageTools: 'stub' | 'real';
  readonly rates: EvalRateTable;
  readonly totals: TokenTotals & { samples: number; passed: number };
  readonly cases: readonly EvalCaseSummary[];
  readonly samples: readonly EvalSampleRecord[];
}

export function summarizeEval(input: {
  layer: 2 | 3;
  startedAt: Date;
  model: string;
  promptContract: string;
  imageTools: 'stub' | 'real';
  rates: EvalRateTable;
  cases: readonly { id: string; summary: string }[];
  samples: readonly EvalSampleRecord[];
}): EvalReport {
  const rateFor = (model: string): EvalRate | undefined =>
    input.rates.models[model] ?? input.rates.models.default;
  const caseSummaries = input.cases.map((evalCase) => {
    const samples = input.samples.filter((sample) => sample.caseId === evalCase.id);
    const passed = samples.filter((sample) => sample.passed).length;
    const failureCategories: Record<string, number> = {};
    for (const sample of samples) {
      for (const category of new Set(sample.failures.map((failure) => failure.category))) {
        failureCategories[category] = (failureCategories[category] ?? 0) + 1;
      }
    }
    const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
    const tokens = sumTokens(
      samples.flatMap((sample) => sample.calls),
      (call) => rateFor(call.kind === 'image-edit' ? 'image-edit' : input.model),
    );
    const runs = Math.max(samples.length, 1);
    return {
      caseId: evalCase.id,
      summary: evalCase.summary,
      samples: samples.length,
      passed,
      passRate: samples.length === 0 ? 0 : passed / samples.length,
      failureCategories,
      latencyMs: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: latencies.at(-1) ?? 0,
      },
      avgModelTurns: average(samples.map((sample) => sample.modelTurns)),
      avgToolErrors: average(samples.map((sample) => sample.toolErrors.length)),
      tokens,
      tokensPerRun: Math.round((tokens.promptTokens + tokens.completionTokens) / runs),
      costPerRun: tokens.estimatedCost / runs,
    };
  });
  const totals = caseSummaries.reduce(
    (sum, summary) => ({
      samples: sum.samples + summary.samples,
      passed: sum.passed + summary.passed,
      promptTokens: sum.promptTokens + summary.tokens.promptTokens,
      completionTokens: sum.completionTokens + summary.tokens.completionTokens,
      cachedPromptTokens: sum.cachedPromptTokens + summary.tokens.cachedPromptTokens,
      reasoningTokens: sum.reasoningTokens + summary.tokens.reasoningTokens,
      calls: sum.calls + summary.tokens.calls,
      estimatedCost: sum.estimatedCost + summary.tokens.estimatedCost,
      gatewayReportedCost: sum.gatewayReportedCost + summary.tokens.gatewayReportedCost,
    }),
    { samples: 0, passed: 0, ...emptyTotals() },
  );
  return {
    schemaVersion: 'decksmith-eval-report/v1',
    layer: input.layer,
    startedAt: input.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    model: input.model,
    promptContract: input.promptContract,
    imageTools: input.imageTools,
    rates: input.rates,
    totals,
    cases: caseSummaries,
    samples: input.samples,
  };
}

export async function writeEvalReport(directory: string, report: EvalReport): Promise<string[]> {
  await mkdir(directory, { recursive: true });
  const json = path.join(directory, 'report.json');
  const markdown = path.join(directory, 'report.md');
  await writeFile(json, JSON.stringify(report, null, 2) + '\n');
  await writeFile(markdown, renderMarkdown(report));
  return [json, markdown];
}

export function renderMarkdown(report: EvalReport): string {
  const money = (value: number) => `${value.toFixed(4)} ${report.rates.currency}`;
  const lines = [
    `# Decksmith 第${report.layer === 2 ? '②' : '③'}层评测报告`,
    '',
    `- 时间：${report.startedAt} → ${report.finishedAt}`,
    `- 模型：\`${report.model}\`；提示词合同：${report.promptContract}；图片工具：${report.imageTools === 'stub' ? '桩' : '真实'}`,
    `- 总计：${report.totals.passed}/${report.totals.samples} 通过；${report.totals.calls} 次模型调用；` +
      `输入 ${report.totals.promptTokens}（缓存 ${report.totals.cachedPromptTokens}）/ 输出 ${report.totals.completionTokens}` +
      `（推理 ${report.totals.reasoningTokens}）token；估算费用 ${money(report.totals.estimatedCost)}` +
      (report.totals.gatewayReportedCost > 0
        ? `；网关报告 ${money(report.totals.gatewayReportedCost)}`
        : ''),
    `- 费率（${report.rates.unit}）：${report.rates.note ?? ''}`,
    '',
    '| 案例 | 通过 | p50 / p95 延迟 | 平均主模型回合 | 每次运行 token | 每次运行费用 | 失败类别 |',
    '| ---- | ---- | -------------- | -------------- | -------------- | ------------ | -------- |',
    ...report.cases.map(
      (summary) =>
        `| ${summary.caseId} | ${summary.passed}/${summary.samples} | ${seconds(summary.latencyMs.p50)} / ${seconds(summary.latencyMs.p95)} | ` +
        `${summary.avgModelTurns.toFixed(1)} | ${summary.tokensPerRun} | ${money(summary.costPerRun)} | ` +
        `${
          Object.entries(summary.failureCategories)
            .map(([category, count]) => `${category}×${count}`)
            .join(', ') || '—'
        } |`,
    ),
    '',
    '## 样本明细',
    '',
  ];
  for (const sample of report.samples) {
    lines.push(
      `### ${sample.caseId} #${sample.sample} — ${sample.passed ? '通过' : '失败'}（${seconds(sample.latencyMs)}，${sample.modelTurns} 回合）`,
      '',
      `- 工具：${sample.toolSequence.join(' → ') || '（无）'}`,
      ...(sample.visionAttached > 0 ? [`- 视觉输入：附带 ${sample.visionAttached} 张图`] : []),
      ...sample.failures.map((failure) => `- **${failure.category}**：${failure.detail}`),
      ...sample.toolErrorDetails.map((detail) => `- 工具报错 \`${detail.tool}\`：${detail.result}`),
      ...(sample.error === undefined ? [] : [`- 错误：${sample.error}`]),
      ...(sample.assistantText === undefined
        ? []
        : [`- 答复：${sample.assistantText.replace(/\s+/g, ' ').slice(0, 300)}`]),
      '',
    );
  }
  return lines.join('\n');
}

function sumTokens(
  calls: readonly EvalCallRecord[],
  rateFor: (call: EvalCallRecord) => EvalRate | undefined,
): TokenTotals {
  const totals = emptyTotals();
  for (const call of calls) {
    if (call.gatewayCostUsd !== undefined) totals.gatewayReportedCost += call.gatewayCostUsd;
    if (call.usage === undefined) continue;
    totals.calls += 1;
    totals.promptTokens += call.usage.promptTokens;
    totals.completionTokens += call.usage.completionTokens;
    totals.cachedPromptTokens += call.usage.cachedPromptTokens;
    totals.reasoningTokens += call.usage.reasoningTokens;
    const rate = rateFor(call);
    if (rate !== undefined) {
      const cached = Math.min(call.usage.cachedPromptTokens, call.usage.promptTokens);
      totals.estimatedCost +=
        ((call.usage.promptTokens - cached) * rate.input +
          cached * rate.cachedInput +
          call.usage.completionTokens * rate.output) /
        1_000_000;
    }
  }
  return totals;
}

function emptyTotals(): TokenTotals {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    reasoningTokens: 0,
    calls: 0,
    estimatedCost: 0,
    gatewayReportedCost: 0,
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
