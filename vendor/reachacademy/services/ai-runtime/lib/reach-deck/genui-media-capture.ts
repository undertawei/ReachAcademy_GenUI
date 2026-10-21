import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

import { chromium, type Browser } from 'playwright-core';
import sharp from 'sharp';
import {
  acquireDeckChromium,
  deckChromiumLaunchOptions,
  launchDeckChromium,
  CODE_MEDIA_LIMITS,
} from './code-media-policy.js';
import { closeOwnedWindowsChromium } from './genui-browser-cleanup.js';
import { loadHtmlLayoutFonts } from './html-layout/fonts.js';

export interface ReachDeckGenuiMediaCaptureInput {
  documentHtml: string;
  format: 'jpg' | 'gif';
  width: number;
  height: number;
  /** Resolved design-palette surface; code media always has an opaque backdrop. */
  background?: string;
  durationSeconds?: number;
  fps?: number;
}

export interface ReachDeckGenuiCaptureSession {
  browser: Browser;
  /** Terminates the browser process tree even when generated JavaScript never yields. */
  kill(): Promise<void>;
}

export interface ReachDeckGenuiMediaCaptureOptions {
  signal?: AbortSignal;
  launch?: () => Promise<ReachDeckGenuiCaptureSession>;
  encodeGif?: (
    frames: readonly Uint8Array[],
    fps: number,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
  timeoutMs?: number;
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DOCUMENT_URL = 'https://reach-diagram.invalid/diagram';
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts',
].join('; ');

export async function captureReachDeckGenuiMedia(
  input: ReachDeckGenuiMediaCaptureInput,
  options: ReachDeckGenuiMediaCaptureOptions = {},
) {
  const { fps, frames } = validateInput(input);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new Error('GenUI capture timeout must be between 1 and 30000 ms.');
  }
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () =>
    controller.abort(options.signal?.reason ?? new Error('GenUI capture cancelled.'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('GenUI capture deadline exceeded.')),
    timeoutMs,
  );
  const signal = controller.signal;
  let session: ReachDeckGenuiCaptureSession | undefined;
  let sessionLaunch: Promise<ReachDeckGenuiCaptureSession> | undefined;
  let encoding: Promise<Uint8Array> | undefined;
  let release: (() => void) | undefined;
  let finished = false;
  let killPromise: Promise<void> | undefined;
  const kill = () => {
    if (session && !killPromise) {
      // Admission follows both process exit and encoder cleanup, not the bounded wait in finally:
      // cancellation can close Chromium before the encoder has stopped using the shared slot.
      // A rejected kill has no process left to wait for (the Windows path only rejects without
      // an owned PID), so it must not strand the worker's single slot.
      killPromise = session.kill().finally(async () => {
        await encoding?.catch(() => undefined);
        release?.();
        release = undefined;
      });
      void killPromise.catch(() => undefined);
    }
    return killPromise ?? Promise.resolve();
  };
  signal.addEventListener(
    'abort',
    () => {
      void kill();
    },
    { once: true },
  );
  try {
    return await abortable(
      (async () => {
        const acquired = await acquireDeckChromium(signal);
        // 槽位移交与取消可能同轮发生；外层 finally 此时可能已跑完，必须在这里归还。
        if (signal.aborted) {
          acquired();
          signal.throwIfAborted();
        }
        release = acquired;
        sessionLaunch = (options.launch ?? launchIsolatedChromium)();
        try {
          session = await sessionLaunch;
        } catch (error) {
          release?.();
          release = undefined;
          throw error;
        }
        if (finished || signal.aborted) {
          await kill();
          signal.throwIfAborted();
          throw new Error('GenUI capture already finished.');
        }
        const context = await session.browser.newContext({
          viewport: { width: input.width, height: input.height },
          deviceScaleFactor: 1,
          acceptDownloads: false,
          offline: true,
          permissions: [],
          reducedMotion: 'reduce',
          colorScheme: 'light',
          locale: 'en-US',
          timezoneId: 'UTC',
        });
        await context.routeWebSocket('**/*', (socket) => socket.close());
        const fontCss = await loadHtmlLayoutFonts(input.documentHtml);
        let served = false;
        await context.route('**/*', async (route) => {
          const request = route.request();
          if (!served && request.isNavigationRequest() && request.url() === DOCUMENT_URL) {
            served = true;
            await route.fulfill({
              status: 200,
              contentType: 'text/html; charset=utf-8',
              headers: { 'Content-Security-Policy': CSP },
              body: input.documentHtml.replace(
                /<head([^>]*)>/i,
                '<head$1><style>' + fontCss + '</style>',
              ),
            });
          } else await route.abort('blockedbyclient');
        });
        // The source is fixed host code; generated code cannot access network, storage or real-time loops.
        await context.addInitScript({
          content: `
        Object.defineProperty(globalThis, '__name', {
          value: (value) => value, writable: false, configurable: false
        });
        const deny = () => { throw new Error('Unavailable in offline diagram capture.'); };
        for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker',
          'SharedWorker', 'RTCPeerConnection', 'open', 'setTimeout', 'setInterval', 'requestAnimationFrame']) {
          Object.defineProperty(globalThis, name, { value: deny, writable: false, configurable: false });
        }
      `,
        });
        const page = await context.newPage();
        page.setDefaultTimeout(5_000);
        let runtimeError: Error | undefined;
        page.on('pageerror', (error) => {
          runtimeError = error;
        });
        page.on('download', () => controller.abort(new Error('GenUI downloads are forbidden.')));
        page.on('popup', () => controller.abort(new Error('GenUI popups are forbidden.')));
        page.on('framenavigated', (frame) => {
          if (frame !== page.mainFrame() || frame.url() !== DOCUMENT_URL) {
            controller.abort(new Error('GenUI navigation is forbidden.'));
          }
        });
        await page.goto(DOCUMENT_URL, { waitUntil: 'load', timeout: 10_000 });
        await page.addStyleTag({
          content: `html,body{background-color:${input.background ?? '#ffffff'} !important}*,*::before,*::after{animation:none !important;transition:none !important}`,
        });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const captured: Uint8Array[] = [];
        let capturedBytes = 0;
        for (let index = 0; index < frames; index += 1) {
          signal.throwIfAborted();
          if (runtimeError)
            throw new Error('GenUI document execution failed.', { cause: runtimeError });
          await page.evaluate((seconds) => {
            const diagram = (
              window as unknown as {
                ReachDiagram?: { renderAt(seconds: number): unknown; check(): unknown };
              }
            ).ReachDiagram;
            if (
              !diagram ||
              typeof diagram.renderAt !== 'function' ||
              typeof diagram.check !== 'function'
            ) {
              throw new Error('GenUI must expose synchronous ReachDiagram.renderAt and check.');
            }
            const rendered = diagram.renderAt(seconds);
            if (rendered && typeof (rendered as { then?: unknown }).then === 'function') {
              throw new Error('GenUI renderAt must be synchronous.');
            }
            const checks = diagram.check();
            if (!Array.isArray(checks) || checks.length < 1 || checks.length > 32) {
              throw new Error('GenUI scientific runtime checks failed: invalid check array.');
            }
            const failedChecks = checks.filter((item) => {
              if (!item || typeof item !== 'object') return true;
              return !(
                typeof item.name === 'string' &&
                item.name.trim().length > 0 &&
                item.passed === true &&
                (item.actual === undefined ||
                  (typeof item.actual === 'number' && Number.isFinite(item.actual))) &&
                (item.expected === undefined ||
                  (typeof item.expected === 'number' && Number.isFinite(item.expected)))
              );
            });
            if (failedChecks.length) {
              // Bounded check names keep a model-authored invariant failure distinguishable
              // from a screenshot failure in page diagnostics.
              const names = failedChecks
                .slice(0, 4)
                .map((item) =>
                  typeof item?.name === 'string'
                    ? item.name.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 80)
                    : 'invalid check',
                );
              throw new Error(
                `GenUI scientific runtime checks failed: ${names.join('; ') || 'invalid check'}.`,
              );
            }
          }, index / fps);
          const bytes = await page.screenshot({
            type: input.format === 'jpg' ? 'jpeg' : 'png',
            ...(input.format === 'jpg' ? { quality: 90 } : {}),
            timeout: 5_000,
          });
          capturedBytes += bytes.byteLength;
          if (capturedBytes > MAX_FRAME_BYTES)
            throw new Error('GenUI capture frames exceed 64 MiB.');
          captured.push(bytes);
        }
        if (runtimeError)
          throw new Error('GenUI document execution failed.', { cause: runtimeError });
        const bytes =
          input.format === 'jpg'
            ? captured[0]!
            : await (encoding = (options.encodeGif ?? encodeGif)(captured, fps, signal));
        const contentType =
          input.format === 'jpg' ? ('image/jpeg' as const) : ('image/gif' as const);
        await validateOutput(bytes, input);
        signal.throwIfAborted();
        return {
          bytes,
          contentType,
          width: input.width,
          height: input.height,
          checksumSha256: createHash('sha256').update(bytes).digest('hex'),
          frameCount: frames,
        };
      })(),
      signal,
    );
  } finally {
    finished = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    await encoding?.catch(() => undefined);
    if (sessionLaunch && !session) {
      // Cancellation can beat process startup. Keep admission until the late process is killed;
      // kill() releases it, and a failed launch releases it in the launch catch above.
      void sessionLaunch
        .then(async (late) => {
          session = late;
          await kill();
        })
        .catch(() => undefined);
    } else if (session) {
      // Windows taskkill can hang; never hold the job past ~1s here. kill() still releases
      // admission only once the owned browser has actually exited.
      await boundedCleanup(kill());
    } else {
      release?.();
    }
  }
}

