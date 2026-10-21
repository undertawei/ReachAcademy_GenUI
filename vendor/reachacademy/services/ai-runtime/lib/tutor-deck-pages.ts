import { isRichTextDocumentShape, richTextToPlainText } from '@reachany/reach-deck-dsl';
import { Type } from 'typebox';

import type { RunRecord } from './contracts.js';
import { domainGet, studentApiUrl } from './domain-client.js';
import { isRuntimeMockMode, type RuntimeEnv } from './env.js';
import {
  contextMismatch,
  contextRecord,
  optionalRecord,
  requireContextIdentity,
  type RuntimeTool,
} from './tutor-tool-support.js';

/** 单页摘要中各段文本的字符上限：页面可见文字、讲稿、测验题面与解析分别截断。 */
const PAGE_TEXT_LIMIT = 2_500;
const PAGE_NARRATION_LIMIT = 2_500;
const PAGE_QUIZ_LIMIT = 3_000;
const MAX_PREVIOUS_PAGES = 3;
const MAX_SEARCH_RESULTS = 3;
const MAX_SEARCH_TERMS = 8;
/** 当前页随提示词附带的图片上限与最小边长（舞台坐标）；更小的元素多为图标或装饰。 */
const MAX_PAGE_IMAGES = 4;
const MIN_IMAGE_EDGE = 80;

export const TUTOR_DECK_PAGE_TOOL_NAMES = [
  'content.get_previous_pages',
  'content.search_previous_pages',
] as const;

/** Tutor 可读的单页纯文本摘要：去掉原生幻灯片的几何、样式与嵌入文档，只保留教学内容。 */
export interface TutorPageDigest {
  pageNumber?: number;
  pageId: string;
  sceneType: string;
  title: string;
  text?: string;
  narration?: string;
  quiz?: string;
  truncated?: true;
}

/** 页面中可随提示词附带的图片：label 与摘要文字中的占位符一致，resourceId 指向文档媒体资源。 */
export interface TutorPageImageRef {
  label: string;
  resourceId: string;
  alt: string;
}

/** 当前页图片的已发布媒体引用，由服务端再解析得到，只用于换签下载，不进入提示词。 */
export interface TutorPageMediaRef extends TutorPageImageRef {
  objectKey: string;
}

interface LearnerDeckPages {
  pages: TutorPageDigest[];
  currentIndex: number;
}

/**
 * 把 verifiedContext 中的 currentPage / currentSlide 原始 JSON 替换为纯文本摘要。
 *
 * 原生幻灯片逐段携带完整样式与几何，常超过提示词上限而被截断成 JSON 前缀，模型因此只能
 * 再调工具重读同一页；摘要保证当前页的文字、讲稿和题目完整进入首轮提示词。
 */
export function compactTutorPageContext(context: Record<string, unknown>): Record<string, unknown> {
  const currentPage = optionalRecord(context.currentPage);
  if (!currentPage) return context;
  const { currentSlide, currentPageMedia: _media, ...rest } = context;
  return {
    ...rest,
    currentPage: tutorPageDigest(currentPage, optionalRecord(currentSlide)),
  };
}

/**
 * 学生 Reach Deck Run 的「前几页」与「检索之前页面」工具，替代整份课件返回的 content.get_module。
 *
 * 数据源：student-service `/my/track-modules/{selectionId}/reach-deck-content/read-only`（学生可见的已发布课件）。
 * 必须用只读接口：学习端的 `reach-deck-content` 会创建或续用 attempt 并锁 selection/attempt 行，
 * 与学生本人的学习事件写入互相死锁（#602）。
 * 核心逻辑：
 * 1. 按 Run 的 selectionId 读取课件，并校验 selectionId / moduleVersionId 与授权范围一致；
 * 2. 按 order 排序页面，用 learningContext.pageId 定位当前页；
 * 3. 只暴露当前页之前的页面，并逐页投影为有上限的纯文本摘要；
 * 4. get_previous_pages 返回紧邻当前页的前 n 页，search_previous_pages 按关键词命中数返回最相关的页。
 */
