import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolveReachDeckRuntimeAsset } from './runtime-assets.js';

/**
 * 每个 worker 进程同时运行的 Deck Chromium 任务数，HTML 版面编译、静态图表与代码动画截取共用。
 *
 * 单槽位时批量生成会让几十页同时挤在一个浏览器队列里；容量按 deck worker 2 核 CPU 取 2。
 */
export const DECK_CHROMIUM_SLOTS = 2;

let activeDeckChromium = 0;
const deckChromiumWaiters: Array<() => void> = [];

/**
 * 取得一个 Deck Chromium 槽位，返回幂等的释放函数。
 *
 * 数据源：无 PG/Mongo 读写；纯进程内调度。
 *
 * 核心逻辑：有空槽立即占用；否则按先来先到排队，只受调用方 `signal` 约束——排队期间取消
 * 会立刻出队并拒绝，不占槽位。释放时若有等待者，槽位直接移交，计数不变。各渲染自身的超时
 * 应在拿到槽位后才开始计时，排队时长不能算进单次渲染预算。
 */
export async function acquireDeckChromium(signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  if (activeDeckChromium < DECK_CHROMIUM_SLOTS) {
    activeDeckChromium += 1;
    return deckChromiumRelease();
  }
  await new Promise<void>((resolve, reject) => {
    const admit = () => {
      signal?.removeEventListener('abort', cancelled);
      resolve();
    };
    const cancelled = () => {
      const index = deckChromiumWaiters.indexOf(admit);
      if (index >= 0) deckChromiumWaiters.splice(index, 1);
      reject(signal!.reason);
    };
    deckChromiumWaiters.push(admit);
    signal?.addEventListener('abort', cancelled, { once: true });
  });
  return deckChromiumRelease();
}

function deckChromiumRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = deckChromiumWaiters.shift();
    if (next) next();
    else activeDeckChromium -= 1;
  };
}

/** Chromium 无法启动属于基础设施故障（镜像缺浏览器、节点禁用 sandbox 所需 namespace 等），与模型输出无关。 */
export class ReachDeckRendererUnavailableError extends Error {
  readonly code = 'TEACHER_DECK_RENDERER_UNAVAILABLE';

  constructor(cause: unknown) {
    super(
      `Deck Chromium renderer is unavailable: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 1500)}`,
      { cause },
    );
    this.name = 'ReachDeckRendererUnavailableError';
  }
}

/** 所有 Deck Chromium 启动点共用：把启动失败统一归类为渲染器不可用。 */
export async function launchDeckChromium<T>(launch: () => Promise<T>): Promise<T> {
  try {
    return await launch();
  } catch (error) {
    throw new ReachDeckRendererUnavailableError(error);
  }
}

export function deckChromiumLaunchOptions() {
  return {
    headless: true,
    chromiumSandbox: true,
    ...(process.env.REACH_DECK_HTML_CHROME_PATH
      ? { executablePath: path.resolve(process.env.REACH_DECK_HTML_CHROME_PATH) }
      : process.platform === 'linux'
        ? { executablePath: '/usr/bin/chromium' }
        : { channel: 'chrome' }),
  };
}

export const CODE_MEDIA_LIMITS = Object.freeze({
  gifWidth: 1280,
  gifHeight: 720,
  // 32M RGBA pixels = 128 MiB worst-case decoded frame storage per active Chromium slot.
  decodedFramePixels: 32_000_000,
  frames: 120,
  outputBytes: 10 * 1024 * 1024,
});

export const CODE_MEDIA_ENCODER_VERSION = 'code-media/ffmpeg-palette-single-sierra2-4a-loop0/v2';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let runtimeIdentity:
  | Promise<{ browserManifestDigest: string; fontManifestDigest: string; ffmpegVersion: string }>
  | undefined;
/** Probe only explicit executable versions, never inspect running process command lines. */
export function getCodeMediaRuntimeIdentity() {
  return (runtimeIdentity ??= (async () => {
    const launch = deckChromiumLaunchOptions();
    const executable =
      'executablePath' in launch
        ? launch.executablePath!
        : process.platform === 'win32'
          ? path.join(
              process.env.PROGRAMFILES ?? 'C:/Program Files',
              'Google/Chrome/Application/chrome.exe',
            )
          : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const version = (file: string, args: string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile(
          file,
          args,
          { timeout: 5000, maxBuffer: 32768, windowsHide: true },
          (error, stdout) =>
            error
              ? reject(new Error('Code media runtime version unavailable', { cause: error }))
              : resolve(stdout.trim().split(/\r?\n/)[0]!),
        ),
      );
    // Windows GUI Chrome does not print --version; its signed PE product version is the same binary identity.
    const browser =
      process.platform === 'win32'
        ? await version('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-Item -LiteralPath '${executable.replaceAll("'", "''")}').VersionInfo.ProductVersion`,
          ])
        : await version(executable, ['--version']);
    const fontDirectory = path.join(
      path.dirname(resolveReachDeckRuntimeAsset('player-styles')),
      'fonts',
    );
    const [manifest, hashes, ffmpegVersion] = await Promise.all([
      readFile(path.join(fontDirectory, 'manifest.json')),
      readFile(path.join(fontDirectory, 'sources/SHA256SUMS')),
      version(process.env.REACH_DECK_FFMPEG_PATH?.trim() || 'ffmpeg', ['-version']),
    ]);
    if (!browser || !ffmpegVersion) throw new Error('Code media runtime identity is empty');
    return {
      browserManifestDigest: digest(
        JSON.stringify({ policy: 'shared-chromium-sandbox/v1', browser, executable }),
      ),
      fontManifestDigest: digest(Buffer.concat([manifest, hashes])),
      ffmpegVersion,
    };
  })().catch((error) => {
    runtimeIdentity = undefined;
    throw error;
  }));
}

export function buildCodeMediaRenderIdentity(input: {
  sourceDigest: string;
  format: 'jpg' | 'gif';
  width: number;
  height: number;
  background?: string;
  fps?: number;
  durationSeconds?: number;
  browserManifestDigest: string;
  fontManifestDigest: string;
  ffmpegVersion: string;
}) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        representation: 'code',
        ...input,
        background: input.background ?? '#ffffff',
        frameCount: input.format === 'gif' ? Math.ceil(input.fps! * input.durationSeconds!) : 1,
        encoder: CODE_MEDIA_ENCODER_VERSION,
      }),
    )
    .digest('hex');
}
