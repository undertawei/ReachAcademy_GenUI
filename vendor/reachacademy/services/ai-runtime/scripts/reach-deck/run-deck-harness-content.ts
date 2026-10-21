/**
 * 内存版 content-service 的启动入口。
 *
 * 先起它，再把 AI Runtime API 与 worker 的 `REACHANY_CONTENT_BASE_URL` 指过来，
 * 生成编排就能在没有真实课程、不写共享库的前提下完整跑通。详见
 * scripts/reach-deck/README.md。
 */
import path from 'node:path';

import {
  normalizeDeckHarnessCliArguments,
  readDeckHarnessScopeConfig,
  resolveDeckHarnessOutputDirectory,
} from './deck-harness.js';
import { startDeckHarnessContentService } from './deck-harness-content-service.js';

/** 固定默认端口：AI Runtime 需要在启动前就知道往哪儿指。 */
const DEFAULT_PORT = 8001;
const DEFAULT_MEDIA_DIRECTORY = 'tmp/reach-deck-harness-media';
const USAGE = `Usage:
  pnpm --filter @reachany/ai-runtime harness:content -- [options]

Options:
  --port <0-65535>         Listen port (default: ${DEFAULT_PORT})
  --media-dir <tmp/path>   Where generated image/audio bytes are also written (default: ${DEFAULT_MEDIA_DIRECTORY})
  --help                   Print this contract

Then start AI Runtime and its worker against it:
  REACHANY_CONTENT_BASE_URL=http://127.0.0.1:${DEFAULT_PORT}
`;

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function waitUntilStopped(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      close().then(resolve, reject);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function main(): Promise<void> {
  const argv = normalizeDeckHarnessCliArguments(process.argv.slice(2));
  if (argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  for (let index = 0; index < argv.length; index += 1) {
    if (!['--port', '--media-dir'].includes(argv[index]!)) {
      throw new Error(`Unknown option: ${argv[index]}`);
    }
    index += 1;
  }
  const port = Number(optionValue(argv, '--port') ?? String(DEFAULT_PORT));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('--port must be an integer from 0 through 65535.');
  }
  const mediaDirectory = resolveDeckHarnessOutputDirectory(
    optionValue(argv, '--media-dir') ?? DEFAULT_MEDIA_DIRECTORY,
  );
  const harnessScope = readDeckHarnessScopeConfig();
  const service = await startDeckHarnessContentService({
    scope: {
      organizationId: harnessScope.organizationId,
      courseId: harnessScope.courseId,
      courseNodeId: harnessScope.courseNodeId,
      moduleId: harnessScope.moduleId,
      moduleVersionId: harnessScope.moduleVersionId,
      moduleTitle: harnessScope.moduleTitle ?? 'Deck Harness 调试模块',
    },
    mediaDirectory,
    port,
  });
  console.log(`Reach Deck harness content-service: ${service.origin}`);
  console.log(`Point AI Runtime at it: REACHANY_CONTENT_BASE_URL=${service.origin}`);
  console.log(`Generated media also written to ${path.relative(process.cwd(), mediaDirectory)}`);
  console.log('In-memory only: everything is lost when this process exits.');
  console.log('Press Ctrl+C to stop.');
  await waitUntilStopped(service.close);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
