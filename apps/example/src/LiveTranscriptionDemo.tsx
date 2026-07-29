import React, { useCallback, useEffect, useRef, useState } from 'react';

type TranscriptMessage = {
  type: string;
  final?: boolean;
  text?: string;
  timestamp?: number;
  [key: string]: any;
};

type LiveTranscriptionDemoProps = {
  apiBaseUrl: string;
  pipelineId?: string;
  authToken?: string;
  tenantId?: string;
};

type StreamSessionResponse = {
  sessionId: string;
  status: string;
  wsUrl: string;
  maxConcurrent?: number;
  currentActive?: number;
};

export const LiveTranscriptionDemo: React.FC<LiveTranscriptionDemoProps> = ({ apiBaseUrl, pipelineId, authToken, tenantId }) => {
  const [status, setStatus] = useState<string>('Idle');
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [transcript, setTranscript] = useState<string>('');

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const isStoppingRef = useRef<boolean>(false);

  const buildWebSocketUrl = useCallback((baseUrl: string, wsPath: string, sessionId: string) => {
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const normalizedWsPath = wsPath.startsWith('/') ? wsPath : `/${wsPath}`;
    const wsBaseUrl = normalizedBaseUrl.replace(/^http/, 'ws');

    return `${wsBaseUrl}${normalizedWsPath}?sessionId=${encodeURIComponent(sessionId)}`;
  }, []);

  const appendTranscript = useCallback((line: string) => {
    setTranscript((prev) => prev + line + '\n');
  }, []);

  const downsampleBuffer = useCallback((buffer: Float32Array, inputSampleRate: number, outputSampleRate: number) => {
    if (outputSampleRate >= inputSampleRate) {
      return buffer;
    }

    const sampleRateRatio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0;
      let count = 0;

      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
        accum += buffer[i];
        count += 1;
      }

      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult += 1;
      offsetBuffer = nextOffsetBuffer;
    }

    return result;
  }, []);

  const convertFloat32ToInt16 = useCallback((buffer: Float32Array) => {
    const result = new Int16Array(buffer.length);

    for (let i = 0; i < buffer.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, buffer[i] ?? 0));
      result[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    return result;
  }, []);

  const buildRequestHeaders = useCallback(() => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    if (tenantId) {
      headers['X-Tenant-ID'] = tenantId;
    }

    return headers;
  }, [authToken, tenantId]);

  const deleteStreamSession = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      return;
    }

    try {
      await fetch(`${apiBaseUrl}/api/v1/audio/transcription-jobs/stream/session/${sessionId}`, {
        method: 'DELETE',
        headers: buildRequestHeaders(),
      });
    } catch (err) {
      console.error('Failed to delete streaming session', err);
    } finally {
      sessionIdRef.current = null;
    }
  }, [apiBaseUrl, buildRequestHeaders]);

  const teardownAudio = useCallback(() => {
    if (processorNodeRef.current) {
      processorNodeRef.current.onaudioprocess = null;
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
    }

    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  const stopAll = useCallback(async () => {
    if (isStoppingRef.current) {
      return;
    }
    isStoppingRef.current = true;

    try {
      teardownAudio();

      const ws = wsRef.current;
      wsRef.current = null;

      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'stop' }));
          ws.send(JSON.stringify({ type: 'close' }));
        } catch (err) {
          console.error('Failed to send websocket shutdown message', err);
        }

        ws.close();
      }

      await deleteStreamSession();
      setStatus('Stopped');
    } finally {
      setIsRunning(false);
      isStoppingRef.current = false;
    }
  }, [deleteStreamSession, teardownAudio]);

  const start = useCallback(async () => {
    setStatus('Creating streaming session...');
    setTranscript('');
    setIsRunning(true);

    try {
      if (!pipelineId) {
        throw new Error('Missing pipelineId');
      }

      if (!authToken) {
        throw new Error('Missing authToken');
      }

      if (!tenantId) {
        throw new Error('Missing tenantId');
      }

      const res = await fetch(`${apiBaseUrl}/api/v1/audio/transcription-jobs/stream/session`, {
        method: 'POST',
        headers: buildRequestHeaders(),
        body: JSON.stringify({
          pipelineId,
          sampleRate: 16000,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Session request failed: ${res.status} ${errorText}`);
      }
      const session: StreamSessionResponse = await res.json();
      console.log('Streaming session response', session);
      sessionIdRef.current = session.sessionId;

      const wsUrl = buildWebSocketUrl(apiBaseUrl, session.wsUrl, session.sessionId);

      setStatus(`Connecting WebSocket for session ${session.sessionId}...`);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.binaryType = 'arraybuffer';

      ws.onopen = async () => {
        setStatus('WebSocket connected. Requesting microphone access...');

        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              sampleRate: 16000,
            },
            video: false,
          });
          mediaStreamRef.current = stream;

          const audioContext = new AudioContext();
          audioContextRef.current = audioContext;

          const sourceNode = audioContext.createMediaStreamSource(stream);
          sourceNodeRef.current = sourceNode;

          const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
          processorNodeRef.current = processorNode;

          processorNode.onaudioprocess = (event) => {
            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
              return;
            }

            const inputData = event.inputBuffer.getChannelData(0);
            const downsampled = downsampleBuffer(inputData, audioContext.sampleRate, 16000);
            const pcm16 = convertFloat32ToInt16(downsampled);
            wsRef.current.send(pcm16.buffer);
          };

          sourceNode.connect(processorNode);
          processorNode.connect(audioContext.destination);

          setStatus('Streaming microphone audio...');
        } catch (err: any) {
          console.error('getUserMedia failed', err);
          setStatus('Microphone permission denied or unavailable');
          stopAll();
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg: TranscriptMessage = JSON.parse(event.data);
          if (msg.type === 'transcript') {
            const prefix = msg.isFinal || msg.final ? '[FINAL] ' : '[PARTIAL] ';
            appendTranscript(prefix + (msg.text ?? ''));
          } else if (msg.type === 'error') {
            appendTranscript(`[ERROR] ${msg.message ?? 'Unknown stream error'}`);
          } else if (msg.type === 'status') {
            appendTranscript(`[STATUS] ${msg.status ?? 'unknown'} ${msg.message ?? ''}`.trim());
          } else {
            appendTranscript('[INFO] ' + event.data);
          }
        } catch (e) {
          appendTranscript('[RAW] ' + event.data);
        }
      };

      ws.onerror = (err) => {
        console.error('WebSocket error', err);
        setStatus('WebSocket error');
      };

      ws.onclose = () => {
        teardownAudio();
        wsRef.current = null;
        setIsRunning(false);
        if (!isStoppingRef.current) {
          setStatus('WebSocket closed');
          void deleteStreamSession();
        }
      };
    } catch (err: any) {
      console.error(err);
      setStatus('Error: ' + err.message);
      setIsRunning(false);
    }
  }, [
    apiBaseUrl,
    appendTranscript,
    authToken,
    buildRequestHeaders,
    buildWebSocketUrl,
    convertFloat32ToInt16,
    deleteStreamSession,
    downsampleBuffer,
    pipelineId,
    teardownAudio,
    tenantId,
  ]);

  useEffect(() => {
    return () => {
      stopAll();
    };
  }, [stopAll]);

  return (
    <div style={{ maxWidth: 800, margin: '2rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Live Transcription Demo</h1>

      <p>
        <button onClick={start} disabled={isRunning}>
          Start
        </button>
        <button onClick={stopAll} disabled={!isRunning}>
          Stop
        </button>
      </p>

      <div style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: '#555' }}>Status: {status}</div>

      <div
        style={{
          marginTop: '1rem',
          border: '1px solid #ddd',
          padding: '1rem',
          minHeight: 200,
          whiteSpace: 'pre-wrap',
          background: '#fafafa',
        }}
      >
        {transcript || 'Transcription will appear here...'}
      </div>
    </div>
  );
};
