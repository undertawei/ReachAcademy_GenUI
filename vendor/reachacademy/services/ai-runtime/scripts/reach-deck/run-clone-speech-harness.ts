/**
 * Login-free Reach Deck clone-speech experiment.
 *
 * The process serves the real narration editor and a loopback-only model-service proxy. It does not
 * start AI Runtime, Teacher, or any other browser application.
 */
import {
  CLONE_SPEECH_HARNESS_DEFAULT_MODEL_SERVICE_URL,
  normalizeCloneSpeechHarnessCliArguments,
  prepareCloneSpeechHarness,
  resolveCloneSpeechHarnessOutputDirectory,
  startCloneSpeechHarnessServer,
} from './clone-speech-harness.js';

const DEFAULT_OUTPUT_DIRECTORY = 'tmp/reach-deck-clone-speech-harness';
const USAGE = `Usage:
  pnpm --filter @reachany/ai-runtime exec tsx scripts/reach-deck/run-clone-speech-harness.ts [options]

Options:
  --model-service-url <url>  Loopback model-service root (default: REACHANY_MODEL_BASE_URL or http://127.0.0.1:8100)
  --output-dir <tmp/path>    Generated bundle directory (default: ${DEFAULT_OUTPUT_DIRECTORY})
  --port <0-65535>           Harness port; 0 chooses a free port (default: 0)
  --help                     Print this contract
`;

interface CliOptions {
  modelServiceUrl: string;
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
  const supported = new Set(['--help', '--model-service-url', '--output-dir', '--port']);
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
    modelServiceUrl:
      optionValue(argv, '--model-service-url') ??
      process.env.REACHANY_MODEL_BASE_URL ??
      CLONE_SPEECH_HARNESS_DEFAULT_MODEL_SERVICE_URL,
    outputDirectory: resolveCloneSpeechHarnessOutputDirectory(
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
  const argv = normalizeCloneSpeechHarnessCliArguments(process.argv.slice(2));
  if (argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const options = parseOptions(argv);
  const prepared = await prepareCloneSpeechHarness({
    outputDirectory: options.outputDirectory,
  });
  const harness = await startCloneSpeechHarnessServer({
    modelServiceUrl: options.modelServiceUrl,
    outputDirectory: prepared.outputDirectory,
    port: options.port,
  });
  console.log(`Reach Deck clone-speech harness: ${harness.origin}`);
  console.log('Press Ctrl+C to stop.');
  await waitUntilStopped(harness.close);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
