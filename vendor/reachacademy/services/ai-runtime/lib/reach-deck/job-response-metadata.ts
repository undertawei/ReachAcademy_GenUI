import type {
  ReachDeckStagedGenerationJobPayload,
  ReachDeckStagedGenerationResult,
} from './contracts.js';

export interface ReachDeckJobResponseMetadata {
  sourceKind?:
    | 'workspace'
    | 'workspace-interactive'
    | 'materialized-native'
    | 'materialized-interactive';
  affectedLanes?: ('layout' | 'narration' | 'audio' | 'animation' | 'image')[];
}

/** 从私有载荷派生公开通道；纯图片通道另存恢复描述符，避免批次清理后丢失。 */
export function reachDeckJobResponseMetadata(
  payload: ReachDeckStagedGenerationJobPayload | undefined,
  result?: ReachDeckStagedGenerationResult,
): ReachDeckJobResponseMetadata {
  if (payload?.kind === 'page-generation')
    return {
      sourceKind: 'workspace',
      affectedLanes:
        payload.request.regenerationPlan?.channels.image &&
        !payload.request.regenerationPlan.channels.layout
          ? ['image']
          : ['layout'],
    };
  if (payload?.kind === 'narration-generation') {
    const request = payload.request;
    const sourceKind = request.sourceKind ?? 'workspace';
    if (request.textOnly === true) return { sourceKind, affectedLanes: ['narration'] };
    if (request.sourceKind === 'materialized-native') {
      if (request.mode === 'saved-content') {
        return {
          sourceKind,
          affectedLanes:
            request.animationMode === 'animations'
              ? ['animation']
              : request.animationMode === 'regenerate'
                ? ['audio', 'animation']
                : ['audio'],
        };
      }
      return { sourceKind, affectedLanes: ['narration', 'audio', 'animation'] };
    }
    if (request.sourceKind === 'materialized-interactive') {
      return {
        sourceKind,
        affectedLanes: request.mode === 'regenerate-text' ? ['narration', 'audio'] : ['audio'],
      };
    }
    return {
      sourceKind,
      affectedLanes:
        sourceKind === 'workspace-interactive'
          ? ['narration', 'audio']
          : ['narration', 'audio', 'animation'],
    };
  }
  if (result?.kind === 'narration-generation') {
    if ('nativeNarration' in result) {
      const product = result.nativeNarration;
      return {
        sourceKind: 'materialized-native',
        ...(product.textOnly === true ? { affectedLanes: ['narration'] as const } : {}),
      };
    }
    return { sourceKind: 'artifact' in result ? 'workspace' : 'materialized-interactive' };
  }
  return {};
}