export function createTutorDeckPageTools(run: RunRecord, env: RuntimeEnv): RuntimeTool[] {
  const learningContext = run.input.learningContext;
  if (
    learningContext?.schemaVersion !== 'reach-deck-tutor-context/v1' &&
    learningContext?.schemaVersion !== 'reach-deck-learning-fence-context/v1'
  ) {
    return [];
  }
  const currentPageId = learningContext.pageId;
  const load = (signal: AbortSignal) => loadLearnerDeckPages(run, currentPageId, env, signal);
  return [
    {
      name: 'content.get_previous_pages',
      label: '读取前几页内容',
      description:
        'Read plain-text digests of the pages immediately before the current page: pages ' +
        '(current - count) through (current - 1), in reading order. The current page is already ' +
        'in your context; use this only when the learner refers to what was taught just before. ' +
        'Images on earlier pages appear only as [image N] placeholders with their alt text.',
      parameters: Type.Object(
        {
          count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PREVIOUS_PAGES })),
        },
        { additionalProperties: false },
      ),
      timeoutMs: 10_000,
      outputBytes: 32_000,
      execute: async (input, signal) => {
        const count = boundedInteger(input.count, 2, MAX_PREVIOUS_PAGES);
        const { pages, currentIndex } = await load(signal);
        return {
          currentPageNumber: currentIndex + 1,
          totalPages: pages.length,
          pages: pages.slice(Math.max(0, currentIndex - count), currentIndex),
        };
      },
    },
    {
      name: 'content.search_previous_pages',
      label: '检索之前页面',
      description:
        'Search pages before the current page by keywords and return the best-matching page ' +
        'digests. Pass a few short keywords separated by spaces (for example "朱自清 生平"), ' +
        'not a full sentence.',
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 200 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
        },
        { additionalProperties: false },
      ),
      timeoutMs: 10_000,
      outputBytes: 32_000,
      execute: async (input, signal) => {
        const terms = searchTerms(input.query);
        if (terms.length === 0) throw new Error('query must contain at least one keyword');
        const limit = boundedInteger(input.limit, 2, MAX_SEARCH_RESULTS);
        const { pages, currentIndex } = await load(signal);
        const searched = pages.slice(0, currentIndex);
        const matches = searched
          .map((page) => ({ page, ...scorePage(page, terms) }))
          .filter((match) => match.score > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, limit);
        return {
          query: terms.join(' '),
          searchedPageCount: searched.length,
          matches: matches.map(({ page, matchedTerms }) => ({ matchedTerms, ...page })),
        };
      },
    },
  ];
}

async function loadLearnerDeckPages(
  run: RunRecord,
  currentPageId: string,
  env: RuntimeEnv,
  signal: AbortSignal,
): Promise<LearnerDeckPages> {
  if (isRuntimeMockMode(env)) return mockDeckPages(currentPageId);
  const selectionId = run.domainScope.selectionId;
  const moduleVersionId = run.domainScope.moduleVersionId;
  if (!selectionId || !moduleVersionId) {
    throw contextMismatch('Tutor Run is missing selection or module version scope');
  }
  const value = await domainGet(
    studentApiUrl(
      `/my/track-modules/${encodeURIComponent(selectionId)}/reach-deck-content/read-only`,
      env,
    ),
    run,
    { env, signal },
  );
  const content = contextRecord(value, 'Reach Deck learner content');
  requireContextIdentity(content, 'selectionId', selectionId);
  requireContextIdentity(content, 'moduleVersionId', moduleVersionId);
  const document = contextRecord(content.content, 'Reach Deck learner document');
  if (!Array.isArray(document.pages)) {
    throw contextMismatch('Reach Deck learner document has no pages');
  }
  const slides = new Map<string, Record<string, unknown>>();
  for (const candidate of Array.isArray(document.nativeSlides) ? document.nativeSlides : []) {
    const binding = optionalRecord(candidate);
    const slide = optionalRecord(binding?.slide);
    if (typeof binding?.pageId === 'string' && slide) slides.set(binding.pageId, slide);
  }
  const ordered = document.pages
    .map((candidate) => optionalRecord(candidate))
    .filter((page): page is Record<string, unknown> => page !== undefined)
    .sort((left, right) => numberOr(left.order, 0) - numberOr(right.order, 0));
  const pages = ordered.map((page, index) => ({
    pageNumber: index + 1,
    ...tutorPageDigest(page, slides.get(String(page.pageId))),
  }));
  const currentIndex = pages.findIndex((page) => page.pageId === currentPageId);
  if (currentIndex < 0) throw contextMismatch('Reach Deck current page is not in the document');
  return { pages, currentIndex };
}

