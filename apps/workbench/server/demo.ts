import type { InteractiveScene } from '@reachany/reach-deck-dsl';

/** Fully offline example; the original ReachInteractive bridge supplies initialization and reset. */
export const DEMO_SCENE: InteractiveScene = {
  schemaVersion: 'reach-interactive-scene/v2',
  id: 'interactive-demo-parabola',
  title: '函数平移实验',
  sceneType: 'interactive',
  bridgeVersion: 'reach-interactive-bridge/v1',
  runtimePolicy: { completionMode: 'none', allowReset: true, maximumDurationSeconds: null },
  runtimeDependencies: [],
  eventManifest: {
    schemaVersion: 'reach-interactive-event-manifest/v1',
    events: [
      {
        name: 'parameter_change',
        eventVersion: 1,
        meaning: '学习者改变抛物线的水平位移量',
        payloadFields: [
          { name: 'offset', type: 'number', required: true, minimum: -3, maximum: 3 },
        ],
        delivery: { mode: 'latest', intervalMs: 500 },
      },
    ],
  },
  narration: {
    schemaVersion: 'reach-interactive-narration/v1',
    text: '移动滑块，观察抛物线顶点的变化。先预测向右平移时公式中的参数如何变化，再通过操作检验你的判断。',
  },
  documentHtml: `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>函数平移实验</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f7fc;color:#182543;font-family:system-ui,sans-serif;padding:clamp(16px,4vw,40px)}main{max-width:920px;margin:auto}h1{margin:0 0 10px;font-size:clamp(24px,4vw,36px)}p{line-height:1.7;color:#53617b}.card{background:white;border:1px solid #e0e6f2;border-radius:20px;padding:clamp(16px,3vw,28px)}canvas{width:100%;height:auto;display:block;background:#fff;border-radius:12px}label{display:block;font-weight:650;margin:20px 0 8px}input{width:100%;min-height:44px;accent-color:#515be8}input:focus-visible,button:focus-visible{outline:3px solid #7b88ef;outline-offset:4px}.row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}output{font-size:20px;font-weight:700;color:#414acc}button{border:1px solid #d4daed;background:#f5f6ff;color:#414acc;padding:11px 18px;border-radius:10px;font:inherit;cursor:pointer}.note{margin-bottom:0;font-size:14px}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
</style></head><body><main><h1>函数平移实验</h1><p>拖动参数，探索公式与图像之间的联系。虚线保留原始函数，实线表示变化后的函数。</p>
<section class="card" data-reach-component-id="parabola-lab" data-reach-component-label="抛物线平移实验"><canvas id="plot" width="800" height="400" role="img" aria-label="原函数与平移后抛物线的图像"></canvas><label for="offset">水平位移 h</label><input id="offset" type="range" min="-3" max="3" step="0.1" value="0"><div class="row"><output id="formula" for="offset" aria-live="polite"></output><button id="reset" type="button">重置实验</button></div><p class="note">思考：顶点向右移动时，括号里为什么使用减号？</p></section></main>
<script>
(() => {
  const slider = document.getElementById('offset');
  const formula = document.getElementById('formula');
  const canvas = document.getElementById('plot');
  const context = canvas.getContext('2d');
  let offset = 0;
  const px = (x) => 52 + (x + 5) * 70;
  const py = (y) => 350 - y * 35;
  function curve(h, color, dashed) {
    context.beginPath();context.lineWidth=3;context.strokeStyle=color;context.setLineDash(dashed ? [7,6] : []);
    let started=false;
    for(let x=-5;x<=5.01;x+=0.025){const y=(x-h)*(x-h);if(y>9.5){started=false;continue;}if(!started){context.moveTo(px(x),py(y));started=true;}else context.lineTo(px(x),py(y));}
    context.stroke();context.setLineDash([]);
  }
  function render() {
    slider.value=String(offset);
    formula.textContent='y = (x '+(offset<0 ? '+ '+Math.abs(offset).toFixed(1) : '− '+offset.toFixed(1))+')²';
    context.clearRect(0,0,800,400);context.lineWidth=1;context.strokeStyle='#e8ecf6';
    for(let x=-5;x<=5;x++){context.beginPath();context.moveTo(px(x),18);context.lineTo(px(x),375);context.stroke();}
    for(let y=0;y<=9;y++){context.beginPath();context.moveTo(35,py(y));context.lineTo(770,py(y));context.stroke();}
    context.strokeStyle='#8793af';context.beginPath();context.moveTo(35,py(0));context.lineTo(770,py(0));context.moveTo(px(0),18);context.lineTo(px(0),375);context.stroke();
    context.fillStyle='#64718c';context.font='14px system-ui';
    for(let x=-4;x<=4;x++) context.fillText(String(x),px(x)-5,py(0)+22);
    curve(0,'#bbc4d8',true);curve(offset,'#5661e8',false);
    context.fillStyle='#5661e8';context.beginPath();context.arc(px(offset),py(0),6,0,Math.PI*2);context.fill();
  }
  slider.addEventListener('input',()=>{
    const value=Number(slider.value);if(!Number.isFinite(value))return;
    offset=Math.max(-3,Math.min(3,value));render();
    window.ReachInteractive.stateChange({offset});
    window.ReachInteractive.learningEvent('parameter_change',{offset});
  });
  document.getElementById('reset').addEventListener('click',()=>window.ReachInteractive.reset());
  window.addEventListener('reach-interactive-initialize',(event)=>{
    const init=event.detail;const snapshot=init.restoredSnapshot;
    const restored=Boolean(snapshot && typeof snapshot.offset==='number' && Number.isFinite(snapshot.offset) && snapshot.offset>=-3 && snapshot.offset<=3);
    offset=restored ? snapshot.offset : 0;render();
    const ready={restored};if(init.restoreToken!==undefined)ready.restoreToken=init.restoreToken;
    window.ReachInteractive.ready(ready);
  });
  window.addEventListener('reach-interactive-reset',()=>{offset=0;render();window.ReachInteractive.stateChange({offset});});
  window.addEventListener('reach-interactive-resize',render);
  render();
})();
</script></body></html>`,
};
