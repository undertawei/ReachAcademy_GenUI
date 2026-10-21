import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let browser: Browser;
let script: string;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  script = (
    await build({
      entryPoints: [
        fileURLToPath(new URL('../../lib/reach-deck/html-layout/text-autofit.ts', import.meta.url)),
      ],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'autofit',
    })
  ).outputFiles[0].text;
});
afterAll(async () => {
  await browser?.close();
});

async function fit(body: string) {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<style>*{box-sizing:border-box}body{margin:0}#slide{position:relative;width:1600px;height:900px}p{position:absolute;margin:0;font:24px/30px Arial} .bg{position:absolute;background:#eee}</style><section id="slide">${body}</section>`,
    );
    await page.addScriptTag({ content: script });
    return await page.evaluate(async () => {
      await document.fonts.ready;
      const root = document.querySelector<HTMLElement>('#slide')!;
      const reports: string[] = [];
      const run = () =>
        (
          window as unknown as {
            autofit: {
              autofitSlideText(
                root: HTMLElement,
                report: (id: string, message: string) => void,
              ): void;
            };
          }
        ).autofit.autofitSlideText(root, (_, message) => reports.push(message));
      run();
      const once = root.outerHTML;
      run();
      return {
        reports,
        stable: once === root.outerHTML,
        elements: Object.fromEntries(
          Array.from(root.children).map((node) => {
            const el = node as HTMLElement;
            const r = el.getBoundingClientRect();
            return [
              el.id,
              {
                width: r.width,
                left: r.left,
                height: r.height,
                tracking: getComputedStyle(el).letterSpacing,
                font: parseFloat(getComputedStyle(el).fontSize),
                html: el.innerHTML,
              },
            ];
          }),
        ),
      };
    });
  } finally {
    await page.close();
  }
}

