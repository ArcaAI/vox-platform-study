// Utilities
export { cn } from './lib/utils';

// Hooks
export { useIsMobile } from './hooks/use-mobile';
export {
  useScribe,
  type ScribeStatus,
  type AudioFormat,
  type CommitStrategy,
  type TranscriptSegment as ScribeTranscriptSegment,
} from './hooks/use-scribe';
export {
  useTranscriptViewer,
  type UseTranscriptViewerProps,
  type UseTranscriptViewerResult,
  type ComposeSegmentsOptions,
  type ComposeSegmentsResult,
  type SegmentComposer,
  type TranscriptSegment,
  type TranscriptWord,
} from './hooks/use-transcript-viewer';

// Components (shadcn/ui primitives)
export * from './components/shadcn/accordion';
export * from './components/shadcn/alert';
export * from './components/shadcn/alert-dialog';
export * from './components/shadcn/aspect-ratio';
export * from './components/shadcn/avatar';
export * from './components/shadcn/badge';
export * from './components/shadcn/breadcrumb';
export * from './components/shadcn/button';
export * from './components/shadcn/button-group';
export * from './components/shadcn/calendar';
export * from './components/shadcn/card';
export * from './components/shadcn/carousel';
export * from './components/shadcn/chart';
export * from './components/shadcn/checkbox';
export * from './components/shadcn/collapsible';
export * from './components/shadcn/command';
export * from './components/shadcn/context-menu';
export * from './components/shadcn/dialog';
export * from './components/shadcn/direction';
export * from './components/shadcn/drawer';
export * from './components/shadcn/dropdown-menu';
export * from './components/shadcn/empty';
export * from './components/shadcn/field';
export * from './components/shadcn/form';
export * from './components/shadcn/hover-card';
export * from './components/shadcn/input';
export * from './components/shadcn/input-group';
export * from './components/shadcn/input-otp';
export * from './components/shadcn/item';
export * from './components/shadcn/kbd';
export * from './components/shadcn/label';
export * from './components/shadcn/menubar';
export * from './components/shadcn/native-select';
export * from './components/shadcn/navigation-menu';
export * from './components/shadcn/pagination';
export * from './components/shadcn/popover';
export * from './components/shadcn/progress';
export * from './components/shadcn/radio-group';
export * from './components/shadcn/resizable';
export * from './components/shadcn/scroll-area';
export * from './components/shadcn/select';
export * from './components/shadcn/separator';
export * from './components/shadcn/sheet';
export * from './components/shadcn/sidebar';
export * from './components/shadcn/skeleton';
export * from './components/shadcn/master-detail-layout';
export * from './components/shadcn/slider';
export * from './components/shadcn/sonner';
export * from './components/shadcn/spinner';
export * from './components/shadcn/switch';
export * from './components/shadcn/table';
export * from './components/shadcn/tabs';
export * from './components/shadcn/textarea';
export * from './components/shadcn/toast';
export * from './components/shadcn/toggle';
export * from './components/shadcn/toggle-group';
export * from './components/shadcn/tooltip';

// Domain-specific components
export * from './components/custom/async-job-tracker';
export * from './components/custom/audio-meter';
export * from './components/custom/code-example';
export * from './components/custom/dept-prompt-selector';
export * from './components/custom/dna-style-selector';
export * from './components/custom/model-selector';
export * from './components/custom/theme-toggle';
// The deprecated `custom/transcript-viewer` was removed by TASK-410 (P2-4) — zero
// remaining usages (grep-proven); `LiveTranscript` is the canonical transcript (D6).
export * from './components/custom/multi-column-layout';
export * from './components/custom/workflow-toggle';

// ElevenLabs UI Components
export * from './components/elevenlabs/audio-player';
export {
  BarVisualizer,
  useAudioVolume,
  useMultibandVolume,
  useBarAnimator,
  type AgentState,
  type AudioAnalyserOptions,
  type MultiBandVolumeOptions,
  type BarVisualizerProps,
} from './components/elevenlabs/bar-visualizer';
export * from './components/elevenlabs/conversation';
export * from './components/elevenlabs/conversation-bar';
export * from './components/elevenlabs/live-waveform';
export * from './components/elevenlabs/matrix';
export * from './components/elevenlabs/message';
export * from './components/elevenlabs/mic-selector';
export { Orb, type AgentState as OrbAgentState } from './components/elevenlabs/orb';
export * from './components/elevenlabs/response';
export * from './components/elevenlabs/scrub-bar';
export * from './components/elevenlabs/shimmering-text';
export * from './components/elevenlabs/speech-input';
export * from './components/elevenlabs/transcript-viewer';
export * from './components/elevenlabs/voice-button';
export * from './components/elevenlabs/voice-picker';
export * from './components/elevenlabs/waveform';

