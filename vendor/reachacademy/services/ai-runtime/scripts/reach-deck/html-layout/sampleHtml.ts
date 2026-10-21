export const SAMPLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 1600px; height: 900px; overflow: hidden; }
    body { font-family: "Source Han Sans VF", "Microsoft YaHei", sans-serif; }
    #slide {
      position: relative;
      width: 1600px;
      height: 900px;
      overflow: hidden;
      color: #f1f5f9;
      background:
        radial-gradient(circle at 82% 18%, rgba(125, 211, 252, .12), transparent 28%),
        linear-gradient(135deg, #0b1220 0%, #101a2c 58%, #0b1220 100%);
    }
    .eyebrow { letter-spacing: .24em; text-transform: uppercase; font-weight: 700; }
    .title { font-weight: 760; letter-spacing: -.05em; line-height: 1.04; }
    .body { line-height: 1.45; }
    .step { font-weight: 720; letter-spacing: -.02em; }
    .number { font-family: "Montserrat", sans-serif; font-weight: 700; letter-spacing: -.06em; }
    .question { font-weight: 650; line-height: 1.32; letter-spacing: -.02em; }
  </style>
</head>
<body>
  <section id="slide" data-title="好问题决定探索的边界" data-theme="deep-tech">
    <div id="rail" style="position:absolute;left:80px;top:64px;width:14px;height:772px;border-radius:999px;background:#17304a;"></div>
    <div id="accent-mark" style="position:absolute;left:80px;top:64px;width:14px;height:174px;border-radius:999px;background:#7dd3fc;"></div>

    <div id="eyebrow" class="eyebrow" style="position:absolute;left:134px;top:76px;width:560px;height:44px;font-size:22px;color:#7dd3fc;">OPENING QUESTION · 01</div>
    <h1 id="title" class="title" style="position:absolute;left:128px;top:146px;width:930px;height:190px;margin:0;font-size:76px;color:#f1f5f9;">好问题，比标准答案<br>更接近学习的起点</h1>
    <p id="summary" class="body" style="position:absolute;left:134px;top:365px;width:660px;height:110px;margin:0;font-size:30px;color:#a9b6c9;">答案结束一次搜索；问题打开新的观察角度。<br>问题决定我们会看见什么，也决定探索能走多远。</p>

    <div id="metric-card" style="position:absolute;left:1120px;top:92px;width:370px;height:282px;border:2px solid #31516f;border-radius:38px;background:rgba(21,31,51,.9);box-shadow:0 28px 80px rgba(0,0,0,.24);"></div>
    <div id="metric-number" class="number" style="position:absolute;left:1170px;top:126px;width:260px;height:104px;font-size:90px;color:#7dd3fc;">?</div>
    <p id="metric-copy" style="position:absolute;left:1170px;top:242px;width:252px;height:80px;margin:0;font-size:28px;line-height:1.35;color:#f1f5f9;">不是知识的缺口<br>而是探索的入口</p>

    <div id="progress-line" style="position:absolute;left:160px;top:588px;width:1250px;height:4px;background:#31516f;"></div>

    <div id="step-one-shape" style="position:absolute;left:134px;top:553px;width:76px;height:76px;border-radius:22px;background:#7dd3fc;"></div>
    <div id="step-one-number" class="number" style="position:absolute;left:155px;top:568px;width:40px;height:44px;font-size:28px;color:#0b1220;">01</div>
    <div id="step-one" class="step" style="position:absolute;left:134px;top:652px;width:250px;height:54px;font-size:38px;color:#f1f5f9;">观察</div>
    <p id="step-one-copy" style="position:absolute;left:134px;top:716px;width:270px;height:64px;margin:0;font-size:23px;line-height:1.4;color:#a9b6c9;">先让事实变得<br>足够具体</p>

    <div id="step-two-shape" style="position:absolute;left:580px;top:553px;width:76px;height:76px;border:2px solid #7dd3fc;border-radius:22px;background:#151f33;"></div>
    <div id="step-two-number" class="number" style="position:absolute;left:600px;top:568px;width:44px;height:44px;font-size:28px;color:#7dd3fc;">02</div>
    <div id="step-two" class="step" style="position:absolute;left:580px;top:652px;width:250px;height:54px;font-size:38px;color:#f1f5f9;">追问</div>
    <p id="step-two-copy" style="position:absolute;left:580px;top:716px;width:290px;height:64px;margin:0;font-size:23px;line-height:1.4;color:#a9b6c9;">把“是什么”推进到<br>“为什么”</p>

    <div id="step-three-shape" style="position:absolute;left:1026px;top:553px;width:76px;height:76px;border:2px solid #6ee7b7;border-radius:22px;background:#151f33;"></div>
    <div id="step-three-number" class="number" style="position:absolute;left:1046px;top:568px;width:44px;height:44px;font-size:28px;color:#6ee7b7;">03</div>
    <div id="step-three" class="step" style="position:absolute;left:1026px;top:652px;width:250px;height:54px;font-size:38px;color:#f1f5f9;">验证</div>
    <p id="step-three-copy" style="position:absolute;left:1026px;top:716px;width:300px;height:64px;margin:0;font-size:23px;line-height:1.4;color:#a9b6c9;">让猜想经得起<br>证据的检验</p>

    <div id="question-card" style="position:absolute;left:830px;top:410px;width:660px;height:112px;border-radius:28px;background:#312c20;"></div>
    <p id="question" class="question" style="position:absolute;left:874px;top:436px;width:570px;height:70px;margin:0;font-size:29px;color:#fcd34d;">如果今天只能带走一个问题，<br>你希望它改变自己看待什么的方式？</p>
  </section>
</body>
</html>`;
