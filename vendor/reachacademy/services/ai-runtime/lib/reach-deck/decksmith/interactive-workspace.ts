import { createHash } from 'node:crypto';

import {
  CANONICAL_BLANK_INTERACTIVE_DOCUMENT,
  type InteractiveCompletionMode,
  type InteractiveEventManifest,
  type InteractiveRuntimePolicy,
  type InteractiveScene,
} from '@reachany/reach-deck-dsl';

import {
  assertInteractiveDocumentStaticallyCompiles,
  createGeneratedInteractiveSceneParser,
  inferInteractiveRuntimeDependencies,
} from '../interactive-generation-validation.js';
import {
  DecksmithDocumentSession,
  DecksmithSessionError,
  type DecksmithInteractiveValidationOptions,
} from './session.js';
import {
  applyDecksmithGeometryProposal,
  inspectDecksmithGeometry,
  type DecksmithGeometryInspection,
} from './geometry-workspace.js';

export interface DecksmithInteractiveTextEdit {
  readonly oldText: string;
  readonly newText: string;
}

interface InteractiveWorkspaceEntry {
  readonly pageId: string;
  readonly mode: 'insert' | 'replace';
  readonly position?: number;
  readonly sourceRevision?: number;
  readonly pendingNarrationText?: string;
  scene: InteractiveScene;
  /** 工作副本是否有尚未提交进会话文档的内容（新建页、写入、文本编辑或几何修改）。 */
  modified?: boolean;
}

export interface DecksmithInteractiveWorkspaceCheck {
  readonly valid: boolean;
  readonly diagnostics: readonly string[];
  readonly documentHtmlUtf8Bytes: number;
  readonly sha256: string;
}

const DEFAULT_RUNTIME_POLICY: InteractiveRuntimePolicy = {
  completionMode: 'none',
  allowReset: true,
  maximumDurationSeconds: null,
};
const DEFAULT_EVENT_MANIFEST: InteractiveEventManifest = {
  schemaVersion: 'reach-interactive-event-manifest/v1',
  events: [],
};

/** 每个会话当前的 Interactive 工作区；预算收尾时据此列出未提交的工作副本（WP4）。 */
const WORKSPACES = new WeakMap<DecksmithDocumentSession, DecksmithInteractiveWorkspace>();

/**
 * 会话中仍有未提交修改的 Interactive 工作副本页 id（按打开顺序）。
 *
 * 数据源：本次运行内存中的 Interactive 工作区（不读任何持久存储）。
 * 核心逻辑：只列出新建后未提交、或写入/编辑/几何修改后未提交的页面；仅被读取的页面不算。
 * 设计动机：工作副本不在提案文档里，额度提前收尾时必须作为剩余任务明示，不能静默丢失。
 */
export function listDecksmithUncommittedInteractivePages(
  session: DecksmithDocumentSession,
): readonly string[] {
  return WORKSPACES.get(session)?.uncommittedPageIds() ?? [];
}

export class DecksmithInteractiveWorkspace {
  private readonly entries = new Map<string, InteractiveWorkspaceEntry>();

  constructor(private readonly session: DecksmithDocumentSession) {
    WORKSPACES.set(session, this);
  }

  uncommittedPageIds(): readonly string[] {
    return [...this.entries.values()]
      .filter((entry) => entry.modified === true)
      .map((entry) => entry.pageId);
  }

  prepareInsert(
    titleValue: string,
    position?: number,
    narrationText?: string,
  ): { pageId: string; position?: number } {
    const title = titleValue.trim();
    if (title.length === 0) throw new DecksmithSessionError('Interactive title must not be blank.');
    const pageId = this.session.reservePageId();
    this.entries.set(pageId, {
      pageId,
      mode: 'insert',
      ...(position === undefined ? {} : { position }),
      ...(narrationText === undefined ? {} : { pendingNarrationText: narrationText }),
      scene: blankInteractiveScene(pageId, title),
      modified: true,
    });
    return { pageId, ...(position === undefined ? {} : { position }) };
  }

  read(pageId: string, offset?: number, limit?: number): string {
    const entry = this.requireExistingInteractive(pageId);
    const lines = entry.scene.documentHtml.split('\n');
    const start = offset === undefined ? 0 : Math.max(0, Math.trunc(offset) - 1);
    if (start >= lines.length) {
      throw new DecksmithSessionError(
        `Interactive HTML offset ${offset} is beyond ${lines.length} lines.`,
      );
    }
    const count = limit === undefined ? lines.length - start : Math.max(1, Math.trunc(limit));
    const end = Math.min(lines.length, start + count);
    const content = lines.slice(start, end).join('\n');
    return end < lines.length
      ? `${content}\n\n[Showing lines ${start + 1}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`
      : content;
  }

