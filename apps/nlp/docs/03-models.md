# NLP Models Documentation

This document provides detailed information about the machine learning models used in the HOPE NLP Service.

## Overview

The NLP Service uses four main components:

| Component | Model | Purpose | Size |
|-----------|-------|---------|------|
| Text Classification | `michellejieli/emotion_text_classifier` | Emotion classification (11 classes) | ~500 MB |
| Token Classification | `blaze999/Medical-NER` | Medical entity extraction (NER) | ~400 MB |
| Medical Diagnosis | `shanover/symps_disease_bert_v3_c41` | Disease suggestion (41 classes) | ~450 MB |
| Text Correction | SymSpellPy + Dictionaries | Spelling correction | ~50 MB |

**Total Model Size:** ~1.4 GB

## Text Classification Model

### Model Details

- **Name:** `michellejieli/emotion_text_classifier`
- **Architecture:** BERT-based sequence classification
- **Task:** Multi-class emotion classification
- **Classes:** 11 emotion categories
- **Input:** Text string (max 512 tokens)
- **Output:** Emotion label + confidence + probabilities

### Supported Emotions

1. **anger** - Expressing anger or frustration
2. **fear** - Expressing fear or anxiety
3. **joy** - Expressing happiness or satisfaction
4. **love** - Expressing affection or care
5. **sadness** - Expressing sadness or disappointment
6. **surprise** - Expressing surprise or shock
7. **neutral** - No strong emotion
8. **disgust** - Expressing disgust or dislike
9. **shame** - Expressing shame or embarrassment
10. **guilt** - Expressing guilt or regret
11. **confusion** - Expressing confusion or uncertainty

### Performance

- **Accuracy:** ~88% on emotion detection tasks
- **Inference Time:** 100-200ms per text (CPU), 50-80ms (GPU)
- **Max Sequence Length:** 512 tokens
- **Batch Size:** 16 (configurable)

### Use Cases

- Patient sentiment analysis
- Doctor-patient communication assessment
- Mental health screening
- Treatment satisfaction measurement
- Clinical note emotion detection

### Example

```python
Input: "The patient is very happy with the treatment results"
Output: {
    "predicted_label": "joy",
    "confidence": 0.92,
    "probabilities": {
        "joy": 0.92,
        "love": 0.05,
        "surprise": 0.02,
        "neutral": 0.01
    }
}
```

## Token Classification Model

### Model Details

- **Name:** `blaze999/Medical-NER`
- **Architecture:** BERT-based token classification
- **Task:** Named Entity Recognition (NER)
- **Entity Types:** 8+ medical entity categories
- **Input:** Text string (max 512 tokens)
- **Output:** List of entities with positions

### Supported Entity Types

1. **DISEASE** - Medical conditions and diseases
   - Examples: diabetes, hypertension, pneumonia

2. **SYMPTOM** - Symptoms and signs
   - Examples: fever, cough, chest pain

3. **TREATMENT** - Treatments and interventions
   - Examples: surgery, therapy, rehabilitation

4. **MEDICATION** - Drugs and medications
   - Examples: aspirin, insulin, antibiotics

5. **ANATOMY** - Body parts and anatomical structures
   - Examples: heart, lungs, abdomen

6. **PROCEDURE** - Medical procedures
   - Examples: blood test, X-ray, ECG

7. **TEST** - Diagnostic tests
   - Examples: MRI, CT scan, blood work

8. **DOSAGE** - Medication dosages
   - Examples: 500mg, twice daily

### Performance

- **F1 Score:** ~85% on medical entity extraction
- **Inference Time:** 200-300ms per text (CPU), 80-120ms (GPU)
- **Max Sequence Length:** 512 tokens
- **Aggregation Strategy:** Simple (default), first, max, average

### Aggregation Strategies

**Simple:** Merge adjacent tokens with the same entity type
```
Input tokens: ["dia", "##betes"]
Output: "diabetes" (DISEASE)
```

**First:** Use the first token's label for merged entities

**Max:** Use the highest confidence label for merged entities

**Average:** Average confidence scores for merged entities

### Use Cases

- Clinical note entity extraction
- Medical report parsing
- Prescription parsing
- Medical coding assistance
- EHR data structuring

### Example

```python
Input: "Patient has diabetes and hypertension with chest pain"
Output: {
    "entities": [
        {
            "text": "diabetes",
            "entity_type": "DISEASE",
            "confidence": 0.95,
            "position": {"start": 12, "end": 20}
        },
        {
            "text": "hypertension",
            "entity_type": "DISEASE",
            "confidence": 0.93,
            "position": {"start": 25, "end": 37}
        },
        {
            "text": "chest pain",
            "entity_type": "SYMPTOM",
            "confidence": 0.89,
            "position": {"start": 43, "end": 53}
        }
    ]
}
```

