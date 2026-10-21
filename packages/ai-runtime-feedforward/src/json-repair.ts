/**
 * LLM JSON 输出多层容错解析。
 *
 * 即便请求侧已声明 json_schema 强约束，provider 仍可能返回带 Markdown 围栏、
 * 推理前缀、非法转义（LaTeX 命令）、截断或未转义引号的"准 JSON"。本模块按
 * 代价从低到高依次尝试多种抽取与修复策略，尽量把文本抢救为可解析的 JSON，
 * 修复后的值仍必须通过下游 schema 权威校验，本层不改变语义正确性的判定。
 *
 * 策略链复制改造自 services/ai-runtime/lib/reach-deck/json-repair.ts（同源 OpenMAIC，MIT）。
 */

import { jsonrepair } from 'jsonrepair';

/** JSON 抽取来源：exact 表示整段原文直接可解析（未发生任何修复）。 */
export type FeedforwardJsonExtraction =
  | 'exact'
  | 'reasoning-strip'
  | 'code-block'
  | 'bracket-scan'
  | 'raw';

/** 修复层级：plain 表示抽取出的候选串未经修复即可解析。 */
export type FeedforwardJsonFixLevel = 'plain' | 'manual-fix' | 'jsonrepair' | 'control-chars';

export interface FeedforwardJsonRepairOutcome {
  value: unknown;
  /** 形如 `code-block/jsonrepair` 的策略标签，便于日志与统计聚合。 */
  strategy: string;
  /** 是否动用了任何抽取/修复手段（`exact/plain` 之外都算）。 */
  repaired: boolean;
}

/**
 * 解析 LLM 返回的 JSON 文本，失败时逐层降级修复；全部策略失败返回 null。
 */
export function parseJsonWithRepair(raw: string): FeedforwardJsonRepairOutcome | null {
  const trimmed = raw.trim();

  const exact = tryPlainParse(trimmed);
  if (exact !== undefined) {
    return { value: exact, strategy: 'exact/plain', repaired: false };
  }

  const stripped = stripReasoningPrefix(trimmed);
  if (stripped !== trimmed) {
    const fromStripped = parseCandidateText(stripped, 'reasoning-strip');
    if (fromStripped !== null) return fromStripped;
  }

  return parseCandidateText(trimmed, undefined);
}

/**
 * 对一段候选文本依次尝试：代码块抽取 → 括号深度扫描截取 → 整段修复解析。
 * baseExtraction 用于在推理前缀剥离后保留来源标签。
 */
function parseCandidateText(
  text: string,
  baseExtraction: FeedforwardJsonExtraction | undefined,
): FeedforwardJsonRepairOutcome | null {
  for (const block of extractCodeBlocks(text)) {
    const parsed = tryParseWithFixes(block);
    if (parsed !== null) {
      return outcome(parsed, baseExtraction ?? 'code-block');
    }
  }

  const scanned = extractByBracketScan(text);
  if (scanned !== undefined) {
    const parsed = tryParseWithFixes(scanned);
    if (parsed !== null) {
      return outcome(parsed, baseExtraction ?? 'bracket-scan');
    }
  }

  const whole = tryParseWithFixes(text);
  if (whole !== null) {
    return outcome(whole, baseExtraction ?? 'raw');
  }
  return null;
}

function outcome(
  parsed: { value: unknown; fixLevel: FeedforwardJsonFixLevel },
  extraction: FeedforwardJsonExtraction,
): FeedforwardJsonRepairOutcome {
  return {
    value: parsed.value,
    strategy: extraction + '/' + parsed.fixLevel,
    repaired: true,
  };
}

/** 剥离 reasoning 模型泄漏的思考前缀（截取最后一个闭合思考标签之后的文本）。 */
function stripReasoningPrefix(text: string): string {
  const matches = [...text.matchAll(/<\/(?:think|thinking|reasoning)>\s*/gi)];
  const last = matches.at(-1);
  if (last?.index === undefined) return text;
  return text.slice(last.index + last[0].length).trim();
}

