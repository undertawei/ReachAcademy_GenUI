/**
 * 讲稿任务的恢复描述符已被清理（结构变更或被新任务取代）：worker 不应再写 continuation，
 * 也不必重试，按过时任务一次性终止。
 */
export class ReachDeckWorkspaceJobDescriptorMissingError extends Error {
  constructor() {
    super('Reach Deck staged generation job is no longer registered in workspace recovery');
    this.name = 'ReachDeckWorkspaceJobDescriptorMissingError';
  }
}
