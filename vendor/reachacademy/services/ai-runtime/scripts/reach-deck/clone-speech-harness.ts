import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

import {
  canonicalizeReachDeckSpeechMarkupV1,
  planReachDeckSsmlSelectionChunks,
  projectReachDeckSpeechDocument,
  projectReachDeckSpeechVisibleRange,
  type ReachDeckSpeechMarkupV1,
} from '@reachany/reach-deck-dsl';
import { build } from 'esbuild';
import type { SourceUnit } from './clone-speech-fuzzy-alignment.js';

export const CLONE_SPEECH_HARNESS_HOST = '127.0.0.1';
export const CLONE_SPEECH_HARNESS_MAX_REQUEST_BYTES = 32 * 1024;
export const CLONE_SPEECH_HARNESS_DEFAULT_MODEL_SERVICE_URL = 'http://127.0.0.1:8100';
export const CLONE_SPEECH_HARNESS_MODEL_ROUTE = '/internal/dev/v1/reach-deck/clone-speech';
export const CLONE_SPEECH_HARNESS_ASR_ROUTE = `${CLONE_SPEECH_HARNESS_MODEL_ROUTE}/asr`;
export const CLONE_SPEECH_HARNESS_ALIGNMENT_ROUTE = `${CLONE_SPEECH_HARNESS_MODEL_ROUTE}/align`;

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../../..');
const ENTRY_FILE = path.join(import.meta.dirname, 'clone-speech-harness-entry.tsx');
const EDITOR_ROOT = path.join(REPOSITORY_ROOT, 'packages/reach-deck-editor');
const DEFAULT_PREVIEW_DEADLINE_MS = 15 * 60 * 1_000;
const MAX_PREVIEW_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_ASR_REQUEST_BYTES = Math.ceil((MAX_PREVIEW_AUDIO_BYTES * 4) / 3) + 1_024;
const MAX_ASR_RESPONSE_BYTES = 512 * 1024;
const ASYNC_HEADER = 'X-ReachAny-TTS-Async';
const IDENTITY_HEADER = 'X-ReachAny-TTS-Request-Identity';
const VOICE_MODE_HEADER = 'X-ReachAny-TTS-Voice-Mode';
const ERROR_CODE_HEADER = 'x-reachany-tts-error-code';
const PUBLIC_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    'media-src data: blob:',
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join('; '),
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

const PUBLIC_ERROR_CODES: Readonly<Record<string, string>> = {
  TTS_ADMISSION_FULL: 'SPEECH_TOOL_RATE_LIMITED',
  TTS_ADMISSION_UNAVAILABLE: 'SPEECH_TOOL_ADMISSION_UNAVAILABLE',
  TTS_LEASE_LOST: 'SPEECH_TOOL_ADMISSION_UNAVAILABLE',
  TTS_PROVIDER_RATE_LIMITED: 'SPEECH_TOOL_RATE_LIMITED',
  TTS_PROVIDER_UNAVAILABLE: 'SPEECH_TOOL_ADMISSION_UNAVAILABLE',
  TTS_QUEUE_CANCELLED: 'SPEECH_TOOL_ADMISSION_UNAVAILABLE',
  TTS_QUEUE_CAPACITY_EXCEEDED: 'SPEECH_TOOL_RATE_LIMITED',
  TTS_QUEUE_DEADLINE_EXCEEDED: 'SPEECH_PREVIEW_TIMEOUT',
  TTS_REQUEST_IDENTITY_CONFLICT: 'SPEECH_TOOL_ADMISSION_UNAVAILABLE',
  TTS_SSML_UNSUPPORTED_VOICE: 'SPEECH_VOICE_UNSUPPORTED',
};

const HARNESS_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>Reach Deck 音色 SSML 对比实验台</title>
    <link rel="stylesheet" href="/clone-speech-harness.css">
  </head>
  <body>
    <div id="root"></div>
    <script src="/clone-speech-harness.js"></script>
  </body>
