/**
 * 纯文本讲稿的分块规划：把整页讲稿切成若干可独立合成与对齐的小块。
 *
 * 数据源：无 PG/Mongo 读写；输入为内存中的整页讲稿文本（`joinNarrationSegments`
 * 的拼接串）。
 *
 * 核心逻辑：
 * <ol>
 *   <li>按句末标点切成句子片段，超限的句子退到次级标点，仍超限的按码点硬切</li>
 *   <li>贪心装箱到 {@link REACH_DECK_SSML_MAX_CHARACTERS}，与 SSML 路径共用同一个
 *       块长上限，保证两条路径的单次上游耗时落在同一量级</li>
 *   <li>短于 {@link REACH_DECK_PLAIN_SPEECH_MIN_CHARACTERS} 的块并入相邻块</li>
 *   <li>收尾断言拼接不变量，任一字符丢失都立即失败而不是产出错位的时间轴</li>
 * </ol>
 *
 * 设计动机：火山方舟字幕对齐的耗时与讲稿字数强相关（实测 147 字约 70 秒、367 字约
 * 255 秒），整页一次对齐在 350 字以上会贴近甚至越过上游超时。SSML 路径早已按 150
 * 字符分块规避，但没有讲稿标记的页此前整页一发——本模块补上这条路径的分块能力。
 *
 * 放在 ai-runtime 而不是 reach-deck-dsl：纯文本分块不涉及 speech unit、alignment
 * map、公式原子性等任何 DSL 语义，消费方只有 worker，放进 DSL 包会让那里出现第二
 * 套语义不同的分块器。
 */

import {
  REACH_DECK_SSML_MAX_CHARACTERS,
  unescapeReachDeckNarrationPlainText,
} from '@reachany/reach-deck-dsl';

/**
 * 块长下限（码点）。
 *
 * 过短的块对齐质量明显更差，且合成音频首尾的静音在总时长里占比过高——时间戳偏移
 * 按各块音频真实时长累加，静音占比失衡会让块边界处的字幕系统性偏移。
 */
export const REACH_DECK_PLAIN_SPEECH_MIN_CHARACTERS = 40;

/**
 * 破句阈值（码点）：只有超过这个长度的句子才会被退到次级标点、乃至硬切。
 *
 * 与打包上限分开是刻意的。打包上限（150）是「多个句子攒成一块」的目标值，越小并发
 * 越充分；破句阈值是「一个句子必须被拆开」的红线，越大越不容易破坏语句完整性。实测
 * 教学讲稿单句普遍 20-80 字，200 这条线基本不会被触到。
 *
 * 不再往上放是有实测依据的：对齐耗时与字数严格线性，约 0.435 秒/字（57/80/132/200/
 * 278 字五个样本一致），但供应方存在尾部放大——事故那页 378 字实测 526 秒，是线性
 * 模型的 3.2 倍。按 2.5 倍尾部估：200 字约 218 秒尚在 300 秒上游超时之内，250 字就
 * 到 272 秒、300 字到 326 秒已然越线。按中位数选阈值正是酿成事故的那类错误。
 */
export const REACH_DECK_PLAIN_SPEECH_SPLIT_LIMIT = 200;

/**
 * 一块纯文本讲稿：`text` 是讲稿 Markdown 原文片段；`alignmentTranscript` 是送 TTS 与
 * 字幕对齐的朗读文本，只比原文少了 `\-`、`\>` 这类转义的反斜杠——反斜杠读不出来，
 * 留在对齐原文里只会白白占掉 model-service 的不匹配额度。
 */
export interface ReachDeckPlainSpeechChunkV1 {
  index: number;
  text: string;
  alignmentTranscript: string;
}

/** 句末标点：优先在这些字符之后断块。英文句号另按上下文判断（见 {@link isEnglishFullStop}）。 */
const SENTENCE_BREAKS = new Set(['。', '！', '？', '；', '…', '!', '?', ';']);

/** 次级标点：句子本身超限时的退路。 */
const CLAUSE_BREAKS = new Set(['，', '、', '：', ',', ':']);

/** 句号后不断句的常见英文缩写（小写比较）；单个字母的缩写（U.S.、e.g.）另行排除。 */
const ENGLISH_ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'st',
  'jr',
  'sr',
  'vs',
  'no',
]);

/** 英文句号后可以紧跟、仍属于同一句收尾的右引号与右括号。 */
const SENTENCE_CLOSERS = new Set(['”', '’', '"', "'", ')', '）', ']']);

/**
 * 英文句号是否是句末：后面是空白、汉字或文本结尾（中间可隔右引号、右括号），前面紧挨字母、
 * 数字或右引号，且不是单字母或常见缩写。中文讲稿常在英文句号后直接接汉字（May.这里…），
 * 那也是句末；后面紧跟拉丁字母、数字或另一个点（2.5、e.g、省略号）则不是。
 *
 * 不把 `.` 直接放进 {@link SENTENCE_BREAKS}：小数（2.5）、省略号与缩写里的点不是句末。
 * 漏掉英文句号的代价是英文长段落整段被当成一个超长句，只能退到逗号处切开分别合成，
 * 句子中间出现语调重置与停顿（「…Florence Nightingale,」‖「a famous nurse.」）。
 */
