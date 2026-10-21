import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * feedforward skill 体系：markdown + frontmatter 的教学方法论文档。
 *
 * <p>数据源：共享包内 `skills/*.md`（构建期静态资产，
 * 不走数据库）。frontmatter 用手写解析（只支持本项目约定的 `key: value` 与
 * `key: [a, b]` 两种形态），不引入 gray-matter 依赖。
 */

export interface FeedforwardSkill {
  /** skill 唯一 id（frontmatter id）。 */
  id: string;
  /** 展示名，拼进 system prompt 作该节标题。 */
  name: string;
  /** 适用学科 code 列表；空数组表示不限学科。 */
  subjects: string[];
  /** 适用题型列表；空数组表示不限题型。 */
  questionTypes: string[];
  /** 加分关键词：题干纯文本或教师要求命中时提高选中优先级。 */
  keywords: string[];
  /** 正文（方法论指导）。 */
  body: string;
}

/** skill 选择器的输入：单题上下文 + 测验级设置。 */
export interface SkillSelectionInput {
  /**
   * 题型（正典六种枚举之一：single_choice / multiple_choice / fill_in_the_blank /
   * cloze / fill_with_candidates / short_answer）。
   */
  questionType: string;
  /** 题干纯文本（tiptap 已转文本）。 */
  stemText: string;
  /** 测验设置里的学科 code（可缺省）。 */
  subjectCode?: string;
  /** 教师全局反馈要求（settings.feedback_requirements）。 */
  quizFeedbackRequirements?: string;
  /** 教师题级 feedforward 要求。 */
  questionFeedforwardRequirement?: string;
}

/**
 * 解析单个 skill markdown（frontmatter + 正文）。
 *
 * <p>核心逻辑：
 * <ol>
 *   <li>文件必须以 `---` 行开头，找到下一个 `---` 行作为 frontmatter 结束；</li>
 *   <li>frontmatter 每行 `key: value`；value 为 `[a, b]` 时按逗号切成数组；</li>
 *   <li>id/name 缺失抛错（skill 资产是仓库内静态文件，写错应 fail fast）。</li>
 * </ol>
 */
export function parseSkillMarkdown(raw: string): FeedforwardSkill {
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new Error('skill markdown 必须以 --- frontmatter 开头');
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex === -1) {
    throw new Error('skill markdown 的 frontmatter 未闭合');
  }
  const front: Record<string, string> = {};
  for (const line of lines.slice(1, endIndex)) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(':');
    if (separator === -1) {
      throw new Error('skill frontmatter 行必须是 key: value 形态: ' + line);
    }
    front[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  const id = front.id;
  const name = front.name;
  if (!id || !name) {
    throw new Error('skill frontmatter 必须包含 id 与 name');
  }
  return {
    id,
    name,
    subjects: parseListValue(front.subjects),
    questionTypes: parseListValue(front.questionTypes),
    keywords: parseListValue(front.keywords),
    body: lines
      .slice(endIndex + 1)
      .join('\n')
      .trim(),
  };
}

/** 解析 `[a, b, c]` 形态的 frontmatter 数组值；缺省返回空数组。 */
function parseListValue(value: string | undefined): string[] {
  if (value === undefined) return [];
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(/[,，]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

let builtinSkillsCache: FeedforwardSkill[] | undefined;

/**
 * 加载内置 skill（skills/ 目录全部 .md，按文件名排序，模块级缓存）。
 */
export function loadBuiltinSkills(): FeedforwardSkill[] {
  if (builtinSkillsCache !== undefined) return builtinSkillsCache;
  const skillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills');
  const files = readdirSync(skillsDir)
    .filter((file) => file.endsWith('.md'))
    .sort();
  builtinSkillsCache = files.map((file) =>
    parseSkillMarkdown(readFileSync(path.join(skillsDir, file), 'utf8')),
  );
  return builtinSkillsCache;
}

/**
 * skill 选择器（独立纯函数，可单测）。
 *
 * <p>核心逻辑：
 * <ol>
 *   <li>硬性过滤：skill 声明了 subjects 时必须命中 subjectCode；声明了
 *       questionTypes 时必须命中题型（空数组视为不限）；</li>
 *   <li>加分：题干纯文本或教师要求（全局 + 题级）包含任一 keyword，每个命中 +1；</li>
 *   <li>按（得分降序，id 升序）排序，返回前 0-2 个。</li>
 * </ol>
 *
 * <p>注意点：subjectCode 缺省时，声明了 subjects 的 skill 一律不选（学科不明时
 * 注入错误学科的方法论比不注入更糟）。
 */
export function selectSkills(
  input: SkillSelectionInput,
  skills: readonly FeedforwardSkill[] = loadBuiltinSkills(),
): FeedforwardSkill[] {
  const haystack = [
    input.stemText,
    input.quizFeedbackRequirements ?? '',
    input.questionFeedforwardRequirement ?? '',
  ].join('\n');
  const candidates = skills
    .filter((skill) => {
      if (skill.subjects.length > 0) {
        if (input.subjectCode === undefined || !skill.subjects.includes(input.subjectCode)) {
          return false;
        }
      }
      if (skill.questionTypes.length > 0 && !skill.questionTypes.includes(input.questionType)) {
        return false;
      }
      return true;
    })
    .map((skill) => ({
      skill,
      score: skill.keywords.filter((keyword) => haystack.includes(keyword)).length,
    }));
  candidates.sort((left, right) =>
    left.score === right.score
      ? left.skill.id.localeCompare(right.skill.id)
      : right.score - left.score,
  );
  return candidates.slice(0, 2).map((entry) => entry.skill);
}

/** 把选中的 skill 组装成 system prompt 片段（每个 skill 一节，标题=name）。 */
export function renderSkillSections(skills: readonly FeedforwardSkill[]): string {
  if (skills.length === 0) return '';
  return skills.map((skill) => `## 教学方法 skill：${skill.name}\n\n${skill.body}`).join('\n\n');
}
