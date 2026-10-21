import { describe, expect, it } from 'vitest';

import {
  loadBuiltinSkills,
  parseSkillMarkdown,
  selectSkills,
  type FeedforwardSkill,
} from '../src/feedforward/skills.js';

const SKILLS: FeedforwardSkill[] = [
  {
    id: 'math-step-error-extraction',
    name: '数学-解题步骤错误知识点提取',
    subjects: ['math'],
    questionTypes: ['short_answer'],
    keywords: ['步骤', '过程', '证明', '计算'],
    body: '正文A',
  },
  {
    id: 'math-explanation-coaching',
    name: '数学-错因讲解与追问生成',
    subjects: ['math'],
    // 不限题型
    questionTypes: [],
    keywords: ['讲解', '错因'],
    body: '正文B',
  },
  {
    id: 'english-subjective-feedback',
    name: '英语-主观题表达反馈',
    subjects: ['english'],
    questionTypes: ['short_answer'],
    keywords: ['作文', '表达'],
    body: '正文C',
  },
];

describe('parseSkillMarkdown', () => {
  it('解析 frontmatter 与正文', () => {
    const skill = parseSkillMarkdown(
      [
        '---',
        'id: demo-skill',
        'name: 演示 skill',
        'subjects: [math, physics]',
        'questionTypes: [short_answer]',
        'keywords: [步骤, 证明]',
        '---',
        '',
        '正文第一段。',
      ].join('\n'),
    );
    expect(skill.id).toBe('demo-skill');
    expect(skill.name).toBe('演示 skill');
    expect(skill.subjects).toEqual(['math', 'physics']);
    expect(skill.questionTypes).toEqual(['short_answer']);
    expect(skill.keywords).toEqual(['步骤', '证明']);
    expect(skill.body).toBe('正文第一段。');
  });

  it('缺失 id/name 或 frontmatter 未闭合时抛错', () => {
    expect(() => parseSkillMarkdown('---\nname: 缺id\n---\n正文')).toThrow('id');
    expect(() => parseSkillMarkdown('---\nid: x\nname: y\n正文没有闭合')).toThrow('未闭合');
    expect(() => parseSkillMarkdown('没有 frontmatter')).toThrow('---');
  });
});

describe('loadBuiltinSkills', () => {
  it('内置 3 个 skill 且 id 齐全', () => {
    const skills = loadBuiltinSkills();
    expect(skills.map((skill) => skill.id).sort()).toEqual([
      'english-subjective-feedback',
      'math-explanation-coaching',
      'math-step-error-extraction',
    ]);
    for (const skill of skills) {
      expect(skill.body.length).toBeGreaterThan(100);
    }
  });
});

describe('selectSkills', () => {
  it('学科 + 题型命中，关键词加分决定排序', () => {
    const selected = selectSkills(
      {
        questionType: 'short_answer',
        stemText: '请写出完整的解题步骤并证明。',
        subjectCode: 'math',
      },
      SKILLS,
    );
    expect(selected.map((skill) => skill.id)).toEqual([
      'math-step-error-extraction',
      'math-explanation-coaching',
    ]);
  });

  it('教师要求命中关键词也参与加分', () => {
    const selected = selectSkills(
      {
        questionType: 'single_choice',
        stemText: '1+1=?',
        subjectCode: 'math',
        quizFeedbackRequirements: '重点讲解错因',
      },
      SKILLS,
    );
    // single_choice 只有不限题型的 coaching 命中
    expect(selected.map((skill) => skill.id)).toEqual(['math-explanation-coaching']);
  });

  it('学科不匹配的 skill 不选', () => {
    const selected = selectSkills(
      { questionType: 'short_answer', stemText: '翻译这句作文表达', subjectCode: 'english' },
      SKILLS,
    );
    expect(selected.map((skill) => skill.id)).toEqual(['english-subjective-feedback']);
  });

  it('subjectCode 缺省时声明了 subjects 的 skill 一律不选', () => {
    const selected = selectSkills({ questionType: 'short_answer', stemText: '解题步骤' }, SKILLS);
    expect(selected).toEqual([]);
  });

  it('题型不匹配时不选', () => {
    const selected = selectSkills(
      { questionType: 'single_choice', stemText: '选出正确一项', subjectCode: 'english' },
      SKILLS,
    );
    expect(selected).toEqual([]);
  });

  it('最多返回 2 个', () => {
    const many = [...SKILLS, { ...SKILLS[0]!, id: 'math-extra', keywords: ['步骤'] }];
    const selected = selectSkills(
      { questionType: 'short_answer', stemText: '步骤 过程 计算 证明', subjectCode: 'math' },
      many,
    );
    expect(selected).toHaveLength(2);
  });
});