function isEnglishFullStop(characters: readonly string[], index: number): boolean {
  if (characters[index] !== '.') return false;
  let next = index + 1;
  while (next < characters.length && SENTENCE_CLOSERS.has(characters[next]!)) next += 1;
  if (next < characters.length && !/[\s\p{Script=Han}]/u.test(characters[next]!)) return false;
  const previous = characters[index - 1];
  if (previous === undefined || !/[\p{Script=Latin}\p{Nd}”’"')）\]]/u.test(previous)) return false;
  let start = index;
  while (start > 0 && /\p{Script=Latin}/u.test(characters[start - 1]!)) start -= 1;
  const word = characters.slice(start, index).join('').toLowerCase();
  return word.length !== 1 && !ENGLISH_ABBREVIATIONS.has(word);
}

const isSentenceBreak = (characters: readonly string[], index: number): boolean =>
  SENTENCE_BREAKS.has(characters[index]!) || isEnglishFullStop(characters, index);

const isClauseBreak = (characters: readonly string[], index: number): boolean =>
  CLAUSE_BREAKS.has(characters[index]!);

/**
 * 允许跟随断点一起留在前一块的收尾字符。
 *
 * 右引号、右括号与空白若被切到下一块开头，会让那一块以孤立标点起头——上游对齐对
 * 这种开头容易吐出畸形条目。
 */
const TRAILING_CHARACTERS = new Set([
  '”',
  '’',
  '"',
  "'",
  '）',
  ')',
  '》',
  '」',
  '』',
  '】',
  '〕',
  '］',
  ' ',
  '\t',
  '\n',
  '\r',
]);

/**
 * 规划纯文本讲稿的分块。
 *
 * **拼接不变量**：`chunks.map((chunk) => chunk.text).join('') === text`。分块不改写
 * 权威讲稿，保留原始 Markdown 区间、段分隔符与缓存身份；下游再将提供方时间戳
 * 对应回这些原文区间，不能用时间戳标签的字数代替原文位置。
 *
 * 文本为空或只有空白时返回空数组，由调用方决定如何处理。
 */
export function planReachDeckPlainSpeechChunks(
  text: string,
  maxCharacters: number = REACH_DECK_SSML_MAX_CHARACTERS,
): ReachDeckPlainSpeechChunkV1[] {
  assertChunkLimit(maxCharacters);
  if (text.length === 0 || text.trim().length === 0) return [];

  // 三级退让：句末标点 → 次级标点 → 硬切。后两级只对超过破句阈值的片段生效，
  // 正常教学讲稿的句子（实测 20-80 字）在第一级就切完了。
  const splitLimit = Math.max(maxCharacters, REACH_DECK_PLAIN_SPEECH_SPLIT_LIMIT);
  const sentences = splitAfterBreaks([text], isSentenceBreak, maxCharacters);
  const clauses = splitAfterBreaks(sentences, isClauseBreak, splitLimit);
  const pieces = splitByLength(clauses, splitLimit);
  const packed = pack(pieces, maxCharacters);
  const bounded = packed.flatMap((chunk) => splitByLength([chunk], splitLimit));

  const joined = bounded.join('');
  if (joined !== text) {
    throw new Error('Plain speech chunk planning did not preserve the narration text');
  }
  return bounded.map((chunk, index) => ({
    index,
    text: chunk,
    alignmentTranscript: unescapeReachDeckNarrationPlainText(chunk),
  }));
}

function assertChunkLimit(maxCharacters: number): void {
  if (
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters > REACH_DECK_SSML_MAX_CHARACTERS ||
    maxCharacters < REACH_DECK_PLAIN_SPEECH_MIN_CHARACTERS
  ) {
    throw new Error(
      `Plain speech chunk limit must be an integer between ${REACH_DECK_PLAIN_SPEECH_MIN_CHARACTERS} and ${REACH_DECK_SSML_MAX_CHARACTERS}.`,
    );
  }
}

/** 反斜杠转义对（`\x`）起点的码点下标；片段起点不会落在转义对中间。 */
function escapePairStarts(characters: readonly string[]): Set<number> {
  const starts = new Set<number>();
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] === '\\' && index + 1 < characters.length) {
      starts.add(index);
      index += 1;
    }
  }
  return starts;
}

/** 码点数组：按码点而非 UTF-16 码元切分，避免把代理对劈成两半。 */
function codePoints(value: string): string[] {
  return Array.from(value);
}

/**
 * 在指定断点字符之后切分，仅对超限的片段生效。
 *
 * 未超限的片段原样透传：句子边界本身就是最自然的块边界，没必要为了对齐块长把已经
 * 合适的片段打散。
 */
