import type { InteractiveScene } from '@reachany/reach-deck-dsl';

export type { InteractiveScene } from '@reachany/reach-deck-dsl';

export interface ProjectSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface Project extends ProjectSummary {
  schemaVersion: 'genui-workbench-project/v1';
  createdAt: string;
  instruction: string;
  scene: InteractiveScene;
}

export interface StatusResponse {
  configured: boolean;
  model: string;
  baseUrl: string;
  promptVersion: string;
}

export interface GenerateRequest {
  instruction: string;
  title?: string;
  scene?: InteractiveScene;
  systemPrompt?: string;
}

export interface GenerateResponse {
  scene: InteractiveScene;
  promptVersion: string;
}

export interface ApiErrorResponse {
  error: string;
  code: string;
}
