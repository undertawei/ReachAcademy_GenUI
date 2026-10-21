import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureReachDeckGenuiMedia } from '../../lib/reach-deck/genui-media-capture.js';
import {
  createGifCompositor,
  parseGif,
} from '../../../../packages/reach-deck-player/src/gifFrames.js';
import {
  compileHtmlLayout,
  validateHtmlLayoutInput,
} from '../../lib/reach-deck/html-layout/index.js';
import {
  acquireDeckChromium,
  buildCodeMediaRenderIdentity,
  DECK_CHROMIUM_SLOTS,
} from '../../lib/reach-deck/code-media-policy.js';

/** 占满除 `leave` 个以外的全部 Chromium 槽位，返回一次性归还函数。 */
async function occupyDeckChromium(leave = 0): Promise<() => void> {
  const held = await Promise.all(
    Array.from({ length: DECK_CHROMIUM_SLOTS - leave }, () => acquireDeckChromium()),
  );
  return () => held.forEach((release) => release());
}

/** 探测槽位：返回是否已拿到以及归还函数。 */
function probeDeckChromium() {
  const state = { acquired: false, release: undefined as (() => void) | undefined };
  const done = acquireDeckChromium().then((release) => {
    state.acquired = true;
    state.release = release;
  });
  return { state, done };
}

const documentHtml = `<!doctype html><html><head><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}
</style></head><body><svg width="320" height="180" viewBox="0 0 320 180">
<line x1="30" y1="140" x2="290" y2="140" stroke="black"/>
<circle id="point" cx="40" cy="100" r="12" fill="blue"/>
<text x="30" y="165">x = 40 + 80t</text></svg><script>
window.ReachDiagram={renderAt(t){document.getElementById('point').setAttribute('cx',String(40+80*t))},
check(){return [{name:'position',passed:Number(document.getElementById('point').getAttribute('cx'))>=40}]}};
</script></body></html>`;

afterEach(() => vi.unstubAllEnvs());

