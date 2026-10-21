import type {
  GeneratedSceneArtifact,
  GenerationWorkspace,
  DeckSlide,
  InteractiveScene,
  PageOutline,
  PagedDeckOutline,
  QuizScene,
  SceneArtifact,
  SlideGenerationMetadata,
  NativeSlideArtifact,
} from '../src/index.js';
import {
  applySceneArtifact,
  applySlideNarrationArtifact,
  setPageGenerationStatus,
} from '../src/index.js';
import { richTextFromPlainText } from '../src/richText.js';

export const NOW = '2026-07-18T08:00:00.000Z';

export const lessonPlan = {
  id: 'plan-1',
  title: 'Mixed scenes',
  audience: 'Grade 8',
  durationMinutes: 45,
  learningObjectives: ['Explain the idea'],
  teachingStrategy: 'Model, practice, reflect',
  keyTerms: ['system'],
  narrative: 'Move from explanation to application.',
};

export const page = (
  id: string,
  order: number,
  sceneType: PageOutline['sceneType'],
): PageOutline => ({
  id,
  order,
  sceneType,
  title: `${sceneType} page`,
});

export const outline = (pages: PageOutline[]): PagedDeckOutline => ({
  id: 'outline-1',
  title: 'Mixed deck',
  pages,
});

export const slideScene = (id: string): DeckSlide => ({
  id,
  title: 'Slide',
  layout: 'freeform' as const,
  duration: 8,
  background: '#ffffff',
  elements: [
    {
      id: `${id}-title`,
      type: 'text' as const,
      frame: { x: 80, y: 64, width: 900, height: 120 },
      layer: 1,
      doc: richTextFromPlainText('A clear idea'),
      variant: 'title' as const,
    },
  ],
  animations: [],
  voiceTimeline: [],
});

export const slideMetadata = (pageId: string): SlideGenerationMetadata => ({
  blueprint: {
    pageId,
    learningGoal: 'Explain one idea',
    keyMessage: 'Systems have connected parts.',
    audienceAssumption: 'New learner',
    narrativeRole: 'explain',
    contentUnits: [{ id: 'claim', role: 'claim', text: 'Connected parts', priority: 'primary' }],
    desiredStudentAttention: 'The relationship',
    mediaIntent: { kind: 'none' },
  },
  classification: {
    primaryType: 'single_focus',
    itemCount: 1,
    density: 'low',
    visualFocus: 'statement',
    mediaType: 'none',
    confidence: 0.9,
    rationale: 'One main claim.',
  },
  layoutReferences: [
    { id: 'single_focus-statement-v1', version: 1, score: 165 },
    { id: 'single_focus-hero-v1', version: 1, score: 120 },
  ],
  promptVersion: 'staged-v1',
});

export const quizScene = (id: string): QuizScene => ({
  schemaVersion: 'reach-quiz-scene/v1' as const,
  id,
  title: 'Quiz',
  sceneType: 'quiz' as const,
  content: {
    questions: [
      {
        id: 'question-1',
        analysis: richTextFromPlainText(''),
        answer: ['A'],
        cognitive_schema: richTextFromPlainText(''),
        has_answer: true,
        options: [
          { value: 'A', label: richTextFromPlainText('正确') },
          { value: 'B', label: richTextFromPlainText('错误') },
        ],
        points: 10,
        question: richTextFromPlainText('Systems have parts.'),
        question_index: 1,
        question_type: 'single_choice' as const,
        sub_problems: [],
      },
    ],
    display_mode: 'single_question' as const,
    navigation: 'horizontal' as const,
    show_progress: true,
    show_question_index: true,
    answer_reveal: 'after_submit' as const,
    allow_previous: true,
    allow_skip: false,
  },
});