function validateInput(input: ReachDeckGenuiMediaCaptureInput) {
  if (input.background !== undefined && !/^#[0-9a-f]{6}$/i.test(input.background))
    throw new Error('Code media background must be an opaque RGB color.');
  if (!input.documentHtml?.trim() || Buffer.byteLength(input.documentHtml) > 200 * 1024) {
    throw new Error('GenUI document must contain at most 200 KiB.');
  }
  if (!['jpg', 'gif'].includes(input.format)) throw new Error('GenUI format must be jpg or gif.');
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 16 ||
    input.height < 16 ||
    input.width > 1600 ||
    input.height > 1200 ||
    input.width * input.height > 2_000_000
  ) {
    throw new Error('GenUI capture dimensions exceed the allowed bounds.');
  }
  if (input.format === 'jpg' && (input.fps !== undefined || input.durationSeconds !== undefined))
    throw new Error('JPG code media forbids animation timing.');
  if (input.format === 'gif' && (input.fps === undefined || input.durationSeconds === undefined))
    throw new Error('GIF code media requires durationSeconds and fps.');
  const fps = input.fps ?? 1;
  const duration = input.durationSeconds ?? 1;
  if (
    !Number.isSafeInteger(fps) ||
    fps < 1 ||
    fps > 15 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 8
  )
    throw new Error('GenUI capture timing exceeds the allowed bounds.');
  const frames = input.format === 'gif' ? Math.ceil(fps * duration) : 1;
  if (input.format === 'gif' && (frames < 2 || frames > 120)) {
    throw new Error('GenUI GIF requires 2 to 120 frames.');
  }
  if (
    input.format === 'gif' &&
    (input.width > CODE_MEDIA_LIMITS.gifWidth ||
      input.height > CODE_MEDIA_LIMITS.gifHeight ||
      input.width * input.height * frames > CODE_MEDIA_LIMITS.decodedFramePixels)
  )
    throw new Error('GIF decoded frame pixel budget exceeded.');
  return { fps, frames };
}

