import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'

import { Badge } from '@arcaai/ui/badge'
import { Button } from '@arcaai/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@arcaai/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@arcaai/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@arcaai/ui/form'
import { Input } from '@arcaai/ui/input'
import { Progress } from '@arcaai/ui/progress'
import { ScrollArea } from '@arcaai/ui/scroll-area'
import { Separator } from '@arcaai/ui/separator'
import { Skeleton } from '@arcaai/ui/skeleton'
import { Textarea } from '@arcaai/ui/textarea'
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Dna,
  FileText,
  Loader2,
  Pencil,
  Radio,
  RotateCw,
  Sparkles,
  StopCircle,
  Timer,
  User as UserIcon,
  Wand2,
  Wifi,
} from 'lucide-react'

import { Main } from '@/components/layout/main'
import { cn } from '@/lib/utils'
import { zodResolver } from '@/lib/zod-resolver'
import {
  streamDnaGenerate,
  useDnaJobStatus,
  useDnaVersions,
  useGenerateDnaReport,
  useMyDnaStyle,
  useUpdateDnaReport,
  type DnaGenerateInput,
  type DnaReport,
  type DnaReportData,
  type DnaStreamChunk
} from './api/dna-writing-styles'
import { VersionsPanel } from './components/versions-panel'

type DeliveryMethod = 'sse' | 'polling'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const generateSchema = z.object({
  textSamples: z.string().min(1, 'At least one text sample is required'),
})

const updateSchema = z.object({
  styleText: z.string().optional(),
  changeReason: z.string().min(1, 'Change reason is required'),
  formality: z.string().optional(),
  sentenceLength: z.string().optional(),
  medicalTermUsage: z.string().optional(),
  abbreviationStyle: z.string().optional(),
  tone: z.string().optional(),
  vocabulary: z.string().optional(),
  structure: z.string().optional(),
})

type GenerateFormValues = z.infer<typeof generateSchema>
type UpdateFormValues = z.infer<typeof updateSchema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(dateStr?: string | null): string {
  if (!dateStr) return '—'
  const ms = Date.now() - new Date(dateStr).getTime()
  const sec = Math.floor(ms / 1000)
  const min = Math.floor(sec / 60)
  const hr = Math.floor(min / 60)
  const day = Math.floor(hr / 24)
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (day > 30) {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }
  if (day >= 1) return rtf.format(-day, 'day')
  if (hr >= 1) return rtf.format(-hr, 'hour')
  if (min >= 1) return rtf.format(-min, 'minute')
  return rtf.format(-sec, 'second')
}