/**
 * 单页投影：slide 取原生元素文字（含图表数据）与讲稿；quiz 取题面、选项、候选项、答案与解析，
 * 并保留题目 / 填空 id；interactive 取可见文字与旁白。
 */
export function tutorPageDigest(
  page: Record<string, unknown>,
  slide?: Record<string, unknown>,
): TutorPageDigest {
  const sceneType = typeof page.sceneType === 'string' ? page.sceneType : 'unknown';
  const scene = optionalRecord(page.scene);
  let text = '';
  let narration = '';
  let quiz = '';
  if (slide) {
    text = slideContent(slide).text;
    narration = stringOr(optionalRecord(slide.narration)?.markdown);
  }
  if (sceneType === 'quiz' && scene) {
    quiz = quizText(optionalRecord(scene.content)?.questions);
  }
  if (sceneType === 'interactive' && scene) {
    text = htmlVisibleText(stringOr(scene.documentHtml));
    narration = stringOr(optionalRecord(scene.narration)?.text);
  }
  const bounded = [
    clip(text, PAGE_TEXT_LIMIT),
    clip(narration, PAGE_NARRATION_LIMIT),
    clip(quiz, PAGE_QUIZ_LIMIT),
  ] as const;
  const truncated = bounded.some((part) => part.truncated);
  return {
    pageId: String(page.pageId ?? ''),
    sceneType,
    title: stringOr(page.title) || stringOr(slide?.title) || stringOr(scene?.title),
    ...(bounded[0].value ? { text: bounded[0].value } : {}),
    ...(bounded[1].value ? { narration: bounded[1].value } : {}),
    ...(bounded[2].value ? { quiz: bounded[2].value } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/**
 * 解析当前页图片对应的已发布媒体资源。
 *
 * 数据源：Reach Deck 学习文档 `resources.media`（id → objectKey）。
 * 核心逻辑：按与摘要相同的阅读顺序取可附带的图片元素，再用 resourceId 匹配媒体资源；
 * 找不到资源的图片只保留文字占位。
 */
export function tutorPageMedia(
  document: Record<string, unknown>,
  slide: Record<string, unknown> | undefined,
): TutorPageMediaRef[] {
  if (!slide) return [];
  const media = optionalRecord(document.resources)?.media;
  const objectKeys = new Map<string, string>();
  for (const candidate of Array.isArray(media) ? media : []) {
    const resource = optionalRecord(candidate);
    if (typeof resource?.id === 'string' && typeof resource.objectKey === 'string') {
      objectKeys.set(resource.id, resource.objectKey);
    }
  }
  return slideContent(slide).images.flatMap((image) => {
    const objectKey = objectKeys.get(image.resourceId);
    return objectKey ? [{ ...image, objectKey }] : [];
  });
}

/**
 * 元素按阅读顺序（先上后下、先左后右）拼接可见文字，并给可附带的图片编号占位；
 * 演讲者备注属于教师私有内容，不纳入。
 */
function slideContent(slide: Record<string, unknown>): {
  text: string;
  images: TutorPageImageRef[];
} {
  const lines: string[] = [];
  const images: TutorPageImageRef[] = [];
  const visit = (elements: unknown): void => {
    if (!Array.isArray(elements)) return;
    const ordered = elements
      .map((candidate) => optionalRecord(candidate))
      .filter((element): element is Record<string, unknown> => element !== undefined)
      .sort((left, right) => {
        const a = optionalRecord(left.transform);
        const b = optionalRecord(right.transform);
        return numberOr(a?.y, 0) - numberOr(b?.y, 0) || numberOr(a?.x, 0) - numberOr(b?.x, 0);
      });
    for (const element of ordered) {
      switch (element.type) {
        case 'textFrame':
        case 'shape':
          push(lines, frameText(element.text));
          break;
        case 'table':
          for (const row of Array.isArray(element.rows) ? element.rows : []) {
            const cells = optionalRecord(row)?.cells;
            push(
              lines,
              (Array.isArray(cells) ? cells : [])
                .map((cell) => frameText(optionalRecord(cell)?.text))
                .join(' | '),
            );
          }
          break;
        case 'group':
          visit(element.children);
          break;
        case 'formula':
          push(lines, stringOr(element.latex));
          break;
        case 'chart':
          for (const line of chartLines(element)) push(lines, line);
          break;
        case 'image': {
          const alt = stringOr(element.alt).trim();
          const transform = optionalRecord(element.transform);
          if (
            typeof element.resourceId === 'string' &&
            element.resourceId !== '' &&
            images.length < MAX_PAGE_IMAGES &&
            numberOr(transform?.width, 0) >= MIN_IMAGE_EDGE &&
            numberOr(transform?.height, 0) >= MIN_IMAGE_EDGE
          ) {
            const label = `[image ${images.length + 1}]`;
            images.push({ label, resourceId: element.resourceId, alt });
            push(lines, alt ? `${label} ${alt}` : label);
          } else {
            push(lines, alt);
          }
          break;
        }
        case 'diagram':
          for (const node of Array.isArray(element.nodes) ? element.nodes : []) {
            push(lines, frameText(optionalRecord(node)?.label));
          }
          break;
        case 'scientificVisual':
          push(lines, stringOr(element.ariaLabel));
          break;
        default:
          break;
      }
    }
  };
  visit(slide.elements);
  return { text: lines.join('\n'), images };
}

/**
 * 测验题摘要：题目与填空保留稳定 id，供模型把 learnerActivity.state.answers（按题目 id 索引、
 * 填空按 blankId 索引）对应到具体题目与空位；选项、每空候选项与参考答案一并输出。
 */
function quizText(value: unknown): string {
  const lines: string[] = [];
  const visit = (questions: unknown, prefix: string): void => {
    if (!Array.isArray(questions)) return;
    questions.forEach((candidate, index) => {
      const question = optionalRecord(candidate);
      if (!question) return;
      const label = `${prefix}${index + 1}`;
      const id = stringOr(question.id);
      push(
        lines,
        `Q${label}${id ? ` (id: ${id})` : ''} [${stringOr(question.question_type)}] ` +
          richText(question.question),
      );
      for (const option of Array.isArray(question.options) ? question.options : []) {
        const record = optionalRecord(option);
        if (record) push(lines, `${stringOr(record.value)}. ${richText(record.label)}`);
      }
      // 旧版选词填空把候选池放在题目级 candidates；新版统一在 options / blanks[].candidates。
      const legacyCandidates = optionText(question.candidates);
      if (legacyCandidates) push(lines, `Candidates: ${legacyCandidates}`);
      const answer = answerText(question.answer);
      if (answer) push(lines, `Answer: ${answer}`);
      for (const blank of Array.isArray(question.blanks) ? question.blanks : []) {
        const record = optionalRecord(blank);
        if (!record) continue;
        const blankId = stringOr(record.id);
        const candidates = optionText(record.candidates);
        const blankAnswer = answerText(record.answer);
        push(
          lines,
          `Blank ${numberOr(record.blank_index, 0)}${blankId ? ` (id: ${blankId})` : ''}` +
            (candidates ? ` candidates: ${candidates};` : '') +
            (blankAnswer ? ` answer: ${blankAnswer}` : ''),
        );
      }
      const analysis = richText(question.analysis);
      if (analysis) push(lines, `Analysis: ${analysis}`);
      visit(question.sub_problems, `${label}.`);
    });
  };
  visit(value, '');
  return lines.join('\n');
}

/** 选项 / 候选项列表压成一行：`A. is | B. are`。 */
function optionText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((option) => optionalRecord(option))
    .filter((option): option is Record<string, unknown> => option !== undefined)
    .map((option) => `${stringOr(option.value)}. ${richText(option.label)}`.trim())
    .filter((option) => option !== '.')
    .join(' | ');
}

/**
 * 原生图表的结构化文本：标题与图表类型一行，分类图按「分类=数值」逐系列列出，
 * 散点 / 气泡图逐点列出坐标；无法渲染的图表只保留标题与源类型。
 */
function chartLines(element: Record<string, unknown>): string[] {
  const chartType = stringOr(element.chartType);
  const title = stringOr(element.title).trim();
  const kind =
    chartType === 'unsupported' ? `unsupported ${stringOr(element.sourceChartType)}` : chartType;
  const lines = [`[chart${kind ? ` ${kind}` : ''}]${title ? ` ${title}` : ''}`];
  const categories = Array.isArray(element.categories) ? element.categories : [];
  for (const candidate of Array.isArray(element.series) ? element.series : []) {
    const series = optionalRecord(candidate);
    if (!series) continue;
    const name = stringOr(series.name).trim() || stringOr(series.id);
    let data: string[] = [];
    if (Array.isArray(series.values)) {
      data = series.values.map((value, index) => {
        const category = stringOr(categories[index]) || `#${index + 1}`;
        return `${category}=${typeof value === 'number' ? value : '-'}`;
      });
    } else if (Array.isArray(series.points)) {
      data = series.points.flatMap((candidatePoint) => {
        const point = optionalRecord(candidatePoint);
        if (!point) return [];
        const size = typeof point.size === 'number' ? `, size ${point.size}` : '';
        return [`(${numberOr(point.x, 0)}, ${numberOr(point.y, 0)}${size})`];
      });
    }
    lines.push(`${name}: ${data.join(', ')}`);
  }
  return lines;
}

function answerText(value: unknown): string {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').join(', ');
  return richText(value);
}

function frameText(frame: unknown): string {
  return richText(optionalRecord(frame)?.doc);
}

function richText(value: unknown): string {
  if (!isRichTextDocumentShape(value)) return '';
  try {
    return richTextToPlainText(value).trim();
  } catch {
    return '';
  }
}

function htmlVisibleText(html: string): string {
  return html
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 关键词检索：标题命中权重 3，正文 / 讲稿 / 题目按出现次数计分，大小写不敏感。 */
function scorePage(
  page: TutorPageDigest,
  terms: readonly string[],
): { score: number; matchedTerms: string[] } {
  const title = page.title.toLowerCase();
  const body = [page.text, page.narration, page.quiz].filter(Boolean).join('\n').toLowerCase();
  let score = 0;
  const matchedTerms: string[] = [];
  for (const term of terms) {
    const hits = occurrences(title, term) * 3 + occurrences(body, term);
    if (hits > 0) {
      score += hits;
      matchedTerms.push(term);
    }
  }
  // 命中更多不同关键词的页面优先于单个词反复出现的页面。
  return { score: score + matchedTerms.length * 100, matchedTerms };
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    count += 1;
  }
  return count;
}

function searchTerms(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const terms = value
    .toLowerCase()
    .split(/[\s,，、;；。.!！?？:："“”'‘’()（）]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && term.length <= 50);
  return [...new Set(terms)].slice(0, MAX_SEARCH_TERMS);
}

function mockDeckPages(currentPageId: string): LearnerDeckPages {
  return {
    currentIndex: 1,
    pages: [
      {
        pageNumber: 1,
        pageId: 'mock-previous-page',
        sceneType: 'slide',
        title: '函数的概念',
        text: '函数描述两个变量之间的对应关系。',
      },
      { pageNumber: 2, pageId: currentPageId, sceneType: 'slide', title: '函数与变化率' },
    ],
  };
}

function push(lines: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed) lines.push(trimmed);
}

function clip(value: string, limit: number): { value: string; truncated: boolean } {
  const characters = [...value.trim()];
  if (characters.length <= limit) return { value: characters.join(''), truncated: false };
  return { value: `${characters.slice(0, limit).join('')}…`, truncated: true };
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(maximum, Math.max(1, value))
    : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
