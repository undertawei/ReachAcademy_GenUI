/**
 * Sequential manifest runner for the production-faithful offline Reach Deck acceptance harness.
 * It deliberately starts no product service and keeps every generated artifact under tmp/ or .tmp/.
 */
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../..');
const SINGLE_RUNNER = path.join(import.meta.dirname, 'run-offline-generation-acceptance.ts');
const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'));
const DEFAULT_OUTPUT_DIRECTORY = path.join(REPOSITORY_ROOT, 'tmp/reach-deck-generation-batch');
const USAGE = `Usage:
  pnpm --filter @reachany/ai-runtime accept:generation-offline:batch -- \\
    --manifest <path> [--output-dir <tmp/path>] [--validate-only]

The manifest is JSON with defaults plus 1-20 cases. Each case may set id, sourceFile, pages,
media, model, and runs. Jobs run sequentially; failures are recorded and the command exits non-zero
after writing the aggregate report and gallery.

--validate-only parses and expands the manifest without calling models or touching output files.
`;

type MediaMode = 'auto' | 'off';

interface BatchDefaults {
  pages?: number;
  media?: MediaMode;
  model?: string;
  runs?: number;
}

interface BatchCase extends BatchDefaults {
  id: string;
  sourceFile?: string;
}

interface BatchManifest {
  name?: string;
  defaults?: BatchDefaults;
  cases: BatchCase[];
}

interface SingleRunReport {
  model: string;
  sourceDigest: string;
  actualPageCount: number;
  plannedImageCount: number;
  generatedImageCount: number;
  pages: Array<{
    status: string;
    imageCount: number;
    warningCount?: number;
  }>;
}

interface BatchRunResult {
  caseId: string;
  run: number;
  status: 'passed' | 'failed';
  relativeDirectory: string;
  error?: string;
  report?: SingleRunReport;
}

interface NormalizedJob {
  caseId: string;
  run: number;
  sourceFile?: string;
  pages: number;
  media: MediaMode;
  model?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionValue = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
};

