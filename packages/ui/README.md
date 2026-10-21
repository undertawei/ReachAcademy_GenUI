# @reachany/ui

ReachAcademy 四个前端共用的 React 组件库（规范 [docs/wiki/frontend/](../../docs/wiki/frontend/README.md)，第二期视觉 issue #691）。

## 接入

```css
/* apps/<app>/app/globals.css */
@import 'tailwindcss';
@import '@reachany/brand/styles/theme.css';
@import '@reachany/ui/styles.css';
```

```tsx
// apps/<app>/app/layout.tsx：Teacher/Admin 为 compact，Student/Portal 为 comfortable
<html data-density="compact" lang={locale}>
```

- 样式只需引入一次；`styles.css` 会引入 `@reachany/brand/styles/variables.css`，**不要**再在 `<body>` 上内联注入 token。
- 共享组件内没有任何中文/英文文案：可见与无障碍文案一律由调用方从各 app 的 i18n 目录传入（`xxxLabel`、`labels`、翻译回调）。
- 尺寸：不传 `size` 时按 `data-density` 取默认（教师 md 32px、学生 lg 36px）；传 `size="sm|md|lg|xl"` 覆盖单个组件。
- `className` 只用于外部布局（宽度、外边距、栅格位置），不要用它改组件内部的颜色和尺寸。
- 状态通过 `data-state`、`data-size`、`data-variant` 暴露；浮层统一渲染到 `body` 下的 `[data-rx-portal-root]`。

## 导出清单

按规范 03 章节分组。完整 props 见各组件源码的 JSDoc 与 `*.interaction.test.tsx`。

