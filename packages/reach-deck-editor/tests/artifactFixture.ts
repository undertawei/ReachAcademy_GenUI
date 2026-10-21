import type {
  GeneratedSceneArtifact,
  NativeSlideArtifact,
  GenerationSceneType,
  SlideGenerationMetadata,
} from '@reachany/reach-deck-dsl';
import { richTextFromPlainText } from '@reachany/reach-deck-dsl';

const generatedAt = '2026-07-18T03:00:00.000Z';

export function artifactFor(
  sceneType: GenerationSceneType,
  pageId = `${sceneType}-page`,
): Exclude<GeneratedSceneArtifact, NativeSlideArtifact> {
  const identity = {
    runId: 'run-preview',
    pageId,
    requestedRevision: 2,
    attempt: 1,
    status: 'ready' as const,
    generatedAt,
  };
  switch (sceneType) {
    case 'slide':
      return {
        ...identity,
        sceneType: 'slide',
        scene: {
          id: `${pageId}-scene`,
          title: 'Slide candidate',
          layout: 'freeform',
          duration: 8,
          background: '#ffffff',
          elements: [
            {
              id: 'title-element',
              type: 'text',
              frame: { x: 80, y: 72, width: 1100, height: 120 },
              layer: 1,
              doc: richTextFromPlainText('Actual generated slide'),
              variant: 'title',
            },
            {
              id: 'body-element',
              type: 'text',
              frame: { x: 80, y: 240, width: 1100, height: 300 },
              layer: 2,
              doc: richTextFromPlainText('Candidate body'),
              variant: 'body',
            },
          ],
          animations: [],
          voiceTimeline: [],
        },
        generationMetadata: slideMetadata(pageId),
      };
    case 'quiz':
      return {
        ...identity,
        sceneType: 'quiz',
        scene: {
          schemaVersion: 'reach-quiz-scene/v1',
          id: pageId,
          title: 'Quiz candidate',
          sceneType: 'quiz',
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
                question: richTextFromPlainText('The candidate is visible.'),
                question_index: 1,
                question_type: 'single_choice',
                sub_problems: [],
              },
            ],
            display_mode: 'single_question',
            navigation: 'horizontal',
            show_progress: true,
            show_question_index: true,
            answer_reveal: 'after_submit',
            allow_previous: true,
            allow_skip: false,
          },
        },
      };
    case 'interactive':
      return {
        ...identity,
        sceneType: 'interactive',
        scene: {
          schemaVersion: 'reach-interactive-scene/v2',
          id: pageId,
          title: 'Interactive candidate',
          sceneType: 'interactive',
          documentHtml:
            '<!doctype html><html><head><style>body{margin:0}</style></head><body>Preview</body></html>',
          bridgeVersion: 'reach-interactive-bridge/v1',
          runtimePolicy: {
            completionMode: 'explicit',
            allowReset: true,
            maximumDurationSeconds: null,
          },
          eventManifest: {
            schemaVersion: 'reach-interactive-event-manifest/v1',
            events: [],
          },
        },
      };
  }
}

function slideMetadata(pageId: string): SlideGenerationMetadata {
  return {
    blueprint: {
      pageId,
      learningGoal: 'Review the generated artifact',
      keyMessage: 'The artifact must be inspected before apply.',
      audienceAssumption: 'Teacher',
      narrativeRole: 'explain',
      contentUnits: [
        { id: 'claim', role: 'claim', text: 'Inspect the candidate', priority: 'primary' },
      ],
      desiredStudentAttention: 'The candidate',
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
    layoutReferences: [{ id: 'single_focus-statement-v1', version: 1, score: 165 }],
    promptVersion: 'staged-v1',
  };
}