// ============================================
// Registry: @prompt-kit (AI Chat Primitives)
// Message/MessageAvatar/MessageContent/MessageProps/MessageAvatarProps/MessageContentProps
// excluded — already exported by elevenlabs/message
// ============================================
export {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtItem,
  ChainOfThoughtStep,
  ChainOfThoughtTrigger,
  type ChainOfThoughtContentProps,
  type ChainOfThoughtItemProps,
  type ChainOfThoughtProps,
  type ChainOfThoughtStepProps,
  type ChainOfThoughtTriggerProps,
} from './components/registries/prompt-kit';
export {
  ChatContainerContent,
  ChatContainerRoot,
  ChatContainerScrollAnchor,
  type ChatContainerContentProps,
  type ChatContainerRootProps,
  type ChatContainerScrollAnchorProps,
} from './components/registries/prompt-kit';
export {
  CodeBlock,
  CodeBlockCode,
  CodeBlockGroup,
  type CodeBlockCodeProps,
  type CodeBlockGroupProps,
  type CodeBlockProps,
} from './components/registries/prompt-kit';
export { FeedbackBar } from './components/registries/prompt-kit';
export {
  FileUpload,
  FileUploadClear,
  FileUploadDropzone,
  FileUploadItem,
  FileUploadItemDelete,
  FileUploadItemMetadata,
  FileUploadItemPreview,
  FileUploadItemProgress,
  FileUploadList,
  FileUploadTrigger,
  useFileUpload,
  type FileUploadProps,
} from './components/registries/prompt-kit';
export {
  BarsLoader,
  CircularLoader,
  ClassicLoader,
  DotsLoader,
  Loader,
  PulseDotLoader,
  PulseLoader,
  TerminalLoader,
  TextBlinkLoader,
  TextDotsLoader,
  TextShimmerLoader,
  TypingLoader,
  WaveLoader,
  type LoaderProps,
} from './components/registries/prompt-kit';
export { Markdown, type MarkdownProps } from './components/registries/prompt-kit';
export {
  MessageAction as PromptKitMessageAction,
  MessageActions as PromptKitMessageActions,
  type MessageActionProps as PromptKitMessageActionProps,
  type MessageActionsProps as PromptKitMessageActionsProps,
} from './components/registries/prompt-kit';
export {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputTextarea,
  type PromptInputActionProps,
  type PromptInputActionsProps,
  type PromptInputProps,
  type PromptInputTextareaProps,
} from './components/registries/prompt-kit';
export { PromptSuggestion, type PromptSuggestionProps } from './components/registries/prompt-kit';
export {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  type ReasoningContentProps,
  type ReasoningProps,
  type ReasoningTriggerProps,
} from './components/registries/prompt-kit';
export {
  ResponseStream,
  useTextStream,
  type Mode,
  type ResponseStreamProps,
  type UseTextStreamOptions,
  type UseTextStreamResult,
} from './components/registries/prompt-kit';
export { ScrollButton, type ScrollButtonProps } from './components/registries/prompt-kit';
export {
  Source,
  SourceContent,
  SourceTrigger,
  type SourceContentProps,
  type SourceProps,
  type SourceTriggerProps,
} from './components/registries/prompt-kit';
export {
  Steps,
  StepsBar,
  StepsContent,
  StepsItem,
  StepsTrigger,
  type StepsBarProps,
  type StepsContentProps,
  type StepsItemProps,
  type StepsProps,
  type StepsTriggerProps,
} from './components/registries/prompt-kit';
export { Tool, type ToolPart, type ToolProps } from './components/registries/prompt-kit';

// ============================================
// Registry: @tool-ui (AI Tool Rendering)
// ============================================
export * from './components/registries/tool-ui';

// ============================================
// Registry: @ai-elements (AI/Chat/Voice/Workflow)
// Namespaced — collides with @prompt-kit (CodeBlock, Source, Tool, Reasoning, PromptInput, etc.)
// ============================================
export * as AIElements from './components/registries/ai-elements';

// ============================================
// Registry: @einui (Glass Morphism)
// ============================================
export * from './components/registries/einui';

// ============================================
// Registry: @diceui (Advanced Accessible)
// ============================================
export * from './components/registries/diceui';

