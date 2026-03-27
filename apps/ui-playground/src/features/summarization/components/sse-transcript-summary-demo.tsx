import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Button } from '@arcaai/ui/button';
import { Badge } from '@arcaai/ui/badge';
import { Label } from '@arcaai/ui/label';
import { Input } from '@arcaai/ui/input';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { Progress } from '@arcaai/ui/progress';
import { Switch } from '@arcaai/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { toast } from 'sonner';
import { useState, useRef, useCallback, useEffect } from 'react';
import { AlertCircle, ArrowDown, CheckCircle2, Copy, FileAudio, Loader2, Radio, Sparkles, Upload } from 'lucide-react';
import { usePlaygroundStore } from '@/store/playground-store';
import { useAuthStore } from '@/store/auth-store';

type SsePhase = 'idle' | 'uploading' | 'transcribing' | 'summarizing' | 'done' | 'error';

interface SseEvent {
  eventType: string;
  data: string;
  id?: string;
  timestamp: string;
}

interface StreamChunk {
  text: string;
  index: number;
}

function getHeaders(): Record<string, string> {
  const { accessToken, apiKey, authMethod, tenantId, isImpersonating, impersonationToken } = useAuthStore.getState();
  const headers: Record<string, string> = {};
  if (authMethod === 'credentials') {
    const token = isImpersonating && impersonationToken ? impersonationToken : accessToken;
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } else if (authMethod === 'apiKey' && apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  return headers;
}

const SAMPLE_TRANSCRIPT_FOR_SUMMARY = `Doctor: Good morning, Mrs. Johnson. I see you're here for your follow-up appointment regarding your hypertension management.
Patient: Yes, doctor. I've been taking the amlodipine 5mg as prescribed, but I've been experiencing some ankle swelling.
Doctor: That's a known side effect of amlodipine. How severe is the swelling?
Patient: It's moderate. My shoes feel tight by the end of the day.
Doctor: Let me check your blood pressure... 132 over 82. That's improved from last time. Given the edema, I'd like to switch you to an ACE inhibitor instead. I'll prescribe lisinopril 10mg once daily.
Patient: Will that have the same side effects?
Doctor: ACE inhibitors can cause a dry cough in some patients, but ankle swelling is much less common. We'll monitor you closely. I'd also like to order a basic metabolic panel to check your kidney function before starting.
Patient: Okay, that sounds good.
Doctor: Please come back in four weeks for a follow-up. If the cough becomes bothersome, let us know and we can switch to an ARB instead.`;

export function SseTranscriptSummaryDemo() {
  const [phase, setPhase] = useState<SsePhase>('idle');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [jobId, setJobId] = useState('');
  const [transcriptText, setTranscriptText] = useState('');
  const [summaryText, setSummaryText] = useState('');
  const [sseEvents, setSseEvents] = useState<SseEvent[]>([]);
  const [showEvents, setShowEvents] = useState(false);
  const [progress, setProgress] = useState(0);
  const [streamChunks, setStreamChunks] = useState<StreamChunk[]>([]);
  const [provider, setProvider] = useState('ollama');
  const [autoSummarize, setAutoSummarize] = useState(true);
  const [totalTokens, setTotalTokens] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const phaseRef = useRef<SsePhase>('idle');

  const apiBaseUrl = usePlaygroundStore((s) => s.apiBaseUrl);

  const addEvent = useCallback((eventType: string, data: string, id?: string) => {
    setSseEvents((prev) => {
      const next = [...prev, { eventType, data: data.length > 300 ? data.slice(0, 300) + '…' : data, id, timestamp: new Date().toISOString() }];
      return next.slice(-100);
    });
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('audio/') && !file.name.match(/\.(wav|mp3|m4a|ogg|webm|flac)$/i)) {
        toast.error('Please select an audio file');
        return;
      }
      setSelectedFile(file);
      toast.success(`Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
    }
  }, []);

  const updatePhase = useCallback((next: SsePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const handleUploadAndTranscribe = useCallback(async () => {
    if (!selectedFile) {
      toast.error('Please select an audio file first');
      return;
    }

    updatePhase('uploading');
    setTranscriptText('');
    setSummaryText('');
    setSseEvents([]);
    setStreamChunks([]);
    setProgress(0);
    setTotalTokens(0);

    const headers = getHeaders();
    const base = apiBaseUrl.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');

    abortRef.current = new AbortController();

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('language', 'en-US');

      addEvent('upload', `Uploading ${selectedFile.name} (${(selectedFile.size / 1024).toFixed(0)} KB)`);

      const uploadRes = await fetch(`${base}/api/v1/audio/transcription-jobs`, {
        method: 'POST',
        headers,
        body: formData,
        signal: abortRef.current.signal,
      });

      let jid: string;
      if (uploadRes.ok) {
        const data = await uploadRes.json();
        jid = data.jobId || data.job_id || data.id;
        addEvent('upload-complete', `Job created: ${jid}`);
      } else {
        jid = `demo-job-${Date.now()}`;
        addEvent('upload-fallback', `API unavailable — using demo job ID: ${jid}`);
        toast.info('Upload API unavailable — switching to SSE demo mode');
      }
      setJobId(jid);

      updatePhase('transcribing');
      setProgress(10);

      const sseUrl = `${base}/api/v1/audio/transcription-jobs/${jid}/stream`;
      addEvent('sse-connect', `Connecting to SSE: ${sseUrl}`);

      const sseRes = await fetch(sseUrl, {
        headers: { ...getHeaders(), Accept: 'text/event-stream' },
        signal: abortRef.current.signal,
      });

      if (!sseRes.ok || !sseRes.body) {
        addEvent('sse-error', `SSE stream failed: ${sseRes.status}`);
        simulateSseTranscription();
        return;
      }

      addEvent('sse-open', 'SSE connection established (authenticated fetch)');

      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let transcriptionComplete = false;

      while (!transcriptionComplete) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('event: ') && !line.startsWith('data: ') && line.trim() !== '') continue;

          if (line.startsWith('event: ')) continue;

          if (line.startsWith('data: ')) {
            const raw = line.slice(6).trim();
            if (raw === '[DONE]' || raw === '') continue;

            try {
              const parsed = JSON.parse(raw);
              const eventType = parsed.event || parsed.type || 'data';

              if (eventType === 'status' || parsed.status) {
                addEvent('status', raw);
                if (parsed.progress) setProgress(parsed.progress);
              } else if (eventType === 'progress' || parsed.percent !== undefined) {
                addEvent('progress', raw);
                if (parsed.percent) setProgress(parsed.percent);
                if (parsed.text) setTranscriptText((prev) => prev + parsed.text);
              } else if (eventType === 'result' || parsed.transcript || parsed.content) {
                addEvent('result', raw);
                const fullText = parsed.transcript || parsed.text || parsed.content || '';
                setTranscriptText(fullText);
                setProgress(100);
                transcriptionComplete = true;

                if (autoSummarize && fullText) {
                  reader.releaseLock();
                  startStreamingSummary(fullText);
                  return;
                } else {
                  updatePhase('done');
                  toast.success('Transcription complete');
                }
              } else {
                addEvent('data', raw);
              }
            } catch {
              addEvent('raw', raw);
            }
          }
        }
      }

      reader.releaseLock();
      if (!transcriptionComplete) {
        updatePhase('done');
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      addEvent('sse-error', `${err instanceof Error ? err.message : 'Unknown error'}`);
      if (phaseRef.current === 'transcribing') {
        simulateSseTranscription();
      } else {
        updatePhase('error');
        toast.error(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }
  }, [selectedFile, apiBaseUrl, autoSummarize, addEvent, updatePhase]);

  const simulateSseTranscription = useCallback(() => {
    const demoText =
      'Patient presents with moderate ankle edema secondary to amlodipine therapy. Blood pressure improved to 132/82. Plan to switch to lisinopril 10mg daily with BMP monitoring. Follow-up in four weeks.';
    const words = demoText.split(' ');
    let idx = 0;

    const interval = setInterval(() => {
      if (idx >= words.length) {
        clearInterval(interval);
        setProgress(100);
        const fullText = words.join(' ');
        setTranscriptText(fullText);
        addEvent('result', JSON.stringify({ transcript: fullText }));

        if (autoSummarize) {
          startStreamingSummary(fullText);
        } else {
          updatePhase('done');
          toast.success('Demo transcription complete');
        }
        return;
      }

      const chunk = words.slice(idx, idx + 3).join(' ') + ' ';
      setTranscriptText((prev) => prev + chunk);
      setProgress(Math.round(((idx + 3) / words.length) * 90) + 10);
      addEvent('progress', JSON.stringify({ text: chunk, percent: Math.round(((idx + 3) / words.length) * 100) }));
      idx += 3;
    }, 200);
  }, [autoSummarize, addEvent, updatePhase]);

  const startStreamingSummary = useCallback(
    async (transcript: string) => {
      updatePhase('summarizing');
      setSummaryText('');
      setStreamChunks([]);
      setProgress(0);

      const base = apiBaseUrl.replace(/\/$/, '');
      const headers = { ...getHeaders(), 'Content-Type': 'application/json' };

      const body = {
        prompt: `Generate a clinical summary from the following transcript:\n\n${transcript}`,
        system_prompt: 'You are a medical documentation assistant. Generate a concise clinical summary.',
        provider,
        stream: true,
        temperature: 0.4,
        max_tokens: 2048,
      };

      try {
        addEvent('smr-request', `POST ${base}/text/generate (stream=true) via API Gateway`);

        abortRef.current = new AbortController();
        const generateRes = await fetch(`${base}/text/generate`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: abortRef.current.signal,
        });

        if (!generateRes.ok) {
          const errBody = await generateRes.text();
          addEvent('smr-error', `HTTP ${generateRes.status}: ${errBody}`);
          simulateStreamingSummary(transcript);
          return;
        }

        const taskInfo = await generateRes.json();
        addEvent('smr-task', `Task created: ${taskInfo.task_id}, stream_url: ${taskInfo.stream_url}`);

        if (!taskInfo.stream_url) {
          addEvent('smr-sync', JSON.stringify(taskInfo));
          setSummaryText(taskInfo.content || '');
          if (taskInfo.usage) setTotalTokens(taskInfo.usage.total_tokens || 0);
          updatePhase('done');
          toast.success('Summary generated (sync response)');
          return;
        }

        const streamUrl = `${base}/text/tasks/${taskInfo.task_id}/stream`;
        addEvent('sse-connect', `Connecting to SSE stream: ${streamUrl}`);

        const sseRes = await fetch(streamUrl, {
          headers: { ...getHeaders(), Accept: 'text/event-stream' },
          signal: abortRef.current.signal,
        });

        if (!sseRes.ok || !sseRes.body) {
          addEvent('smr-error', `SSE stream failed: ${sseRes.status}`);
          simulateStreamingSummary(transcript);
          return;
        }

        addEvent('sse-stream', 'SMR SSE stream opened via API Gateway');
        const reader = sseRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let chunkIdx = 0;
        let accumulated = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') {
                addEvent('sse-done', '[DONE]');
                continue;
              }
              try {
                const parsed = JSON.parse(data);
                const text = parsed.content || parsed.text || parsed.delta?.content || '';
                if (text) {
                  accumulated += text;
                  setSummaryText(accumulated);
                  setStreamChunks((prev) => [...prev, { text, index: chunkIdx++ }]);
                  addEvent('chunk', data);
                }
                if (parsed.usage) {
                  setTotalTokens(parsed.usage.total_tokens || 0);
                }
              } catch {
                addEvent('chunk-raw', data);
              }
            }
          }
        }

        reader.releaseLock();
        updatePhase('done');
        toast.success('Summary generated via SSE streaming (API Gateway)');
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        addEvent('smr-error', `${err instanceof Error ? err.message : 'Unknown error'}`);
        simulateStreamingSummary(transcript);
      }
    },
    [apiBaseUrl, provider, addEvent, updatePhase],
  );

  const simulateStreamingSummary = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (transcript: string) => {
      addEvent('smr-demo', 'SMR unavailable — demonstrating SSE streaming with simulated data');
      const demoSummary = `Clinical Summary

Patient: Mrs. Johnson
Visit Type: Follow-up — Hypertension Management

Subjective: Patient reports moderate bilateral ankle edema since starting amlodipine 5mg. Shoes feel tight by end of day. No chest pain, dyspnea, or other complaints.

Objective: BP 132/82 mmHg (improved from prior). Bilateral pedal edema noted.

Assessment:
1. Essential hypertension — improved on current regimen
2. Peripheral edema — likely amlodipine-related adverse effect

Plan:
1. Discontinue amlodipine 5mg
2. Start lisinopril 10mg once daily
3. Order BMP to establish renal baseline before ACE inhibitor initiation
4. Follow-up in 4 weeks for BP recheck and medication tolerance
5. Patient counseled on potential ACE inhibitor side effects (dry cough); if intolerable, will switch to ARB`;

      const words = demoSummary.split(' ');
      let idx = 0;
      let chunkIdx = 0;
      let accumulated = '';

      const interval = setInterval(() => {
        if (idx >= words.length) {
          clearInterval(interval);
          updatePhase('done');
          setTotalTokens(Math.round(words.length * 1.3));
          toast.success('Demo summary streaming complete');
          return;
        }

        const chunk = words.slice(idx, idx + 2).join(' ') + ' ';
        accumulated += chunk;
        setSummaryText(accumulated);
        setStreamChunks((prev) => [...prev, { text: chunk, index: chunkIdx++ }]);
        setProgress(Math.round((idx / words.length) * 100));
        addEvent('chunk', JSON.stringify({ content: chunk, index: chunkIdx }));
        idx += 2;
      }, 80);
    },
    [addEvent, updatePhase],
  );

  const handleManualSummarize = useCallback(() => {
    const text = transcriptText || SAMPLE_TRANSCRIPT_FOR_SUMMARY;
    if (!transcriptText) {
      setTranscriptText(SAMPLE_TRANSCRIPT_FOR_SUMMARY);
      toast.info('Using sample transcript for summary generation');
    }
    startStreamingSummary(text);
  }, [transcriptText, startStreamingSummary]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    updatePhase('idle');
    toast.info('Operation cancelled');
  }, [updatePhase]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const phaseLabel = {
    idle: 'Ready',
    uploading: 'Uploading…',
    transcribing: 'Transcribing (SSE)…',
    summarizing: 'Generating Summary (SSE)…',
    done: 'Complete',
    error: 'Error',
  }[phase];

  const phaseBadge = {
    idle: 'secondary' as const,
    uploading: 'outline' as const,
    transcribing: 'outline' as const,
    summarizing: 'outline' as const,
    done: 'default' as const,
    error: 'destructive' as const,
  }[phase];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowDown className="size-5 text-blue-500" />
            <CardTitle>SSE — File Upload, Transcription & Streaming Summary</CardTitle>
          </div>
          <Badge variant={phaseBadge} className="gap-1.5">
            {phase === 'transcribing' || phase === 'summarizing' || phase === 'uploading' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : phase === 'done' ? (
              <CheckCircle2 className="size-3.5" />
            ) : phase === 'error' ? (
              <AlertCircle className="size-3.5" />
            ) : (
              <Radio className="size-3.5" />
            )}
            {phaseLabel}
          </Badge>
        </div>
        <CardDescription>
          Unidirectional SSE: upload audio file → receive transcription progress via SSE → stream summary tokens via SSE. Two SSE streams via API
          Gateway: <code className="text-[10px]">/transcription-jobs/:id/stream</code> and <code className="text-[10px]">/text/tasks/:id/stream</code>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-3">
            <div className="space-y-2">
              <Label className="text-xs">Audio File Upload</Label>
              <div className="flex gap-2">
                <Input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm,.flac"
                  onChange={handleFileSelect}
                  className="text-xs"
                />
              </div>
              {selectedFile && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <FileAudio className="size-3.5" />
                  {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(1)} MB)
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Summary Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ollama">Ollama (Local)</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label className="text-xs">Auto-summarize after transcription</Label>
                <p className="text-muted-foreground text-[10px]">Chain SSE streams: transcribe → summarize</p>
              </div>
              <Switch checked={autoSummarize} onCheckedChange={setAutoSummarize} />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={handleUploadAndTranscribe}
                size="sm"
                className="gap-1.5"
                disabled={!selectedFile || (phase !== 'idle' && phase !== 'done' && phase !== 'error')}
              >
                <Upload className="size-3.5" />
                Upload & Transcribe
              </Button>
              <Button
                onClick={handleManualSummarize}
                size="sm"
                variant="secondary"
                className="gap-1.5"
                disabled={phase === 'uploading' || phase === 'transcribing' || phase === 'summarizing'}
              >
                <Sparkles className="size-3.5" />
                Summarize {transcriptText ? 'Transcript' : '(Sample)'}
              </Button>
              {(phase === 'uploading' || phase === 'transcribing' || phase === 'summarizing') && (
                <Button onClick={handleCancel} size="sm" variant="destructive" className="gap-1.5">
                  Cancel
                </Button>
              )}
            </div>

            {phase !== 'idle' && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{phaseLabel}</span>
                  <span className="tabular-nums">{progress}%</span>
                </div>
                <Progress value={progress} className="h-1.5" />
              </div>
            )}

            <div className="bg-muted/30 grid grid-cols-3 gap-3 rounded-lg border p-3 text-center">
              <div>
                <p className="text-muted-foreground text-[10px]">SSE Events</p>
                <p className="text-sm font-medium tabular-nums">{sseEvents.length}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-[10px]">Stream Chunks</p>
                <p className="text-sm font-medium tabular-nums">{streamChunks.length}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-[10px]">Tokens</p>
                <p className="text-sm font-medium tabular-nums">{totalTokens.toLocaleString()}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label className="text-xs">Transcript (SSE Stream 1)</Label>
              {transcriptText && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 gap-1 text-[10px]"
                  onClick={() => {
                    navigator.clipboard.writeText(transcriptText);
                    toast.success('Copied');
                  }}
                >
                  <Copy className="size-2.5" /> Copy
                </Button>
              )}
            </div>
            <ScrollArea className="bg-muted/20 h-48 rounded-lg border p-3">
              {!transcriptText ? (
                <p className="text-muted-foreground text-xs italic">Upload an audio file to see SSE-streamed transcription…</p>
              ) : (
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {transcriptText}
                  {phase === 'transcribing' && <span className="animate-pulse">▊</span>}
                </p>
              )}
            </ScrollArea>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label className="text-xs">Summary (SSE Stream 2)</Label>
              {summaryText && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 gap-1 text-[10px]"
                  onClick={() => {
                    navigator.clipboard.writeText(summaryText);
                    toast.success('Copied');
                  }}
                >
                  <Copy className="size-2.5" /> Copy
                </Button>
              )}
            </div>
            <ScrollArea className="bg-muted/20 h-48 rounded-lg border p-3">
              {!summaryText ? (
                <p className="text-muted-foreground text-xs italic">Summary will stream here after transcription completes…</p>
              ) : (
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {summaryText}
                  {phase === 'summarizing' && <span className="animate-pulse">▊</span>}
                </p>
              )}
            </ScrollArea>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label className="text-xs">SSE Event Log</Label>
            <Switch checked={showEvents} onCheckedChange={setShowEvents} />
          </div>
          {showEvents && (
            <ScrollArea className="bg-muted/20 h-36 rounded-lg border p-2">
              {sseEvents.length === 0 ? (
                <p className="text-muted-foreground p-1 text-xs italic">No events yet…</p>
              ) : (
                <div className="space-y-0.5">
                  {sseEvents.map((ev, i) => (
                    <div key={i} className="flex items-start gap-1.5 rounded px-1.5 py-0.5 text-[10px] font-mono bg-blue-500/5">
                      <Badge variant="outline" className="h-4 shrink-0 text-[8px] px-1">
                        {ev.eventType}
                      </Badge>
                      {ev.id && <span className="text-muted-foreground shrink-0">id:{ev.id}</span>}
                      <span className="break-all">{ev.data}</span>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          )}
          {!showEvents && (
            <div className="bg-muted/20 flex h-12 items-center justify-center rounded-lg border">
              <p className="text-muted-foreground text-xs">Toggle to view raw SSE event log</p>
            </div>
          )}
        </div>

        <div className="bg-muted/30 rounded-lg border p-3">
          <p className="text-xs font-medium mb-1">SSE Protocol Flow</p>
          <div className="grid gap-2 sm:grid-cols-3 text-[10px] text-muted-foreground">
            <div>
              <p className="font-medium text-foreground">1. File Upload</p>
              <p>
                <code>POST /audio/transcription-jobs</code>
              </p>
              <p>
                Returns <code>jobId</code> for tracking
              </p>
            </div>
            <div>
              <p className="font-medium text-foreground">2. Transcription SSE</p>
              <p>
                <code>GET /transcription-jobs/:id/stream</code>
              </p>
              <p>
                Events: <code>status</code>, <code>progress</code>, <code>result</code>
              </p>
            </div>
            <div>
              <p className="font-medium text-foreground">3. Summary SSE</p>
              <p>
                <code>POST /text/generate</code> → <code>GET /text/tasks/:id/stream</code>
              </p>
              <p>
                Events: <code>data: {'{content}'}</code>, <code>done</code>
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
