export { cn } from './cn';
export { CourseCatalogFilterControls } from './components/CourseCatalogFilterControls';
export type {
  CourseCatalogFilterControl,
  CourseCatalogFilterControlsProps,
} from './components/CourseCatalogFilterControls';
export * from './components/course-catalog-filters';
export { StageCollapseButton, useStageCollapse } from './components/StageCollapse';
export type { StageCollapseState } from './components/StageCollapse';
export type { ClassValue } from './cn';

// —— 基础设施：浮层栈、定位、presence、焦点、受控状态（规范 03 §1.2、04 §6）——
export * from './primitives';

// —— 基础组件（规范 03 §3），按组维护在 ./exports/ ——
export { Button, buttonStyleProps } from './components/Button';
export type {
  ButtonProps,
  ButtonStyleOptions,
  ButtonVariant,
  ControlSize,
  ControlTouchTarget,
} from './components/Button';
export { IconButton } from './components/IconButton';
export type { IconButtonProps } from './components/IconButton';
export { Popover } from './components/Popover';
export { AnchorPopover } from './components/AnchorPopover';
export type { AnchorPopoverProps } from './components/AnchorPopover';
export type { PopoverProps } from './components/Popover';
export { Tooltip } from './components/Tooltip';
export type { TooltipProps } from './components/Tooltip';
export * from './exports/fields';
export * from './exports/select';
export * from './exports/choice';
export * from './exports/navigation';
export * from './exports/overlay';
export * from './exports/display';
export * from './exports/upload';
export * from './exports/date';
export * from './exports/sortable';

// —— 应用壳与布局（规范 02）——
export {
  ActionFooterBar,
  AppViewport,
  BackBar,
  CardGrid,
  PageColumn,
  PageColumns,
  PageContent,
  PageLayout,
} from './components/Layout';
export type {
  ActionFooterBarProps,
  AppViewportProps,
  BackBarProps,
  PageColumnProps,
  PageColumnsProps,
  PageColumnWidth,
  PageContentProps,
  PageLayoutProps,
  PageTemplate,
} from './components/Layout';
export { ScrollArea } from './components/ScrollArea';
export type { ScrollAreaProps } from './components/ScrollArea';
export { AppShell } from './components/AppShell';
export type { AppShellProps } from './components/AppShell';
export { BrandMark } from './components/BrandMark';
export type { BrandMarkProps } from './components/BrandMark';
export { BrandLoader } from './components/BrandLoader';
export type { BrandLoaderProps, BrandLoaderSize } from './components/BrandLoader';
export { NavRail } from './components/NavRail';
export type { NavRailItem, NavRailProps } from './components/NavRail';
export { PageHeader } from './components/PageHeader';
export type { PageHeaderProps } from './components/PageHeader';
export { ROLE_HEADER_COMPACT_MAX_WIDTH, RoleHeader } from './components/RoleHeader';
export type {
  RoleHeaderCollapsibleConfig,
  RoleHeaderNavItem,
  RoleHeaderProfileItem,
  RoleHeaderProps,
} from './components/RoleHeader';
export {
  ROLE_HEADER_COLLAPSED_ATTRIBUTE,
  ROLE_HEADER_COLLAPSE_STORAGE_KEY,
  RoleHeaderPersistenceScript,
} from './components/RoleHeaderPersistence';
export { RoleHeaderAction } from './components/RoleHeaderAction';
export type { RoleHeaderActionProps } from './components/RoleHeaderAction';

// —— 反馈（规范 04、05）——
export { FeedbackCapture } from './components/FeedbackCapture';
export type {
  FeedbackCaptureProps,
  FeedbackCategory,
  FeedbackTranslator,
} from './components/FeedbackCapture';
export { FormSubmitButton } from './components/FormSubmitButton';
export type { FormSubmitButtonProps } from './components/FormSubmitButton';
export { PageTransition } from './components/PageTransition';
export type { PageTransitionProps } from './components/PageTransition';
export { PasswordDialog } from './components/PasswordDialog';
export type { PasswordDialogLabels, PasswordDialogProps } from './components/PasswordDialog';
export { RouteLoading } from './components/RouteLoading';
export { RouteProgress, startRouteProgress } from './components/RouteProgress';
export type { RouteProgressProps } from './components/RouteProgress';
export type { RouteLoadingProps } from './components/RouteLoading';
export { SessionExpiryBoundary } from './components/SessionExpiryBoundary';
export type {
  SessionExpiryBoundaryProps,
  SessionExpiryTranslator,
} from './components/SessionExpiryBoundary';
export {
  captureSessionDrafts,
  clearSessionDraft,
  handleSessionExpiryResponse,
  installSessionExpiryInterceptor,
  isSessionReauthorizing,
  readSessionDraft,
  readSessionExpiryNotice,
  registerSessionDraftSnapshot,
  SESSION_EXPIRED_ERROR,
  startSessionReauthorization,
  writeSessionDraft,
} from './session-expiry';
export type { SessionExpiryInterceptorOptions, SessionExpiryNotice } from './session-expiry';
export { Spinner } from './components/Spinner';
export { LoadingIndicator, LoadingIndicatorProvider } from './components/LoadingIndicatorProvider';
export type { SpinnerProps, SpinnerSize } from './components/Spinner';
export {
  DEFAULT_ACTION_TOAST_DURATION,
  DEFAULT_TOAST_DURATION,
  ToastProvider,
  useToast,
} from './components/Toast';
export type {
  ToastAction,
  ToastInput,
  ToastItem,
  ToastProviderProps,
  ToastVariant,
} from './components/Toast';

// —— 业务组件（L2，规范 03 §4）——
export * from './exports/domain';
export { StudentImportGuide } from './StudentImportGuide';
export {
  usePersonalProfile,
  PersonalProfileEditor,
  profileAvatarUrl,
} from './components/PersonalProfile';
export type { PersonalProfile, ProfileTranslate } from './components/PersonalProfile';
export type { StudentImportGuideProps } from './StudentImportGuide';
export { StudentImportResults } from './StudentImportResults';
export type {
  StudentImportClassification,
  StudentImportResultRow,
  StudentImportResultsProps,
  StudentImportStatistics,
} from './StudentImportResults';

export {
  MediaRenewalRevokedError,
  readMediaRenewalResponse,
  startMediaRenewal,
  signedMediaExpiresInSeconds,
  mediaRenewalDelay,
} from './media-renewal';
export { RenewableImage, RenewableImageProvider } from './components/RenewableImage';
export type { RenewableImageProps } from './components/RenewableImage';