async function validateOutput(bytes: Uint8Array, input: ReachDeckGenuiMediaCaptureInput) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 10 ||
    bytes.byteLength > MAX_OUTPUT_BYTES
  ) {
    throw new Error('GenUI capture output size is invalid.');
  }
  const metadata = await sharp(Buffer.from(bytes), {
    limitInputPixels: 2_000_000,
    animated: false,
  }).metadata();
  if (
    metadata.format !== (input.format === 'jpg' ? 'jpeg' : 'gif') ||
    metadata.width !== input.width ||
    metadata.height !== input.height
  ) {
    throw new Error('GenUI capture output format or dimensions are invalid.');
  }
  if (input.format === 'gif') {
    const expected = Math.ceil(input.fps! * input.durationSeconds!);
    const delays = metadata.delay ?? [];
    const total = delays.reduce((sum, delay) => sum + delay, 0);
    if (
      metadata.pages !== expected ||
      metadata.loop !== 0 ||
      delays.length !== expected ||
      delays.some((delay) => delay < 10 || delay > 1000) ||
      Math.abs(total - (expected / input.fps!) * 1000) > expected * 10
    )
      throw new Error('GIF frame count, loop or encoded timing is invalid.');
  }
}

async function launchIsolatedChromium(): Promise<ReachDeckGenuiCaptureSession> {
  const env: Record<string, string> = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
  ]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  const server = await launchDeckChromium(() =>
    chromium.launchServer({
      ...deckChromiumLaunchOptions(),
      env,
      timeout: 10_000,
    }),
  );
  let browser: Browser | undefined;
  // BrowserServer.kill uses synchronous taskkill on Windows, which can block the event loop.
  const kill = () =>
    process.platform === 'win32'
      ? closeOwnedWindowsChromium(server.process(), browser)
      : server.kill();
  try {
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 10_000 });
    return { browser, kill };
  } catch (error) {
    await kill();
    throw error;
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function boundedCleanup(operation: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    void operation
      .finally(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch(() => undefined);
  });
}

