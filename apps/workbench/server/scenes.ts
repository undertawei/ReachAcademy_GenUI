import { randomUUID } from 'node:crypto';
import { parseInteractiveSceneValue, type InteractiveScene } from '@reachany/reach-deck-dsl';
import {
  assertFunctionPlotMarkersAreValid,
  assertInteractiveComponentMarkersAreValid,
  assertInteractiveDocumentStaticallyCompiles,
  assertRuntimeDependenciesMatchDocument,
  inferInteractiveRuntimeDependencies,
} from '../../../vendor/reachacademy/services/ai-runtime/lib/reach-deck/interactive-generation-validation.js';
import { HttpError, requestObject, textField, validationMessage } from './errors.js';
import { assertInteractiveInitializationContract } from './initialization.js';

/** Imported/previously saved scenes may legitimately have no narration. */
export async function validateScene(value: unknown): Promise<InteractiveScene> {
  try {
    const scene = parseInteractiveSceneValue(value);
    assertInteractiveComponentMarkersAreValid(scene.documentHtml);
    assertFunctionPlotMarkersAreValid(scene.documentHtml);
    const withDependencies =
      scene.runtimeDependencies === undefined
        ? { ...scene, runtimeDependencies: inferInteractiveRuntimeDependencies(scene.documentHtml) }
        : scene;
    assertRuntimeDependenciesMatchDocument(withDependencies);
    await assertInteractiveDocumentStaticallyCompiles(scene.documentHtml);
    assertInteractiveInitializationContract(scene.documentHtml);
    return withDependencies;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, 'invalid_scene', `互动页面校验失败：${validationMessage(error)}`);
  }
}

export async function validateRequest(value: unknown): Promise<InteractiveScene> {
  const body = requestObject(value, ['scene', 'html', 'title']);
  if (body.scene !== undefined && body.html !== undefined) {
    throw new HttpError(400, 'invalid_request', 'scene 和 html 只能提供其中一个。');
  }
  if (body.scene !== undefined) return validateScene(body.scene);
  const html = textField(body.html, 'HTML', 524288)!;
  const title = textField(body.title, '标题', 200, true) ?? '导入的互动页面';
  let runtimeDependencies;
  try {
    runtimeDependencies = inferInteractiveRuntimeDependencies(html);
  } catch (error) {
    throw new HttpError(422, 'invalid_scene', `互动页面校验失败：${validationMessage(error)}`);
  }
  return validateScene({
    schemaVersion: 'reach-interactive-scene/v2',
    id: `interactive-${randomUUID()}`,
    title,
    sceneType: 'interactive',
    documentHtml: html,
    bridgeVersion: 'reach-interactive-bridge/v1',
    runtimePolicy: { completionMode: 'none', allowReset: true, maximumDurationSeconds: null },
    eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
    runtimeDependencies,
  });
}