</html>`;

const HARNESS_CSS = `
:root { color: var(--reachany-color-text); background: var(--reachany-color-canvas); font-family: var(--reachany-font-sans); }
* { box-sizing: border-box; }
body { margin: 0; min-width: 20rem; }
button, input, select, textarea { letter-spacing: 0; }
.clone-speech-harness { min-height: 100vh; background: var(--reachany-color-canvas); }
.clone-speech-harness__masthead { background: var(--reachany-color-header); color: var(--reachany-color-primary-contrast); border-bottom: 3px solid var(--reachany-color-primary); }
.clone-speech-harness__masthead-inner { width: min(76rem, calc(100% - 2rem)); min-height: 4.5rem; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.clone-speech-harness__identity { display: flex; align-items: center; gap: .75rem; min-width: 0; }
.clone-speech-harness__mark { display: grid; width: 2.25rem; height: 2.25rem; flex: 0 0 auto; place-items: center; border: 1px solid color-mix(in srgb, var(--reachany-color-primary-contrast) 26%, transparent); border-radius: var(--reachany-radius-md); background: var(--reachany-color-primary); color: var(--reachany-color-primary-contrast); font-family: var(--reachany-font-brand); font-size: .85rem; font-weight: 800; }
.clone-speech-harness__titles { min-width: 0; }
.clone-speech-harness__titles p { margin: 0 0 .15rem; color: color-mix(in srgb, var(--reachany-color-primary-contrast) 72%, transparent); font-size: .68rem; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
.clone-speech-harness__titles h1 { margin: 0; overflow-wrap: anywhere; font-size: 1.05rem; line-height: 1.3; letter-spacing: 0; }
.clone-speech-harness__status { display: inline-flex; min-height: 1.75rem; flex: 0 0 auto; align-items: center; gap: .45rem; padding: .25rem .55rem; border: 1px solid color-mix(in srgb, var(--reachany-color-primary-contrast) 18%, transparent); border-radius: var(--reachany-radius-sm); background: color-mix(in srgb, var(--reachany-color-primary-contrast) 7%, transparent); color: var(--reachany-color-primary-contrast); font-size: .72rem; font-weight: 700; white-space: nowrap; }
.clone-speech-harness__status::before { width: .45rem; height: .45rem; border-radius: 50%; background: var(--reachany-color-success); content: ''; box-shadow: 0 0 0 3px color-mix(in srgb, var(--reachany-color-success) 18%, transparent); }
.clone-speech-harness__main { width: min(76rem, calc(100% - 2rem)); margin: 0 auto; padding: 1.25rem 0 2rem; }
.clone-speech-harness__section-header { display: flex; align-items: end; justify-content: space-between; gap: 1rem; margin-bottom: .65rem; }
.clone-speech-harness__section-header h2 { margin: 0; color: var(--reachany-color-text); font-size: .95rem; line-height: 1.4; letter-spacing: 0; }
.clone-speech-harness__section-header span { color: var(--reachany-color-muted-text); font-size: .72rem; }
.clone-speech-harness__controls { display: flex; flex-wrap: wrap; align-items: end; gap: .75rem 1.5rem; margin: 0 0 .85rem; padding: .8rem 0; border-block: 1px solid var(--reachany-color-border); }
.clone-speech-harness__mode { min-width: 0; margin: 0; padding: 0; border: 0; }
.clone-speech-harness__mode legend { margin-bottom: .35rem; color: var(--reachany-color-muted-text); font-size: .72rem; font-weight: 700; }
.clone-speech-harness__mode label { display: inline-flex; align-items: center; min-height: 2rem; padding: .35rem .55rem; border: 1px solid var(--reachany-color-border); color: var(--reachany-color-text); background: var(--reachany-color-surface); font-size: .76rem; cursor: pointer; }
.clone-speech-harness__mode label + label { border-left: 0; }
.clone-speech-harness__mode label:first-of-type { border-radius: 4px 0 0 4px; }
.clone-speech-harness__mode label:last-of-type { border-radius: 0 4px 4px 0; }
.clone-speech-harness__mode label.is-active { background: var(--reachany-color-primary); color: var(--reachany-color-primary-contrast); }
.clone-speech-harness__mode input { margin: 0 .35rem 0 0; accent-color: var(--reachany-color-primary); }
.clone-speech-harness__switches { display: flex; flex-wrap: wrap; gap: .5rem 1rem; padding-bottom: .3rem; }
.clone-speech-harness__switches label { display: inline-flex; align-items: center; gap: .35rem; font-size: .74rem; cursor: pointer; }
.clone-speech-harness__switches input { accent-color: var(--reachany-color-primary); }
.clone-speech-harness__editor { min-height: 35rem; padding: 1rem; border: 1px solid var(--reachany-color-border); border-radius: var(--reachany-radius-md); background: var(--reachany-color-surface); box-shadow: 0 .6rem 1.75rem color-mix(in srgb, var(--reachany-color-player) 7%, transparent); }
.clone-speech-harness__editor.reach-deck-editor { height: auto; }
.clone-speech-harness__editor .reach-deck-timeline__narration-editor { min-height: 32rem; }
.clone-speech-harness__editor .reach-deck-timeline__narration-content { flex: 0 0 auto; min-height: auto; overflow: visible; }
.clone-speech-harness__editor .reach-deck-timeline__narration-editor .reach-deck-editor__rich-text { flex: 0 0 auto; min-height: 12rem; }
.clone-speech-harness__editor .reach-deck-timeline__narration-editor .reach-deck-editor__rich-text > div:last-child { min-height: 8rem; }
.clone-speech-harness__editor .reach-deck-timeline__narration-editor .reach-deck-editor__rich-text-surface { min-height: 8rem; }
.clone-speech-harness__editor .reach-deck-timeline__speech-preview-track { display: block; min-width: 0; }
.clone-speech-harness__track { display: grid; gap: .6rem; width: 100%; min-width: 0; }
.clone-speech-harness__track-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .25rem 1rem; }
.clone-speech-harness__track-heading strong { font-size: .82rem; }
.clone-speech-harness__track-heading span { color: var(--reachany-color-muted-text); font-size: .72rem; }
.clone-speech-harness__track audio { width: 100%; min-width: 0; height: 2.5rem; }
.clone-speech-harness__asr-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem .7rem; }
.clone-speech-harness__asr-actions button { display: inline-flex; align-items: center; gap: .35rem; min-height: 1.9rem; padding: .2rem .55rem; border: 1px solid var(--reachany-color-border); border-radius: 4px; background: var(--reachany-color-surface); color: var(--reachany-color-text); font-size: .73rem; cursor: pointer; }
.clone-speech-harness__asr-actions button:disabled { opacity: .6; cursor: wait; }
.clone-speech-harness__asr-actions span { color: var(--reachany-color-muted-text); font-size: .72rem; }
.clone-speech-harness__transcripts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .9rem; }
.clone-speech-harness__transcripts:has(> div:nth-child(3)) { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.clone-speech-harness__transcripts > div { min-width: 0; padding-top: .5rem; border-top: 1px solid var(--reachany-color-border); }
.clone-speech-harness__transcripts h3 { margin: 0 0 .3rem; color: var(--reachany-color-muted-text); font-size: .7rem; }
.clone-speech-harness__transcripts p { margin: 0; overflow-wrap: anywhere; font-size: .85rem; line-height: 1.9; }
.clone-speech-harness__empty { color: var(--reachany-color-muted-text); }
.clone-speech-harness__subtitle-text { color: var(--reachany-color-text); }
.clone-speech-harness__offsets { margin: 0; padding: .4rem .5rem; border-left: 3px solid #7c93b1; background: #f1f4f8; color: #384e67; font-size: .74rem; font-variant-numeric: tabular-nums; }
.clone-speech-harness__timeline { display: grid; gap: .4rem; padding-top: .6rem; border-top: 1px solid var(--reachany-color-border); }
.clone-speech-harness__timeline-header { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .8rem; min-height: 2rem; }
.clone-speech-harness__timeline-header strong { font-size: .76rem; white-space: nowrap; }
.clone-speech-harness__timeline-header > span { flex: 1 1 12rem; color: #245f54; font-size: .76rem; font-variant-numeric: tabular-nums; }
.clone-speech-harness__timeline-header > span.is-gap { color: #9b532d; }
.clone-speech-harness__timeline-header label { display: inline-flex; align-items: center; gap: .3rem; font-size: .7rem; white-space: nowrap; }
.clone-speech-harness__timeline-header select { min-height: 1.7rem; padding: .1rem .3rem; border: 1px solid var(--reachany-color-border); border-radius: 4px; background: var(--reachany-color-surface); color: var(--reachany-color-text); font-size: .72rem; }
.clone-speech-harness__timeline-body { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); overflow: hidden; border: 1px solid #d7cdc5; border-radius: 4px; }
.clone-speech-harness__timeline-labels { display: flex; flex-direction: column; border-right: 1px solid #ddd3cb; background: #f5f0eb; }
.clone-speech-harness__timeline-labels span { display: flex; align-items: center; padding: 0 .35rem; border-bottom: 1px solid #e2d9d2; color: #695e66; font-size: .69rem; white-space: nowrap; }
.clone-speech-harness__timeline-labels span:first-child { height: 1.45rem; }
.clone-speech-harness__timeline-scroller { max-width: 100%; overflow-x: auto; overflow-y: hidden; background: #fffdfa; }
.clone-speech-harness__timeline-canvas { position: relative; min-width: 100%; background-image: linear-gradient(90deg, rgb(126 99 110 / 10%) 1px, transparent 1px); background-size: var(--timeline-second-width) 100%; cursor: crosshair; }
.clone-speech-harness__timeline-ruler { position: relative; height: 1.45rem; border-bottom: 1px solid #e2d9d2; }
.clone-speech-harness__timeline-ruler span { position: absolute; top: .3rem; padding-left: .25rem; color: #8a7d84; font-size: .67rem; font-variant-numeric: tabular-nums; }
.clone-speech-harness__timeline-lanes { position: relative; border-bottom: 1px solid #e2d9d2; background: rgb(220 239 233 / 25%); }
.clone-speech-harness__timeline-lanes.is-asr { background: rgb(225 232 244 / 32%); }
.clone-speech-harness__timeline-lanes.is-aligned { background: rgb(244 236 218 / 35%); }
.clone-speech-harness__timeline-cue { position: absolute; height: 1.75rem; overflow: hidden; padding: .15rem .25rem .35rem; border: 1px solid #8ab8aa; border-radius: 4px; background: #dcefe9; color: #245f54; font-size: .76rem; line-height: 1.1; text-align: center; white-space: nowrap; cursor: pointer; }
.clone-speech-harness__timeline-cue::after { position: absolute; bottom: 0; left: 0; width: var(--cue-duration); max-width: 100%; height: 3px; background: #318070; content: ''; }
.clone-speech-harness__timeline-cue.is-asr { border-color: #a5b3cc; background: #e5ebf4; color: #384e67; }
.clone-speech-harness__timeline-cue.is-asr::after { background: #718cb0; }
.clone-speech-harness__timeline-cue.is-aligned { border-color: #af9b67; background: #f4ead2; color: #5a4820; }
.clone-speech-harness__timeline-cue.is-aligned::after { background: #9b7b37; }
.clone-speech-harness__timeline-cue.is-aligned.is-block { border-style: dashed; font-weight: 700; }
.clone-speech-harness__timeline-cue.is-aligned.is-seed { border-color: #b18e95; background: #f4e7e9; color: #6f3d49; }
.clone-speech-harness__timeline-cue.is-aligned.is-seed::after { background: #9d606e; }
.clone-speech-harness__timeline-cue.is-current { z-index: 1; border-color: #b74720; background: #fff0df; color: #8f3d20; box-shadow: 0 0 0 2px rgb(183 71 32 / 18%); }
.clone-speech-harness__timeline-cue.is-current::after { background: #b74720; }
.clone-speech-harness__timeline-playhead { position: absolute; top: 0; bottom: 0; width: 2px; background: #ff6b35; pointer-events: none; z-index: 2; }
.clone-speech-harness__timeline-playhead::before { position: absolute; top: 0; left: -.28rem; width: .7rem; height: .55rem; background: #ff6b35; clip-path: polygon(0 0, 100% 0, 50% 100%); content: ''; }
.clone-speech-harness__request { padding-top: .5rem; border-top: 1px solid var(--reachany-color-border); font-size: .73rem; }
.clone-speech-harness__request summary { cursor: pointer; font-weight: 700; }
.clone-speech-harness__request p { margin: .5rem 0; overflow-wrap: anywhere; }
.clone-speech-harness__request pre { margin: .5rem 0; padding: .5rem; overflow: auto; background: var(--reachany-color-canvas); font-size: .7rem; }
@media (max-width: 42rem) {
  .clone-speech-harness__masthead-inner, .clone-speech-harness__main { width: min(100% - 1rem, 76rem); }
  .clone-speech-harness__masthead-inner { min-height: 4rem; }
  .clone-speech-harness__titles p { display: none; }
  .clone-speech-harness__titles h1 { font-size: .9rem; }
  .clone-speech-harness__status { padding-inline: .4rem; font-size: .66rem; }
  .clone-speech-harness__main { padding-top: .75rem; }
  .clone-speech-harness__section-header { align-items: start; flex-direction: column; gap: .15rem; }
  .clone-speech-harness__editor { min-height: 31rem; padding: .5rem; }
  .clone-speech-harness__editor .reach-deck-timeline__narration-editor { min-height: 29rem; }
  .clone-speech-harness__mode label { font-size: .68rem; }
  .clone-speech-harness__transcripts { grid-template-columns: 1fr; }
  .clone-speech-harness__transcripts:has(> div:nth-child(3)) { grid-template-columns: 1fr; }
  .clone-speech-harness__timeline-header > span { order: 2; flex-basis: 100%; }
  .clone-speech-harness__timeline-body { grid-template-columns: 3.6rem minmax(0, 1fr); }
}
`;

export interface CloneSpeechHarnessPreviewInput {
  markdown: string;
  markdownFrom: number;
  markdownTo: number;
  speechMarkup?: ReachDeckSpeechMarkupV1;
  inputMode?: 'ssml_text_type' | 'ssml_field' | 'plain_text';
  enableSubtitle?: boolean;
  enableTimestamp?: boolean;
}

export interface CloneSpeechHarnessWord {
  word: string;
  startTime: number;
  endTime: number;
}

export interface CloneSpeechHarnessPreviewResult {
  contentType: 'audio/mpeg';
  dataBase64: string;
  durationSeconds?: number;
  sourceText?: string;
  spokenText?: string;
  ssml?: readonly string[];
  inputMode?: CloneSpeechHarnessPreviewInput['inputMode'];
  words?: readonly CloneSpeechHarnessWord[];
  chunks?: readonly CloneSpeechHarnessChunk[];
}

export interface CloneSpeechHarnessChunk {
  dataBase64: string;
  durationSeconds: number;
  offsetSeconds: number;
  alignmentTranscript: string;
  sourceUnits: readonly SourceUnit[];
}

export interface CloneSpeechHarnessPreviewTrack extends CloneSpeechHarnessPreviewResult {
  id: 'default' | 'clone';
  label: string;
}

export interface CloneSpeechHarnessComparisonResult {
  tracks: readonly CloneSpeechHarnessPreviewTrack[];
}

export interface CloneSpeechHarnessAsrResult {
  text: string;
  words: readonly CloneSpeechHarnessWord[];
  elapsedMs: number;
}

export interface CloneSpeechHarnessAlignmentResult {
  words: readonly CloneSpeechHarnessWord[];
  elapsedMs: number;
  exact: boolean;
}

export interface PreparedCloneSpeechHarness {
  outputDirectory: string;
}

export interface CloneSpeechHarnessServer {
  close: () => Promise<void>;
  origin: string;
  server: Server;
}

export interface CloneSpeechProxyOptions {
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
  identityFactory?: () => string;
  maxAudioBytes?: number;
  modelServiceUrl: string;
  pollDelay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function normalizeCloneSpeechHarnessCliArguments(
  argv: readonly string[],
): readonly string[] {
  return argv[0] === '--' ? argv.slice(1) : argv;
}

export class CloneSpeechHarnessPublicError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'CloneSpeechHarnessPublicError';
  }
}

class RequestBodyTooLargeError extends Error {}

const isChildOf = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
};

export function resolveCloneSpeechHarnessOutputDirectory(requested: string): string {
  const outputDirectory = path.resolve(REPOSITORY_ROOT, requested);
  if (
    !['tmp', '.tmp'].some((directory) =>
      isChildOf(path.join(REPOSITORY_ROOT, directory), outputDirectory),
    )
  ) {
    throw new Error('The clone speech harness output must be inside repository tmp/ or .tmp/.');
  }
  return outputDirectory;
}

export function resolveCloneSpeechModelServiceUrl(configured: string): string {
  const url = new URL(configured);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'http:' ||
    !isLoopbackHostname(hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('The clone speech harness requires a loopback HTTP model-service URL.');
  }
  const normalizedPath = url.pathname.replace(/\/+$/, '') || '/';
  if (!['/', '/v1', '/api/v1', CLONE_SPEECH_HARNESS_MODEL_ROUTE].includes(normalizedPath)) {
    throw new Error('The model-service URL must point to its root or API v1 root.');
  }
  url.pathname = CLONE_SPEECH_HARNESS_MODEL_ROUTE;
  return url.toString();
}

export async function prepareCloneSpeechHarness(input: {
  outputDirectory: string;
}): Promise<PreparedCloneSpeechHarness> {
  const outputDirectory = resolveCloneSpeechHarnessOutputDirectory(input.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const bundle = await build({
    absWorkingDir: REPOSITORY_ROOT,
    bundle: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    entryPoints: [ENTRY_FILE],
    format: 'iife',
    jsx: 'automatic',
    loader: { '.js': 'jsx' },
    nodePaths: [path.join(REPOSITORY_ROOT, 'node_modules')],
    write: false,
  });
  const javascript = bundle.outputFiles[0];
  if (javascript === undefined) throw new Error('The clone speech harness bundle was not emitted.');
  await Promise.all([
    writeFile(path.join(outputDirectory, 'index.html'), HARNESS_HTML, 'utf8'),
    writeFile(path.join(outputDirectory, 'clone-speech-harness.js'), javascript.text, 'utf8'),
    writeFile(
      path.join(outputDirectory, 'clone-speech-harness.css'),
      `${await loadHarnessCss()}\n${HARNESS_CSS}`,
      'utf8',
    ),
  ]);
  return { outputDirectory };
}

export async function proxyCloneSpeechPreview(
  input: CloneSpeechHarnessPreviewInput,
  signal: AbortSignal,
  options: CloneSpeechProxyOptions,
): Promise<CloneSpeechHarnessPreviewResult> {
  return withPreviewDeadline(options.deadlineMs, (deadlineSignal) =>
    proxySpeechPreview(input, signal, deadlineSignal, options, 'clone'),
  );
}

export async function proxyCloneSpeechComparison(
  input: CloneSpeechHarnessPreviewInput,
  signal: AbortSignal,
  options: CloneSpeechProxyOptions,
): Promise<CloneSpeechHarnessComparisonResult> {
  return withPreviewDeadline(options.deadlineMs, async (deadlineSignal) => {
    const comparisonIdentity = (options.identityFactory ?? randomUUID)();
    const defaultAudio = await proxySpeechPreview(
      input,
      signal,
      deadlineSignal,
      options,
      'default',
      comparisonIdentity,
    );
    const cloneAudio = await proxySpeechPreview(
      input,
      signal,
      deadlineSignal,
      options,
      'clone',
      comparisonIdentity,
    );
    return {
      tracks: [
        { id: 'default', label: '默认音色', ...defaultAudio },
        { id: 'clone', label: '克隆音色', ...cloneAudio },
      ],
    };
  });
}

export async function proxyCloneSpeechAsr(
  dataBase64: string,
  signal: AbortSignal,
  options: CloneSpeechProxyOptions,
): Promise<CloneSpeechHarnessAsrResult> {
  validateAsrAudio(dataBase64);
  const upstreamUrl = new URL(resolveCloneSpeechModelServiceUrl(options.modelServiceUrl));
  upstreamUrl.pathname = CLONE_SPEECH_HARNESS_ASR_ROUTE;
  const deadline = AbortSignal.timeout(60_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(upstreamUrl, {
      body: JSON.stringify({ dataBase64 }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.any([signal, deadline]),
    });
    if (!response.ok || mediaType(response.headers.get('content-type')) !== 'application/json') {
      await discardResponse(response);
      throw unavailableError(502);
    }
    const bytes = await readBoundedResponseBytes(response, MAX_ASR_RESPONSE_BYTES);
    return parseAsrResponse(bytes);
  } catch (error) {
    if (signal.aborted)
      throw new CloneSpeechHarnessPublicError('SPEECH_TOOL_ADMISSION_UNAVAILABLE', 499);
    if (deadline.aborted) throw new CloneSpeechHarnessPublicError('SPEECH_PREVIEW_TIMEOUT', 504);
    if (error instanceof CloneSpeechHarnessPublicError) throw error;
    throw unavailableError(502);
  }
}

export async function proxyCloneSpeechAlignment(
  input: { dataBase64: string; transcript: string },
  signal: AbortSignal,
  options: CloneSpeechProxyOptions,
): Promise<CloneSpeechHarnessAlignmentResult> {
  validateAsrAudio(input.dataBase64);
  validateAlignmentTranscript(input.transcript);
  const upstreamUrl = new URL(resolveCloneSpeechModelServiceUrl(options.modelServiceUrl));
  upstreamUrl.pathname = CLONE_SPEECH_HARNESS_ALIGNMENT_ROUTE;
  const deadline = AbortSignal.timeout(90_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(upstreamUrl, {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.any([signal, deadline]),
    });
    if (!response.ok || mediaType(response.headers.get('content-type')) !== 'application/json') {
      await discardResponse(response);
      throw unavailableError(502);
    }
    const bytes = await readBoundedResponseBytes(response, MAX_ASR_RESPONSE_BYTES);
    return parseAlignmentResponse(bytes);
  } catch (error) {
    if (signal.aborted)
      throw new CloneSpeechHarnessPublicError('SPEECH_TOOL_ADMISSION_UNAVAILABLE', 499);
    if (deadline.aborted) throw new CloneSpeechHarnessPublicError('SPEECH_PREVIEW_TIMEOUT', 504);
    if (error instanceof CloneSpeechHarnessPublicError) throw error;
    throw unavailableError(502);
  }
}

async function withPreviewDeadline<Result>(
  deadlineMs: number | undefined,
  operation: (deadlineSignal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(new DOMException('Preview deadline exceeded', 'TimeoutError')),
    deadlineMs ?? DEFAULT_PREVIEW_DEADLINE_MS,
  );
  try {
    return await operation(deadlineController.signal);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function proxySpeechPreview(
  input: CloneSpeechHarnessPreviewInput,
  signal: AbortSignal,
  deadlineSignal: AbortSignal,
  options: CloneSpeechProxyOptions,
  voiceMode: 'default' | 'clone',
  identityToken?: string,
): Promise<CloneSpeechHarnessPreviewResult> {
  const previews = createProviderPreviews(input);
  const upstreamUrl = resolveCloneSpeechModelServiceUrl(options.modelServiceUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const identityPrefix = voiceMode === 'default' ? 'local-default-preview' : 'local-clone-preview';
  const baseIdentity = `${identityPrefix}:${identityToken ?? (options.identityFactory ?? randomUUID)()}`;
  const operationSignal = AbortSignal.any([signal, deadlineSignal]);
  const audioParts: Uint8Array[] = [];
  const words: CloneSpeechHarnessWord[] = [];
  const sourceText: string[] = [];
  const spokenText: string[] = [];
  const ssml: string[] = [];
  const chunks: CloneSpeechHarnessChunk[] = [];
  const maxAudioBytes = options.maxAudioBytes ?? MAX_PREVIEW_AUDIO_BYTES;
  let audioBytes = 0;
  let durationSeconds = 0;
  let activeRequest: { headers: Record<string, string>; shouldCancel: boolean } | undefined;
  try {
    operationSignal.throwIfAborted();
    for (const [index, preview] of previews.entries()) {
      const identity =
        previews.length === 1 ? baseIdentity : `${baseIdentity}:${String(index + 1)}`;
      const headers = {
        [ASYNC_HEADER]: 'v1',
        [IDENTITY_HEADER]: identity,
        [VOICE_MODE_HEADER]: voiceMode,
        'Content-Type': 'application/json',
      };
      const body = JSON.stringify({
        alignment_transcript: preview.alignmentTranscript,
        input: preview.ssml,
        input_type: 'ssml',
        response_format: 'mp3',
        speed: 0,
        ...(input.inputMode === undefined
          ? {}
          : {
              input_mode: input.inputMode,
              enable_subtitle: input.enableSubtitle,
              enable_timestamp: input.enableTimestamp,
            }),
      });
      activeRequest = { headers, shouldCancel: false };
      for (;;) {
        activeRequest.shouldCancel = true;
        const upstream = await fetchImpl(upstreamUrl, {
          body,
          headers,
          method: 'POST',
          signal: operationSignal,
        });
        operationSignal.throwIfAborted();
        if (upstream.status === 202) {
          await discardResponse(upstream);
          const retryAfterSeconds = readRetryAfterSeconds(upstream.headers.get('retry-after')) ?? 1;
          await (options.pollDelay ?? abortableDelay)(retryAfterSeconds * 1_000, operationSignal);
          continue;
        }
        if (!upstream.ok) {
          const error = publicUpstreamError(upstream);
          await discardResponse(upstream);
          activeRequest.shouldCancel = false;
          throw error;
        }
        const experimental = input.inputMode !== undefined;
        const expectedType = experimental ? 'application/json' : 'audio/mpeg';
        if (mediaType(upstream.headers.get('content-type')) !== expectedType) {
          await discardResponse(upstream);
          throw unavailableError(502);
        }
        const responseBytes = await readBoundedResponseBytes(
          upstream,
          experimental
            ? Math.ceil(((maxAudioBytes - audioBytes) * 4) / 3) + 32_768
            : maxAudioBytes - audioBytes,
        );
        const parsed = experimental
          ? parseExperimentalResponse(responseBytes, maxAudioBytes - audioBytes)
          : undefined;
        const audio = parsed?.audio ?? responseBytes;
        if (audio.byteLength === 0) throw unavailableError(502);
        audioParts.push(audio);
        audioBytes += audio.byteLength;
        if (parsed !== undefined) {
          chunks.push({
            dataBase64: Buffer.from(audio).toString('base64'),
            durationSeconds: parsed.durationSeconds,
            offsetSeconds: durationSeconds,
            alignmentTranscript: preview.alignmentTranscript,
            sourceUnits: preview.sourceUnits,
          });
          words.push(
            ...parsed.words.map((word) => ({
              ...word,
              startTime: word.startTime + durationSeconds,
              endTime: word.endTime + durationSeconds,
            })),
          );
          durationSeconds += parsed.durationSeconds;
          sourceText.push(preview.sourceText);
          spokenText.push(preview.alignmentTranscript);
          ssml.push(preview.ssml);
        }
        activeRequest.shouldCancel = false;
        break;
      }
    }
    return {
      contentType: 'audio/mpeg',
      dataBase64: Buffer.concat(audioParts.map((part) => Buffer.from(part))).toString('base64'),
      ...(input.inputMode === undefined
        ? {}
        : {
            durationSeconds,
            sourceText: sourceText.join(''),
            spokenText: spokenText.join(''),
            ssml,
            inputMode: input.inputMode,
            words,
            chunks,
          }),
    };
  } catch (error) {
    if (activeRequest?.shouldCancel) {
      await cancelPreview(upstreamUrl, activeRequest.headers, fetchImpl);
    }
    if (error instanceof CloneSpeechHarnessPublicError) throw error;
    if (deadlineSignal.aborted) {
      throw new CloneSpeechHarnessPublicError('SPEECH_PREVIEW_TIMEOUT', 504);
    }
    if (signal.aborted) {
      throw new CloneSpeechHarnessPublicError('SPEECH_TOOL_ADMISSION_UNAVAILABLE', 499);
    }
    throw unavailableError(502);
  }
}

export async function startCloneSpeechHarnessServer(input: {
  modelServiceUrl: string;
  outputDirectory: string;
  port?: number;
  proxyOptions?: Omit<CloneSpeechProxyOptions, 'modelServiceUrl'>;
}): Promise<CloneSpeechHarnessServer> {
  const outputDirectory = resolveCloneSpeechHarnessOutputDirectory(input.outputDirectory);
  const modelServiceUrl = resolveCloneSpeechModelServiceUrl(input.modelServiceUrl);
  await Promise.all(
    ['index.html', 'clone-speech-harness.js', 'clone-speech-harness.css'].map((file) =>
      access(path.join(outputDirectory, file)),
    ),
  );

  const activePreviewOperations = new Set<AbortController>();
  const activeRequestTasks = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    applyPublicHeaders(response);
    const requestTask = handleHarnessRequest(request, response, {
      activePreviewOperations,
      modelServiceUrl,
      outputDirectory,
      proxyOptions: input.proxyOptions,
      server,
    }).catch(() => {
      if (!response.headersSent) writePublicError(response, unavailableError(500));
      else response.end();
    });
    activeRequestTasks.add(requestTask);
    void requestTask.finally(() => activeRequestTasks.delete(requestTask));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.port ?? 0, CLONE_SPEECH_HARNESS_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('The clone speech harness server has no TCP address.');
  }
  let closePromise: Promise<void> | undefined;
  return {
    close: () => {
      closePromise ??= (async () => {
        for (const operation of activePreviewOperations) {
          operation.abort(new DOMException('Harness stopped', 'AbortError'));
        }
        const serverClose = closeServer(server);
        while (activeRequestTasks.size > 0) {
          await Promise.allSettled([...activeRequestTasks]);
        }
        server.closeAllConnections();
        await serverClose;
      })();
      return closePromise;
    },
    origin: `http://${CLONE_SPEECH_HARNESS_HOST}:${address.port}`,
    server,
  };
}

async function handleHarnessRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    activePreviewOperations: Set<AbortController>;
    modelServiceUrl: string;
    outputDirectory: string;
    proxyOptions: Omit<CloneSpeechProxyOptions, 'modelServiceUrl'> | undefined;
    server: Server;
  },
): Promise<void> {
  const address = context.server.address();
  if (address === null || typeof address === 'string') {
    writePublicError(response, unavailableError(500));
    return;
  }
  const expectedOrigin = `http://${CLONE_SPEECH_HARNESS_HOST}:${address.port}`;
  const pathname = safePathname(request.url);
  if (pathname === '/preview' || pathname === '/asr' || pathname === '/align') {
    if (request.method !== 'POST' || !isSameOriginRequest(request, expectedOrigin)) {
      response.writeHead(404).end();
      return;
    }
    const operationController = new AbortController();
    const abort = () => operationController.abort(new DOMException('Client closed', 'AbortError'));
    const abortOnResponseClose = () => {
      if (!response.writableEnded) abort();
    };
    context.activePreviewOperations.add(operationController);
    request.once('aborted', abort);
    response.once('close', abortOnResponseClose);
    try {
      const options = { ...context.proxyOptions, modelServiceUrl: context.modelServiceUrl };
      const result =
        pathname === '/preview'
          ? await proxyCloneSpeechComparison(
              await readPreviewRequest(request),
              operationController.signal,
              options,
            )
          : pathname === '/asr'
            ? await proxyCloneSpeechAsr(
                await readAsrRequest(request),
                operationController.signal,
                options,
              )
            : await proxyCloneSpeechAlignment(
                await readAlignmentRequest(request),
                operationController.signal,
                options,
              );
      writeJson(response, 200, result);
    } catch (error) {
      const publicError =
        error instanceof RequestBodyTooLargeError
          ? new CloneSpeechHarnessPublicError('SPEECH_TOOL_INVALID_REQUEST', 413)
          : error instanceof CloneSpeechHarnessPublicError
            ? error
            : new CloneSpeechHarnessPublicError('SPEECH_TOOL_INVALID_REQUEST', 400);
      if (!response.destroyed) writePublicError(response, publicError);
    } finally {
      context.activePreviewOperations.delete(operationController);
      request.off('aborted', abort);
      response.off('close', abortOnResponseClose);
    }
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(404).end();
    return;
  }
  const fileName =
    pathname === '/'
      ? 'index.html'
      : pathname === '/clone-speech-harness.js'
        ? 'clone-speech-harness.js'
        : pathname === '/clone-speech-harness.css'
          ? 'clone-speech-harness.css'
          : undefined;
  if (fileName === undefined) {
    response.writeHead(404).end();
    return;
  }
  const file = path.join(context.outputDirectory, fileName);
  response.setHeader('Content-Type', contentTypeFor(fileName));
  if (request.method === 'HEAD') {
    response.writeHead(200).end();
    return;
  }
  createReadStream(file)
    .once('error', () => {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    })
    .pipe(response);
}

async function readAsrRequest(request: IncomingMessage): Promise<string> {
  if (
    mediaType(request.headers['content-type']) !== 'application/json' ||
    request.headers['content-encoding'] !== undefined
  )
    throw new Error('JSON body required');
  const body = await readBoundedRequestBody(request, MAX_ASR_REQUEST_BYTES);
  const value: unknown = JSON.parse(body.toString('utf8'));
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.dataBase64 !== 'string')
    throw new Error('Invalid ASR request');
  validateAsrAudio(value.dataBase64);
  return value.dataBase64;
}

async function readAlignmentRequest(
  request: IncomingMessage,
): Promise<{ dataBase64: string; transcript: string }> {
  if (
    mediaType(request.headers['content-type']) !== 'application/json' ||
    request.headers['content-encoding'] !== undefined
  )
    throw new Error('JSON body required');
  const body = await readBoundedRequestBody(request, MAX_ASR_REQUEST_BYTES + 1_024);
  const value: unknown = JSON.parse(body.toString('utf8'));
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.dataBase64 !== 'string' ||
    typeof value.transcript !== 'string'
  )
    throw new Error('Invalid alignment request');
  validateAsrAudio(value.dataBase64);
  validateAlignmentTranscript(value.transcript);
  return { dataBase64: value.dataBase64, transcript: value.transcript };
}

function validateAlignmentTranscript(transcript: string): void {
  if (
    transcript.trim().length === 0 ||
    Array.from(transcript).length > 150 ||
    /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(transcript)
  ) {
    throw new CloneSpeechHarnessPublicError('SPEECH_TOOL_INVALID_REQUEST', 400);
  }
}

function validateAsrAudio(dataBase64: string): void {
  if (
    dataBase64.length === 0 ||
    dataBase64.length > MAX_ASR_REQUEST_BYTES ||
    dataBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64) ||
    Buffer.from(dataBase64, 'base64').byteLength > MAX_PREVIEW_AUDIO_BYTES
  ) {
    throw new CloneSpeechHarnessPublicError('SPEECH_TOOL_INVALID_REQUEST', 400);
  }
}

function parseAsrResponse(bytes: Uint8Array): CloneSpeechHarnessAsrResult {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw unavailableError(502);
  }
  if (
    !isRecord(value) ||
    typeof value.text !== 'string' ||
    value.text.length > 10_000 ||
    typeof value.elapsedMs !== 'number' ||
    !Number.isFinite(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    value.elapsedMs > 120_000 ||
    !Array.isArray(value.words) ||
    value.words.length > 2_000
  )
    throw unavailableError(502);
  const words: CloneSpeechHarnessWord[] = [];
  for (const entry of value.words) {
    if (
      !isRecord(entry) ||
      typeof entry.word !== 'string' ||
      entry.word.length === 0 ||
      entry.word.length > 256 ||
      typeof entry.startTime !== 'number' ||
      typeof entry.endTime !== 'number' ||
      !Number.isFinite(entry.startTime) ||
      !Number.isFinite(entry.endTime) ||
      entry.startTime < 0 ||
      entry.endTime < entry.startTime ||
      entry.endTime > 3_600
    )
      throw unavailableError(502);
    words.push({ word: entry.word, startTime: entry.startTime, endTime: entry.endTime });
  }
  return { text: value.text, elapsedMs: value.elapsedMs, words };
}

function parseAlignmentResponse(bytes: Uint8Array): CloneSpeechHarnessAlignmentResult {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw unavailableError(502);
  }
  if (
    !isRecord(value) ||
    typeof value.elapsedMs !== 'number' ||
    !Number.isFinite(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    value.elapsedMs > 120_000 ||
    typeof value.exact !== 'boolean' ||
    !Array.isArray(value.words) ||
    value.words.length > 2_000
  )
    throw unavailableError(502);
  const words: CloneSpeechHarnessWord[] = [];
  for (const entry of value.words) {
    if (
      !isRecord(entry) ||
      typeof entry.word !== 'string' ||
      entry.word.length === 0 ||
      entry.word.length > 256 ||
      typeof entry.startTime !== 'number' ||
      typeof entry.endTime !== 'number' ||
      !Number.isFinite(entry.startTime) ||
      !Number.isFinite(entry.endTime) ||
      entry.startTime < 0 ||
      entry.endTime < entry.startTime ||
      entry.endTime > 600
    )
      throw unavailableError(502);
    words.push({ word: entry.word, startTime: entry.startTime, endTime: entry.endTime });
  }
  return { words, elapsedMs: value.elapsedMs, exact: value.exact };
}

async function readPreviewRequest(
  request: IncomingMessage,
): Promise<CloneSpeechHarnessPreviewInput> {
  if (mediaType(request.headers['content-type']) !== 'application/json') {
    throw new Error('JSON body required');
  }
  if (request.headers['content-encoding'] !== undefined) {
    throw new Error('Encoded bodies are not accepted');
  }
  const body = await readBoundedRequestBody(request, CLONE_SPEECH_HARNESS_MAX_REQUEST_BYTES);
  const value: unknown = JSON.parse(body.toString('utf8'));
  if (!isRecord(value)) throw new Error('Object body required');
  const allowedKeys = new Set([
    'markdown',
    'markdownFrom',
    'markdownTo',
    'speechMarkup',
    'inputMode',
    'enableSubtitle',
    'enableTimestamp',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error('Unknown request field');
  }
  if (
    typeof value.markdown !== 'string' ||
    !Number.isSafeInteger(value.markdownFrom) ||
    !Number.isSafeInteger(value.markdownTo)
  ) {
    throw new Error('Invalid preview selection');
  }
  const speechMarkup = readSpeechMarkup(value.speechMarkup, value.markdown);
  if (
    value.inputMode !== undefined &&
    !['ssml_text_type', 'ssml_field', 'plain_text'].includes(value.inputMode as string)
  ) {
    throw new Error('Invalid input mode');
  }
  if (
    value.inputMode === undefined
      ? value.enableSubtitle !== undefined || value.enableTimestamp !== undefined
      : typeof value.enableSubtitle !== 'boolean' || typeof value.enableTimestamp !== 'boolean'
  ) {
    throw new Error('Invalid subtitle options');
  }
  return {
    markdown: value.markdown,
    markdownFrom: value.markdownFrom as number,
    markdownTo: value.markdownTo as number,
    ...(speechMarkup === undefined ? {} : { speechMarkup }),
    ...(value.inputMode === undefined
      ? {}
      : {
          inputMode: value.inputMode as CloneSpeechHarnessPreviewInput['inputMode'],
          enableSubtitle: value.enableSubtitle as boolean,
          enableTimestamp: value.enableTimestamp as boolean,
        }),
  };
}

function parseExperimentalResponse(
  bytes: Uint8Array,
  maxAudioBytes: number,
): { audio: Uint8Array; durationSeconds: number; words: CloneSpeechHarnessWord[] } {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw unavailableError(502);
  }
  if (
    !isRecord(value) ||
    value.contentType !== 'audio/mpeg' ||
    typeof value.dataBase64 !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.dataBase64) ||
    value.dataBase64.length % 4 !== 0 ||
    typeof value.durationSeconds !== 'number' ||
    !Number.isFinite(value.durationSeconds) ||
    value.durationSeconds < 0 ||
    value.durationSeconds > 600 ||
    !Array.isArray(value.words) ||
    value.words.length > 2_000
  )
    throw unavailableError(502);
  const audio = Buffer.from(value.dataBase64, 'base64');
  if (audio.length === 0 || audio.length > maxAudioBytes) throw unavailableError(502);
  const words: CloneSpeechHarnessWord[] = [];
  for (const item of value.words) {
    if (
      !isRecord(item) ||
      typeof item.word !== 'string' ||
      item.word.length === 0 ||
      item.word.length > 100 ||
      typeof item.startTime !== 'number' ||
      typeof item.endTime !== 'number' ||
      !Number.isFinite(item.startTime) ||
      !Number.isFinite(item.endTime) ||
      item.startTime < 0 ||
      item.endTime < item.startTime ||
      item.endTime > 600
    )
      throw unavailableError(502);
    words.push({ word: item.word, startTime: item.startTime, endTime: item.endTime });
  }
  return { audio, durationSeconds: value.durationSeconds, words };
}

function createProviderPreviews(input: CloneSpeechHarnessPreviewInput): readonly {
  alignmentTranscript: string;
  sourceText: string;
  sourceUnits: readonly SourceUnit[];
  ssml: string;
}[] {
  const speechMarkup = readSpeechMarkup(input.speechMarkup, input.markdown);
  const projection = projectReachDeckSpeechDocument(input.markdown, speechMarkup);
  const chunks = planReachDeckSsmlSelectionChunks(input.markdown, speechMarkup, {
    from: input.markdownFrom,
    to: input.markdownTo,
  });
  if (
    chunks.length === 0 ||
    chunks.some((chunk) => chunk.alignmentTranscript.trim().length === 0)
  ) {
    throw new CloneSpeechHarnessPublicError('SPEECH_TOOL_INVALID_REQUEST', 400);
  }
  return chunks.map((chunk) => ({
    alignmentTranscript: chunk.alignmentTranscript,
    sourceText: projectReachDeckSpeechVisibleRange(projection, {
      from: chunk.markdownFrom,
      to: chunk.markdownTo,
    }),
    sourceUnits: chunk.alignmentMap.flatMap((entry): SourceUnit[] => {
      const text = projectReachDeckSpeechVisibleRange(projection, {
        from: entry.markdownFrom,
        to: entry.markdownTo,
      });
      const spoken = chunk.alignmentTranscript.slice(entry.spokenFrom, entry.spokenTo);
      if (text.length === 0 && spoken.length === 0) return [];
      if (entry.atomic || text.length !== spoken.length) {
        return [{ text, spoken, atomic: true }];
      }
      return Array.from(spoken).map((scalar, index) => ({
        text: Array.from(text)[index] ?? '',
        spoken: scalar,
        atomic: false,
      }));
    }),
    ssml: chunk.ssml,
  }));
}

function readSpeechMarkup(value: unknown, markdown: string): ReachDeckSpeechMarkupV1 | undefined {
  if (value === undefined) return undefined;
  return canonicalizeReachDeckSpeechMarkupV1(value, markdown);
}

function readBoundedRequestBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) throw new Error('Invalid Content-Length');
    if (Number(contentLength) > limit) {
      request.resume();
      throw new RequestBodyTooLargeError();
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > limit) {
        settled = true;
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(bytes);
    });
    request.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });
    request.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    request.once('aborted', () => {
      if (settled) return;
      settled = true;
      reject(new Error('Request aborted'));
    });
  });
}

async function readBoundedResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (/^\d+$/.test(declared) === false || Number(declared) > limit)) {
    await discardResponse(response);
    throw unavailableError(502);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw unavailableError(502);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function publicUpstreamError(upstream: Response): CloneSpeechHarnessPublicError {
  const internalCode = upstream.headers.get(ERROR_CODE_HEADER);
  const code =
    internalCode === null
      ? 'SPEECH_TOOL_ADMISSION_UNAVAILABLE'
      : (PUBLIC_ERROR_CODES[internalCode] ?? 'SPEECH_TOOL_ADMISSION_UNAVAILABLE');
  const retryAfterSeconds =
    code === 'SPEECH_TOOL_RATE_LIMITED'
      ? readRetryAfterSeconds(upstream.headers.get('retry-after'))
      : undefined;
  const status =
    code === 'SPEECH_TOOL_RATE_LIMITED'
      ? 429
      : code === 'SPEECH_VOICE_UNSUPPORTED'
        ? 422
        : code === 'SPEECH_PREVIEW_TIMEOUT'
          ? 504
          : 503;
  return new CloneSpeechHarnessPublicError(code, status, retryAfterSeconds);
}

function unavailableError(status: number): CloneSpeechHarnessPublicError {
  return new CloneSpeechHarnessPublicError('SPEECH_TOOL_ADMISSION_UNAVAILABLE', status);
}

async function cancelPreview(
  upstreamUrl: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    const response = await fetchImpl(upstreamUrl, {
      headers: {
        [ASYNC_HEADER]: headers[ASYNC_HEADER]!,
        [IDENTITY_HEADER]: headers[IDENTITY_HEADER]!,
        [VOICE_MODE_HEADER]: headers[VOICE_MODE_HEADER]!,
      },
      method: 'DELETE',
      signal: AbortSignal.timeout(3_000),
    });
    await discardResponse(response);
  } catch {
    // The browser request is ending; cancellation remains best effort.
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // No upstream body is part of the public harness response.
  }
}

function readRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds <= 60 ? seconds : undefined;
}

function isSameOriginRequest(request: IncomingMessage, expectedOrigin: string): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
  if (request.headers.host !== expectedOrigin.slice('http://'.length)) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === expectedOrigin && parsed.href === `${expectedOrigin}/`;
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') {
    return true;
  }
  const octets = hostname.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  return isLoopbackHostname(address.replace(/^::ffff:/, '').toLowerCase());
}

function safePathname(requestUrl: string | undefined): string | undefined {
  try {
    return new URL(requestUrl ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return undefined;
  }
}

function mediaType(value: string | string[] | null | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(';', 1)[0]?.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applyPublicHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(PUBLIC_HEADERS)) response.setHeader(name, value);
}

function writePublicError(response: ServerResponse, error: CloneSpeechHarnessPublicError): void {
  if (error.retryAfterSeconds !== undefined) {
    response.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
  writeJson(response, error.status, { code: error.code });
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.writeHead(status).end(JSON.stringify(value));
}

function contentTypeFor(fileName: string): string {
  if (fileName.endsWith('.html')) return 'text/html; charset=utf-8';
  if (fileName.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'text/css; charset=utf-8';
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

async function loadHarnessCss(): Promise<string> {
  const [brand, ui, editor, math, katex, mathliveFonts] = await Promise.all([
    readFile(path.join(REPOSITORY_ROOT, 'packages/brand/styles/variables.css'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'packages/ui/src/styles.css'), 'utf8'),
    readFile(path.join(EDITOR_ROOT, 'styles.css'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'packages/tiptap-mathlive/styles.css'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'node_modules/katex/dist/katex.min.css'), 'utf8'),
    readFile(path.join(REPOSITORY_ROOT, 'node_modules/mathlive/mathlive-fonts.css'), 'utf8'),
  ]);
  const stripImports = (css: string) => css.replace(/^@import .*;$/gm, '');
  const stripFontFaces = (css: string) => css.replace(/@font-face\s*\{[^}]*\}/g, '');
  return [
    brand,
    stripImports(ui),
    stripImports(editor),
    stripImports(math),
    stripFontFaces(katex),
    stripFontFaces(mathliveFonts),
  ].join('\n');
}
