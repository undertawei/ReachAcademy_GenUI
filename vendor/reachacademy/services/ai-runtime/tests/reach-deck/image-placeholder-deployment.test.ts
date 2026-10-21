import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const documents = [
  'docs/plans/2026-10-17-deck-image-failure-placeholder.md',
  'docs/wiki/services/reach-deck.md',
];

it.each(documents)('documents the accepted narration-wait cancellation delay: %s', async (file) => {
  const source = await readFile(new URL(`../../../../${file}`, import.meta.url), 'utf8');
  const observations = source
    .split(file.includes('/plans/') ? '### 部署后恢复数据观察' : 'After deployment,')[1]!
    .split(file.includes('/plans/') ? '## 已定决策' : '\n## ')[0]!;
  expect(observations).toContain(file.includes('/plans/') ? '最多 15 秒' : 'up to 15 seconds');
  expect(observations).toContain(file.includes('/plans/') ? '取消中' : 'Cancelling');
  expect(observations).toContain(file.includes('/plans/') ? '已知现象' : 'known behavior');
});

it.each(documents)('treats stale Teacher tabs as a communicated limitation: %s', async (file) => {
  const source = await readFile(new URL(`../../../../${file}`, import.meta.url), 'utf8');
  const deployment = source
    .split(file.includes('/plans/') ? '## 部署\n' : 'New metadata,')[1]!
    .split(file.includes('/plans/') ? '## 已定决策' : 'After deployment,')[0]!;
  expect(deployment).not.toMatch(
    /强制刷新|Force-refresh|After compatibility checks and refreshing/,
  );
  expect(deployment).toContain(
    file.includes('/plans/') ? '提前通知教师和协作者' : 'Notify teachers and collaborators',
  );
  expect(deployment).toContain(
    file.includes('/plans/')
      ? '不作为恢复生成的前置条件'
      : 'not a prerequisite for resuming generation',
  );
  expect(deployment).toContain(
    file.includes('/plans/') ? '工作区解析失败' : 'workspace parsing fails',
  );
});

it.each(documents)(
  'allows idle old workers only while producers and all channels stay empty: %s',
  async (file) => {
    const source = await readFile(new URL(`../../../../${file}`, import.meta.url), 'utf8');
    const deployment = source
      .split(file.includes('/plans/') ? '## 部署\n' : 'New metadata,')[1]!
      .split(file.includes('/plans/') ? '## 已定决策' : 'After deployment,')[0]!;
    expect(deployment).not.toContain('安装新 API 前须保证旧读者已排空并停止');
    expect(deployment).not.toContain('After old readers drain and stop');
    expect(deployment).not.toContain('before upgrading the API');
    expect(deployment).toContain(
      file.includes('/plans/') ? '旧 worker 空闲存在可以接受' : 'idle old workers may remain',
    );
  },
);

it.each(documents)('requires complete queue and workspace drain evidence: %s', async (file) => {
  const source = await readFile(new URL(`../../../../${file}`, import.meta.url), 'utf8');
  const deployment = source
    .split(file.includes('/plans/') ? '## 部署\n' : 'New metadata,')[1]!
    .split(file.includes('/plans/') ? '## 已定决策' : 'After deployment,')[0]!;
  for (const state of ['wait', 'prioritized', 'active', 'delayed', 'paused', 'waiting-children'])
    expect(deployment).toContain(`\`${state} = 0\``);
  expect(deployment).toContain('ai-runtime-teacher-deck-jobs-v1');
  expect(deployment).toContain(
    '{ai-runtime:<REACHANY_ENV>:<REACHANY_QUEUE_NAMESPACE>:teacher-deck}',
  );
  expect(deployment).toContain('reach_deck_authoring_workspaces');
  expect(deployment).toContain('$objectToArray');
  expect(deployment).toContain("'$$batch.v.phase'");
  expect(deployment).toContain("'terminal'");
  expect(deployment).toContain('$count');
});
