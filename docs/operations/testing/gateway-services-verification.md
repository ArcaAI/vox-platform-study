# HOPE Services Verification & Gateway Test Runbook

This guide contains concise `curl` commands to verify the **API Gateway** and each downstream microservice directly and through the gateway.

---

## 1. Environment & Variables

```bash
NODE_IP="192.168.112.6"
GW_URL="http://${NODE_IP}:32458"
TOKEN="J5ZP2P21KiM+sLNSsbdV5n0iR+ndY2Qer0vPzbYbTfo="
```

---

## 2. API Gateway Probes

```bash
# Gateway Health
curl -s "${GW_URL}/api/v1/health" | jq .

# Liveness
curl -s "${GW_URL}/api/v1/health/live" | jq .

# Readiness
curl -s "${GW_URL}/api/v1/health/ready" | jq .
```

---

## 3. Verify Services via API Gateway (Config Plane)

The API Gateway controls dynamic configuration for each service via `/internal/effective-config`:

```bash
# 1. Text Service (LLM)
curl -s -H "X-Service-Token: ${TOKEN}" \
  "${GW_URL}/api/v1/internal/effective-config?service=text" | jq .

# 2. Medical NLP Service
curl -s -H "X-Service-Token: ${TOKEN}" \
  "${GW_URL}/api/v1/internal/effective-config?service=nlp" | jq .

# 3. Clinical Harness Service
curl -s -H "X-Service-Token: ${TOKEN}" \
  "${GW_URL}/api/v1/internal/effective-config?service=harness" | jq .

# 4. Text-to-Speech (TTS) Service
curl -s -H "X-Service-Token: ${TOKEN}" \
  "${GW_URL}/api/v1/internal/effective-config?service=tts" | jq .

# 5. Speech-to-Text (STT) Service
curl -s -H "X-Internal-Service-Key: ${TOKEN}" \
  "${GW_URL}/api/v1/internal/effective-config?service=stt" | jq .
```

---

## 4. Individual Service Direct Verification

### A. Hope-Text (LLM)
- **NodePort**: `30366`
```bash
# Direct Health
curl -s "http://${NODE_IP}:30366/api/v1/health" | jq .

# List All Registered Providers
curl -s -H "X-Service-Token: ${TOKEN}" -H "X-Tenant-Id: tenantless:operator-inspection" \
  "http://${NODE_IP}:30366/api/v1/providers" | jq '.[].name'

# Direct Model Generation Probe
curl -s -X POST "http://${NODE_IP}:30366/api/v1/generate" \
  -H "Content-Type: application/json" \
  -H "X-Service-Token: ${TOKEN}" \
  -d '{"prompt": "Hello", "stream": false}' | jq .
```

---

### B. Hope-NLP (Medical NLP)
- **NodePort**: `31765`
```bash
# Check Health (Inspect lazy/loaded states)
curl -s "http://${NODE_IP}:31765/api/v1/health" | jq .checks

# Live Medical Named-Entity Recognition (NER)
curl -s -X POST "http://${NODE_IP}:31765/api/v1/classify/tokens" \
  -H "Content-Type: application/json" \
  -H "X-Service-Token: ${TOKEN}" \
  -d '{
    "text": "Patient reports severe chest pain and takes 10mg amlodipine.",
    "model_name": "blaze999/Medical-NER"
  }' | jq .

# Verify Model Loaded into Memory
curl -s "http://${NODE_IP}:31765/api/v1/health" | jq '.checks.token_classifier'
```

---

### C. Hope-Harness & Temporal Worker
- **Harness NodePort**: `31665`
- **Temporal Web UI NodePort**: `31888`
```bash
# Direct Harness Readiness
curl -s "http://${NODE_IP}:31665/api/v1/health/ready" | jq .

# Verify Harness Worker Pollers in Temporal
curl -s "http://${NODE_IP}:31888/api/v1/namespaces/default/task-queues/harness-task-queue?taskQueueType=1" | jq .
```

---

### D. Hope-TTS (Text-to-Speech)
- **Cluster Deployment**: `hope-tts` in `project-hope-vox`
```bash
# 1. Check Pod Status on Master Node
kubectl get pods,svc -n project-hope-vox | grep tts

# 2. In-Pod / In-Cluster Health Check
kubectl exec -it deployment/hope-tts -n project-hope-vox -- curl -s http://localhost:8865/api/v1/health | jq .

# 3. Speech Audio Synthesis (Kokoro engine, af_heart voice)
kubectl exec -it deployment/hope-tts -n project-hope-vox -- curl -s -X POST "http://localhost:8865/api/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Patient reports severe chest pain.",
    "voice": "af_heart",
    "response_format": "wav"
  }' --output /tmp/test_speech.wav

# 4. Check generated audio file size
kubectl exec -it deployment/hope-tts -n project-hope-vox -- ls -lh /tmp/test_speech.wav
```

---

### E. Hope-STT (Speech-to-Text)
- **Cluster DNS**: `http://hope-stt-svc:8860`
```bash
# Inside Cluster / via Pod
curl -s "http://hope-stt-svc.project-hope-vox.svc.cluster.local:8860/api/v1/health" | jq .
```
