/**
 * Stable Feedforward import path for the shared Portal/agent TipTap semantic contract.
 *
 * Keeping this re-export avoids call-site churn while ensuring persisted node names and
 * empty-content detection are owned by one workspace package.
 */
export { tiptapToPlainText } from '@reachany/quiz-markdown-contract';
