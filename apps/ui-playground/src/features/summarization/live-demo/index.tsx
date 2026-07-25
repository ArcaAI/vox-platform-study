import { Main } from '@/components/layout/main';
import { Badge } from '@arcaai/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { ArrowDownUp, ArrowDown, Info } from 'lucide-react';
import { WsAudioTranscriptDemo, SseTranscriptSummaryDemo } from '../components';

export default function LiveDemoPage() {
  return (
    <Main>
      <div className="mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Live Streaming Demo</h1>
            <p className="text-muted-foreground mt-1">
              Demonstrates WebSocket (bidirectional) and SSE (server-sent events) transport protocols for real-time audio streaming, transcription,
              and summary generation.
            </p>
          </div>
          <div className="flex gap-2">
            <Badge variant="outline" className="gap-1.5">
              <ArrowDownUp className="size-3" />
              WebSocket
            </Badge>
            <Badge variant="outline" className="gap-1.5">
              <ArrowDown className="size-3" />
              SSE
            </Badge>
          </div>
        </div>
      </div>

      <Card className="mb-6">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Info className="size-4 text-blue-500" />
            <CardTitle className="text-sm">Transport Protocol Comparison</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-2 mb-2">
                <ArrowDownUp className="size-4 text-green-500" />
                <span className="text-sm font-medium">WebSocket — Bidirectional</span>
              </div>
              <ul className="text-muted-foreground space-y-1 text-xs">
                <li>Full-duplex: client and server send simultaneously</li>
                <li>Used for: real-time audio streaming + live transcription</li>
                <li>Client sends PCM audio frames (Int16 LE, base64 JSON)</li>
                <li>Server sends transcript segments (interim + final)</li>
                <li>Persistent connection with session management</li>
                <li>
                  Protocol: <code className="text-[10px]">SttWebSocketClient</code>
                </li>
              </ul>
            </div>
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-2 mb-2">
                <ArrowDown className="size-4 text-blue-500" />
                <span className="text-sm font-medium">SSE — Server-Sent Events</span>
              </div>
              <ul className="text-muted-foreground space-y-1 text-xs">
                <li>Unidirectional: server pushes events to client</li>
                <li>Used for: file upload transcription + summary streaming</li>
                <li>Client uploads file via POST, then subscribes to event stream</li>
                <li>Server sends progress, status, and result events</li>
                <li>
                  Auto-reconnect with <code className="text-[10px]">Last-Event-ID</code>
                </li>
                <li>Two streams: transcription job + SMR generation</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-6">
        <WsAudioTranscriptDemo />
        <SseTranscriptSummaryDemo />
      </div>
    </Main>
  );
}