  async edit(pageId: string, edits: readonly DecksmithInteractiveTextEdit[]) {
    const entry = this.requireExistingInteractive(pageId);
    entry.scene = {
      ...entry.scene,
      documentHtml: applyExactTextEdits(entry.scene.documentHtml, edits),
    };
    entry.modified = true;
    return this.check(pageId);
  }

  inspectGeometry(pageId: string): DecksmithGeometryInspection {
    const entry = this.requireExistingInteractive(pageId);
    return inspectDecksmithGeometry(entry.scene.documentHtml);
  }

  async proposeGeometryEdit(input: {
    readonly pageId: string;
    readonly instanceId: string;
    readonly expectedHtmlSha256: string;
    readonly envelope: unknown;
  }) {
    const entry = this.requireExistingInteractive(input.pageId);
    const proposal = applyDecksmithGeometryProposal({
      documentHtml: entry.scene.documentHtml,
      instanceId: input.instanceId,
      expectedHtmlSha256: input.expectedHtmlSha256,
      envelope: input.envelope,
    });
    entry.scene = { ...entry.scene, documentHtml: proposal.documentHtml };
    entry.modified = true;
    return { ...proposal, check: await this.check(input.pageId) };
  }

  async write(pageId: string, documentHtml: string, narrationText?: string) {
    const entry = this.requireWritable(pageId);
    const nextNarrationText = narrationText ?? entry.pendingNarrationText;
    entry.scene = {
      ...entry.scene,
      documentHtml,
      ...(nextNarrationText === undefined
        ? {}
        : {
            narration: {
              schemaVersion: 'reach-interactive-narration/v1' as const,
              text: nextNarrationText,
            },
          }),
    };
    entry.modified = true;
    return this.check(pageId);
  }

  async check(pageId: string): Promise<DecksmithInteractiveWorkspaceCheck> {
    const entry = this.requireEntry(pageId);
    try {
      const scene = sceneWithInferredRuntimes(
        entry.scene,
        this.session.interactiveValidationOptions,
      );
      createGeneratedInteractiveSceneParser(
        pageId,
        this.session.interactiveValidationOptions,
      )(scene);
      await assertInteractiveDocumentStaticallyCompiles(scene.documentHtml);
      entry.scene = scene;
      return {
        valid: true,
        diagnostics: [],
        documentHtmlUtf8Bytes: Buffer.byteLength(scene.documentHtml, 'utf8'),
        sha256: htmlDigest(scene.documentHtml),
      };
    } catch (error) {
      return {
        valid: false,
        diagnostics: [boundedDiagnostic(error)],
        documentHtmlUtf8Bytes: Buffer.byteLength(entry.scene.documentHtml, 'utf8'),
        sha256: htmlDigest(entry.scene.documentHtml),
      };
    }
  }

  async commit(input: {
    pageId: string;
    title?: string;
    completionMode?: InteractiveCompletionMode;
    eventManifest?: unknown;
  }) {
    const entry = this.requireEntry(input.pageId);
    const title = input.title?.trim();
    if (title !== undefined && title.length === 0) {
      throw new DecksmithSessionError('Interactive title must not be blank.');
    }
    let scene: InteractiveScene;
    try {
      const candidate = sceneWithInferredRuntimes(
        {
          ...entry.scene,
          ...(title === undefined ? {} : { title }),
          ...(input.completionMode === undefined
            ? {}
            : {
                runtimePolicy: {
                  ...entry.scene.runtimePolicy,
                  completionMode: input.completionMode,
                },
              }),
          ...(input.eventManifest === undefined ? {} : { eventManifest: input.eventManifest }),
        } as InteractiveScene,
        this.session.interactiveValidationOptions,
      );
      scene = createGeneratedInteractiveSceneParser(
        input.pageId,
        this.session.interactiveValidationOptions,
      )(candidate);
      await assertInteractiveDocumentStaticallyCompiles(scene.documentHtml);
    } catch (error) {
      return {
        committed: false,
        pageId: input.pageId,
        diagnostics: [boundedDiagnostic(error)],
      };
    }
    if (
      entry.sourceRevision !== undefined &&
      this.session.readPage(entry.pageId).revision !== entry.sourceRevision
    ) {
      this.entries.delete(entry.pageId);
      throw new DecksmithSessionError(
        `Interactive page ${entry.pageId} changed after the working copy was opened; read it again before committing.`,
      );
    }
    const page =
      entry.mode === 'insert'
        ? this.session.insertScenePage('interactive', scene, entry.position, entry.pageId)
        : this.session.readPage(entry.pageId).sceneType === 'interactive'
          ? this.session.replaceScene(entry.pageId, 'interactive', scene)
          : this.session.replaceWithInteractiveScene(entry.pageId, scene);
    this.entries.delete(entry.pageId);
    return {
      committed: true,
      pageId: page.pageId,
      order: page.order,
      revision: page.revision,
      title: page.title,
      diagnostics: [],
      sha256: htmlDigest(scene.documentHtml),
    };
  }