function splitAfterBreaks(
  pieces: readonly string[],
  isBreak: (characters: readonly string[], index: number) => boolean,
  maxCharacters: number,
): string[] {
  const result: string[] = [];
  for (const piece of pieces) {
    const characters = codePoints(piece);
    if (characters.length <= maxCharacters) {
      result.push(piece);
      continue;
    }
    let current = '';
    for (let index = 0; index < characters.length; index += 1) {
      current += characters[index];
      if (!isBreak(characters, index)) continue;
      while (index + 1 < characters.length && TRAILING_CHARACTERS.has(characters[index + 1]!)) {
        current += characters[index + 1];
        index += 1;
      }
      result.push(current);
      current = '';
    }
    if (current.length > 0) result.push(current);
  }
  return result;
}

/** 字母、数字与常见连写符号：切在这类连写中间会把一个词或一个数劈成两半。 */
const WORD_CHARACTERS = /[A-Za-z0-9_'’.\-]/;

/**
 * 最后的退路：既无句末也无次级标点可依时按长度硬切。
 *
 * 正常中文讲稿到不了这里——要触发它，得有一整段超过破句阈值且不含任何标点的文本，
 * 通常意味着公式、代码或链接之类的非讲稿内容。既然到了这一步就必须切，那至少不要
 * 切在字母数字连写的中间：往回找最近的非连写位置，找不到（整段都是连写）才原地切。
 * 往回找的窗口取块长的一成，避免为了躲一个长串把块切得过短。
 */
function splitByLength(pieces: readonly string[], maxCharacters: number): string[] {
  const window = Math.max(1, Math.floor(maxCharacters / 10));
  const result: string[] = [];
  for (const piece of pieces) {
    const characters = codePoints(piece);
    if (characters.length <= maxCharacters) {
      result.push(piece);
      continue;
    }
    const escapeStarts = escapePairStarts(characters);
    let index = 0;
    while (index < characters.length) {
      let end = Math.min(index + maxCharacters, characters.length);
      if (end < characters.length) {
        if (characters.length - end < REACH_DECK_PLAIN_SPEECH_MIN_CHARACTERS) {
          end = characters.length - REACH_DECK_PLAIN_SPEECH_MIN_CHARACTERS;
        }
        let retreat = end;
        while (
          retreat > index + maxCharacters - window &&
          WORD_CHARACTERS.test(characters[retreat - 1]!) &&
          WORD_CHARACTERS.test(characters[retreat]!)
        ) {
          retreat -= 1;
        }
        if (retreat > index) end = retreat;
        // 不把 `\-` 这类转义对切开：前一块会留下孤立的反斜杠，朗读文本就去不掉它。
        if (escapeStarts.has(end - 1) && end - 1 > index) end -= 1;
      }
      result.push(characters.slice(index, end).join(''));
      index = end;
    }
  }
  return result;
}

/**
 * 贪心装箱，并保证没有过短的块。
 *
 * 核心逻辑：
 * <ol>
 *   <li>逐片段装箱；当前块已达下限且再装会超上限时封箱</li>
 *   <li>尾块短于下限时向前一块借片段，借到达标为止——直接把尾块并回前一块会让一页
 *       一百多字的讲稿退化成单块，白白丢掉并发</li>
 *   <li>借不动（前一块会跌破下限，或借过来会超上限）时才整块并回去</li>
 * </ol>
 *
 * 上限是打包目标（150 字符），下限关乎对齐质量。合并后超过破句阈值的块由调用方
 * 再次硬切，保证不会越过 Java 对齐器的 200 码点上限。
 */
function pack(pieces: readonly string[], maxCharacters: number): string[] {
  const size = (parts: readonly string[]): number => codePoints(parts.join('')).length;
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const piece of pieces) {
    if (current.length === 0) {
      current.push(piece);
      continue;
    }
    const overflows = size(current) + codePoints(piece).length > maxCharacters;
    if (overflows && size(current) >= REACH_DECK_PLAIN_SPEECH_MIN_CHARACTERS) {
      chunks.push(current);
      current = [piece];
      continue;
    }
    current.push(piece);
  }
  if (current.length > 0) chunks.push(current);

  const tail = chunks.at(-1);
  const previous = chunks.at(-2);
  if (tail !== undefined && previous !== undefined) {
    while (size(tail) < REACH_DECK_PLAIN_SPEECH_MIN_CHARACTERS) {
      const borrowed = previous.at(-1);
      if (
        borrowed === undefined ||
        previous.length <= 1 ||
        size(previous) - codePoints(borrowed).length < REACH_DECK_PLAIN_SPEECH_MIN_CHARACTERS ||
        size(tail) + codePoints(borrowed).length > maxCharacters
      ) {
        break;
      }
      previous.pop();
      tail.unshift(borrowed);
    }
    if (size(tail) < REACH_DECK_PLAIN_SPEECH_MIN_CHARACTERS) {
      chunks.pop();
      previous.push(...tail);
    }
  }
  return chunks.map((parts) => parts.join(''));
}
