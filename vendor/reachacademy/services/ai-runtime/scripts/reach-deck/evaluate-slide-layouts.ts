import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  compileDeckSlideToNativeV2,
  parseDeckSlideValue,
  resolveDeckTheme,
  richTextToPlainText,
  type DeckSlide,
} from '@reachany/reach-deck-dsl';

import { SLIDE_LAYOUT_EVALUATION_BRIEFS } from '../../tests/reach-deck/fixtures/slide-layout-briefs.js';

interface EvaluationInput {
  slide: unknown;
  promptVersion?: string;
  modelDurationMs?: number;
  imageDurationMs?: number;
  rawOutputFile?: string;
  playerScreenshot?: string;
  authorScreenshot?: string;
}

interface EvaluatedSlide {
  id: string;
  promptVersion?: string;
  available: boolean;
  schemaValid: boolean;
  nativeV2Compiles: boolean;
  elementCounts: Record<string, number>;
  captionCount: number;
  suspiciousCaptionCount: number;
  relationPrimitiveCount: number;
  imageCount: number;
  modelDurationMs?: number;
  imageDurationMs?: number;
  rawOutputFile?: string;
  playerScreenshot?: string;
  authorScreenshot?: string;
  error?: string;
}

interface CliOptions {
  baselineDir?: string;
  candidateDir?: string;
  outputDir: string;
}

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../..');
const fromRepositoryRoot = (value: string): string =>
  path.isAbsolute(value) ? value : path.join(REPOSITORY_ROOT, value);

const parseArgs = (argv: readonly string[]): CliOptions => {
  const take = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  const outputDir = fromRepositoryRoot(take('--output-dir') ?? 'tmp/reach-deck-layout-eval');
  const baselineDirValue = take('--baseline-dir');
  const candidateDirValue = take('--candidate-dir');
  const baselineDir =
    baselineDirValue === undefined ? undefined : fromRepositoryRoot(baselineDirValue);
  const candidateDir =
    candidateDirValue === undefined ? undefined : fromRepositoryRoot(candidateDirValue);
  if (baselineDir === undefined && candidateDir === undefined) {
    throw new Error('Provide --baseline-dir and/or --candidate-dir.');
  }
  return { baselineDir, candidateDir, outputDir };
};

const loadInput = async (root: string, id: string): Promise<EvaluationInput | undefined> => {
  const file = path.join(root, id, 'result.json');
  try {
    return JSON.parse(await readFile(file, 'utf8')) as EvaluationInput;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

const existingRelativePath = async (
  root: string,
  value: string | undefined,
): Promise<string | undefined> => {
  if (value === undefined) return undefined;
  const absolute = path.isAbsolute(value) ? value : path.join(root, value);
  try {
    if ((await stat(absolute)).isFile()) return path.relative(process.cwd(), absolute);
  } catch {
    // Missing optional evidence is reported by omission rather than failing the whole corpus.
  }
  return undefined;
};

const countElements = (slide: DeckSlide): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const element of slide.elements) counts[element.type] = (counts[element.type] ?? 0) + 1;
  return counts;
};

const suspiciousCaptionCount = (slide: DeckSlide): number =>
  slide.elements.filter((element) => {
    if (element.type !== 'text' || element.variant !== 'caption') return false;
    const text = richTextToPlainText(element.doc).trim();
    return text.length > 64 || /结论|因此|所以|takeaway|conclusion|therefore/iu.test(text);
  }).length;