const childOfTemporaryRoot = (requested: string | undefined): string => {
  const outputDirectory = requested
    ? path.resolve(REPOSITORY_ROOT, requested)
    : DEFAULT_OUTPUT_DIRECTORY;
  const allowed = ['tmp', '.tmp'].some((directory) => {
    const root = path.join(REPOSITORY_ROOT, directory);
    const relative = path.relative(root, outputDirectory);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  if (!allowed) throw new Error('The batch output directory must be below tmp/ or .tmp/.');
  return outputDirectory;
};

const resolveSourceFile = (requested: string): string => {
  const sourceFile = path.resolve(REPOSITORY_ROOT, requested);
  const relative = path.relative(REPOSITORY_ROOT, sourceFile);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Source file must be inside this repository: ${requested}`);
  }
  const segments = relative.split(path.sep);
  if (segments[0] === 'infra' && segments[1] === 'env') {
    throw new Error(`Source file must not point into infra/env: ${requested}`);
  }
  return sourceFile;
};

const resolveManifestFile = (requested: string): string => {
  const manifestFile = path.resolve(REPOSITORY_ROOT, requested);
  const relative = path.relative(REPOSITORY_ROOT, manifestFile);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('--manifest must resolve to a file inside this repository.');
  }
  const segments = relative.split(path.sep);
  if (segments[0] === 'infra' && segments[1] === 'env') {
    throw new Error('--manifest must not point into infra/env.');
  }
  return manifestFile;
};

const integerInRange = (
  value: unknown,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number => {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || Number(resolved) < minimum || Number(resolved) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(resolved);
};

const optionalString = (value: unknown, name: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
};

const mediaMode = (value: unknown, fallback: MediaMode, name: string): MediaMode => {
  const resolved = value === undefined ? fallback : value;
  if (resolved !== 'auto' && resolved !== 'off') {
    throw new Error(`${name} must be auto or off.`);
  }
  return resolved;
};

const parseDefaults = (value: unknown, name: string): BatchDefaults => {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${name} must be an object.`);
  return {
    ...(value.pages === undefined
      ? {}
      : { pages: integerInRange(value.pages, 5, `${name}.pages`, 3, 10) }),
    ...(value.media === undefined
      ? {}
      : { media: mediaMode(value.media, 'auto', `${name}.media`) }),
    ...(value.model === undefined ? {} : { model: optionalString(value.model, `${name}.model`) }),
    ...(value.runs === undefined
      ? {}
      : { runs: integerInRange(value.runs, 1, `${name}.runs`, 1, 10) }),
  };
};

const parseManifest = (value: unknown): BatchManifest => {
  if (!isRecord(value)) throw new Error('Batch manifest must be a JSON object.');
  const name = optionalString(value.name, 'name');
  const defaults = parseDefaults(value.defaults, 'defaults');
  if (!Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 20) {
    throw new Error('cases must contain between 1 and 20 entries.');
  }
  const seen = new Set<string>();
  const cases = value.cases.map((entry, index): BatchCase => {
    const label = `cases[${index}]`;
    if (!isRecord(entry)) throw new Error(`${label} must be an object.`);
    const id = optionalString(entry.id, `${label}.id`);
    if (id === undefined || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      throw new Error(`${label}.id must match ^[a-z0-9][a-z0-9_-]{0,63}$.`);
    }
    if (seen.has(id)) throw new Error(`Duplicate batch case id: ${id}`);
    seen.add(id);
    return {
      id,
      ...parseDefaults(entry, label),
      ...(entry.sourceFile === undefined
        ? {}
        : { sourceFile: optionalString(entry.sourceFile, `${label}.sourceFile`) }),
    };
  });
  return { ...(name === undefined ? {} : { name }), defaults, cases };
};

const jobsFor = (manifest: BatchManifest): NormalizedJob[] => {
  const jobs = manifest.cases.flatMap((entry) => {
    const runs = entry.runs ?? manifest.defaults?.runs ?? 1;
    const pages = entry.pages ?? manifest.defaults?.pages ?? 5;
    const media = entry.media ?? manifest.defaults?.media ?? 'auto';
    const model = entry.model ?? manifest.defaults?.model;
    return Array.from({ length: runs }, (_, index) => ({
      caseId: entry.id,
      run: index + 1,
      ...(entry.sourceFile === undefined ? {} : { sourceFile: entry.sourceFile }),
      pages,
      media,
      ...(model === undefined ? {} : { model }),
    }));
  });
  if (jobs.length > 50) throw new Error('A batch may contain at most 50 total runs.');
  return jobs;
};

const escapeHtml = (value: unknown): string =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

const runChild = (args: string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, SINGLE_RUNNER, ...args], {
      cwd: REPOSITORY_ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error(`Offline generation terminated by ${signal}.`));
      else resolve(code ?? 1);
    });
  });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const buildGallery = (name: string, results: BatchRunResult[]): string => {
  const cards = results
    .map((result) => {
      const href = `${result.relativeDirectory}/index.html`;
      const image = `${result.relativeDirectory}/contact-sheet.png`;
      const report = result.report;
      const warningCounts = report?.pages.flatMap((page) =>
        page.warningCount === undefined ? [] : [page.warningCount],
      );
      const warningSummary =
        warningCounts === undefined || warningCounts.length === 0
          ? ''
          : ` · ${warningCounts.reduce((total, count) => total + count, 0)} warnings`;
      const summary =
        report === undefined
          ? escapeHtml(result.error ?? 'Run failed before producing a report.')
          : `${report.actualPageCount} pages · ${report.generatedImageCount}/${report.plannedImageCount} images${warningSummary} · ${escapeHtml(report.model)}`;
      return `<article class="${result.status}"><header><strong>${escapeHtml(result.caseId)}</strong><span>run ${result.run}</span><b>${result.status}</b></header><p>${summary}</p>${result.status === 'passed' ? `<a href="${href}"><img src="${image}" alt="${escapeHtml(result.caseId)} run ${result.run} contact sheet"></a>` : ''}</article>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(name)}</title><style>:root{font-family:Inter,system-ui,sans-serif;color:#17212b;background:#e9eef2}*{box-sizing:border-box}body{margin:0}main{width:min(1800px,100%);margin:auto;padding:28px}h1{margin:0 0 20px}article{background:#fff;border:1px solid #d3dce3;margin:0 0 28px;padding:18px}article.failed{border-color:#d97777}header{display:flex;gap:14px;align-items:center;margin-bottom:8px}header span{color:#667582}header b{margin-left:auto;text-transform:uppercase}.passed header b{color:#17623c}.failed header b{color:#a42828}p{color:#566572}a,img{display:block;width:100%}img{height:auto;border:1px solid #d3dce3}</style></head><body><main><h1>${escapeHtml(name)}</h1>${cards}</main></body></html>`;
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const manifestArgument = optionValue(argv, '--manifest');
  if (manifestArgument === undefined) throw new Error('--manifest is required.');
  const manifestPath = resolveManifestFile(manifestArgument);
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const outputDirectory = childOfTemporaryRoot(optionValue(argv, '--output-dir'));
  const jobs = jobsFor(manifest);
  await Promise.all(
    [...new Set(jobs.flatMap((job) => (job.sourceFile === undefined ? [] : [job.sourceFile])))].map(
      async (sourceFile) => access(resolveSourceFile(sourceFile)),
    ),
  );
  if (argv.includes('--validate-only')) {
    console.log(
      JSON.stringify(
        {
          name: manifest.name ?? path.basename(manifestPath, path.extname(manifestPath)),
          totalRuns: jobs.length,
          outputDirectory: path.relative(REPOSITORY_ROOT, outputDirectory),
          jobs,
        },
        null,
        2,
      ),
    );
    return;
  }
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const results: BatchRunResult[] = [];

  for (const [jobIndex, job] of jobs.entries()) {
    const relativeDirectory = path.posix.join(
      job.caseId,
      `run-${String(job.run).padStart(3, '0')}`,
    );
    const runDirectory = path.join(outputDirectory, relativeDirectory);
    console.log(`\n[batch ${jobIndex + 1}/${jobs.length}] ${job.caseId} run ${job.run}`);
    const args = [
      '--pages',
      String(job.pages),
      '--media',
      job.media,
      '--output-dir',
      runDirectory,
      ...(job.sourceFile === undefined ? [] : ['--source-file', job.sourceFile]),
      ...(job.model === undefined ? [] : ['--model', job.model]),
    ];
    try {
      const exitCode = await runChild(args);
      if (exitCode !== 0) throw new Error(`Single-run process exited with code ${exitCode}.`);
      const report = JSON.parse(
        await readFile(path.join(runDirectory, 'report.json'), 'utf8'),
      ) as SingleRunReport;
      results.push({
        caseId: job.caseId,
        run: job.run,
        status: 'passed',
        relativeDirectory,
        report,
      });
    } catch (error) {
      results.push({
        caseId: job.caseId,
        run: job.run,
        status: 'failed',
        relativeDirectory,
        error: errorMessage(error),
      });
    }
  }

  const batchReport = {
    generatedAt: new Date().toISOString(),
    name: manifest.name ?? path.basename(manifestPath, path.extname(manifestPath)),
    manifestPath: path.relative(REPOSITORY_ROOT, manifestPath),
    totalRuns: results.length,
    passedRuns: results.filter((result) => result.status === 'passed').length,
    failedRuns: results.filter((result) => result.status === 'failed').length,
    totals: {
      pages: results.reduce((total, result) => total + (result.report?.actualPageCount ?? 0), 0),
      plannedImages: results.reduce(
        (total, result) => total + (result.report?.plannedImageCount ?? 0),
        0,
      ),
      generatedImages: results.reduce(
        (total, result) => total + (result.report?.generatedImageCount ?? 0),
        0,
      ),
      warnings: results.reduce(
        (total, result) =>
          total +
          (result.report?.pages.reduce(
            (subtotal, page) => subtotal + (page.warningCount ?? 0),
            0,
          ) ?? 0),
        0,
      ),
    },
    results,
  };
  await writeFile(
    path.join(outputDirectory, 'batch-report.json'),
    `${JSON.stringify(batchReport, null, 2)}\n`,
    'utf8',
  );
  const galleryPath = path.join(outputDirectory, 'index.html');
  await writeFile(galleryPath, buildGallery(batchReport.name, results), 'utf8');
  console.log(`\nBatch report: ${path.join(outputDirectory, 'batch-report.json')}`);
  console.log(`Batch gallery: ${pathToFileURL(galleryPath).href}`);
  if (batchReport.failedRuns > 0) process.exitCode = 1;
};

await main();