describe('browser-measured conservative slide text autofit', () => {
  it.each([25, 50])(
    'fits a centered final-character wrap even with a %ipx tall frame',
    async (height) => {
      const result = await fit(
        `<div id="left" class="bg" style="left:96px;top:400px;width:610px;height:200px"></div><div id="right" class="bg" style="left:798px;top:400px;width:610px;height:200px"></div><p id="label" style="left:710px;top:452px;width:84px;height:${height}px;font:18px/23.4px Arial;letter-spacing:1px;text-align:center">同一关系式</p>`,
      );
      expect(result.elements.label.width).toBeGreaterThan(84);
      expect(result.elements.label.left).toBeLessThan(710);
      expect(result.elements.label.left).toBeGreaterThanOrEqual(706);
      expect(result.elements.label.left + result.elements.label.width).toBeLessThanOrEqual(798);
      expect(result.elements.label.height).toBe(height);
      expect(result.elements.label.font).toBe(18);
      expect(result.stable).toBe(true);
    },
  );
  it('repairs a long sentence with one orphan character, without reducing its font', async () => {
    const result = await fit(
      '<p id="label" style="left:50px;top:50px;width:700px;height:60px">通过比较物体运动的距离和所用的时间我们可以判断它们运动的快慢</p><script>const el=document.getElementById("label");el.style.whiteSpace="nowrap";const r=document.createRange();r.selectNodeContents(el);el.style.width=(r.getBoundingClientRect().width-12)+"px";el.style.whiteSpace="normal";</script>',
    );
    expect(result.elements.label.font).toBe(24);
    expect(result.reports.some((r) => r.includes('adjusted width'))).toBe(true);
    expect(result.elements.label.height).toBe(60);
    expect(result.stable).toBe(true);
  });
  it.each(['100 m distance', '速度 100 m', 'WWW 100 m'])(
    'expands short mixed labels using the real font: %s',
    async (text) => {
      const result = await fit(
        `<p id="label" style="left:50px;top:50px;width:150px;height:30px;font-weight:800">${text}</p>`,
      );
      expect(result.stable).toBe(true);
      expect(result.elements.label.font).toBe(24);
      expect(result.reports.every((r) => !r.includes('"unresolved":true'))).toBe(true);
    },
  );
  it('grows multiline height while preserving explicit breaks and font', async () => {
    const result = await fit(
      '<p id="label" style="left:50px;top:50px;width:400px;height:45px;line-height:35px">one<br>two<br>three</p>',
    );
    expect(result.elements.label.height).toBe(105);
    expect(result.elements.label.html).toBe('one<br>two<br>three');
    expect(result.elements.label.font).toBe(24);
    expect(result.stable).toBe(true);
  });
  it('does not expand into a neighbor or shrink below legibility floor', async () => {
    const result = await fit(
      '<p id="label" style="left:1450px;top:50px;width:150px;height:25px;font-size:18px;line-height:25px">A very long explanation with many words</p><p id="neighbor" style="left:1450px;top:76px;width:150px;height:100px">neighbor</p>',
    );
    expect(result.elements.label.width).toBe(150);
    expect(result.elements.label.height).toBe(25);
    expect(result.elements.label.font).toBe(18);
    expect(result.reports.some((r) => r.includes('unresolved'))).toBe(true);
    expect(result.stable).toBe(true);
  });
  it('restores sibling card bottom inset without shrinking body text', async () => {
    const result = await fit(
      '<div id="card" class="bg" style="left:50px;top:50px;width:500px;height:200px"></div><p id="heading" style="left:80px;top:80px;width:400px;height:30px">Example</p><p id="body" style="left:80px;top:190px;width:400px;height:55px">One<br>Two</p>',
    );
    expect(result.elements.card.height).toBe(230);
    expect(result.elements.body.font).toBe(24);
    expect(result.stable).toBe(true);
  });
  it('does not grow a background into another card', async () => {
    const result = await fit(
      '<div id="card" class="bg" style="left:50px;top:50px;width:500px;height:200px"></div><div id="next" class="bg" style="left:50px;top:260px;width:500px;height:100px"></div><p id="heading" style="left:80px;top:80px;width:400px;height:30px">Example</p><p id="body" style="left:80px;top:215px;width:400px;height:30px">Caption</p>',
    );
    expect(result.elements.card.height).toBe(200);
    expect(result.reports.some((r) => r.includes('unsafe expansion'))).toBe(true);
  });
  it.each([
    ['text', 'drawing', ''],
    ['image', '<img width="20" height="20">', ''],
    ['asset', '', 'data-reach-asset="trusted"'],
    ['scientific asset', '', 'data-reach-scientific-asset="trusted"'],
    ['subtree', '<div style="width:10px;height:10px;background:red"></div>', ''],
  ])(
    'does not treat a figure containing %s as an empty text carrier',
    async (_, content, attributes) => {
      const result = await fit(
        `<figure id="card" ${attributes} style="position:absolute;left:50px;top:50px;width:500px;height:300px;margin:0;background:linear-gradient(red,blue)">${content}</figure><p id="copy" style="left:80px;top:100px;width:400px;height:50px;font:18px/30px Arial">One<br>Two</p>`,
      );
      expect(result.elements.copy.height).toBe(50);
      expect(result.elements.card.height).toBe(300);
      expect(result.reports.some((report) => report.includes('"unresolved":true'))).toBe(true);
    },
  );
  it('expands the trusted geometric background together with a numeric label', async () => {
    const result = await fit(
      '<div id="card" class="bg" style="left:50px;top:50px;width:190px;height:100px"></div><p id="label" style="left:70px;top:70px;width:150px;height:30px;font-weight:800">100 m distance</p>',
    );
    expect(result.elements.label.width).toBeGreaterThan(150);
    expect(result.elements.card.width).toBeGreaterThan(190);
    expect(result.elements.label.height).toBe(30);
    expect(result.elements.label.font).toBe(24);
    expect(result.stable).toBe(true);
  });
  it('repairs the formula example card geometry without shrinking 17px captions', async () => {
    const result = await fit(
      '<div id="calculation" class="bg" style="left:96px;top:510px;width:965px;height:246px"></div><div id="unit" class="bg" style="left:1090px;top:510px;width:414px;height:246px"></div><p id="calc-title" style="left:142px;top:540px;width:230px;height:28px;font:17px/28px Arial">Example</p><p id="caption" style="left:143px;top:725px;width:830px;height:26px;font:17px/26px Arial">Substitute distance and time</p><p id="unit-title" style="left:1130px;top:544px;width:300px;height:28px;font:17px/28px Arial">Check units</p><p id="units" style="left:1130px;top:650px;width:320px;height:73px;font:19px/32px Arial">Distance in m<br>Time in s<br>Speed in m/s</p>',
    );
    expect(result.elements.calculation.height).toBe(271);
    expect(result.elements.unit.height).toBe(268);
    expect(result.elements.units.height).toBe(96);
    expect(result.elements.caption.font).toBe(17);
    expect(result.elements.units.font).toBe(19);
    expect(result.stable).toBe(true);
  });
  it('leaves ambiguous overlapping surfaces, assets, math and figures unchanged', async () => {
    const result = await fit(
      '<div id="a" class="bg" style="left:50px;top:50px;width:500px;height:200px"></div><div id="b" class="bg" style="left:50px;top:50px;width:500px;height:200px"></div><p id="heading" style="left:80px;top:80px;width:400px;height:30px">Example</p><p id="body" style="left:80px;top:215px;width:400px;height:30px">Caption</p><div id="asset" data-reach-asset="image" style="position:absolute;width:10px;height:10px">asset content</div><p id="math" data-latex="x" style="width:10px;height:10px">long formula</p><figure id="figure" style="width:10px;height:10px">drawing</figure>',
    );
    expect(result.elements.a.height).toBe(200);
    expect(result.elements.b.height).toBe(200);
    expect(result.elements.asset.width).toBe(10);
    expect(result.elements.math.width).toBe(10);
    expect(result.elements.figure.width).toBe(10);
  });
  it('does not shrink already small captions and never shrinks more than ten percent', async () => {
    const result = await fit(
      '<p id="small" style="left:1450px;top:870px;width:150px;height:20px;font-size:14px;line-height:20px">too many words to fit in this tiny caption</p><p id="large" style="left:1450px;top:800px;width:150px;height:30px">WWWWWWWWWWWW</p>',
    );
    expect(result.elements.small.font).toBe(14);
    expect(result.elements.large.font).toBeGreaterThanOrEqual(21.6);
    expect(result.stable).toBe(true);
  });
  it('uses a bounded font reduction only when expansion cannot fit', async () => {
    const result = await fit(
      '<p id="label" style="left:1450px;top:50px;width:150px;height:30px;font-family:monospace"><span style="font-family:monospace">MMMMMMMMMMMM</span></p><script>const el=document.getElementById("label");const range=document.createRange();range.selectNodeContents(el);el.style.width=(range.getBoundingClientRect().width*0.94)+"px";el.style.left=(1600-parseFloat(el.style.width))+"px";</script>',
    );
    expect(result.elements.label.font, JSON.stringify(result)).toBeLessThan(24);
    expect(result.elements.label.font).toBeGreaterThanOrEqual(21.6);
    expect(result.reports.some((r) => r.includes('adjusted fontSize'))).toBe(true);
    expect(result.stable).toBe(true);
  });
  it('does not mistake mixed inline font sizes for two lines or shrink the smaller run', async () => {
    const result = await fit(
      '<p id="label" style="left:50px;top:50px;width:500px;height:30px"><span>Speed</span><span style="font-size:17px"> 100 m</span></p>',
    );
    expect(result.elements.label.height).toBe(30);
    expect(result.elements.label.font).toBe(24);
    expect(result.reports).toEqual([]);
  });

  // Frozen from the 2026-09-25 acceptance run (page 14): an authored <br> in a title
  // budgeted for one line overlapped the subtitle stacked directly below it.
  const title = (width: number, extra = '') =>
    `<h1 id="main-title" style="position:absolute;margin:0;left:96px;top:88px;width:${width}px;height:88px;font:700 48px/57.6px Arial">知道比值和斜边，<br>能找回对边吗？</h1><p id="subtitle" style="left:98px;top:188px;width:980px;height:34px;font:22px/34px Arial">已知 sin A = 3/5，斜边为 10</p>${extra}`;
  it('removes a redundant title break when one line fits the authored box', async () => {
    const result = await fit(title(1040));
    expect(result.elements['main-title'].html).not.toContain('<br>');
    expect(result.elements['main-title'].height).toBe(88);
    expect(result.elements['main-title'].font).toBe(48);
    expect(result.reports.some((r) => r.includes('removed redundant line break'))).toBe(true);
    expect(result.stable).toBe(true);
  });
  it('pushes the stacked subtitle down when the title needs its break', async () => {
    const result = await fit(title(420));
    expect(result.elements['main-title'].html).toContain('<br>');
    expect(result.elements['main-title'].font).toBe(48);
    expect(result.elements['main-title'].height).toBeGreaterThan(88);
    const shifted = result.reports.find((r) => r.includes('shifted subtitle down'));
    expect(shifted).toBeDefined();
    expect(result.reports.join('\n')).not.toContain('"unresolved":true');
    expect(result.stable).toBe(true);
  });
  it('tightens a heading within its floor when the stack below cannot move', async () => {
    const result = await fit(
      title(
        420,
        '<p id="panel-text" style="left:98px;top:224px;width:980px;height:34px">紧贴副标题的正文</p>',
      ),
    );
    expect(result.elements['main-title'].html).toContain('<br>');
    expect(result.elements['main-title'].height).toBe(88);
    expect(result.elements['main-title'].font).toBeGreaterThanOrEqual(48 * 0.8 - 0.01);
    expect(result.elements['main-title'].font).toBeLessThanOrEqual(48);
    expect(result.reports.some((r) => r.includes('shifted'))).toBe(false);
    expect(result.reports.join('\n')).not.toContain('"unresolved":true');
    expect(result.stable).toBe(true);
  });
});
