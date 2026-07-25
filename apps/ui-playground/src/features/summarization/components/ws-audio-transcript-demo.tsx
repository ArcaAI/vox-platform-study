import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Button } from '@arcaai/ui/button';
import { Badge } from '@arcaai/ui/badge';
import { Label } from '@arcaai/ui/label';
import { Input } from '@arcaai/ui/input';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { Switch } from '@arcaai/ui/switch';
import { toast } from 'sonner';
import { useState, useRef, useCallback, useEffect } from 'react';
import { Activity, ArrowDownUp, CheckCircle2, Mic, MicOff, Radio, Send, Wifi, WifiOff, XCircle } from 'lucide-react';
import { usePlaygroundStore } from '@/store/playground-store';
import { useAuthStore } from '@/store/auth-store';

type WsState = 'disconnected' | 'connecting' | 'connected' | 'error';

interface TranscriptSegment {
  id: number;
  text: string;
  isFinal: boolean;
  startTime?: number;
  endTime?: number;
  timestamp: string;
}

interface WsMessage {
  direction: 'sent' | 'received';
  type: string;
  data: string;
  timestamp: string;
}

export function WsAudioTranscriptDemo() {
  const [wsState, setWsState] = useState<WsState>('disconnected');
  const [wsUrl, setWsUrl] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptSegment[]>([]);
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [showProtocol, setShowProtocol] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [bytesSent, setBytesSent] = useState(0);
  const [frameCount, setFrameCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const seqRef = useRef(0);
  const transcriptIdRef = useRef(0);

  const apiBaseUrl = usePlaygroundStore((s) => s.apiBaseUrl);
  const { accessToken, apiKey, authMethod, tenantId, isImpersonating, impersonationToken } = useAuthStore();

  useEffect(() => {
    const base = apiBaseUrl.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
    const wsBase = base.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    setWsUrl(`${wsBase}/ws/stt/stream`);
  }, [apiBaseUrl]);

  const addMessage = useCallback((direction: 'sent' | 'received', type: string, data: string) => {
    setMessages((prev) => {
      const next = [
        ...prev,
        {
          direction,
          type,
          data: data.length > 200 ? data.slice(0, 200) + '…' : data,
          timestamp: new Date().toISOString(),
        },
      ];
      return next.slice(-50);
    });
  }, []);

  const handleConnect = useCallback(async () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setWsState('connecting');
    setTranscripts([]);
    setMessages([]);
    setBytesSent(0);
    setFrameCount(0);
    seqRef.current = 0;

    try {
      const base = apiBaseUrl.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const effectiveToken = isImpersonating && impersonationToken ? impersonationToken : accessToken;
      if (authMethod === 'credentials' && effectiveToken) headers['Authorization'] = `Bearer ${effectiveToken}`;
      else if (authMethod === 'apiKey' && apiKey) headers['X-API-Key'] = apiKey;
      if (tenantId) headers['X-Tenant-Id'] = tenantId;

      const sessionRes = await fetch(`${base}/api/v1/audio/transcription-jobs/stream/session`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ pipelineId: 'default', language: 'en-US', sampleRate: 16000 }),
      });

      let sid = '';
      if (sessionRes.ok) {
        const sessionData = await sessionRes.json();
        sid = sessionData.sessionId || sessionData.session_id || `demo-${Date.now()}`;
      } else {
        sid = `demo-${Date.now()}`;
        toast.info('Session API unavailable — using demo session ID');
      }
      setSessionId(sid);

      const fullUrl = `${wsUrl}?sessionId=${sid}`;
      addMessage('sent', 'connect', fullUrl);

      const ws = new WebSocket(fullUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsState('connected');
        addMessage('received', 'open', 'WebSocket connection established');

        const effectiveToken = isImpersonating && impersonationToken ? impersonationToken : accessToken;
        if (authMethod === 'credentials' && effectiveToken) {
          const authMsg = JSON.stringify({ type: 'auth', token: effectiveToken });
          ws.send(authMsg);
          addMessage('sent', 'auth', '{ type: "auth", token: "***" }');
        }

        toast.success('WebSocket connected');
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          addMessage('received', msg.type || 'message', event.data);

          if (msg.type === 'transcript') {
            const segment: TranscriptSegment = {
              id: transcriptIdRef.current++,
              text: msg.text,
              isFinal: msg.isFinal ?? false,
              startTime: msg.startTime,
              endTime: msg.endTime,
              timestamp: new Date().toISOString(),
            };

            setTranscripts((prev) => {
              if (!segment.isFinal) {
                const withoutInterim = prev.filter((t) => t.isFinal);
                return [...withoutInterim, segment];
              }
              return [...prev.filter((t) => t.isFinal), segment];
            });
          } else if (msg.type === 'status') {
            toast.info(`STT Status: ${msg.message || msg.status}`);
          } else if (msg.type === 'error') {
            toast.error(`STT Error: ${msg.message}`);
          }
        } catch {
          addMessage('received', 'raw', event.data);
        }
      };

      ws.onerror = () => {
        setWsState('error');
        addMessage('received', 'error', 'WebSocket error occurred');
      };

      ws.onclose = (event) => {
        setWsState('disconnected');
        setIsRecording(false);
        addMessage('received', 'close', `Code: ${event.code}, Reason: ${event.reason || 'none'}`);
        if (event.code !== 1000) {
          toast.error(`WebSocket closed: ${event.reason || `code ${event.code}`}`);
        }
      };
    } catch (err) {
      setWsState('error');
      toast.error(`Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [wsUrl, apiBaseUrl, authMethod, accessToken, apiKey, tenantId, isImpersonating, impersonationToken, addMessage]);

  const handleDisconnect = useCallback(() => {
    if (isRecording) {
      stopRecording();
    }
    if (wsRef.current) {
      const closeMsg = JSON.stringify({ type: 'close' });
      wsRef.current.send(closeMsg);
      addMessage('sent', 'close', closeMsg);
      wsRef.current.close(1000, 'User disconnected');
      wsRef.current = null;
    }
    setWsState('disconnected');
  }, [isRecording, addMessage]);

  const startRecording = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      toast.error('WebSocket not connected');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      mediaStreamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      source.connect(analyser);

      const workletCode = `
        class PcmCaptureProcessor extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0];
            if (input.length > 0 && input[0].length > 0) {
              const float32 = input[0];
              const int16 = new Int16Array(float32.length);
              for (let i = 0; i < float32.length; i++) {
                const s = Math.max(-1, Math.min(1, float32[i]));
                int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
              }
              this.port.postMessage(int16.buffer, [int16.buffer]);
            }
            return true;
          }
        }
        registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
      `;
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);

      await audioContext.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const workletNode = new AudioWorkletNode(audioContext, 'pcm-capture-processor');
      workletNodeRef.current = workletNode;

      workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const pcmBuffer = e.data;
        wsRef.current.send(pcmBuffer);

        const seq = seqRef.current++;
        setBytesSent((prev) => prev + pcmBuffer.byteLength);
        setFrameCount((prev) => prev + 1);

        if (seq % 50 === 0) {
          addMessage('sent', 'audio', `seq=${seq}, ${pcmBuffer.byteLength} bytes (binary PCM)`);
        }
      };

      source.connect(workletNode);
      workletNode.connect(audioContext.destination);

      const updateLevel = () => {
        if (!analyserRef.current) return;
        const data = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setAudioLevel(avg / 255);
        animFrameRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();

      setIsRecording(true);
      toast.success('Recording started — binary PCM streaming via WebSocket');
    } catch (err) {
      toast.error(`Microphone access failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [addMessage]);

  const stopRecording = useCallback(() => {
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    cancelAnimationFrame(animFrameRef.current);
    setAudioLevel(0);
    setIsRecording(false);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const stopMsg = JSON.stringify({ type: 'stop' });
      wsRef.current.send(stopMsg);
      addMessage('sent', 'stop', stopMsg);
    }
  }, [addMessage]);

  useEffect(() => {
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (workletNodeRef.current) workletNodeRef.current.disconnect();
      if (audioContextRef.current) audioContextRef.current.close();
      if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  const wsStateIcon = {
    disconnected: <WifiOff className="size-4" />,
    connecting: <Activity className="size-4 animate-pulse" />,
    connected: <Wifi className="size-4" />,
    error: <XCircle className="size-4" />,
  }[wsState];

  const wsStateBadge = {
    disconnected: 'secondary' as const,
    connecting: 'outline' as const,
    connected: 'default' as const,
    error: 'destructive' as const,
  }[wsState];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowDownUp className="size-5 text-green-500" />
            <CardTitle>WebSocket — Audio Streaming & Live Transcription</CardTitle>
          </div>
          <Badge variant={wsStateBadge} className="gap-1.5">
            {wsStateIcon}
            {wsState}
          </Badge>
        </div>
        <CardDescription>
          Bidirectional WebSocket: streams binary PCM audio frames to STT service, receives real-time transcript segments. Protocol:{' '}
          <code className="text-[10px]">SttWebSocketClient</code> — binary Int16 LE mono (AudioWorklet).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-3">
            <div className="space-y-2">
              <Label className="text-xs">WebSocket URL</Label>
              <Input
                value={wsUrl}
                onChange={(e) => setWsUrl(e.target.value)}
                className="font-mono text-xs"
                placeholder="ws://localhost:8868/ws/stt/stream"
              />
            </div>
            {sessionId && (
              <div className="flex items-center gap-2">
                <Label className="text-xs">Session ID:</Label>
                <code className="bg-muted rounded px-2 py-0.5 font-mono text-[10px]">{sessionId}</code>
              </div>
            )}
            <div className="flex gap-2">
              {wsState === 'disconnected' || wsState === 'error' ? (
                <Button onClick={handleConnect} size="sm" className="gap-1.5">
                  <Wifi className="size-3.5" />
                  Connect
                </Button>
              ) : (
                <Button onClick={handleDisconnect} variant="destructive" size="sm" className="gap-1.5">
                  <WifiOff className="size-3.5" />
                  Disconnect
                </Button>
              )}
              {wsState === 'connected' &&
                (isRecording ? (
                  <Button onClick={stopRecording} variant="secondary" size="sm" className="gap-1.5">
                    <MicOff className="size-3.5" />
                    Stop Recording
                  </Button>
                ) : (
                  <Button onClick={startRecording} size="sm" className="gap-1.5">
                    <Mic className="size-3.5" />
                    Start Recording
                  </Button>
                ))}
            </div>
          </div>

          <div className="space-y-3">
            {isRecording && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Radio className="size-3.5 text-red-500 animate-pulse" />
                  <span className="text-xs font-medium text-red-500">Recording</span>
                </div>
                <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
                  <div
                    className="bg-green-500 h-full rounded-full transition-all duration-75"
                    style={{ width: `${Math.min(audioLevel * 100, 100)}%` }}
                  />
                </div>
              </div>
            )}
            <div className="bg-muted/30 grid grid-cols-3 gap-3 rounded-lg border p-3 text-center">
              <div>
                <p className="text-muted-foreground text-[10px]">Frames Sent</p>
                <p className="text-sm font-medium tabular-nums">{frameCount.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-[10px]">Bytes Sent</p>
                <p className="text-sm font-medium tabular-nums">{(bytesSent / 1024).toFixed(1)} KB</p>
              </div>
              <div>
                <p className="text-muted-foreground text-[10px]">Transcripts</p>
                <p className="text-sm font-medium tabular-nums">{transcripts.filter((t) => t.isFinal).length}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label className="text-xs">Live Transcript</Label>
              {transcripts.length > 0 && (
                <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => setTranscripts([])}>
                  Clear
                </Button>
              )}
            </div>
            <ScrollArea className="bg-muted/20 h-48 rounded-lg border p-3">
              {transcripts.length === 0 ? (
                <p className="text-muted-foreground text-xs italic">
                  {wsState === 'connected' ? 'Start recording to see live transcripts…' : 'Connect and record to see transcripts…'}
                </p>
              ) : (
                <div className="space-y-1">
                  {transcripts.map((t) => (
                    <p key={t.id} className={`text-sm ${t.isFinal ? 'font-medium' : 'text-muted-foreground italic'}`}>
                      {t.isFinal && <CheckCircle2 className="mr-1 inline size-3 text-green-500" />}
                      {t.text}
                    </p>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label className="text-xs">Protocol Messages</Label>
              <Switch checked={showProtocol} onCheckedChange={setShowProtocol} />
            </div>
            {showProtocol && (
              <ScrollArea className="bg-muted/20 h-48 rounded-lg border p-2">
                {messages.length === 0 ? (
                  <p className="text-muted-foreground p-1 text-xs italic">No messages yet…</p>
                ) : (
                  <div className="space-y-0.5">
                    {messages.map((m, i) => (
                      <div
                        key={i}
                        className={`flex items-start gap-1.5 rounded px-1.5 py-0.5 text-[10px] font-mono ${m.direction === 'sent' ? 'bg-blue-500/10' : 'bg-green-500/10'}`}
                      >
                        <Send className={`mt-0.5 size-2.5 shrink-0 ${m.direction === 'sent' ? 'text-blue-500' : 'text-green-500 rotate-180'}`} />
                        <span className="text-muted-foreground">[{m.type}]</span>
                        <span className="break-all">{m.data}</span>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            )}
            {!showProtocol && (
              <div className="bg-muted/20 flex h-48 items-center justify-center rounded-lg border">
                <p className="text-muted-foreground text-xs">Toggle to view raw WebSocket protocol messages</p>
              </div>
            )}
          </div>
        </div>

        <div className="bg-muted/30 rounded-lg border p-3">
          <p className="text-xs font-medium mb-1">WebSocket Protocol (Stt)</p>
          <div className="grid gap-2 sm:grid-cols-2 text-[10px] text-muted-foreground">
            <div>
              <p className="font-medium text-foreground">Client → Server:</p>
              <ul className="mt-0.5 space-y-0.5">
                <li>
                  <code>Binary ArrayBuffer</code> — PCM Int16 LE mono frames
                </li>
                <li>
                  <code>{'{ type: "stop" }'}</code> — finalize transcription
                </li>
                <li>
                  <code>{'{ type: "close" }'}</code> — close session
                </li>
              </ul>
            </div>
            <div>
              <p className="font-medium text-foreground">Server → Client:</p>
              <ul className="mt-0.5 space-y-0.5">
                <li>
                  <code>{'{ type: "transcript", text, isFinal }'}</code> — transcript segment
                </li>
                <li>
                  <code>{'{ type: "status", status, message }'}</code> — status update
                </li>
                <li>
                  <code>{'{ type: "error", code, message }'}</code> — error
                </li>
              </ul>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