function encodeGif(
  frames: readonly Uint8Array[],
  fps: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.REACH_DECK_FFMPEG_PATH?.trim() || 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-protocol_whitelist',
        'pipe',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        '-framerate',
        String(fps),
        '-i',
        'pipe:0',
        '-filter_complex_threads',
        '1',
        '-filter_complex',
        '[0:v]split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1:dither=sierra2_4a',
        '-an',
        '-sn',
        '-dn',
        '-loop',
        '0',
        '-f',
        'gif',
        'pipe:1',
      ],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let failure: Error | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else resolve(Buffer.concat(chunks));
    };
    const fail = (error: Error) => {
      if (failure || settled) return;
      failure = error;
      child.kill('SIGKILL');
      // Resolve only on close: the shared browser slot includes encoder cleanup.
    };
    const abort = () => fail(new Error('GenUI GIF encoding cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_OUTPUT_BYTES) fail(new Error('GenUI GIF output exceeds 10 MiB.'));
      else if (!settled && !failure) chunks.push(chunk);
    });
    child.stderr.resume();
    child.once('error', () => fail(new Error('GenUI GIF encoder unavailable.')));
    child.once('close', (code) =>
      finish(failure ?? (code === 0 ? undefined : new Error('GenUI GIF encoder failed.'))),
    );
    child.stdin.on('error', () => fail(new Error('GenUI GIF encoder input failed.')));
    void (async () => {
      for (const frame of frames) {
        signal.throwIfAborted();
        if (settled || failure) return;
        if (!child.stdin.write(frame)) await once(child.stdin, 'drain', { signal });
      }
      child.stdin.end();
    })().catch(() => fail(new Error('GenUI GIF encoding cancelled.')));
  });
}
