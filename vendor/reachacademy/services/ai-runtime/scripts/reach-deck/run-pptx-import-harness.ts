/**
 * Login-free PPTX import harness.
 *
 * It runs the real `parsePptx` + `mapPptxPresentationToReachDeckV2` pipeline and
 * the production `preflightReachDeckPptx` gate over one or more local .pptx
 * files, then serves the real `NativeV2SlideRenderer` next to that package's
 * diagnostics over local HTTP. It loads no env file, starts no product service,
 * and calls neither content-service nor model-service.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { resolveTemporaryOutputDirectory } from './player-harness.js';
import {
  analyzePptxImportCase,
  preparePptxImportHarness,
  startPptxImportHarnessServer,
  type HarnessAssetFile,
  type PptxImportHarnessCase,
} from './pptx-import-harness.js';

const DEFAULT_OUTPUT_DIRECTORY = 'tmp/reach-deck-pptx-import-harness';
const USAGE = `Usage:
  pnpm --filter @reachany/ai-runtime accept:pptx-import-harness -- [options]

Input (repeatable; at least one is required):
  --pptx <path>        A local .pptx file
  --pptx-dir <path>    Every .pptx directly inside a local directory

Output:
  --output-dir <tmp/path>  Artifact directory (default: ${DEFAULT_OUTPUT_DIRECTORY})
  --serve                  Keep a local HTTP viewer open after preparation
  --port <0-65535>         Viewer port; 0 chooses a free port (default: 0)
  --help                   Print this contract

canApply / canApplyDegraded come from the production preflight in
services/ai-runtime/lib/reach-deck/pptx-import.ts — the harness never restates
that gate. Media bytes stay on disk under the output directory instead of being
uploaded through content-service.
`;

interface CliOptions {
  files: string[];
  outputDirectory: string;
  port: number;
  serve: boolean;
}

const optionValues = (argv: readonly string[], name: string): string[] => {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    values.push(value);
  }
  return values;
};

const optionValue = (argv: readonly string[], name: string): string | undefined => {
  const values = optionValues(argv, name);
  if (values.length > 1) throw new Error(`${name} must be supplied at most once.`);
  return values[0];
};

/** Refuses env material; .pptx inputs are otherwise free to live outside the repository. */
const resolvePptxInput = async (requested: string): Promise<string> => {
  const file = path.resolve(requested);
  const relative = path.relative(process.cwd(), file).split(path.sep);
  if (relative[0] === 'infra' && relative[1] === 'env') {
    throw new Error('--pptx must not point into infra/env.');
  }
  if (!file.toLowerCase().endsWith('.pptx')) throw new Error(`${requested} is not a .pptx file.`);
  const stats = await stat(file);
  if (!stats.isFile()) throw new Error(`${requested} is not a file.`);
  return file;
};

const parseOptions = async (argv: readonly string[]): Promise<CliOptions> => {
  const direct = await Promise.all(optionValues(argv, '--pptx').map(resolvePptxInput));
  const fromDirectories: string[] = [];
  for (const directory of optionValues(argv, '--pptx-dir')) {
    const root = path.resolve(directory);
    const entries = await readdir(root, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pptx'))
      .map((entry) => path.join(root, entry.name))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    if (files.length === 0) throw new Error(`${directory} contains no .pptx file.`);
    for (const file of files) fromDirectories.push(await resolvePptxInput(file));
  }
  const files = [...new Set([...direct, ...fromDirectories])];
  if (files.length === 0) throw new Error('At least one --pptx or --pptx-dir is required.');
  const port = Number(optionValue(argv, '--port') ?? '0');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('--port must be an integer from 0 through 65535.');
  }
  return {
    files,
    outputDirectory: resolveTemporaryOutputDirectory(
      optionValue(argv, '--output-dir') ?? DEFAULT_OUTPUT_DIRECTORY,
    ),
    port,
    serve: argv.includes('--serve'),
  };
};

const waitUntilStopped = (close: () => Promise<void>): Promise<void> =>
  new Promise((resolve, reject) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      close().then(resolve, reject);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

/**
 * The import gate refuses only an unreadable file, so `canApply` no longer says
 * anything about fidelity. This harness exists to measure fidelity, so it
 * reports what was lost.
 */
const lostContent = (value: PptxImportHarnessCase): boolean =>
  value.severityCounts.error + value.severityCounts.fatal > 0;

const verdict = (value: PptxImportHarnessCase): string =>
  !value.canApply && !value.canApplyDegraded ? 'blocked' : lostContent(value) ? 'lossy' : 'clean';

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const options = await parseOptions(argv);
  await rm(options.outputDirectory, { recursive: true, force: true });

  const assetFiles = new Map<string, HarnessAssetFile>();
  const cases: PptxImportHarnessCase[] = [];
  for (const [index, file] of options.files.entries()) {
    process.stdout.write(`[${index + 1}/${options.files.length}] ${path.basename(file)} … `);
    try {
      const value = await analyzePptxImportCase({ file, index }, assetFiles);
      cases.push(value);
      console.log(
        `${verdict(value)} · ${value.slideCount} slides · pages ok/warn/err ` +
          `${value.pageStatusCounts.ok}/${value.pageStatusCounts.warning}/${value.pageStatusCounts.error}` +
          ` · diagnostics ${value.diagnosticCount} (distinct ${value.distinctDiagnosticCount})`,
      );
    } catch (error) {
      console.log(`failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  const prepared = await preparePptxImportHarness({
    assetFiles,
    cases,
    outputDirectory: options.outputDirectory,
  });
  const blocked = cases.filter((value) => !value.canApply && !value.canApplyDegraded).length;
  const lossy = cases.filter((value) => lostContent(value)).length - blocked;
  console.log(
    `\nclean ${cases.length - lossy - blocked}/${cases.length} · lossy ${lossy} · unreadable ${blocked}`,
  );
  console.log(`Artifacts: ${prepared.outputDirectory}`);

  if (!options.serve) {
    console.log('Run again with --serve to open the local viewer.');
    return;
  }
  const local = await startPptxImportHarnessServer(options.outputDirectory, options.port);
  console.log(`Harness: ${local.origin}`);
  console.log('Press Ctrl+C to stop the local viewer.');
  try {
    await waitUntilStopped(local.close);
  } finally {
    if (local.server.listening) await local.close();
  }
};

await main();