function fmtDate(dateStr?: string | null): string {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ---------------------------------------------------------------------------
// StyleAttributeCard (used by MyStyleCard)
// ---------------------------------------------------------------------------

function StyleAttributeCard({
  label,
  value,
  icon,
}: {
  label: string
  value?: string | null
  icon: React.ReactNode
}) {
  return (
    <div className="bg-muted/30 rounded-lg border p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </span>
      </div>
      <p className="text-sm font-medium">{value || '—'}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// JobPollingBanner — HTTP polling progress display
// ---------------------------------------------------------------------------

function JobPollingBanner({
  jobId,
  onComplete,
  onDismiss,
}: {
  jobId: string
  onComplete: () => void
  onDismiss: () => void
}) {
  const { data: jobStatus } = useDnaJobStatus(jobId)
  const [pollCount, setPollCount] = useState(0)
  const startTimeRef = useRef(Date.now())

  useEffect(() => {
    if (!jobStatus) return
    setPollCount((c) => c + 1)
  }, [jobStatus])

  useEffect(() => {
    if (jobStatus?.status === 'completed') {
      toast.success('DNA writing style report generated successfully')
      onComplete()
    }
    if (jobStatus?.status === 'failed') {
      toast.error(`Generation failed: ${jobStatus.error ?? 'Unknown error'}`)
    }
  }, [jobStatus?.status, jobStatus?.error, onComplete])

  if (!jobStatus) return null

  const elapsed = Math.round((Date.now() - startTimeRef.current) / 1000)
  const isTerminal = jobStatus.status === 'completed' || jobStatus.status === 'failed'

  const statusConfig = {
    queued: { icon: <Timer className="size-4" />, color: 'text-yellow-600', bg: 'bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-800', label: 'Queued', progress: 10 },
    processing: { icon: <Loader2 className="size-4 animate-spin" />, color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800', label: 'Processing', progress: 50 },
    completed: { icon: <CheckCircle2 className="size-4" />, color: 'text-green-600', bg: 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800', label: 'Completed', progress: 100 },
    failed: { icon: <AlertCircle className="size-4" />, color: 'text-red-600', bg: 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800', label: 'Failed', progress: 100 },
  }

  const config = statusConfig[jobStatus.status] ?? statusConfig.queued

  return (
    <div className={`rounded-lg border px-4 py-3 space-y-2 ${config.bg}`}>
      <div className="flex items-center gap-3">
        <span className={config.color}>{config.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <p className={`text-sm font-medium ${config.color}`}>
              HTTP Job Polling: {config.label}
            </p>
            {isTerminal && (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onDismiss}>
                Dismiss
              </Button>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
            <span>Job: <code className="font-mono">{jobId.slice(0, 12)}…</code></span>
            <span>Polls: {pollCount}</span>
            <span>Elapsed: {elapsed}s</span>
            <Badge variant="outline" className="text-[10px] gap-1">
              <RotateCw className="size-2.5" />
              2s interval
            </Badge>
          </div>
        </div>
      </div>
      <Progress value={config.progress} className="h-1.5" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// StreamingReportView — SSE real-time token display
// ---------------------------------------------------------------------------

interface StreamingState {
  status: 'idle' | 'connecting' | 'streaming' | 'done' | 'error'
  chunks: DnaStreamChunk[]
  streamedText: string
  error?: string
  startedAt?: number
  endedAt?: number
}

function StreamingReportView({
  state,
  onCancel,
  onDismiss,
}: {
  state: StreamingState
  onCancel: () => void
  onDismiss: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [state.streamedText])

  const elapsed = state.startedAt
    ? Math.round(((state.endedAt ?? Date.now()) - state.startedAt) / 1000)
    : 0
  const charCount = state.streamedText.length
  const chunkCount = state.chunks.length
  const isActive = state.status === 'connecting' || state.status === 'streaming'

  const statusConfig = {
    idle: { icon: <Radio className="size-4" />, color: 'text-muted-foreground', bg: 'border', label: 'Ready' },
    connecting: { icon: <Wifi className="size-4 animate-pulse" />, color: 'text-yellow-600', bg: 'bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-800', label: 'Connecting' },
    streaming: { icon: <Radio className="size-4 animate-pulse" />, color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800', label: 'Streaming' },
    done: { icon: <CheckCircle2 className="size-4" />, color: 'text-green-600', bg: 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800', label: 'Complete' },
    error: { icon: <AlertCircle className="size-4" />, color: 'text-red-600', bg: 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800', label: 'Error' },
  }

  const config = statusConfig[state.status]

  return (
    <div className={`rounded-lg border space-y-0 overflow-hidden ${config.bg}`}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={config.color}>{config.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <p className={`text-sm font-medium ${config.color}`}>
              SSE Stream: {config.label}
            </p>
            <div className="flex items-center gap-1.5">
              {isActive && (
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-destructive" onClick={onCancel}>
                  <StopCircle className="size-3 mr-1" />
                  Stop
                </Button>
              )}
              {!isActive && state.status !== 'idle' && (
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onDismiss}>
                  Dismiss
                </Button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
            <span>Chunks: {chunkCount}</span>
            <span>Chars: {charCount.toLocaleString()}</span>
            <span>Elapsed: {elapsed}s</span>
            <Badge variant="outline" className="text-[10px] gap-1">
              <Wifi className="size-2.5" />
              SSE
            </Badge>
          </div>
        </div>
      </div>

      {/* Streamed content */}
      {state.streamedText && (
        <div
          ref={scrollRef}
          className="max-h-64 overflow-y-auto border-t bg-background/50 px-4 py-3"
        >
          <pre className="text-sm whitespace-pre-wrap font-mono leading-relaxed text-foreground/90">
            {state.streamedText}
            {isActive && <span className="inline-block w-2 h-4 bg-primary/70 animate-pulse ml-0.5 align-text-bottom" />}
          </pre>
        </div>
      )}

      {/* Error message */}
      {state.error && (
        <div className="border-t bg-red-50 dark:bg-red-950/20 px-4 py-2">
          <p className="text-xs text-red-600">{state.error}</p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// GenerateDialog — supports SSE streaming and HTTP job polling
// ---------------------------------------------------------------------------

function GenerateDialog({
  open,
  onOpenChange,
  onJobStarted,
  onStreamStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onJobStarted: (jobId: string) => void
  onStreamStarted: (input: DnaGenerateInput) => void
}) {
  const generateMutation = useGenerateDnaReport()
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>('sse')

  const form = useForm<GenerateFormValues>({
    resolver: zodResolver(generateSchema),
    defaultValues: { textSamples: '' },
  })

  useEffect(() => {
    if (open) form.reset({ textSamples: '' })
  }, [open, form])

  const handleSubmit = useCallback(
    (values: GenerateFormValues) => {
      const samples = values.textSamples
        .split('\n---\n')
        .map((s) => s.trim())
        .filter(Boolean)

      const input: DnaGenerateInput = { textSamples: samples }

      if (deliveryMethod === 'sse') {
        onStreamStarted(input)
        onOpenChange(false)
        return
      }

      generateMutation.mutate(
        { textSamples: samples },
        {
          onSuccess: (data) => {
            toast.success('DNA report generation started — polling for status')
            onJobStarted(data.jobId)
            onOpenChange(false)
          },
          onError: (err) =>
            toast.error(`Failed to start generation: ${err.message}`),
        },
      )
    },
    [deliveryMethod, generateMutation, onJobStarted, onStreamStarted, onOpenChange],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5" />
            Generate DNA Writing Style
          </DialogTitle>
          <DialogDescription>
            Provide writing samples (case notes, clinical documentation) to analyze
            and generate a DNA writing style profile. Separate multiple samples with
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">---</code>
            on its own line.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            {/* Delivery method selector */}
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Delivery Method</legend>
              <div className="grid grid-cols-2 gap-3">
                <label
                  className={cn(
                    'relative flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-all',
                    deliveryMethod === 'sse'
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                      : 'hover:border-muted-foreground/30',
                  )}
                >
                  <input
                    type="radio"
                    name="delivery-method"
                    className="sr-only"
                    value="sse"
                    checked={deliveryMethod === 'sse'}
                    onChange={() => setDeliveryMethod('sse')}
                  />
                  <div className="flex items-center gap-2">
                    <Wifi className={cn('size-4', deliveryMethod === 'sse' ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
                    <span className="text-sm font-medium">SSE Stream</span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Real-time token-by-token streaming via Server-Sent Events. See the report as it's generated.
                  </p>
                  {deliveryMethod === 'sse' && (
                    <div className="absolute right-2 top-2">
                      <CheckCircle2 className="size-4 text-primary" />
                    </div>
                  )}
                </label>

                <label
                  className={cn(
                    'relative flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-all',
                    deliveryMethod === 'polling'
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                      : 'hover:border-muted-foreground/30',
                  )}
                >
                  <input
                    type="radio"
                    name="delivery-method"
                    className="sr-only"
                    value="polling"
                    checked={deliveryMethod === 'polling'}
                    onChange={() => setDeliveryMethod('polling')}
                  />
                  <div className="flex items-center gap-2">
                    <RotateCw className={cn('size-4', deliveryMethod === 'polling' ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
                    <span className="text-sm font-medium">HTTP Polling</span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Submit a background job and poll for status every 2 seconds until complete.
                  </p>
                  {deliveryMethod === 'polling' && (
                    <div className="absolute right-2 top-2">
                      <CheckCircle2 className="size-4 text-primary" />
                    </div>
                  )}
                </label>
              </div>
            </fieldset>

            <Separator />

            <FormField
              control={form.control}
              name="textSamples"
              render={({ field }: { field: any }) => (
                <FormItem>
                  <FormLabel>Writing Samples</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={`Paste clinical notes or writing samples here…\n\nSeparate multiple samples with --- on its own line.\n\nExample:\nPatient presented with acute chest pain…\n---\nFollow-up visit for diabetes management…`}
                      className="min-h-48 font-mono text-sm"
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormDescription>
                    More samples yield a more accurate writing style profile.
                    Recommended: 3-5 samples of 200+ words each.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={generateMutation.isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={generateMutation.isPending}>
                {generateMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                {deliveryMethod === 'sse' ? (
                  <><Wifi className="mr-2 size-4" />Generate (Stream)</>
                ) : (
                  <><Wand2 className="mr-2 size-4" />Generate (Poll)</>
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// EditDialog
// ---------------------------------------------------------------------------

function EditDialog({
  open,
  onOpenChange,
  report,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  report: DnaReport | null
}) {
  const updateMutation = useUpdateDnaReport()

  const form = useForm<UpdateFormValues>({
    resolver: zodResolver(updateSchema),
    defaultValues: {
      styleText: '',
      changeReason: '',
      formality: '',
      sentenceLength: '',
      medicalTermUsage: '',
      abbreviationStyle: '',
      tone: '',
      vocabulary: '',
      structure: '',
    },
  })

  useEffect(() => {
    if (open && report) {
      form.reset({
        styleText: report.styleText ?? '',
        changeReason: '',
        formality: report.reportData?.formality ?? '',
        sentenceLength: report.reportData?.sentenceLength ?? '',
        medicalTermUsage: report.reportData?.medicalTermUsage ?? '',
        abbreviationStyle: report.reportData?.abbreviationStyle ?? '',
        tone: report.reportData?.tone ?? '',
        vocabulary: report.reportData?.vocabulary ?? '',
        structure: report.reportData?.structure ?? '',
      })
    }
  }, [open, report, form])

  const handleSubmit = useCallback(
    (values: UpdateFormValues) => {
      if (!report) return
      const reportData: Partial<DnaReportData> = {}
      if (values.formality) reportData.formality = values.formality
      if (values.sentenceLength) reportData.sentenceLength = values.sentenceLength
      if (values.medicalTermUsage) reportData.medicalTermUsage = values.medicalTermUsage
      if (values.abbreviationStyle) reportData.abbreviationStyle = values.abbreviationStyle
      if (values.tone) reportData.tone = values.tone
      if (values.vocabulary) reportData.vocabulary = values.vocabulary
      if (values.structure) reportData.structure = values.structure

      updateMutation.mutate(
        {
          reportId: report.id,
          styleText: values.styleText || undefined,
          reportData: Object.keys(reportData).length > 0 ? reportData : undefined,
          changeReason: values.changeReason,
        },
        {
          onSuccess: () => {
            toast.success('DNA report updated successfully')
            onOpenChange(false)
          },
          onError: (err) =>
            toast.error(`Failed to update report: ${err.message}`),
        },
      )
    },
    [report, updateMutation, onOpenChange],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="size-5" />
            Edit DNA Writing Style
          </DialogTitle>
          <DialogDescription>
            Update the writing style attributes and provide a reason for the change.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 pr-4">
          <Form {...form}>
            <form
              id="edit-dna-form"
              onSubmit={form.handleSubmit(handleSubmit)}
              className="space-y-4"
            >
              <FormField
                control={form.control}
                name="styleText"
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>Style Text</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Descriptive text about the writing style..."
                        className="min-h-25"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Separator />
              <p className="text-sm font-medium">Style Attributes</p>

              <div className="grid grid-cols-2 gap-4">
                {(['tone', 'vocabulary', 'structure', 'formality', 'sentenceLength', 'medicalTermUsage', 'abbreviationStyle'] as const).map(
                  (fieldName) => (
                    <FormField
                      key={fieldName}
                      control={form.control}
                      name={fieldName}
                      render={({ field }: { field: any }) => (
                        <FormItem>
                          <FormLabel className="capitalize">
                            {fieldName.replace(/([A-Z])/g, ' $1').trim()}
                          </FormLabel>
                          <FormControl>
                            <Input placeholder={`e.g., ${fieldName}`} {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  ),
                )}
              </div>

              <Separator />

              <FormField
                control={form.control}
                name="changeReason"
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>Change Reason</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Why are you making this change?"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </form>
          </Form>
        </ScrollArea>

        <DialogFooter className="pt-4 border-t">
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={updateMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form="edit-dna-form" disabled={updateMutation.isPending}>
            {updateMutation.isPending && (
              <Loader2 className="mr-2 size-4 animate-spin" />
            )}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


// ---------------------------------------------------------------------------
// MyStyleCard — Quick view of current user's DNA style
// ---------------------------------------------------------------------------

function MyStyleCard() {
  const { data: myStyle, isLoading, error } = useMyDnaStyle()

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-60" />
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error || !myStyle) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-8">
          <Dna className="text-muted-foreground/50 mb-2 size-8" aria-hidden="true" />
          <p className="text-muted-foreground text-sm">
            No DNA writing style found. Generate one using the button above.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Dna className="size-4" aria-hidden="true" />
              My Writing Style
            </CardTitle>
            <CardDescription>
              Version {myStyle.currentVersionNumber} · Updated {relativeTime(myStyle.updatedAt)}
            </CardDescription>
          </div>
          <Badge variant={myStyle.isLatest ? 'default' : 'secondary'}>
            {myStyle.isLatest ? 'Latest' : 'Outdated'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {myStyle.styleText && (
          <p className="text-sm text-muted-foreground mb-3 line-clamp-2">
            {myStyle.styleText}
          </p>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {myStyle.reportData?.tone && (
            <StyleAttributeCard label="Tone" value={myStyle.reportData.tone} icon={<Sparkles className="size-3" />} />
          )}
          {myStyle.reportData?.formality && (
            <StyleAttributeCard label="Formality" value={myStyle.reportData.formality} icon={<UserIcon className="size-3" />} />
          )}
          {myStyle.reportData?.vocabulary && (
            <StyleAttributeCard label="Vocabulary" value={myStyle.reportData.vocabulary} icon={<BookOpen className="size-3" />} />
          )}
          {myStyle.reportData?.structure && (
            <StyleAttributeCard label="Structure" value={myStyle.reportData.structure} icon={<FileText className="size-3" />} />
          )}
        </div>
      </CardContent>
    </Card>
  )
}


// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function DnaWritingStylePage() {
  const [generateOpen, setGenerateOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [selectedReport, setSelectedReport] = useState<DnaReport | null>(null)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)

  // Polling state
  const [activeJobId, setActiveJobId] = useState<string | null>(null)

  // SSE streaming state
  const [streamState, setStreamState] = useState<StreamingState>({
    status: 'idle',
    chunks: [],
    streamedText: '',
  })
  const abortRef = useRef<AbortController | null>(null)

  // ---- Data (user-scoped only) --------------------------------------------

  const {
    data: myStyle,
    refetch: refetchMyStyle,
  } = useMyDnaStyle()

  const reportId = myStyle?.id ?? ''

  const {
    data: versions = [],
    isLoading: isLoadingVersions,
    refetch: refetchVersions,
  } = useDnaVersions(reportId)

  useEffect(() => {
    if (versions.length === 0) {
      setSelectedVersionId(null)
      return
    }

    if (!selectedVersionId || !versions.some((v) => v.id === selectedVersionId)) {
      setSelectedVersionId(versions[0]?.id ?? null)
    }
  }, [selectedVersionId, versions])

  // ---- Polling handlers ---------------------------------------------------

  const handleJobStarted = useCallback((jobId: string) => {
    setActiveJobId(jobId)
  }, [])

  const handleJobComplete = useCallback(() => {
    setActiveJobId(null)
    refetchMyStyle()
    refetchVersions()
  }, [refetchMyStyle, refetchVersions])

  const handleJobDismiss = useCallback(() => {
    setActiveJobId(null)
  }, [])

  // ---- SSE streaming handlers ---------------------------------------------

  const handleStreamStarted = useCallback(
    (input: DnaGenerateInput) => {
      if (abortRef.current) abortRef.current.abort()

      setStreamState({
        status: 'connecting',
        chunks: [],
        streamedText: '',
        startedAt: Date.now(),
      })

      const abort = streamDnaGenerate(input, {
        onChunk: (chunk) => {
          setStreamState((prev) => ({
            ...prev,
            status: 'streaming',
            chunks: [...prev.chunks, chunk],
            streamedText: chunk.content
              ? prev.streamedText + chunk.content
              : prev.streamedText,
          }))
        },
        onDone: () => {
          setStreamState((prev) => ({
            ...prev,
            status: 'done',
            endedAt: Date.now(),
          }))
          toast.success('DNA report streamed successfully')
          refetchMyStyle()
          refetchVersions()
        },
        onError: (err) => {
          setStreamState((prev) => ({
            ...prev,
            status: 'error',
            error: err.message,
            endedAt: Date.now(),
          }))
          toast.error(`Stream error: ${err.message}`)
        },
      })

      abortRef.current = abort
    },
    [refetchMyStyle, refetchVersions],
  )

  const handleStreamCancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreamState((prev) => ({
      ...prev,
      status: 'error',
      error: 'Cancelled by user',
      endedAt: Date.now(),
    }))
  }, [])

  const handleStreamDismiss = useCallback(() => {
    setStreamState({ status: 'idle', chunks: [], streamedText: '' })
  }, [])

  useEffect(() => {
    return () => { abortRef.current?.abort() }
  }, [])

  // ---- Render -------------------------------------------------------------

  return (
    <Main>
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between" data-doc="dna-header">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Dna className="size-6" />
            DNA Writing Style
          </h2>
          <p className="text-muted-foreground mt-1">
            View and manage your personal DNA writing style profile used for
            clinical documentation.
          </p>
        </div>
        <Button onClick={() => setGenerateOpen(true)}>
          <Sparkles className="mr-2 size-4" />
          Generate Style
        </Button>
      </div>

      {/* Active generation banners */}
      {(activeJobId || streamState.status !== 'idle') && (
        <div className="mb-4 space-y-3">
          {activeJobId && (
            <JobPollingBanner
              jobId={activeJobId}
              onComplete={handleJobComplete}
              onDismiss={handleJobDismiss}
            />
          )}
          {streamState.status !== 'idle' && (
            <StreamingReportView
              state={streamState}
              onCancel={handleStreamCancel}
              onDismiss={handleStreamDismiss}
            />
          )}
        </div>
      )}

      <div data-doc="dna-report-detail">
        <MyStyleCard />
      </div>

      {myStyle && (
        <div className="mt-6" data-doc="dna-reports-list">
          <VersionsPanel
            report={myStyle}
            versions={versions}
            isLoadingVersions={isLoadingVersions}
            selectedVersionId={selectedVersionId}
            onSelectVersion={setSelectedVersionId}
            onRefreshVersions={() => void refetchVersions()}
          />
        </div>
      )}

      {/* Dialogs */}
      <GenerateDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        onJobStarted={handleJobStarted}
        onStreamStarted={handleStreamStarted}
      />

      <EditDialog
        open={editOpen}
        onOpenChange={(v) => {
          setEditOpen(v)
          if (!v) setSelectedReport(null)
        }}
        report={selectedReport}
      />
      </div>
      </div>
    </Main>
  )
}
