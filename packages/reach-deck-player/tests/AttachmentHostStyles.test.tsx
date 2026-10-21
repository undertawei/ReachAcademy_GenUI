// @vitest-environment node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createQuizQuestion,
  richTextFromPlainText,
  type QuizAttachmentReference,
  type QuizScene,
} from '@reachany/reach-deck-dsl';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const attachments: QuizAttachmentReference[] = [
  {
    assetId: 'image',
    objectKey: 'diagram.png',
    name: 'diagram-with-a-long-descriptive-name.png',
    contentType: 'image/png',
    sizeBytes: 204800,
    order: 0,
  },
  {
    assetId: 'pdf',
    objectKey: 'reference.pdf',
    name: '课程参考资料与实验记录.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1048576,
    order: 1,
  },
];
const scene: QuizScene = {
  schemaVersion: 'reach-quiz-scene/v1',
  id: 'quiz',
  title: '课程测验',
  sceneType: 'quiz',
  content: {
    display_mode: 'single_question',
    navigation: 'horizontal',
    show_progress: true,
    show_question_index: true,
    answer_reveal: 'after_submit',
    allow_previous: true,
    allow_skip: false,
    questions: [
      {
        ...createQuizQuestion('single_choice', 1, 'q'),
        question: richTextFromPlainText('请选择正确答案。'),
        question_attachments: attachments,
      },
    ],
  },
};
const hosts = [
  { id: 'answer-attachments', buttonsPerRow: 5, editActions: true },
  { id: 'editor-attachments', buttonsPerRow: 5, editActions: true },
  { id: 'quiz-question-attachments', buttonsPerRow: 2, editActions: false },
];

// Browser mounting is required: the real Tiptap answer editor renders only a loading shell on SSR.
// Student answers and Teacher trials share this editor, so they are one host, not separate evidence.
const browserEntry = `
import { createRoot } from 'react-dom/client';
import { QuizAnswerEditor } from '../src/QuizAnswerEditor.js';
import { QuizScenePlayer } from '../src/QuizScenePlayer.js';
import { QuizQuestionAttachmentsEditor } from '../../reach-deck-editor/src/QuizQuestionAttachmentsEditor.js';
const attachments = ${JSON.stringify(attachments)};
const scene = ${JSON.stringify(scene)};
const resolveAttachmentUrl = async (_, disposition) => ({
  url: 'https://example.test/attachment', disposition,
});
createRoot(document.getElementById('app')).render(
  <main>
    <section id="answer-attachments" className="reach-deck-player">
      <h2>作答附件</h2>
      <QuizAnswerEditor
        allowAttachments disabled={false} onChange={() => undefined} questionId="answer"
        resolveAttachmentUrl={resolveAttachmentUrl}
        value={{document: ${JSON.stringify(richTextFromPlainText(''))}, attachments}}
      />
    </section>
    <section id="editor-attachments" className="reach-deck-editor">
      <h2>编辑器题目附件</h2>
      <div className="reach-deck-editor__quiz-questions">
        <article className="reach-deck-editor__quiz-question">
          <QuizQuestionAttachmentsEditor
            attachments={attachments} resolveAttachmentUrl={resolveAttachmentUrl}
            onChange={() => undefined}
          />
        </article>
      </div>
    </section>
    <section id="quiz-question-attachments" className="reach-deck-player">
      <QuizScenePlayer scene={scene} resolveAttachmentUrl={resolveAttachmentUrl} />
    </section>
  </main>,
);`;

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return chromium.launch({ channel: 'chrome', headless: true });
  }
}

