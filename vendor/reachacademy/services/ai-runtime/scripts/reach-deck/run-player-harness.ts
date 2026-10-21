/**
 * Login-free Reach Deck Player harness.
 *
 * It loads a deterministic fixture or a strict reach-deck-document/v2 JSON file, optionally applies
 * preview-only uniform timing to a cloned document, and serves the real ReachDeckPlayer over local
 * HTTP. It starts no product service and never reads or mutates shared course data.
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseReachDeckDocumentV2, type ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';

import {
  applyUniformPlayerHarnessTiming,
  createReachDeckPlayerHarnessFixture,
  type PlayerHarnessFixtureKind,
} from './player-harness-fixtures.js';
import { runReachDeckPlayerHarnessSmoke } from './player-harness-smoke.js';
import { runGeometryPlayerSmoke } from './geometry-player-smoke.js';
import {
  loadPlayerHarnessResourceMap,
  loadStrictReachDeckDocument,
  prepareReachDeckPlayerHarness,
  resolveTemporaryOutputDirectory,
  startReachDeckPlayerHarnessServer,
} from './player-harness.js';

const DEFAULT_OUTPUT_DIRECTORY = 'tmp/reach-deck-player-harness';
const USAGE = `Usage:
  pnpm --filter @reachany/ai-runtime accept:player-harness -- [options]

Input (choose one; default is --fixture scientific):
  --fixture <scientific|mixed|geometry>   Deterministic local fixture; no cloud calls
  --document-file <path>        Strict reach-deck-document/v2 JSON inside this repository
  --resource-map <path>         JSON object: declared media resource id -> repository file

Preview and output:
  --timing <uniform-preview|document>  Preview-only synthetic timing (fixture default) or preserve document timing
  --output-dir <tmp/path>        Artifact directory (default: ${DEFAULT_OUTPUT_DIRECTORY})
  --smoke                        Run desktop/mobile browser acceptance, then exit
  --serve                        Keep a local HTTP viewer open after preparation/smoke
  --port <0-65535>               Viewer port; 0 chooses a free port (default: 0)
  --help                         Print this contract

Synthetic timing is marked harness-preview and does not validate real TTS alignment.
`;

type TimingMode = 'document' | 'uniform-preview';

interface CliOptions {
  documentFile?: string;
  fixture?: PlayerHarnessFixtureKind;
  outputDirectory: string;
  port: number;
  resourceMap?: string;
  serve: boolean;
  smoke: boolean;
  timing: TimingMode;
}

const optionValue = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
};

const parseOptions = (argv: readonly string[]): CliOptions => {
  const documentFile = optionValue(argv, '--document-file');
  const fixtureValue = optionValue(argv, '--fixture');
  if (documentFile !== undefined && fixtureValue !== undefined) {
    throw new Error('--document-file and --fixture are mutually exclusive.');
  }
  if (
    fixtureValue !== undefined &&
    fixtureValue !== 'scientific' &&
    fixtureValue !== 'mixed' &&
    fixtureValue !== 'geometry'
  ) {
    throw new Error('--fixture must be scientific, mixed, or geometry.');
  }
  const fixture = documentFile === undefined ? (fixtureValue ?? 'scientific') : undefined;
  const timingValue =
    optionValue(argv, '--timing') ?? (fixture === undefined ? 'document' : 'uniform-preview');
  if (timingValue !== 'document' && timingValue !== 'uniform-preview') {
    throw new Error('--timing must be document or uniform-preview.');
  }
  const port = Number(optionValue(argv, '--port') ?? '0');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('--port must be an integer from 0 through 65535.');
  }
  return {
    ...(documentFile === undefined ? {} : { documentFile }),
    ...(fixture === undefined ? {} : { fixture }),
    outputDirectory: resolveTemporaryOutputDirectory(
      optionValue(argv, '--output-dir') ?? DEFAULT_OUTPUT_DIRECTORY,
    ),
    port,
    ...(optionValue(argv, '--resource-map') === undefined
      ? {}
      : { resourceMap: optionValue(argv, '--resource-map') }),
    serve: argv.includes('--serve'),
    smoke: argv.includes('--smoke'),
    timing: timingValue,
  };
};

const digest = (document: ReachDeckDocumentV2): string =>
  createHash('sha256').update(JSON.stringify(document)).digest('hex');

const hasRealTtsAlignment = (document: ReachDeckDocumentV2): boolean =>
  document.nativeSlides.length > 0 &&
  document.nativeSlides.every(({ slide }) => {
    const narration = slide.narration;
    return (
      narration?.audioResourceId !== undefined &&
      narration.segments !== undefined &&
      narration.segments.length > 0 &&
      narration.segments.every(
        (segment) =>
          segment.words !== undefined &&
          segment.words.length > 0 &&
          segment.words.every(
            (word) =>
              Number.isFinite(word.start) &&
              Number.isFinite(word.end) &&
              word.start >= 0 &&
              word.end >= word.start,
          ),
      )
    );
  });

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

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const options = parseOptions(argv);
  await rm(options.outputDirectory, { recursive: true, force: true });
  await mkdir(options.outputDirectory, { recursive: true });

  const loaded =
    options.fixture === undefined
      ? {
          document: await loadStrictReachDeckDocument(options.documentFile!),
          assetsByResourceId: undefined,
          source: 'document-file' as const,
        }
      : {
          ...createReachDeckPlayerHarnessFixture(options.fixture),
          source: 'fixture' as const,
        };
  const sourceDocument = parseReachDeckDocumentV2(loaded.document);
  const sourceDigest = digest(sourceDocument);
  const assetsByResourceId =
    loaded.assetsByResourceId ??
    (await loadPlayerHarnessResourceMap(sourceDocument, options.resourceMap));
  const timingResult =
    options.timing === 'uniform-preview'
      ? applyUniformPlayerHarnessTiming(sourceDocument)
      : {
          document: parseReachDeckDocumentV2(sourceDocument),
          evidence: {
            mode: 'document' as const,
            validatesTtsAlignment: hasRealTtsAlignment(sourceDocument),
            slides: [],
          },
        };
  if (digest(sourceDocument) !== sourceDigest) {
    throw new Error('Preview timing mutated the source document.');
  }
  const previewDigest = digest(timingResult.document);

  await Promise.all([
    writeFile(
      path.join(options.outputDirectory, 'source-document.json'),
      `${JSON.stringify(sourceDocument, null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      path.join(options.outputDirectory, 'timing-evidence.json'),
      `${JSON.stringify(
        {
          ...timingResult.evidence,
          sourceDigest,
          previewDigest,
          sourceDocumentUnchanged: digest(sourceDocument) === sourceDigest,
        },
        null,
        2,
      )}\n`,
      'utf8',
    ),
  ]);
  const prepared = await prepareReachDeckPlayerHarness({
    assetsByResourceId,
    document: timingResult.document,
    outputDirectory: options.outputDirectory,
    source: loaded.source,
    timingSource: options.timing,
    validatesTtsAlignment: timingResult.evidence.validatesTtsAlignment,
  });

  if (!options.smoke && !options.serve) {
    console.log(`Prepared Player harness: ${prepared.playerHtml}`);
    console.log('Run again with --serve to view it or --smoke for desktop/mobile acceptance.');
    return;
  }
  const local = await startReachDeckPlayerHarnessServer(options.outputDirectory, options.port);
  console.log(`Player: ${local.origin}`);
  try {
    if (options.smoke) {
      if (options.fixture === 'geometry') await runGeometryPlayerSmoke(prepared, local.origin);
      else await runReachDeckPlayerHarnessSmoke(prepared, local.origin);
      console.log(
        `Smoke evidence: ${path.join(options.outputDirectory, options.fixture === 'geometry' ? 'geometry-smoke-evidence.json' : 'smoke-evidence.json')}`,
      );
    }
    if (options.serve) {
      console.log('Press Ctrl+C to stop the local viewer.');
      await waitUntilStopped(local.close);
    }
  } finally {
    if (local.server.listening) await local.close();
  }
};

await main();
