/** Read-only route summaries for the local workbench; planning remains in the real pipeline. */
export const FOUR_ROUTE_TEACHING_SAMPLE = `面向初中学生，制作“从真实文物到科学表达”的五页微课，每页围绕一个明确教学目标，全部使用普通幻灯片。
第 1 页：观察司母戊鼎（后母戊鼎）的真实器物照片，辨认器物整体造型。必须使用能够核实身份的真实文物照片，不使用重绘或想象图。
第 2 页：静态展示中国青铜时代的三个时间节点：夏约公元前 2070 年、商约公元前 1600 年、周约公元前 1046 年。日期均为约数；用清楚的横向时间轴和标签表达先后关系，无需图内动画。
第 3 页：静态解释水循环中的蒸发、凝结和降水，用清晰箭头和少量中文标签组成一张完整知识示意图，避免照片和装饰图。讲稿一次展示全图。
第 4 页：讲解匀速直线运动，位置满足 x=2t（米，秒）。让图内的质点位置与时间标记随讲稿推进，并能在暂停、拖动播放头和重播时保持一致；这页需要图内状态变化，而不只是整图出现。
第 5 页：总结观察证据、绘制模型和验证解释的学习方法。用一张原创的想象场景插图表现学生在未来科学教室合作探索；它只营造学习氛围，不代表真实人物、事件或科学证据。
页面正文和独立公式保持可编辑文字，不把整页烘焙成图片。请根据以上教学需求自行规划合适的视觉制作方式，不为装饰补图。`;

export const VISUAL_ROUTE_LABELS: Readonly<Record<string, string>> = {
  'reference-image': '真实图片搜索',
  diagram: '静态知识图',
  'scientific-visual': '讲稿驱动科学图',
  image: '原创生图',
};

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

export interface PlannedRouteSummary {
  route: string;
  representation?: string;
  purpose?: string;
}

export function plannedRouteSummaries(page: unknown): PlannedRouteSummary[] {
  const candidate = record(page);
  const spec = record(candidate?.instructionalSpec);
  if (!Array.isArray(spec?.visualAssets)) return [];
  return spec.visualAssets.flatMap((value) => {
    const asset = record(value);
    if (!asset || typeof asset.kind !== 'string') return [];
    return [
      {
        route: asset.kind,
        ...(typeof asset.representation === 'string'
          ? { representation: asset.representation }
          : {}),
        ...(typeof asset.purpose === 'string' ? { purpose: asset.purpose } : {}),
      },
    ];
  });
}

export function PlannedVisualRoutes({ page }: { page: unknown }) {
  const routes = plannedRouteSummaries(page);
  return (
    <span data-harness-planned-routes>
      {routes.length === 0
        ? '无计划视觉资产'
        : routes.map((asset, index) => (
            <span
              key={index}
              data-visual-route={asset.route}
              style={{ display: 'block', fontSize: 12 }}
            >
              {VISUAL_ROUTE_LABELS[asset.route] ?? asset.route}
              {asset.representation ? ` · ${asset.representation}` : ''}
              {asset.purpose ? `：${asset.purpose}` : ''}
            </span>
          ))}
    </span>
  );
}

export function requestOutlinePage(request: unknown): unknown {
  const input = record(request);
  return input?.page ?? input?.outlinePage;
}

/** Origins are already validated by the shared DSL; only display an allowlist, never raw URLs. */
export function summarizeMediaOrigin(
  value: unknown,
): { route: string; details: string[] } | undefined {
  const origin = record(value);
  if (
    origin?.schemaVersion !== 'reach-deck-media-origin/v1' ||
    typeof origin.route !== 'string' ||
    !['reference-image', 'diagram', 'image'].includes(origin.route)
  )
    return undefined;
  const labels: Record<string, string> = {
    provider: '提供方',
    title: '标题',
    description: '说明',
    author: '作者',
    license: '许可',
    attribution: '署名',
    engine: '引擎',
    rendererVersion: '渲染版本',
    sourceDigest: '源稿摘要',
  };
  return {
    route: origin.route,
    details: Object.entries(labels).flatMap(([key, label]) =>
      typeof origin[key] === 'string' && origin[key] ? [`${label}：${origin[key]}`] : [],
    ),
  };
}