const evaluateOne = async (
  root: string,
  id: string,
  input: EvaluationInput | undefined,
): Promise<EvaluatedSlide> => {
  if (input === undefined) {
    return {
      id,
      available: false,
      schemaValid: false,
      nativeV2Compiles: false,
      elementCounts: {},
      captionCount: 0,
      suspiciousCaptionCount: 0,
      relationPrimitiveCount: 0,
      imageCount: 0,
      error: 'Missing result.json.',
    };
  }
  const evidence = {
    ...(input.rawOutputFile === undefined
      ? {}
      : { rawOutputFile: await existingRelativePath(root, input.rawOutputFile) }),
    ...(input.playerScreenshot === undefined
      ? {}
      : { playerScreenshot: await existingRelativePath(root, input.playerScreenshot) }),
    ...(input.authorScreenshot === undefined
      ? {}
      : { authorScreenshot: await existingRelativePath(root, input.authorScreenshot) }),
  };
  try {
    const slide = parseDeckSlideValue(input.slide);
    const compiled = compileDeckSlideToNativeV2({
      slide,
      theme: resolveDeckTheme(undefined),
      duration: slide.duration,
    });
    const counts = countElements(slide);
    return {
      id,
      ...(input.promptVersion === undefined ? {} : { promptVersion: input.promptVersion }),
      available: true,
      schemaValid: true,
      nativeV2Compiles: compiled.slide.schemaVersion === 'reach-deck-slide/v2',
      elementCounts: counts,
      captionCount:
        counts.text === undefined
          ? 0
          : slide.elements.filter(
              (element) => element.type === 'text' && element.variant === 'caption',
            ).length,
      suspiciousCaptionCount: suspiciousCaptionCount(slide),
      relationPrimitiveCount: (counts.shape ?? 0) + (counts.line ?? 0),
      imageCount: counts.image ?? 0,
      ...(input.modelDurationMs === undefined ? {} : { modelDurationMs: input.modelDurationMs }),
      ...(input.imageDurationMs === undefined ? {} : { imageDurationMs: input.imageDurationMs }),
      ...evidence,
    };
  } catch (error) {
    return {
      id,
      ...(input.promptVersion === undefined ? {} : { promptVersion: input.promptVersion }),
      available: true,
      schemaValid: false,
      nativeV2Compiles: false,
      elementCounts: {},
      captionCount: 0,
      suspiciousCaptionCount: 0,
      relationPrimitiveCount: 0,
      imageCount: 0,
      ...evidence,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const evaluateVariant = async (root: string | undefined): Promise<EvaluatedSlide[]> => {
  if (root === undefined) return [];
  return Promise.all(
    SLIDE_LAYOUT_EVALUATION_BRIEFS.map(async (brief) =>
      evaluateOne(root, brief.id, await loadInput(root, brief.id)),
    ),
  );
};

const aggregate = (slides: readonly EvaluatedSlide[]) => ({
  total: slides.length,
  available: slides.filter((slide) => slide.available).length,
  schemaValid: slides.filter((slide) => slide.schemaValid).length,
  nativeV2Compiles: slides.filter((slide) => slide.nativeV2Compiles).length,
  suspiciousCaptions: slides.reduce((total, slide) => total + slide.suspiciousCaptionCount, 0),
  relationPrimitivePages: slides.filter((slide) => slide.relationPrimitiveCount > 0).length,
  imagePages: slides.filter((slide) => slide.imageCount > 0).length,
  withPlayerScreenshot: slides.filter((slide) => slide.playerScreenshot !== undefined).length,
  withAuthorScreenshot: slides.filter((slide) => slide.authorScreenshot !== undefined).length,
});

const markdownReport = (report: {
  generatedAt: string;
  baseline: ReturnType<typeof aggregate>;
  candidate: ReturnType<typeof aggregate>;
}): string =>
  `# Reach Deck layout evaluation\n\nGenerated: ${report.generatedAt}\n\n| Metric | v15 baseline | v16 candidate |\n| --- | ---: | ---: |\n| Available | ${report.baseline.available}/${report.baseline.total} | ${report.candidate.available}/${report.candidate.total} |\n| Schema valid | ${report.baseline.schemaValid} | ${report.candidate.schemaValid} |\n| Native v2 compiled | ${report.baseline.nativeV2Compiles} | ${report.candidate.nativeV2Compiles} |\n| Pages using shape/line | ${report.baseline.relationPrimitivePages} | ${report.candidate.relationPrimitivePages} |\n| Pages using images | ${report.baseline.imagePages} | ${report.candidate.imagePages} |\n| Suspicious caption uses | ${report.baseline.suspiciousCaptions} | ${report.candidate.suspiciousCaptions} |\n| Player screenshots | ${report.baseline.withPlayerScreenshot} | ${report.candidate.withPlayerScreenshot} |\n| Orca author screenshots | ${report.baseline.withAuthorScreenshot} | ${report.candidate.withAuthorScreenshot} |\n`;

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const [baselineSlides, candidateSlides] = await Promise.all([
    evaluateVariant(options.baselineDir),
    evaluateVariant(options.candidateDir),
  ]);
  const report = {
    generatedAt: new Date().toISOString(),
    corpusSize: SLIDE_LAYOUT_EVALUATION_BRIEFS.length,
    baseline: aggregate(baselineSlides),
    candidate: aggregate(candidateSlides),
    slides: { baseline: baselineSlides, candidate: candidateSlides },
  };
  await mkdir(options.outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(options.outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n'),
    writeFile(path.join(options.outputDir, 'report.md'), markdownReport(report)),
  ]);
  console.log(`Wrote layout evaluation to ${options.outputDir}`);
};

await main();