  private requireExistingInteractive(pageId: string): InteractiveWorkspaceEntry {
    const existing = this.entries.get(pageId);
    if (existing !== undefined) return existing;
    const view = this.session.readPageView(pageId);
    if (view.sceneType !== 'interactive' || view.scene?.sceneType !== 'interactive') {
      throw new DecksmithSessionError(
        `Page ${pageId} is ${view.sceneType}; write complete Interactive HTML to convert it.`,
      );
    }
    const entry: InteractiveWorkspaceEntry = {
      pageId,
      mode: 'replace',
      sourceRevision: view.revision,
      scene: structuredClone(view.scene),
    };
    this.entries.set(pageId, entry);
    return entry;
  }

  private requireWritable(pageId: string): InteractiveWorkspaceEntry {
    const existing = this.entries.get(pageId);
    if (existing !== undefined) return existing;
    const view = this.session.readPageView(pageId);
    if (view.sceneType === 'interactive' && view.scene?.sceneType === 'interactive') {
      return this.requireExistingInteractive(pageId);
    }
    const entry: InteractiveWorkspaceEntry = {
      pageId,
      mode: 'replace',
      sourceRevision: view.revision,
      scene: blankInteractiveScene(pageId, view.title),
    };
    this.entries.set(pageId, entry);
    return entry;
  }

  private requireEntry(pageId: string): InteractiveWorkspaceEntry {
    return this.entries.get(pageId) ?? this.requireExistingInteractive(pageId);
  }
}

function blankInteractiveScene(pageId: string, title: string): InteractiveScene {
  return {
    schemaVersion: 'reach-interactive-scene/v2',
    id: pageId,
    title,
    sceneType: 'interactive',
    documentHtml: CANONICAL_BLANK_INTERACTIVE_DOCUMENT,
    bridgeVersion: 'reach-interactive-bridge/v1',
    runtimeDependencies: [],
    runtimePolicy: structuredClone(DEFAULT_RUNTIME_POLICY),
    eventManifest: structuredClone(DEFAULT_EVENT_MANIFEST),
  };
}

function sceneWithInferredRuntimes(
  scene: InteractiveScene,
  options: DecksmithInteractiveValidationOptions,
): InteractiveScene {
  return {
    ...scene,
    runtimeDependencies: inferInteractiveRuntimeDependencies(scene.documentHtml, options),
  };
}

function applyExactTextEdits(
  source: string,
  edits: readonly DecksmithInteractiveTextEdit[],
): string {
  if (edits.length === 0) throw new DecksmithSessionError('edits must not be empty.');
  const matches = edits.map((edit, index) => {
    if (edit.oldText.length === 0) {
      throw new DecksmithSessionError(`edits[${index}].oldText must not be empty.`);
    }
    const start = source.indexOf(edit.oldText);
    if (start < 0) throw new DecksmithSessionError(`edits[${index}].oldText was not found.`);
    if (source.indexOf(edit.oldText, start + edit.oldText.length) >= 0) {
      throw new DecksmithSessionError(`edits[${index}].oldText must be unique.`);
    }
    return { ...edit, start, end: start + edit.oldText.length };
  });
  const sorted = [...matches].sort((left, right) => left.start - right.start);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.start < sorted[index - 1]!.end) {
      throw new DecksmithSessionError('Interactive HTML edits must not overlap.');
    }
  }
  let output = source;
  for (const edit of sorted.reverse()) {
    output = output.slice(0, edit.start) + edit.newText + output.slice(edit.end);
  }
  return output;
}

function boundedDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 1000 ? message : `${message.slice(0, 997)}...`;
}

function htmlDigest(documentHtml: string): string {
  return createHash('sha256').update(documentHtml).digest('hex');
}
