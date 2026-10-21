import type { RunRecord } from './contracts.js';

export interface TutorDirectorContext {
  candidateIds: string[];
  replyTargetIds: string[];
}

// Execution-local transport evidence. Model-service remains the durable authority.
const turns = new WeakMap<
  RunRecord,
  { turnId: string; input: string; reviewed?: boolean; receipt?: string }
>();

export function bindTutorTurn(run: RunRecord, turnId: string): void {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(turnId)) throw new Error('TUTOR_INPUT_TURN_INVALID');
  turns.set(run, {
    turnId,
    input: String(run.input.message),
  });
}

export function tutorTurn(run: RunRecord) {
  const current = turns.get(run);
  if (current && current.input === run.input.message) return current;
  bindTutorTurn(run, current?.turnId ?? run.id);
  return turns.get(run)!;
}

export function recordTutorReview(run: RunRecord, receipt?: string): void {
  const current = tutorTurn(run);
  current.reviewed = true;
  current.receipt = receipt;
}
