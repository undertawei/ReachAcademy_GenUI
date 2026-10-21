const accountingFailures = new WeakSet<object>();

/** 保留原始计费/审计异常身份，避免图片容错把台账失败当作普通素材失败。 */
export function protectReachDeckMediaAccounting<Input>(
  callback: ((input: Input) => void | Promise<void>) | undefined,
): ((input: Input) => Promise<void>) | undefined {
  if (!callback) return undefined;
  return async (input) => {
    try {
      await callback(input);
    } catch (error) {
      if (typeof error === 'object' && error !== null) {
        accountingFailures.add(error);
        throw error;
      }
      const wrapped = new Error('Reach Deck accounting callback failed', { cause: error });
      accountingFailures.add(wrapped);
      throw wrapped;
    }
  };
}

/** 模型适配器可能包装异常；沿 cause 检查同一调用链上的计费和准入边界。 */
export function isReachDeckMediaBoundaryFatal(error: unknown): boolean {
  const visited = new Set<object>();
  let current = error;
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    if (accountingFailures.has(current)) return true;
    const candidate = current as { name?: unknown; cause?: unknown };
    if (
      candidate.name === 'UnrecoverableError' ||
      candidate.name === 'ReachDeckMaterialAdmissionError'
    )
      return true;
    current = candidate.cause;
  }
  return false;
}