// ============================================
// Registry: @kibo-ui (Full UI Toolkit)
// Namespaced — collides with @diceui (Marquee, ColorPicker, Rating), @magicui (Terminal), shadcn (Spinner)
// ============================================
export * as KiboUI from './components/registries/kibo-ui';

// ============================================
// Registry: @billingsdk (Billing/Payments)
// ============================================
export * from './components/registries/billingsdk';

// ============================================
// Registry: @better-upload (File Upload)
// ============================================
export * from './components/registries/better-upload';

// ============================================
// Registry: @mapcn (Map Components)
// ============================================
export * from './components/registries/mapcn';

// ============================================
// Registry: @manifest (MCP/Agentic UI)
// Namespaced — collides with @tool-ui (OptionList), @tour (Step)
// ============================================
export * as Manifest from './components/registries/manifest';

// ============================================
// Registry: @tour (Onboarding Tours)
// ============================================
export * from './components/registries/tour';

// ============================================
// Registry: @basecn (Base UI Primitives)
// REMOVED from barrel — duplicates ALL shadcn component names.
// Import directly: import { Button } from '@arcaai/ui/components/registries/basecn/button'
// ============================================

// ============================================
// Registry: @magicui (Animated Effects)
// Marquee excluded — already exported by @diceui
// Terminal/AnimatedSpan excluded — Terminal already exported by @tool-ui
// ============================================
export { BorderBeam } from './components/registries/magicui';
export { ShineBorder } from './components/registries/magicui';
export { MagicCard } from './components/registries/magicui';
export { Meteors } from './components/registries/magicui';
export { Confetti, ConfettiButton } from './components/registries/magicui';
export type { ConfettiRef } from './components/registries/magicui';
export { Particles } from './components/registries/magicui';
export { AnimatedBeam } from './components/registries/magicui';
export type { AnimatedBeamProps } from './components/registries/magicui';
export { TextAnimate } from './components/registries/magicui';
export { AuroraText } from './components/registries/magicui';
export { MorphingText } from './components/registries/magicui';
export { SparklesText } from './components/registries/magicui';
export { TypingAnimation } from './components/registries/magicui';
export { NumberTicker } from './components/registries/magicui';
export { AnimatedGradientText } from './components/registries/magicui';
export { AnimatedShinyText } from './components/registries/magicui';
export { HyperText } from './components/registries/magicui';
export { WordRotate } from './components/registries/magicui';
export { LineShadowText } from './components/registries/magicui';
export { Dock, DockIcon, dockVariants } from './components/registries/magicui';
export type { DockProps, DockIconProps } from './components/registries/magicui';
export { Globe } from './components/registries/magicui';
export { BentoCard, BentoGrid } from './components/registries/magicui';
export { AnimatedList, AnimatedListItem } from './components/registries/magicui';
export { HeroVideoDialog } from './components/registries/magicui';
export { AvatarCircles } from './components/registries/magicui';
export { OrbitingCircles } from './components/registries/magicui';
export { IconCloud } from './components/registries/magicui';
export { DotPattern } from './components/registries/magicui';
export { GridPattern } from './components/registries/magicui';
export { RetroGrid } from './components/registries/magicui';
export { Ripple } from './components/registries/magicui';
export { FlickeringGrid } from './components/registries/magicui';
export { AnimatedGridPattern } from './components/registries/magicui';
export { ShimmerButton } from './components/registries/magicui';
export { RainbowButton, rainbowButtonVariants } from './components/registries/magicui';
export type { RainbowButtonProps } from './components/registries/magicui';
export { RippleButton } from './components/registries/magicui';
export { PulsatingButton } from './components/registries/magicui';
export { ShinyButton } from './components/registries/magicui';
export { InteractiveHoverButton } from './components/registries/magicui';
export { BlurFade } from './components/registries/magicui';
export { ScrollProgress } from './components/registries/magicui';
export { CoolMode } from './components/registries/magicui';
export { NeonGradientCard } from './components/registries/magicui';
export { Safari } from './components/registries/magicui';
export { Android } from './components/registries/magicui';
export { Tree, Folder, File, CollapseButton } from './components/registries/magicui';
export type { TreeViewElement } from './components/registries/magicui';
export { CodeComparison } from './components/registries/magicui';

// ============================================
// Registry: @lucide-animated (Animated Icons)
// Namespaced — icon names may collide with other exports
// ============================================
export * as LucideAnimated from './components/registries/lucide-animated';