/** 抽取所有 Markdown 代码块中疑似 JSON 的内容（以 { 或 [ 开头）。 */
function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const inner = match[1].trim();
    if (inner.startsWith('{') || inner.startsWith('[')) blocks.push(inner);
  }
  return blocks;
}

/**
 * 从首个 { 或 [ 起做括号深度扫描（跳过字符串字面量），截取首个完整的
 * JSON 结构子串；未闭合时返回 undefined。
 */
function extractByBracketScan(text: string): string | undefined {
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  if (objectStart === -1 && arrayStart === -1) return undefined;
  const start =
    objectStart === -1
      ? arrayStart
      : arrayStart === -1
        ? objectStart
        : Math.min(objectStart, arrayStart);

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/** 逐层尝试：原样解析 → 手工修复 → jsonrepair → 控制字符清洗。 */
function tryParseWithFixes(
  jsonText: string,
): { value: unknown; fixLevel: FeedforwardJsonFixLevel } | null {
  const plain = tryPlainParse(jsonText);
  if (plain !== undefined) return { value: plain, fixLevel: 'plain' };

  const manuallyFixed = tryPlainParse(applyManualFixes(jsonText));
  if (manuallyFixed !== undefined) return { value: manuallyFixed, fixLevel: 'manual-fix' };

  try {
    const repaired: unknown = JSON.parse(jsonrepair(jsonText));
    return { value: repaired, fixLevel: 'jsonrepair' };
  } catch {
    // 继续降级到控制字符清洗
  }

  const controlCleaned = tryPlainParse(escapeControlCharacters(jsonText));
  if (controlCleaned !== undefined) return { value: controlCleaned, fixLevel: 'control-chars' };
  return null;
}

/**
 * 手工修复 LLM 常见 JSON 错误：
 * 1. 被整体误引号化的属性片段（`"height: 76"` → `"height": 76`）；
 * 2. 字符串内未双重转义的 LaTeX 命令等非法反斜杠转义；
 * 3. 截断的数组/对象补闭合。
 */
function applyManualFixes(jsonText: string): string {
  let fixed = jsonText;

  fixed = fixed.replace(
    /([,{]\s*)"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(true|false|null|[+-]?\d+(?:\.\d+)?)"(?=\s*[,}])/g,
    (_match, prefix: string, key: string, value: string) => prefix + '"' + key + '": ' + value,
  );

  // 先整体匹配已成对的双反斜杠并原样保留，避免对同一处转义做二次加倍
  fixed = fixed.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (_match, content: string) => {
    const fixedContent = content.replace(
      /\\\\|\\([a-zA-Z])/g,
      (inner: string, ch: string | undefined) =>
        ch === undefined || 'bfnrtu'.includes(ch) ? inner : '\\\\' + ch,
    );
    return '"' + fixedContent + '"';
  });

  fixed = fixed.replace(/\\\\|\\([^"\\/bfnrtu\n\r])/g, (match: string, char: string | undefined) =>
    char !== undefined && /[a-zA-Z]/.test(char) ? '\\\\' + char : match,
  );

  const trimmed = fixed.trim();
  if (trimmed.startsWith('[') && !trimmed.endsWith(']')) {
    const lastCompleteObject = fixed.lastIndexOf('}');
    if (lastCompleteObject > 0) {
      fixed = fixed.slice(0, lastCompleteObject + 1) + ']';
    }
  } else if (trimmed.startsWith('{') && !trimmed.endsWith('}')) {
    const openBraces = (fixed.match(/{/g) ?? []).length;
    const closeBraces = (fixed.match(/}/g) ?? []).length;
    if (openBraces > closeBraces) {
      fixed += '}'.repeat(openBraces - closeBraces);
    }
  }
  return fixed;
}

/** 把裸控制字符转义或移除（常见于模型把换行原样放进字符串字面量）。 */
function escapeControlCharacters(jsonText: string): string {
  // eslint-disable-next-line no-control-regex
  return jsonText.replace(/[\x00-\x1F\x7F]/g, (char) => {
    switch (char) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        return '';
    }
  });
}

function tryPlainParse(jsonText: string): unknown {
  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    return undefined;
  }
}
