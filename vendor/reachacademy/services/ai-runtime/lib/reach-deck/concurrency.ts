/**
 * 有界并发执行助手。
 *
 * 数据源：无 PG/Mongo 读写；纯内存调度。
 *
 * 核心逻辑：起 min(concurrency, 任务数) 个 worker 共享一个游标，各自取下一个下标执行，
 * 结果按输入顺序写回。顺序保证是关键：调用方常要按原顺序拼接结果（如讲稿分块的音频
 * 与时间戳偏移），按完成先后收集会静默错位。
 */
export async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await operation(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, values.length)) }, () => worker()),
  );
  return results;
}

/**
 * 有界并发查找：任一任务给出结果即停止派发新任务并返回该结果，全部无结果时返回 undefined。
 *
 * 数据源：无 PG/Mongo 读写；纯内存调度。
 *
 * 核心逻辑：与 mapWithConcurrency 共用游标模型，命中或出错后各 worker 只跑完手上的任务。
 * 已有命中时以命中结果为准，不再抛出其它任务的错误；没有命中才在全部在途任务结束后
 * 抛出首个错误。命中结果不保证是输入顺序里的第一个，只适合「任一命中即可」的判定。
 */
export async function findWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<U | undefined>,
): Promise<U | undefined> {
  let cursor = 0;
  const state: { found?: { readonly value: U }; failure?: { readonly error: unknown } } = {};
  const worker = async (): Promise<void> => {
    while (state.found === undefined && state.failure === undefined) {
      const index = cursor++;
      if (index >= values.length) return;
      try {
        const result = await operation(values[index]!, index);
        if (result !== undefined) state.found ??= { value: result };
      } catch (error) {
        state.failure ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, values.length)) }, () => worker()),
  );
  if (state.found !== undefined) return state.found.value;
  if (state.failure !== undefined) throw state.failure.error;
  return undefined;
}

/** 每个 key 当前的队尾；队列排空后立刻删除条目，避免长跑进程无界增长。 */
const keyedSerialTails = new Map<string, Promise<unknown>>();

/**
 * 同 key 的操作在本进程内串行执行，不同 key 互不阻塞。
 *
 * 数据源：无 PG/Mongo 读写；纯内存调度。
 *
 * 用途是压掉**进程内**对同一份远端 CAS 文档的自我争用。典型场景：一页讲稿的 3 路分块并发
 * 同时上报 TTS 队列状态，再乘以 worker 的 job 并发——它们写的是同一份按工作区归一的
 * recovery 文档，不串行化就必然在 `recoveryRevision` 上互撞。这不能替代跨进程的退避重试
 * （API pod 与其它 worker 副本仍会并发写），两者是互补的。
 *
 * 核心逻辑：把新操作挂到该 key 的队尾之后，无论前一个成功还是失败都继续（用 catch 吞掉
 * 前驱的 rejection，只用它做时序栅栏），并在自己是队尾时清理 Map 条目。
 */
export async function runSerializedByKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = keyedSerialTails.get(key);
  const result = (
    previous === undefined ? Promise.resolve() : previous.catch(() => undefined)
  ).then(operation);
  // 队尾只用于排序，绝不能让未处理的 rejection 逃逸成进程级 unhandledRejection。
  const tail = result.catch(() => undefined);
  keyedSerialTails.set(key, tail);
  try {
    return await result;
  } finally {
    if (keyedSerialTails.get(key) === tail) keyedSerialTails.delete(key);
  }
}