## Medical Diagnosis Suggester

### Model Details

- **Name:** `shanover/symps_disease_bert_v3_c41`
- **Architecture:** BERT-based multi-label classification
- **Task:** Disease prediction from symptoms
- **Classes:** 41 common diseases
- **Input:** Symptom description
- **Output:** Ranked disease suggestions

### Supported Diseases (41 Classes)

Common conditions including:
- Pneumonia
- COVID-19
- Diabetes
- Hypertension
- Asthma
- Bronchitis
- Influenza
- Migraine
- Gastritis
- Arthritis
- And 31 more...

### Performance

- **Top-1 Accuracy:** ~75%
- **Top-3 Accuracy:** ~90%
- **Inference Time:** 150-250ms (CPU), 60-100ms (GPU)
- **Confidence Threshold:** 0.1 (default, configurable)

### Use Cases

- Clinical decision support
- Differential diagnosis assistance
- Symptom checker applications
- Triage support
- Medical education tools

### Important Disclaimers

⚠️ **Medical Disclaimer:**
- This is an AI-based suggestion tool
- NOT a replacement for professional medical diagnosis
- Should be used as a supportive tool only
- Always consult qualified healthcare professionals

### Example

```python
Input: "Patient complains of fever, cough, and difficulty breathing for 3 days"
Output: {
    "suggestions": [
        {"disease": "Pneumonia", "confidence": 0.78},
        {"disease": "COVID-19", "confidence": 0.65},
        {"disease": "Bronchitis", "confidence": 0.52},
        {"disease": "Influenza", "confidence": 0.45}
    ],
    "symptoms_analyzed": ["fever", "cough", "difficulty breathing"]
}
```

## Text Correction System

### System Details

- **Engine:** SymSpellPy
- **Algorithm:** Symmetric Delete Spelling Correction
- **Dictionaries:** Medical terminology (English & Malayalam)
- **Languages:** English (en), Malayalam (ml)
- **Dictionary Size:** ~50,000 medical terms

### Features

1. **Fast Spelling Correction** - O(1) lookup time
2. **Edit Distance:** Configurable (default: 2)
3. **Prefix Length:** 7 characters
4. **Max Suggestions:** 5 alternatives
5. **Case Preservation:** Maintains original case
6. **Medical Terminology:** Specialized medical vocabulary

### Dictionary Structure

```
data/dictionaries/
├── en/
│   ├── unigram.txt    # Single word terms
│   └── bigram.txt     # Two-word phrases
└── ml/
    ├── unigram.txt    # Malayalam terms
    └── bigram.txt     # Malayalam phrases
```

### Performance

- **Correction Time:** 50-100ms per text
- **Accuracy:** ~95% for common medical terms
- **Dictionary Coverage:** 50,000+ terms
- **Memory Usage:** ~50 MB

### Use Cases

- Medical transcription correction
- Clinical note cleanup
- Voice-to-text post-processing
- Medical terminology standardization
- Data quality improvement

### Example

```python
Input: "paracetmol for fver and headach"
Output: {
    "original_text": "paracetmol for fver and headach",
    "corrected_text": "paracetamol for fever and headache",
    "alternatives": [
        "paracetmol -> paracetamol",
        "fver -> fever",
        "headach -> headache"
    ]
}
```

## Model Loading & Caching

### Hugging Face Hub

All transformer models are loaded from Hugging Face Hub:

```python
from transformers import AutoModel, AutoTokenizer

# Automatically downloads and caches models
model = AutoModel.from_pretrained("michellejieli/emotion_text_classifier")
tokenizer = AutoTokenizer.from_pretrained("michellejieli/emotion_text_classifier")
```

### Cache Location

**Default Cache Directory:**
```bash
~/.cache/huggingface/hub/
```

**Docker Volume:**
```yaml
volumes:
  - huggingface-cache:/root/.cache/huggingface
```

### Model Loading Sequence

1. Check local cache
2. Download from Hugging Face Hub (if not cached)
3. Load model weights into memory
4. Initialize tokenizer
5. Create inference pipeline
6. Warm-up with sample input

### Startup Time

- **First Run:** 2-5 minutes (download + load)
- **Subsequent Runs:** 30-60 seconds (load from cache)
- **With Warm Cache + GPU:** 10-20 seconds

## GPU Acceleration

### Requirements

- NVIDIA GPU with CUDA support
- CUDA 11.0+ / ROCm 4.0+
- 4GB+ VRAM (8GB recommended)

### Configuration