it('keeps real Deck answer, editor and QuizScenePlayer attachments usable at desktop and 390px', async () => {
  const result = await build({
    stdin: {
      contents: `@import './packages/ui/src/styles.css';\n@import './packages/reach-deck-player/styles.css';\n@import './packages/reach-deck-editor/styles.css';`,
      loader: 'css',
      resolveDir: repoRoot,
    },
    bundle: true,
    write: false,
    external: ['*.woff2', '*.woff', '*.ttf', '*.otf'],
  });
  const script = await build({
    stdin: {
      contents: browserEntry,
      loader: 'tsx',
      resolveDir: path.join(repoRoot, 'packages/reach-deck-player/tests'),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.route(/\.(woff2?|ttf|otf)$/, (route) => route.abort());
    for (const width of [1200, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(`<!doctype html><html><head><style>${result.outputFiles[0]!.text}</style>
        <style>body { margin: 0; padding: var(--reachany-space-4); background: var(--reachany-color-surface); font-family: var(--reachany-font-sans); }
        main { display: grid; gap: var(--reachany-space-6); min-width: 0; }
        section.reach-deck-editor { min-height: 0; height: auto; }
        h2 { font-size: var(--reachany-text-body); }</style></head><body><div id="app"></div></body></html>`);
      await page.addScriptTag({ content: script.outputFiles[0]!.text });
      await page.locator('#answer-attachments .quiz-answer-editor__attachments').waitFor();
      for (const host of hosts) {
        const section = page.locator(`#${host.id}`);
        const list = section.locator('.reach-deck-attachments');
        expect(await list.count()).toBe(1);
        expect(await list.locator('.reach-deck-attachment-edit-actions').count()).toBe(
          host.editActions ? 2 : 0,
        );
        const rows = await list.locator('.rx-attachment-row').evaluateAll((elements) =>
          elements.map((row) => {
            const rowBox = row.getBoundingClientRect();
            const rowStyle = getComputedStyle(row);
            const name = row.querySelector<HTMLElement>('.rx-attachment-name')!;
            const nameStyle = getComputedStyle(name);
            const main = row.querySelector<HTMLElement>('.rx-file-list-main')!;
            const mainBox = main.getBoundingClientRect();
            const actionBox = row
              .querySelector<HTMLElement>('.rx-file-list-actions')!
              .getBoundingClientRect();
            return {
              row: {
                width: rowBox.width,
                border: rowStyle.borderWidth,
                padding: rowStyle.padding,
                rightInset: rowBox.right - mainBox.right,
                overflow: row.scrollWidth - row.clientWidth,
              },
              name: {
                width: name.getBoundingClientRect().width,
                border: nameStyle.borderWidth,
                padding: nameStyle.padding,
                overflow: nameStyle.overflow,
                ellipsis: nameStyle.textOverflow,
              },
              mainAndActionsOverlap:
                Math.min(mainBox.right, actionBox.right) >
                  Math.max(mainBox.left, actionBox.left) + 1 &&
                Math.min(mainBox.bottom, actionBox.bottom) >
                  Math.max(mainBox.top, actionBox.top) + 1,
              actionsWrapped: actionBox.top >= mainBox.bottom,
              buttons: [...row.querySelectorAll<HTMLElement>('.rx-icon-button')].map((button) => {
                const box = button.getBoundingClientRect();
                return {
                  width: box.width,
                  height: box.height,
                  left: box.left,
                  right: box.right,
                  padding: getComputedStyle(button).padding,
                  withinRow:
                    box.left >= rowBox.left &&
                    box.right <= rowBox.right + 1 &&
                    box.top >= rowBox.top &&
                    box.bottom <= rowBox.bottom + 1,
                };
              }),
              mainChildren: [...main.children].map((child) => {
                const box = child.getBoundingClientRect();
                return { left: box.left, right: box.right };
              }),
            };
          }),
        );
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.buttons).toHaveLength(host.buttonsPerRow);
          for (const button of row.buttons)
            expect(button).toMatchObject({
              width: 28,
              height: 28,
              padding: '0px',
              withinRow: true,
            });
          for (let index = 1; index < row.buttons.length; index++)
            expect(row.buttons[index]!.left).toBeGreaterThanOrEqual(
              row.buttons[index - 1]!.right - 1,
            );
          expect(row.name.border).toBe('0px');
          expect(row.name.padding).toBe('0px');
          expect(row.name.width).toBeGreaterThanOrEqual(48);
          expect(row.name.overflow).toBe('hidden');
          expect(row.name.ellipsis).toBe('ellipsis');
          expect(row.row.border).toBe('1px');
          expect(row.row.padding).toBe('4px 12px');
          expect(row.row.rightInset).toBeGreaterThanOrEqual(12);
          expect(row.row.overflow).toBeLessThanOrEqual(1);
          expect(row.mainAndActionsOverlap).toBe(false);
          expect(row.actionsWrapped).toBe(width === 390);
          for (let index = 1; index < row.mainChildren.length; index++)
            expect(row.mainChildren[index]!.left).toBeGreaterThanOrEqual(
              row.mainChildren[index - 1]!.right - 1,
            );
        }
        if (host.id === 'editor-attachments') {
          const hierarchy = await list.evaluate((element) => {
            const section = element.parentElement!;
            const article = section.parentElement!;
            const style = getComputedStyle(article);
            return {
              sectionTag: section.tagName,
              articleTag: article.tagName,
              articleClass: article.className,
              inset: article.getBoundingClientRect().width - section.getBoundingClientRect().width,
              padding: style.padding,
              border: style.borderWidth,
            };
          });
          expect(hierarchy).toEqual({
            sectionTag: 'SECTION',
            articleTag: 'ARTICLE',
            articleClass: 'reach-deck-editor__quiz-question',
            inset: 34,
            padding: '16px',
            border: '1px',
          });
        }
        if (host.id === 'answer-attachments') {
          expect(await section.locator('.learner-editor .tiptap').count()).toBe(1);
          expect(
            await section.locator('.learner-editor-attachments .reach-deck-attachments').count(),
          ).toBe(1);
        }
        if (host.id === 'quiz-question-attachments') {
          const spacing = await list.evaluate((element) => ({
            margin: getComputedStyle(element).marginBottom,
            gap:
              element.parentElement!.querySelector('.quiz-scene__options')!.getBoundingClientRect()
                .top - element.getBoundingClientRect().bottom,
          }));
          expect(spacing.margin).toBe('16px');
          expect(spacing.gap).toBeGreaterThanOrEqual(16);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        const screenshotDir = process.env.REACH_ATTACHMENT_SCREENSHOT_DIR;
        if (screenshotDir) {
          await mkdir(screenshotDir, { recursive: true });
          await section.screenshot({ path: path.join(screenshotDir, `${host.id}-${width}.png`) });
        }
      }
    }
  } finally {
    await browser.close();
  }
}, 30_000);
