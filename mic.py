import sys
import time
import uuid
import json
import redis
import threading
import urllib.request
import numpy as np

# Check for audio recording library
try:
    import sounddevice as sd
    AUDIO_BACKEND = "sounddevice"
except ImportError:
    try:
        import pyaudio
        AUDIO_BACKEND = "pyaudio"
    except ImportError:
        print("❌ Error: No supported microphone recording library found.")
        print("Please install sounddevice or pyaudio by running:")
        print("   pip install sounddevice numpy")
        sys.exit(1)

# Configuration
SERVER_IP = "192.168.112.2"
TOKEN = "5939fa2a0c6a357a2ebd2e8378cb9dc64d4e2ad40cd9cb45855ee749aa081930"
SESSION_ID = str(uuid.uuid4())
FIXTURE_PATH = "/Users/apple/Desktop/project-hope/tests/contracts/resolved-asr-spec.fixture.json"
SAMPLE_RATE = 16000
CHUNK_DURATION_SEC = 0.1  # 100ms chunks
CHUNK_SAMPLES = int(SAMPLE_RATE * CHUNK_DURATION_SEC)  # 1600 samples = 3200 bytes PCM16

print(f"🎙️ Creating STT Real-Time Streaming Session on {SERVER_IP}: {SESSION_ID}")

# Load resolved_spec from contract fixture
with open(FIXTURE_PATH, "r") as f:
    fixture = json.load(f)
resolved_spec = fixture["platformDefault"]["expected"]

# Create Session via STT Internal API
payload = json.dumps({
    "session_id": SESSION_ID,
    "tenant_id": "00000000-0000-0000-0000-000000000000",
    "pipeline_id": "0199a861-0000-7000-8000-000000000001",
    "sample_rate": SAMPLE_RATE,
    "language_mode": "en",
    "resolved_spec": resolved_spec
}).encode("utf-8")

req = urllib.request.Request(
    f"http://{SERVER_IP}:8861/internal/streaming/sessions",
    data=payload,
    headers={
        "X-Service-Token": TOKEN,
        "Content-Type": "application/json"
    },
    method="POST"
)

try:
    with urllib.request.urlopen(req) as response:
        res_data = json.loads(response.read().decode("utf-8"))
        print(f"✅ Session Active: status={res_data.get('status')}")
        
        asr_model_info = resolved_spec.get("models", {}).get("asr", {})
        vad_model_info = resolved_spec.get("models", {}).get("vad", {})
        print(f"🧠 [MODEL CONFIG]: ASR Engine -> {asr_model_info.get('slug', 'whisper')}")
        print(f"🎙️ [MODEL CONFIG]: VAD Engine -> {vad_model_info.get('slug', 'silero-vad')}\n")
except Exception as e:
    print(f"❌ Failed to create session: {e}")
    sys.exit(1)

r = redis.Redis(host=SERVER_IP, port=6379, db=0)
streaming_active = True

def result_listener():
    """Background listener to read real-time transcription results from Redis stream."""
    last_id = "0-0"
    print("------------------------------------------------------------")
    print("📡 LIVE MIC TRANSCRIPTION STREAM (Speak into your mic):")
    print("------------------------------------------------------------")
    
    while streaming_active:
        try:
            entries = r.xread({f"stt:result:{SESSION_ID}": last_id}, count=10, block=200)
            if entries:
                for stream_name, messages in entries:
                    for msg_id, fields in messages:
                        last_id = msg_id
                        parsed = {k.decode("utf-8"): v.decode("utf-8") if isinstance(v, bytes) else v for k, v in fields.items()}

                        if "text" in parsed and parsed["text"].strip():
                            is_final = parsed.get("is_final") == "1"
                            tag = "✅ FINAL" if is_final else "⚡ PARTIAL"
                            print(f"\r[{tag}] \"{parsed['text']}\"")
                        elif parsed.get("status") == "provider_switched":
                            print(f"\n⚙️ [ENGINE]: Active model switch -> {parsed.get('to_pipeline')}")
                        elif parsed.get("status") == "finalizing":
                            print("\n⏳ [ENGINE]: Flushing remaining audio buffer...")
                        elif parsed.get("status") == "closed":
                            print("\n🔒 [ENGINE]: Session Closed.")
        except Exception:
            pass
        time.sleep(0.05)

# Start background listener thread
listener_thread = threading.Thread(target=result_listener, daemon=True)
listener_thread.start()

seq = 0

print("🎤 Microphone streaming started. Press Ctrl+C to stop recording and finalize.\n")

try:
    if AUDIO_BACKEND == "sounddevice":
        def audio_callback(indata, frames, time_info, status):
            global seq
            if status:
                print(f"Audio status warning: {status}", file=sys.stderr)
            
            # indata is float32 numpy array [-1.0, 1.0]; convert to int16 PCM
            pcm16_data = (indata[:, 0] * 32767).astype(np.int16).tobytes()
            seq += 1
            
            r.xadd(f"stt:audio:{SESSION_ID}", {
                "seq": str(seq),
                "sr": str(SAMPLE_RATE),
                "enc": "pcm_s16le",
                "ch": "1",
                "data": pcm16_data,
                "final": "0",
                "ts": str(time.time())
            })

        with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype='float32',
                            blocksize=CHUNK_SAMPLES, callback=audio_callback):
            while True:
                time.sleep(0.1)

    elif AUDIO_BACKEND == "pyaudio":
        p = pyaudio.PyAudio()
        stream = p.open(format=pyaudio.paInt16, channels=1, rate=SAMPLE_RATE,
                        input=True, frames_per_buffer=CHUNK_SAMPLES)
        
        while True:
            data = stream.read(CHUNK_SAMPLES, exception_on_overflow=False)
            seq += 1
            r.xadd(f"stt:audio:{SESSION_ID}", {
                "seq": str(seq),
                "sr": str(SAMPLE_RATE),
                "enc": "pcm_s16le",
                "ch": "1",
                "data": data,
                "final": "0",
                "ts": str(time.time())
            })

except KeyboardInterrupt:
    print("\n\n⏹️ Recording stopped. Sending finalize signal...")

    # Send Finalize signal
    r.xadd(f"stt:control:{SESSION_ID}", {
        "action": "finalize",
        "target": "fallback"
    })

    # Wait for final result to flush
    time.sleep(5)
    streaming_active = False
    print("\n🎉 Microphone streaming test complete!")