export const interactiveScene = (id: string): InteractiveScene => ({
  schemaVersion: 'reach-interactive-scene/v2' as const,
  id,
  title: 'Interactive',
  sceneType: 'interactive' as const,
  documentHtml:
    '<!doctype html><html><head><style>body{margin:0}</style></head><body><button>Try</button><script>window.ReachInteractive?.ready?.();</script></body></html>',
  bridgeVersion: 'reach-interactive-bridge/v1' as const,
  runtimePolicy: {
    completionMode: 'explicit' as const,
    allowReset: true,
    maximumDurationSeconds: null,
  },
  eventManifest: {
    schemaVersion: 'reach-interactive-event-manifest/v1',
    events: [
      {
        name: 'strategy_chosen',
        eventVersion: 1,
        meaning: 'The learner selected a strategy to try.',
        payloadFields: [
          {
            name: 'strategy',
            type: 'string',
            required: true,
            maxLength: 80,
            enum: [],
          },
        ],
        delivery: { mode: 'immediate' },
      },
    ],
  },
  narration: {
    schemaVersion: 'reach-interactive-narration/v1' as const,
    text: 'Adjust the activity and observe what changes.',
  },
});

export const sceneFor = (sceneType: PageOutline['sceneType'], id: string) => {
  switch (sceneType) {
    case 'slide':
      return slideScene(id);
    case 'quiz':
      return quizScene(id);
    case 'interactive':
      return interactiveScene(id);
  }
};

export const artifactFor = (
  workspace: GenerationWorkspace,
  pageId: string,
): Exclude<GeneratedSceneArtifact, NativeSlideArtifact> => {
  const record = workspace.records[pageId];
  if (!record.request) throw new Error(`Page ${pageId} is not a generation target.`);
  const identity = {
    runId: workspace.runId,
    pageId,
    requestedRevision: record.revision,
    attempt: record.request.attempt,
    status: 'ready' as const,
    generatedAt: NOW,
  };
  switch (record.page.sceneType) {
    case 'slide':
      return {
        ...identity,
        sceneType: 'slide',
        scene: slideScene(pageId),
        generationMetadata: slideMetadata(pageId),
      };
    case 'quiz':
      return { ...identity, sceneType: 'quiz', scene: quizScene(pageId) };
    case 'interactive':
      return { ...identity, sceneType: 'interactive', scene: interactiveScene(pageId) };
  }
};

/** 给版面工件补一份讲稿（占位窗口）后的讲稿工件：与版面 stripSlideNarration 等价。 */
export const narratedArtifact = (
  artifact: Exclude<GeneratedSceneArtifact, NativeSlideArtifact>,
): Exclude<GeneratedSceneArtifact, NativeSlideArtifact> => {
  if (artifact.sceneType !== 'slide') return artifact;
  return {
    ...artifact,
    scene: {
      ...artifact.scene,
      voiceTimeline: [
        {
          id: 'narration-1',
          label: '讲稿 1',
          text: `${artifact.pageId} 的讲稿。`,
          start: 0,
          end: 7,
        },
      ],
      duration: Math.max(artifact.scene.duration, 8),
    },
  };
};

/** 两跳落地：slide 版面落地（页进 narrating）后再落讲稿工件，页到 ready。 */
export const landSceneArtifact = (
  workspace: GenerationWorkspace,
  artifact: Exclude<GeneratedSceneArtifact, NativeSlideArtifact>,
): GenerationWorkspace => {
  const applied = applySceneArtifact(workspace, artifact);
  if (artifact.sceneType !== 'slide') return applied;
  return applySlideNarrationArtifact(applied, narratedArtifact(artifact));
};

export const prepareForArtifact = (
  workspace: GenerationWorkspace,
  pageId: string,
): GenerationWorkspace => {
  const record = workspace.records[pageId];
  if (!record.request) throw new Error(`Page ${pageId} is not a generation target.`);
  const identity = {
    runId: workspace.runId,
    pageId,
    requestedRevision: record.revision,
    attempt: record.request.attempt,
  };
  return setPageGenerationStatus(
    workspace,
    { ...identity, state: 'generating', startedAt: NOW },
    NOW,
  );
};

export const withArtifact = (
  workspace: GenerationWorkspace,
  artifact: SceneArtifact,
): GenerationWorkspace => ({
  ...workspace,
  sceneArtifacts: { ...workspace.sceneArtifacts, [artifact.pageId]: artifact },
});
