import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  NARRATION_HUMANIZATION_ADAPTED_RULES,
  NARRATION_HUMANIZATION_EXAMPLES,
  NARRATION_HUMANIZATION_PRODUCTION_REFERENCE_BLOCK,
  NARRATION_HUMANIZATION_SOURCES,
  NARRATION_HUMANIZATION_SOURCES_VERSION,
} from '../../lib/reach-deck/narration-humanization-sources.js';

const runtimeRoot = path.resolve(import.meta.dirname, '../..');

const sha256Lf = (value: string): string =>
  createHash('sha256').update(value.replaceAll('\r\n', '\n'), 'utf8').digest('hex');

describe('Reach Deck narration Humanizer / 说人话来源资产', () => {
  it('锁定固定提交、MIT 来源和逐字 vendored 文件摘要', async () => {
    expect(NARRATION_HUMANIZATION_SOURCES_VERSION).toBe('narration-humanization-sources/v1');
    expect(new Set(NARRATION_HUMANIZATION_SOURCES.map((source) => source.project))).toEqual(
      new Set(['Humanizer', '说人话']),
    );

    for (const source of NARRATION_HUMANIZATION_SOURCES) {
      expect(source.commitSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(source.sha256Lf).toMatch(/^[a-f0-9]{64}$/u);
      expect(source.license).toBe('MIT');
      expect(source.copyright).toMatch(/^Copyright \(c\)/u);
      expect(source.copiedVerbatim).toBe(true);
      const text = await readFile(path.join(runtimeRoot, source.vendoredPath), 'utf8');
      expect(sha256Lf(text)).toBe(source.sha256Lf);
    }

    const manifest = JSON.parse(
      await readFile(
        path.join(runtimeRoot, 'reference-packs/v1/narration-humanization/manifest.json'),
        'utf8',
      ),
    ) as {
      schemaVersion: string;
      sources: Array<{
        repository: string;
        commitSha: string;
        license: string;
        files: Array<{ vendoredPath: string; sha256Lf: string; copiedVerbatim: boolean }>;
      }>;
    };
    expect(manifest.schemaVersion).toBe('reach-deck-narration-humanization-sources/v1');
    expect(manifest.sources).toHaveLength(2);
    expect(manifest.sources.flatMap((source) => source.files)).toHaveLength(7);
    for (const source of manifest.sources) {
      expect(source.repository).toMatch(/^https:\/\/github\.com\//u);
      expect(source.commitSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(source.license).toBe('MIT');
      for (const file of source.files) {
        expect(file.copiedVerbatim).toBe(true);
        const text = await readFile(
          path.join(runtimeRoot, 'reference-packs/v1/narration-humanization', file.vendoredPath),
          'utf8',
        );
        expect(sha256Lf(text)).toBe(file.sha256Lf);
      }
    }
  });

  it('保留完整中文对照案例并区分正常生成、纠错和审计用途', () => {
    expect(NARRATION_HUMANIZATION_EXAMPLES).toHaveLength(3);
    expect(NARRATION_HUMANIZATION_EXAMPLES.map((example) => example.id)).toEqual([
      'shuorenhua-strip-wrapper-preserve-result',
      'shuorenhua-normal-technical-noop',
      'shuorenhua-chat-engineer-register',
    ]);
    for (const example of NARRATION_HUMANIZATION_EXAMPLES) {
      expect(example.originalText.length).toBeGreaterThan(10);
      expect(example.rewrittenText.length).toBeGreaterThan(10);
      expect(example.explanation.length).toBeGreaterThan(10);
      expect(NARRATION_HUMANIZATION_SOURCES.some((source) => source.id === example.sourceId)).toBe(
        true,
      );
    }
    expect(
      NARRATION_HUMANIZATION_EXAMPLES.find(
        (example) => example.id === 'shuorenhua-normal-technical-noop',
      ),
    ).toMatchObject({
      use: 'correction',
      originalText:
        '闭环控制器每 20 ms 读取一次传感器。配置中的 `retry_limit` 为 3，超过后记录错误并退出。',
      rewrittenText:
        '闭环控制器每 20 ms 读取一次传感器。配置中的 `retry_limit` 为 3，超过后记录错误并退出。',
    });
  });

  it('生产引用包含完整生动对照和保真编辑纪律，但不冒充教师声音语料', () => {
    expect(NARRATION_HUMANIZATION_ADAPTED_RULES).toHaveLength(10);
    expect(NARRATION_HUMANIZATION_PRODUCTION_REFERENCE_BLOCK).toContain('先说结论：吃日料。');
    expect(NARRATION_HUMANIZATION_PRODUCTION_REFERENCE_BLOCK).toContain(
      '吃日料吧，上周你说火锅腻了。要帮你下单吗？',
    );
    expect(NARRATION_HUMANIZATION_PRODUCTION_REFERENCE_BLOCK).toContain(
      '它们不是教师人格，也不是当前课程内容',
    );
    expect(NARRATION_HUMANIZATION_PRODUCTION_REFERENCE_BLOCK).toContain(
      '保留事实、主体、动作、条件、范围、否定、可能性、完成状态、比较、程度、公式和绑定',
    );
    expect(NARRATION_HUMANIZATION_PRODUCTION_REFERENCE_BLOCK).toContain(
      '保留它的段落顺序、任务铺垫、完整复句和必要重复',
    );
    expect(NARRATION_HUMANIZATION_PRODUCTION_REFERENCE_BLOCK).toContain(
      '行动主体、最终产物、时长、质量标准与步骤都属于事实',
    );
  });
});
