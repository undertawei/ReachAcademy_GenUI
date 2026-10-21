/**
 * 不依赖任何运行时库的进程模式判定。
 *
 * 单独成文件是为了让 `instrumentation.ts` 只为读两个环境变量而引入它时，
 * 不会连带把 `lib/env.ts` 顶层的 undici 拉进 Next 的 server bundle——
 * undici 的 mock 子模块 import `node:console`，webpack 解析不了这个 scheme，
 * 整个 instrumentation 会编译失败。
 */

export type RuntimeEnv = Partial<Record<string, string | undefined>>;

/** 运行时是否处于 mock 模式（不调用真实供应商）。 */
export function isRuntimeMockMode(env: RuntimeEnv = process.env): boolean {
  return env.REACHANY_MOCK_MODE === '1' || env.AI_RUNTIME_MOCK_MODE === '1';
}
