import { isRuntimeMockMode, type RuntimeEnv } from './runtime-mode.js';

export const MODEL_MOCK_CONTRACT_VERSION = 'student-load/model-mock/v1';

/** Server configuration only; never derive execution requirements from request data. */
export function modelExecutionClaims(env: RuntimeEnv = process.env): Record<string, string> {
  const configuredMode = env.REACHANY_MODEL_EXECUTION_MODE;
  const hash = env.REACHANY_MODEL_MOCK_CONTRACT_SHA256;
  const mode = configuredMode === undefined ? 'provider' : configuredMode;
  if (mode !== 'provider' && mode !== 'mock-only') {
    throw new Error('model_execution_configuration_invalid');
  }
  if (mode === 'provider') {
    if (hash !== undefined) throw new Error('model_execution_configuration_invalid');
    return {};
  }
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || isRuntimeMockMode(env)) {
    throw new Error('model_execution_configuration_invalid');
  }
  return {
    model_execution_requirement: 'mock-only',
    model_execution_contract_version: MODEL_MOCK_CONTRACT_VERSION,
    model_execution_contract_sha256: hash,
  };
}
