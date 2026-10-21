/**
 * 免登录 Reach Deck 四阶段调试工作台的启动入口。
 *
 * 它只起一个回环 HTTP 服务并把请求代理到真实 AI Runtime；不启动 AI Runtime、
 * worker、model-service 或 content-service——那些必须按 README 的顺序单独起好。
 */
import {
  normalizeDeckHarnessCliArguments,
  unconfiguredDeckHarnessIdentityKeys,
  DECK_HARNESS_DEFAULT_AI_RUNTIME_URL,
  prepareDeckHarness,
  readDeckHarnessScopeConfig,
  resolveDeckHarnessOutputDirectory,
  startDeckHarnessServer,
} from './deck-harness.js';
import { isReachDeckHarnessModeEnabled } from '../../lib/reach-deck/harness-mode.js';

const DEFAULT_OUTPUT_DIRECTORY = 'tmp/reach-deck-harness';
const USAGE = `Usage:
  pnpm --filter @reachany/ai-runtime harness:deck -- [options]

Options:
  --ai-runtime-url <url>   Loopback AI Runtime root (default: REACHANY_AI_RUNTIME_BASE_URL or ${DECK_HARNESS_DEFAULT_AI_RUNTIME_URL})
  --output-dir <tmp/path>  Generated bundle directory (default: ${DEFAULT_OUTPUT_DIRECTORY})
  --port <0-65535>         Harness port; 0 chooses a free port (default: 0)
  --help                   Print this contract

The harness drives the real AI Runtime API and worker. Start those first, along with
model-service and content-service, and point the debug course scope at a course that
actually exists. See scripts/reach-deck/README.md.
`;

interface CliOptions {
  aiRuntimeUrl: string;
  outputDirectory: string;
  port: number;
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function parseOptions(argv: readonly string[]): CliOptions {
  const supported = new Set(['--help', '--ai-runtime-url', '--output-dir', '--port']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!supported.has(argument)) throw new Error(`Unknown option: ${argument}`);
    if (argument !== '--help') index += 1;
  }
  const port = Number(optionValue(argv, '--port') ?? '0');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('--port must be an integer from 0 through 65535.');
  }
  return {
    aiRuntimeUrl:
      optionValue(argv, '--ai-runtime-url') ??
      process.env.REACHANY_AI_RUNTIME_BASE_URL ??
      DECK_HARNESS_DEFAULT_AI_RUNTIME_URL,
    outputDirectory: resolveDeckHarnessOutputDirectory(
      optionValue(argv, '--output-dir') ?? DEFAULT_OUTPUT_DIRECTORY,
    ),
    port,
  };
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
  const options = parseOptions(argv);
  const scope = readDeckHarnessScopeConfig();
  const prepared = await prepareDeckHarness({ outputDirectory: options.outputDirectory });
  const harness = await startDeckHarnessServer({
    aiRuntimeUrl: options.aiRuntimeUrl,
    outputDirectory: prepared.outputDirectory,
    port: options.port,
    scope,
  });
  console.log(`Reach Deck harness: ${harness.origin}`);
  if (process.env.REACH_DECK_HARNESS_HTML_LAYOUT === 'on') {
    console.log(
      'Stage 3 HTML layout trial: browser memory only; model calls are real and billable.',
    );
    console.log('Press Ctrl+C to stop.');
    await waitUntilStopped(harness.close);
    return;
  }
  console.log(`Upstream AI Runtime: ${options.aiRuntimeUrl}`);
  console.log(`Debug course module: ${scope.moduleId} (draft)`);
  const unconfigured = unconfiguredDeckHarnessIdentityKeys();
  if (unconfigured.length > 0) {
    // 这两项造不了假：ai_run 的外键指向真实的 organization/account。
    console.warn(
      `${unconfigured.join(' and ')} still use built-in defaults. Generation will fail on an ` +
        'ai_run foreign key until they name a real organization and account. ' +
        'See scripts/reach-deck/README.md, "One-time setup".',
    );
  }
  if (!isReachDeckHarnessModeEnabled()) {
    console.warn(
      'REACH_DECK_HARNESS_MODE is not "on": prompt snippet overrides will be rejected and ' +
        'composed prompts will not be captured. Set it on the AI Runtime API and worker too.',
    );
  }
  // 数据落在哪取决于 AI Runtime 指向的 content-service：内存替身只在进程内留痕，
  // 真实 content-service 则会写进共享库。模型与 TTS 调用两种模式下都是真的。
  console.warn(
    'Model and TTS calls are real and billable. Where data lands depends on the ' +
      'content-service AI Runtime points at (harness:content keeps it in memory).',
  );
  console.log('Press Ctrl+C to stop.');
  await waitUntilStopped(harness.close);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
