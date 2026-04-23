import { PlaygroundLayout } from '@/components/layout/playground-layout';
import { ImpersonationGuard } from '@/features/summarization/components/impersonation-guard';
import { useDoctorContext } from '@/features/summarization/hooks/use-doctor-context';
import { useFileTranscription } from '@/hooks/use-file-transcription';
import { useAudioStore } from '@/store/audio-store';
import { useAuthStore } from '@/store/auth-store';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { LiveWaveform } from '@arcaai/ui/components/elevenlabs/live-waveform';
import { Progress } from '@arcaai/ui/progress';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { useAuth, usePipelines } from '@arcaai/vox';
import { AlertCircle, CloudUpload, FileAudio, Languages, RefreshCw, Server, Trash2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AudioImpersonationBanner, AudioPageHeaderAction } from './components/audio-page-chrome';
import { AudioTranscriptItem } from './components/audio-transcript-item';
import { DEFAULT_TRANSCRIPTION_PIPELINE_ID, SUPPORTED_LANGUAGES } from './constants';

function FileUploadPanel({
  file,
  onFileSelect,
  onLoadTestFile,
  disabled,
}: {
  file: File | null;
  onFileSelect: (file: File) => void;
  onLoadTestFile: () => void;
  disabled: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) onFileSelect(selected);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <FileAudio className="size-4" />
          <CardTitle className="text-sm">Audio File</CardTitle>
        </div>
        <CardDescription className="text-xs">Upload an audio file for backend-based batch transcription</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <input ref={fileInputRef} type="file" accept="audio/*" onChange={handleFileChange} className="hidden" aria-label="Upload audio file" />

        {!file ? (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-50"
            >
              <Upload className="text-muted-foreground size-8" />
              <span className="text-muted-foreground text-sm">Click to select an audio file</span>
              <span className="text-muted-foreground text-[10px]">Supports MP3, WAV, FLAC, OGG, M4A, and more</span>
            </button>
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1 text-xs"
              onClick={onLoadTestFile}
              disabled={disabled}
              data-testid="load-test-file"
            >
              <FileAudio className="size-3" /> Load Test File
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <FileAudio className="text-primary size-3.5 shrink-0" />
                <span className="truncate text-xs">{file.name}</span>
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  {(file.size / (1024 * 1024)).toFixed(1)} MB
                </Badge>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1 gap-1 text-xs" onClick={() => fileInputRef.current?.click()} disabled={disabled}>
                <Upload className="size-3" /> Change File
              </Button>
              <Button variant="outline" size="sm" className="gap-1 text-xs" onClick={onLoadTestFile} disabled={disabled}>
                <FileAudio className="size-3" /> Test File
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BatchTranscriptPanel() {
  const fileTranscription = useFileTranscription();
  const { selectedPipelineId, setSelectedPipelineId } = useAudioStore();
  const { pipelines, isLoading: pipelinesLoading, error: pipelinesError, list: listPipelines } = usePipelines();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [language, setLanguage] = useState<string>('');

  useEffect(() => {
    listPipelines();
  }, [listPipelines]);

  useEffect(() => {
    if (pipelinesLoading || pipelines.length === 0) return;
    const currentValid = pipelines.some((p: { id: string }) => p.id === selectedPipelineId);
    if (!selectedPipelineId || !currentValid) {
      setSelectedPipelineId(pipelines[0].id);
    }
  }, [pipelinesLoading, pipelines, selectedPipelineId, setSelectedPipelineId]);

  const handleFileSelect = useCallback((file: File) => {
    setSelectedFile(file);
    toast.success(`Selected file: ${file.name}`);
  }, []);

  const handleLoadTestFile = useCallback(async () => {
    try {
      const response = await fetch('/2p_argument.mp3');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const file = new File([blob], '2p_argument.mp3', { type: 'audio/mpeg' });
      setSelectedFile(file);
      toast.success('Loaded test audio file');
    } catch (err) {
      toast.error(`Failed to load test file: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  }, []);

  const handleUpload = useCallback(async () => {
    if (!selectedFile) {
      toast.warning('Select an audio file first');
      return;
    }
    toast.info(`Uploading ${selectedFile.name}...`);
    try {
      await fileTranscription.upload(selectedFile, {
        pipelineId: selectedPipelineId || DEFAULT_TRANSCRIPTION_PIPELINE_ID,
        ...(language ? { language } : {}),
      });
      toast.success(`Upload complete. Job: ${fileTranscription.jobId?.slice(0, 12) ?? ''}...`);
    } catch (err) {
      toast.error(`Upload failed: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  }, [selectedFile, fileTranscription, selectedPipelineId, language]);

  const handleReset = useCallback(() => {
    fileTranscription.reset();
    setSelectedFile(null);
  }, [fileTranscription]);

  const wordCount = fileTranscription.transcripts.reduce((acc, t) => acc + t.text.split(/\s+/).length, 0);

  const isProcessing = fileTranscription.isUploading || fileTranscription.isStreaming;

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <div className="space-y-4">
        <FileUploadPanel file={selectedFile} onFileSelect={handleFileSelect} onLoadTestFile={handleLoadTestFile} disabled={isProcessing} />

        <Card data-doc="audio-pipeline">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Server className="size-4 text-blue-500" />
              <CardTitle className="text-sm">Audio Pipeline</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {pipelinesLoading ? (
              <div className="bg-muted h-8 animate-pulse rounded-md" />
            ) : pipelinesError ? (
              <div className="bg-destructive/10 flex items-center gap-2 rounded-md p-2">
                <AlertCircle className="text-destructive size-4 shrink-0" />
                <span className="text-destructive text-[10px]">Failed to load pipelines</span>
              </div>
            ) : (
              <Select value={selectedPipelineId ?? undefined} onValueChange={setSelectedPipelineId} disabled={isProcessing}>
                <SelectTrigger className="h-8 w-full min-w-0 text-xs">
                  <SelectValue placeholder="Select a pipeline..." className="truncate" />
                </SelectTrigger>
                <SelectContent>
                  {pipelines.map((pipeline: { id: string; name: string }) => (
                    <SelectItem key={pipeline.id} value={pipeline.id} className="text-xs">
                      <span className="block w-full truncate">{pipeline.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </CardContent>
        </Card>

        <Card data-doc="batch-language">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Languages className="size-4" />
              <CardTitle className="text-sm">Language</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <Select value={language || '__none__'} onValueChange={(v: string) => setLanguage(v === '__none__' ? '' : v)} disabled={isProcessing}>
              <SelectTrigger className="h-8 w-full min-w-0 text-xs">
                <SelectValue className="truncate" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None (use pipeline config)</SelectItem>
                {SUPPORTED_LANGUAGES.map((lang) => (
                  <SelectItem key={lang.value} value={lang.value}>
                    {lang.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {language ? (
              <p className="text-amber-500 text-[10px]">Not recommended: overrides the pipeline's default language setting</p>
            ) : (
              <p className="text-muted-foreground text-[10px]">Uses language configured in the pipeline YAML</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <CloudUpload className="text-emerald-500 size-4" />
              <CardTitle className="text-sm">Processing</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-xs">
              Audio files are uploaded to the backend service and processed server-side. Transcription results stream back via SSE (Server-Sent
              Events) in real-time.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="flex flex-col" data-doc="batch-transcript">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CloudUpload className="text-emerald-500 size-4" />
            <CardTitle className="text-sm">Batch Transcript</CardTitle>
          </div>
          <CardDescription className="text-xs">Upload audio file, receive transcript via SSE stream from backend</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  fileTranscription.isStreaming
                    ? 'default'
                    : fileTranscription.status === 'complete'
                      ? 'secondary'
                      : fileTranscription.status === 'error'
                        ? 'destructive'
                        : 'outline'
                }
                className="text-[10px]"
              >
                {fileTranscription.status}
              </Badge>
              {fileTranscription.jobId && <code className="bg-muted rounded px-1.5 text-[10px]">Job: {fileTranscription.jobId.slice(0, 16)}</code>}
              <span className="text-muted-foreground text-[10px]">
                {fileTranscription.transcripts.length} segments | {wordCount} words
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={fileTranscription.clearTranscripts} disabled={fileTranscription.transcripts.length === 0}>
                <Trash2 className="mr-1 size-3" /> Clear
              </Button>
              {fileTranscription.status === 'idle' ? (
                <Button size="sm" onClick={handleUpload} className="gap-1.5" disabled={!selectedFile}>
                  <Upload className="size-3.5" />
                  Upload & Transcribe
                </Button>
              ) : fileTranscription.status === 'complete' || fileTranscription.status === 'error' ? (
                <Button variant="outline" size="sm" onClick={handleReset} className="gap-1.5">
                  <RefreshCw className="size-3.5" />
                  Upload Another
                </Button>
              ) : (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled className="gap-1.5">
                    {fileTranscription.isUploading ? 'Uploading...' : 'Processing...'}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={fileTranscription.cancel} className="gap-1.5">
                    <X className="size-3.5" aria-hidden="true" />
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          </div>

          {selectedFile && fileTranscription.isUploading && (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 rounded-lg border px-3 py-1.5">
                <FileAudio className="text-muted-foreground size-3.5" />
                <span className="text-xs">{selectedFile.name}</span>
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                </Badge>
              </div>
              <div className="flex flex-1 items-center gap-2">
                <Progress value={fileTranscription.uploadProgress} className="h-2" />
                <span className="text-[10px] font-medium tabular-nums">{fileTranscription.uploadProgress}%</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={fileTranscription.cancel}
                className="h-7 gap-1 text-xs text-destructive hover:text-destructive"
                aria-label="Cancel upload"
              >
                <X className="size-3.5" />
                Cancel
              </Button>
            </div>
          )}

          {!selectedFile && fileTranscription.fileName && fileTranscription.isStreaming && (
            <div className="flex items-center gap-2 rounded-lg border px-3 py-1.5">
              <FileAudio className="text-muted-foreground size-3.5" />
              <span className="text-xs">{fileTranscription.fileName}</span>
              <Badge variant="secondary" className="text-[10px]">Resumed</Badge>
            </div>
          )}

          {isProcessing && (
            <div className="bg-muted/30 overflow-hidden rounded-lg border p-1">
              <LiveWaveform
                active={false}
                processing={isProcessing}
                height={36}
                barWidth={2}
                barGap={1}
                barRadius={1}
                mode="scrolling"
                className="text-emerald-500"
              />
            </div>
          )}

          {fileTranscription.error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2">
              <p className="text-destructive text-[11px]">{fileTranscription.error}</p>
            </div>
          )}

          {fileTranscription.isReconnecting && (
            <div role="status" aria-live="polite" className="rounded-md border border-blue-200 bg-blue-50 p-2 dark:border-blue-800 dark:bg-blue-950">
              <p className="text-blue-700 dark:text-blue-300 text-xs">Reconnecting to previous job...</p>
            </div>
          )}

          <ScrollArea className="h-96 rounded-lg border">
            {fileTranscription.transcripts.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center py-16 text-center">
                <Languages className="text-muted-foreground mb-3 size-10" />
                <p className="text-muted-foreground text-sm">
                  {fileTranscription.isUploading
                    ? 'Uploading audio file...'
                    : fileTranscription.isStreaming
                      ? 'Waiting for first transcript event...'
                      : 'Select an audio file and click "Upload & Transcribe"'}
                </p>
              </div>
            ) : (
              <div className="space-y-1 p-2">
                {fileTranscription.transcripts.map((entry) => (
                  <AudioTranscriptItem key={entry.id} entry={entry} />
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

export default function BatchTranscriptionPage() {
  const { isImpersonating, impersonatedUser } = useAuth();
  const localUser = useAuthStore((s: { user: { username?: string } | null }) => s.user);
  const { reset } = useAudioStore();
  const tenantId = useAuthStore((s) => s.tenantId);
  const { requiresImpersonation, roles } = useDoctorContext();

  const activeUser = isImpersonating ? impersonatedUser : localUser;

  const handleReset = () => {
    reset();
    toast.success('Configuration reset to defaults');
  };

  return (
    <PlaygroundLayout
      title="Batch Transcription"
      description="Upload audio files for backend-based transcription via SSE streaming."
      showServiceStatus={false}
      headerAction={
        <AudioPageHeaderAction
          isImpersonating={isImpersonating}
          impersonatedUsername={impersonatedUser?.username}
          activeUsername={activeUser?.username}
          onReset={handleReset}
        />
      }
    >
      <AudioImpersonationBanner
        isImpersonating={isImpersonating}
        impersonatedUsername={impersonatedUser?.username}
        description="Audio settings and recordings will be associated with the impersonated user."
      />

      {!tenantId ? (
        <div className="flex h-60 flex-col items-center justify-center text-center">
          <p className="text-muted-foreground text-sm">Tenant configuration required</p>
          <p className="text-muted-foreground mt-1 text-xs">Please log in with a valid tenant to access batch transcription.</p>
        </div>
      ) : requiresImpersonation ? (
        <ImpersonationGuard
          roles={roles}
          featureName="batch transcription"
          featureDescription="Batch transcription requires pipeline access. As an admin, you need to impersonate a doctor user to load pipelines and start transcription jobs."
        />
      ) : (
        <BatchTranscriptPanel />
      )}
    </PlaygroundLayout>
  );
}