describe('offline scientific media capture in Chromium', () => {
  it('separates render identities by source, geometry, timing, background and runtime', () => {
    const base = {
      sourceDigest: 'a'.repeat(64),
      format: 'gif' as const,
      width: 640,
      height: 360,
      fps: 10,
      durationSeconds: 4,
      browserManifestDigest: 'browser',
      fontManifestDigest: 'fonts',
      ffmpegVersion: 'ffmpeg',
    };
    const identity = buildCodeMediaRenderIdentity(base);
    for (const change of [
      { sourceDigest: 'b'.repeat(64) },
      { width: 600 },
      { height: 320 },
      { fps: 12 },
      { durationSeconds: 3 },
      { background: '#aabbcc' },
      { browserManifestDigest: 'next-browser' },
      { fontManifestDigest: 'next-fonts' },
      { ffmpegVersion: 'next-ffmpeg' },
    ])
      expect(buildCodeMediaRenderIdentity({ ...base, ...change })).not.toBe(identity);
  });
  it('captures a correctly sized JPG with nonempty visual content', async () => {
    const result = await captureReachDeckGenuiMedia({
      documentHtml,
      format: 'jpg',
      width: 320,
      height: 180,
    });
    expect(result.contentType).toBe('image/jpeg');
    expect(result.frameCount).toBe(1);
    expect(await sharp(result.bytes).metadata()).toMatchObject({
      format: 'jpeg',
      width: 320,
      height: 180,
    });
    const stats = await sharp(result.bytes).stats();
    expect(stats.channels.some((channel) => channel.stdev > 10)).toBe(true);
  }, 20_000);

  it('encodes multiple deterministic frames as an animated GIF', async () => {
    const result = await captureReachDeckGenuiMedia({
      documentHtml,
      format: 'gif',
      width: 320,
      height: 180,
      fps: 4,
      durationSeconds: 1,
    });
    expect(result.frameCount).toBe(4);
    const metadata = await sharp(result.bytes, { animated: true }).metadata();
    expect(metadata).toMatchObject({ format: 'gif', width: 320, pageHeight: 180, pages: 4 });
    const first = await sharp(result.bytes, { page: 0 }).raw().toBuffer();
    const last = await sharp(result.bytes, { page: 3 }).raw().toBuffer();
    expect(first.equals(last)).toBe(false);
    expect(metadata.loop).toBe(0);
    expect(metadata.delay).toEqual([250, 250, 250, 250]);
    const animation = parseGif(result.bytes);
    const draw = createGifCompositor(animation);
    for (let index = 0; index < result.frameCount; index++) {
      const decoded = await sharp(result.bytes, { page: index }).ensureAlpha().raw().toBuffer();
      expect(Buffer.from(draw(index)).equals(decoded)).toBe(true);
    }
    expect(
      Buffer.from(draw(0)).equals(
        await sharp(result.bytes, { page: 0 }).ensureAlpha().raw().toBuffer(),
      ),
    ).toBe(true);
    const input = {
      html: '<!doctype html><html><head></head><body><section id="slide" style="position:relative;width:1600px;height:900px"><img id="animated" data-reach-asset="motion" style="position:absolute;left:100px;top:100px;width:640px;height:360px"/></section></body></html>',
      pageId: 'gif-page',
      themeName: 'academic-blue',
      assets: [
        {
          kind: 'image' as const,
          assetId: 'motion',
          alt: 'Moving point',
          resource: {
            id: 'motion-resource',
            objectKey: 'motion.gif',
            digest: result.checksumSha256,
            contentType: 'image/gif',
          },
          dataUrl: `data:image/gif;base64,${Buffer.from(result.bytes).toString('base64')}`,
          codeAnimation: { sourceDigest: 'a'.repeat(64), frameCount: 4 },
        },
      ],
    };
    await expect(
      validateHtmlLayoutInput({
        ...input,
        assets: input.assets.map(({ codeAnimation, ...asset }) => asset),
      }),
    ).rejects.toThrow('frame budget');
    await expect(
      validateHtmlLayoutInput({
        ...input,
        assets: [],
        html: input.html.replace('data-reach-asset="motion"', `src="${input.assets[0]!.dataUrl}"`),
      }),
    ).rejects.toThrow('frame budget');
    const compiled = await compileHtmlLayout(input);
    expect(compiled.resources).toContainEqual(input.assets[0]!.resource);
    expect(compiled.slide.elements).toContainEqual(
      expect.objectContaining({ type: 'image', resourceId: 'motion-resource' }),
    );
    expect(compiled.pendingMedia).toHaveLength(0);
  }, 20_000);

  it('rejects illegal timing and decoded-memory budgets before starting Chromium', async () => {
    const launch = vi.fn();
    for (const input of [
      { format: 'jpg' as const, fps: 10 },
      { format: 'gif' as const },
      { format: 'gif' as const, fps: 15, durationSeconds: 8, width: 1280, height: 720 },
      { format: 'gif' as const, fps: 1, durationSeconds: 2, width: 1281 },
    ])
      await expect(
        captureReachDeckGenuiMedia({ documentHtml, width: 320, height: 180, ...input }, { launch }),
      ).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });

  it('shares HTML Chromium admission and cancels queued code without launching', async () => {
    const release = await occupyDeckChromium();
    const signal = new AbortController();
    const launch = vi.fn();
    const capture = captureReachDeckGenuiMedia(
      { documentHtml, format: 'jpg', width: 320, height: 180 },
      { signal: signal.signal, launch },
    );
    signal.abort(new Error('queued cancellation'));
    await expect(capture).rejects.toThrow('queued cancellation');
    release();
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects a failed scientific invariant', async () => {
    await expect(
      captureReachDeckGenuiMedia({
        documentHtml: documentHtml.replace('passed:Number', 'passed:false&&Number'),
        format: 'jpg',
        width: 320,
        height: 180,
      }),
    ).rejects.toThrow('scientific runtime checks failed');
  }, 20_000);

  it('kills non-yielding code on deadline and releases the capture slot', async () => {
    await expect(
      captureReachDeckGenuiMedia(
        {
          documentHtml: documentHtml.replace(
            "document.getElementById('point').setAttribute",
            "while(true){};document.getElementById('point').setAttribute",
          ),
          format: 'jpg',
          width: 320,
          height: 180,
        },
        { timeoutMs: 1500 },
      ),
    ).rejects.toThrow('deadline exceeded');
    const result = await captureReachDeckGenuiMedia({
      documentHtml,
      format: 'jpg',
      width: 320,
      height: 180,
    });
    expect(result.frameCount).toBe(1);
  }, 20_000);

  it('cancels an in-flight launch and kills the late browser without leaking it', async () => {
    const controller = new AbortController();
    let finishLaunch!: (session: any) => void;
    const kill = vi.fn(async () => undefined);
    const result = captureReachDeckGenuiMedia(
      { documentHtml, format: 'jpg', width: 320, height: 180 },
      {
        signal: controller.signal,
        launch: () =>
          new Promise((resolve) => {
            finishLaunch = resolve;
          }),
      },
    );
    await vi.waitFor(() => expect(finishLaunch).toBeTypeOf('function'));
    controller.abort(new Error('cancel capture'));
    await expect(result).rejects.toThrow('cancel capture');
    finishLaunch({ browser: {}, kill });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('bounds cleanup but keeps shared admission until a cancelled browser actually closes', async () => {
    const others = await occupyDeckChromium(1);
    const controller = new AbortController();
    let finishCleanup!: () => void;
    let launched!: () => void;
    const started = new Promise<void>((resolve) => (launched = resolve));
    const capture = captureReachDeckGenuiMedia(
      { documentHtml, format: 'jpg', width: 320, height: 180 },
      {
        signal: controller.signal,
        launch: async () => {
          launched();
          return {
            browser: { newContext: () => new Promise(() => {}) } as any,
            kill: () => new Promise<void>((resolve) => (finishCleanup = resolve)),
          };
        },
      },
    );
    const outcome = expect(capture).rejects.toThrow('cancel');
    await started;
    controller.abort(new Error('cancel'));
    // The caller is not held hostage by a stuck browser close.
    await outcome;
    const probe = probeDeckChromium();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(probe.state.acquired).toBe(false);
    finishCleanup();
    await probe.done;
    probe.state.release!();
    others();
  }, 10_000);

  it('releases admission when the browser launch itself fails', async () => {
    await expect(
      captureReachDeckGenuiMedia(
        { documentHtml, format: 'jpg', width: 320, height: 180 },
        {
          launch: async () => {
            throw new Error('launch failed');
          },
        },
      ),
    ).rejects.toThrow('launch failed');
    // 若失败路径漏还槽位，这里拿不满全部槽位会一直挂起。
    const all = await occupyDeckChromium();
    all();
  });

  it('names the failed scientific invariant without control characters', async () => {
    await expect(
      captureReachDeckGenuiMedia({
        documentHtml: documentHtml.replace(
          "return [{name:'position',passed:Number",
          "return [{name:'边角\\n配对',passed:false},{name:'position',passed:Number",
        ),
        format: 'jpg',
        width: 320,
        height: 180,
      }),
    ).rejects.toThrow('GenUI scientific runtime checks failed: 边角 配对.');
  }, 20_000);

  it('holds shared admission until cancelled encoding cleanup finishes', async () => {
    const others = await occupyDeckChromium(1);
    const controller = new AbortController();
    let encodingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      encodingStarted = resolve;
    });
    let finishEncoder!: () => void;
    const capture = captureReachDeckGenuiMedia(
      { documentHtml, format: 'gif', width: 320, height: 180, durationSeconds: 1, fps: 2 },
      {
        signal: controller.signal,
        encodeGif: async () => {
          encodingStarted();
          await new Promise<void>((resolve) => {
            finishEncoder = resolve;
          });
          throw new Error('encoder stopped');
        },
      },
    );
    const outcome = expect(capture).rejects.toThrow('cancel during encoding');
    await started;
    controller.abort(new Error('cancel during encoding'));
    const probe = probeDeckChromium();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(probe.state.acquired).toBe(false);
    finishEncoder();
    await outcome;
    await probe.done;
    probe.state.release!();
    others();
  }, 20_000);
});