// ============================================
// Registry: @shadcn-editor (Rich Text Editor)
// ============================================
export * from './components/registries/shadcn-editor';

// ============================================
// Registry: @blocks (App Building Blocks)
// ============================================
export * from './components/registries/blocks';

// ============================================
// Registry: @hooks (React Hooks Collection)
// ============================================
export * from './hooks/registries';

// ============================================
// TASK-372 — Gold-standard shared component system (canonical, D6)
// ============================================

// Shared contracts: pagination / query-state / async-collection / surface props.
export * from './lib/shared';

// Shared primitives. `StatusBadge` joined the root barrel in TASK-410 (P2-4): the
// colliding tool-ui formatter `StatusBadge` was removed together with the deprecated
// tool-ui `DataTable`. The '@arcaai/ui/components/shared' subpath keeps exporting it too.
export { DensityProvider, useDensity, type DensityProviderProps } from './components/shared/density-provider';
export { StatusBadge, type StatusBadgeProps, type StatusColorRole } from './components/shared/status-badge';

// VirtualizedDataGrid — canonical data grid (supersedes tool-ui DataTable, D6).
export * from './components/data-grid';

// HistoryTimelineList — content-type-aware, virtualized history.
// `TimelineItem` is omitted (collides with the diceui `TimelineItem` export).
export {
  HistoryTimelineList,
  useTimeline,
  ScrollSpyTimeline,
  useScrollSpy,
  MarkdownRenderer,
  PdfRenderer,
  ImageGridRenderer,
  AudioRenderer,
  FileRenderer,
  MixedRenderer,
  CustomRenderer,
  FallbackRenderer,
  DEFAULT_RENDERERS,
  resolveRenderer,
} from './components/timeline';
export type {
  TimelineContentVariant,
  TimelineContent,
  TimelineItemModel,
  TimelineBadge,
  TimelineWord,
  TimelineImage,
  TimelineTranscriptSegment,
  TimelineRenderer,
  TimelineRendererProps,
  TimelineExpansion,
  HistoryTimelineListProps,
  UseTimelineParams,
  UseTimelineResult,
  ScrollSpyTimelineProps,
  TimelineMilestone,
  UseScrollSpyParams,
  UseScrollSpyResult,
} from './components/timeline';

// TASK-378 — Collection foundations: CardGrid + EntityCard + ItemList.
export { CardGrid, EntityCard, ItemList } from './components/collection';
export type { CardGridProps, EntityCardProps, ItemListProps } from './components/collection';

// LiveTranscript — canonical realtime transcript (supersedes custom TranscriptViewer, D6).
// The `TranscriptSegment` / `TranscriptWord` sub-components are omitted (their names
// collide with the `use-transcript-viewer` type exports); import them from
// '@arcaai/ui/components/live-transcript' (subpath) if needed.
export { LiveTranscript, useLiveTranscript, JumpToLive, ListeningPulse } from './components/live-transcript';
export type {
  LiveTranscriptSegment,
  LiveTranscriptWord,
  LiveTranscriptProps,
  SpeakerConfig,
  AudioController,
  UseLiveTranscriptParams,
  UseLiveTranscriptResult,
  ActiveWord,
} from './components/live-transcript';

// ============================================
// TASK-377 — Shared Metrics / Reporting / Chart primitives (PHASE-2-PLAN §3)
// TASK-404 retired the legacy `components/custom/service-status-bar`, so the
// canonical semantic `ServiceStatusBar` now owns the root-barrel name (the
// subpath '@arcaai/ui/components/metrics' keeps exporting it too).
// ============================================
export {
  StatusDot,
  StatCard,
  MetricChart,
  ServiceStatusBar,
  ServiceStatusItem,
  DateRangeSelector,
  TenantFilter,
  MetricTable,
  RunningTasksList,
  ModelsList,
} from './components/metrics';
export type {
  StatusDotProps,
  StatCardProps,
  StatCardAccent,
  StatCardDelta,
  DeltaDirection,
  DeltaIntent,
  MetricChartProps,
  MetricChartKind,
  MetricSeries,
  ServiceStatus,
  ServiceStatusBarProps,
  ServiceStatusItemProps,
  DateRangeSelectorProps,
  RangePreset,
  DateRange,
  TenantFilterProps,
  TenantOption,
  MetricTableProps,
  MetricColumn,
  MetricColumnAlign,
  MetricColumnFormat,
  RunningTasksListProps,
  RunningTask,
  TaskStatus,
  ModelsListProps,
  ModelInfo,
  ModelStatus,
} from './components/metrics';