```bash
# Enable GPU for all models
TEXT_CLASSIFIER_USE_GPU=true
TOKEN_CLASSIFIER_USE_GPU=true
MEDICAL_SUGGESTER_USE_GPU=true
```

### Performance Comparison

| Model | CPU (ms) | GPU (ms) | Speedup |
|-------|----------|----------|---------|
| Text Classification | 150 | 60 | 2.5x |
| Token Classification | 250 | 100 | 2.5x |
| Medical Diagnosis | 200 | 80 | 2.5x |

### Docker GPU Support

```bash
docker run --gpus all \
  -e TEXT_CLASSIFIER_USE_GPU=true \
  hope-nlp:latest
```

## Model Optimization

### FP16 Precision

Enable half-precision for faster inference:

```bash
TEXT_CLASSIFIER_FP16=true
TOKEN_CLASSIFIER_FP16=true
MEDICAL_SUGGESTER_FP16=true
```

**Benefits:**
- 2x faster inference
- 50% less memory usage
- Minimal accuracy loss (<1%)

**Requirements:**
- GPU with FP16 support (Volta+, T4, A100, etc.)
- PyTorch with CUDA

### Batch Processing

Process multiple texts together:

```bash
TEXT_CLASSIFIER_BATCH_SIZE=32
TOKEN_CLASSIFIER_BATCH_SIZE=32
```

**Benefits:**
- Higher throughput
- Better GPU utilization
- Efficient for batch jobs

### Model Quantization

Future optimization (not yet implemented):

- INT8 quantization (4x smaller, 3x faster)
- Dynamic quantization
- Static quantization with calibration

## Model Updates

### Version Management

Models are versioned in configuration:

```bash
TEXT_CLASSIFIER_MODEL_VERSION=1.0.0
TOKEN_CLASSIFIER_MODEL_VERSION=1.0.0
MEDICAL_SUGGESTER_MODEL_VERSION=1.0.0
```

### Updating Models

1. Update model name in environment variables
2. Clear Hugging Face cache (optional)
3. Restart service
4. New model will be downloaded and cached

```bash
# Clear cache
rm -rf ~/.cache/huggingface/

# Update configuration
TEXT_CLASSIFIER_MODEL_NAME=new-model-name

# Restart service
docker restart hope-nlp
```

### A/B Testing Models

Run multiple instances with different models:

```bash
# Instance A - Original model
docker run -e TEXT_CLASSIFIER_MODEL_NAME=model-v1 hope-nlp:latest

# Instance B - New model
docker run -e TEXT_CLASSIFIER_MODEL_NAME=model-v2 hope-nlp:latest
```

## Model Monitoring

### Metrics

- Inference latency (ms)
- Model confidence distribution
- Prediction counts by class
- Error rates
- GPU utilization

### Logging

```python
logger.info("Text classification complete", extra={
    "model": "michellejieli/emotion_text_classifier",
    "confidence": 0.92,
    "inference_time_ms": 120,
    "predicted_label": "joy"
})
```

### Performance Tracking

```bash
# Prometheus metrics
curl http://localhost:8864/metrics | grep nlp_model
```

## Troubleshooting

### Model Loading Errors

```bash
# Check GPU availability
python -c "import torch; print(torch.cuda.is_available())"

# Check CUDA version
nvidia-smi

# Clear cache and retry
rm -rf ~/.cache/huggingface/
```

### Out of Memory (OOM)

```bash
# Reduce batch size
TEXT_CLASSIFIER_BATCH_SIZE=8

# Disable GPU (use CPU)
TEXT_CLASSIFIER_USE_GPU=false

# Enable FP16 (if using GPU)
TEXT_CLASSIFIER_FP16=true
```

### Slow Inference

```bash
# Enable GPU
TEXT_CLASSIFIER_USE_GPU=true

# Enable FP16
TEXT_CLASSIFIER_FP16=true

# Increase batch size
TEXT_CLASSIFIER_BATCH_SIZE=32

# Check GPU utilization
nvidia-smi
```

## Best Practices

1. **Cache Models** - Use persistent volumes for Docker
2. **Enable GPU** - 2-5x performance improvement
3. **Use FP16** - Faster inference with minimal accuracy loss
4. **Tune Batch Size** - Balance latency vs. throughput
5. **Monitor Performance** - Track inference times and errors
6. **Version Models** - Track which model versions are deployed
7. **Test Before Deploy** - Validate accuracy on test set
8. **Warm Up Models** - Send test requests after startup

## References

- [Hugging Face Transformers](https://huggingface.co/docs/transformers)
- [SymSpellPy Documentation](https://symspellpy.readthedocs.io/)
- [PyTorch Documentation](https://pytorch.org/docs/)
- [CUDA Toolkit](https://developer.nvidia.com/cuda-toolkit)