| 分组（源文件）                    | 导出                                                                                                                                                                                                                                                                                                                                                                     | 规范              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| 按钮                              | `Button`（primary/ink/accent/outline/default/ghost/link/danger/inverse，loading/success）、`buttonStyleProps`（给 `<a>`/`<Link>` 套按钮外观）、`IconButton`、`CopyButton`                                                                                                                                                                                                | §3.1              |
| 表单输入（`exports/fields.ts`）   | `Input`、`Textarea`、`NumberInput`、`SearchInput`、`PasswordInput`、`FormField`、`FormGrid`、`FormSection`、`useFormFieldControl`                                                                                                                                                                                                                                        | §3.2–3.3          |
| 下拉（`exports/select.ts`）       | `Select`（本地/远程分页/搜索/虚拟列表/可清除/筛选型）、`MultiSelect`（固定宽度胶囊 + `+N`）、`TagInput`                                                                                                                                                                                                                                                                  | §3.4–3.6          |
| 选择（`exports/choice.ts`）       | `Radio`、`RadioGroup`、`RadioCard`、`Checkbox`、`CheckboxGroup`、`CheckboxCard`、`Switch`、`SettingRow`、`SettingGrid`、`SegmentedControl`                                                                                                                                                                                                                               | §3.7–3.10         |
| 导航（`exports/navigation.ts`）   | `Tabs`、`TabList`、`Tab`、`TabPanel`、`ClosableTabs`、`Steps`、`SideNav`                                                                                                                                                                                                                                                                                                 | §3.11–3.12、§3.16 |
| 浮层                              | `Tooltip`、`Popover`；`exports/overlay.ts`：`Dialog`、`DialogClose`、`useDialogClose`、`ConfirmDialog`、`Drawer`、`SidePanel`、`DropdownMenu`                                                                                                                                                                                                                            | §3.13–3.15、§3.19 |
| 展示（`exports/display.ts`）      | `Card`、`CardHeader`、`CardBody`、`CardFooter`、`CardOverlayLink`、`StatTile`、`Tag`、`MetaTag`、`StatusPill`、`Badge`、`Ribbon`、`Dot`、`CountBadge`、`InlineNotice`、`ContextChip`、`Empty`、`Avatar`、`AvatarGroup`、`Collapse`、`Table`、`Pagination`、`ProgressBar`、`Skeleton`、`SkeletonList`、`SkeletonCard`、`useDelayedVisibility`、`useCountUp`、`AsyncState` | §3.17–3.28、§3.33 |
| 上传（`exports/upload.ts`）       | `Dropzone`、`validateFiles`、`ImageUpload`、`FileList`、`UploadChooser`、`useUploadQueue`（并发 3、可取消/重试）、`AttachmentList`、`AttachmentPreviewDialog`、`useAttachmentPreview`、`attachmentPreviewKind`、`attachmentIcon`、`formatAttachmentSize`                                                                                                                 | §3.29             |
| 日期（`exports/date.ts`）         | `DatePicker`（含 `display="pill"` 工具条胶囊）、`DateRangePicker`、`TimePicker`、`DateTimePicker`（ISO 字符串，`Intl` 格式化，无原生 date 输入）；常驻月历 `DateCalendar`（`highlight` 区间底带、`today` 业务时区）                                                                                                                                                      | §3.30             |
| 拖拽排序（`exports/sortable.ts`） | `VirtualTree`、`VirtualTreeHandle`（平铺树虚拟化、跨容器落点、边缘自动滚动、键盘拖动、有限活动行保留）；`SortableList`、`SortableItem`、`SortableHandle`、`useSortable`（仅手柄可拖、键盘 Space/↑↓/Esc、读屏播报、失败回滚）                                                                                                                                             | §3.23             |
| 反馈                              | `ToastProvider`/`useToast`（右上角、最多 3 条、悬停暂停、操作链接）、`Spinner`、`BrandLoader`（品牌加载动画）、`RouteProgress`/`startRouteProgress`、`RouteLoading`、`PageTransition`、`FormSubmitButton`、`SessionExpiryBoundary`、`FeedbackCapture`                                                                                                                    | §3.20、04、05     |
| 应用壳与页面骨架                  | `AppViewport`、`RoleHeader`、`RoleHeaderAction`、`PageLayout`、`PageHeader`、`PageContent`、`PageColumns`、`PageColumn`、`BackBar`、`ActionFooterBar`、`CardGrid`、`ScrollArea`；第一期 `AppShell`/`NavRail`（新页面不用）                                                                                                                                               | 02                |
| 基础设施（`primitives/`）         | `Portal`、`useLayer`（浮层栈：层级、Esc 只关最上层、点击外部）、`useFloating`、`usePresence`（离场动画后卸载）、`useFocusTrap`、`useControllableState`、`usePrefersReducedMotion`、`mergeRefs`                                                                                                                                                                           | 03 §1.2、04 §6    |
| 业务组件（`exports/domain.ts`）   | `QuestionOptionGroup`、`QuestionOption`、`QuestionOutcome`、`questionOptionMarker`（学生答题选项，源码 `src/domain/`）；`StudentImportGuide`、`StudentImportResults`、`PasswordDialog`                                                                                                                                                                                   | 03 §4             |

附件流程也可直接使用 `AttachmentCollection`：宿主传入翻译标签、签名器和下载错误回调，共享库组合列表、预览弹窗与状态管理。

## 页面骨架示例

```tsx
<AppViewport header={<RoleHeader … />}>            {/* 角色布局：body 不再滚动 */}
  <PageLayout template="overview">
    <PageHeader title="课程广场" description="…" actions={<Button>创建课程</Button>} />
    <PageContent restoreKey="course-market">       {/* 唯一主滚动容器，返回时恢复位置 */}
      <CardGrid>…</CardGrid>
    </PageContent>
  </PageLayout>
</AppViewport>
```

带二级侧栏或右侧面板的页面用 `PageColumns` + `PageColumn width="side-nav|overview|side-panel"`，每列独立滚动。

## 维护

- 样式按组拆在 `src/styles/*.css`，由 `src/styles.css` 统一引入；只引用 `--reachany-*` token 与 `foundation.css` 的密度变量 `--rx-*`。
- 含 `transform` 的关键帧只能 `animation-fill-mode: backwards`（`tools/css-animation-fill-mode.test.mjs`）；离场动画的终态写在 `[data-state='closed']` 的静态样式里。
- 新增或修改组件：先改规范 03 对应小节，再改代码，同一 PR 附交互测试并更新本表（规范 03 §5 完成标准）。
