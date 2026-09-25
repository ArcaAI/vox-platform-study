# HOPE Architecture Interactive Diagrams

This directory contains interactive visual architecture diagrams, specifications, and visual check artifacts generated with [Archify](https://github.com).

## Directory Structure

```text
diagrams/
├── platform/                                    # Whole-System Platform Topology
│   ├── hope-architecture.html                  # Interactive standalone HTML diagram
│   ├── hope-architecture.json                  # Archify architecture IR specification
│   └── hope-architecture.visual-check.1440x900.dark.png
│
├── stt/                                         # Speech-to-Text Subsystem
│   ├── stt-subsystem-architecture.html          # Interactive standalone HTML diagram
│   ├── stt-subsystem-architecture.json          # Archify architecture IR specification
│   ├── stt-subsystem-architecture.visual-check.1440x900.dark.png
│   ├── stt-subsystem-architecture.visual-check.1440x900.light.png
│   ├── stt-subsystem-architecture.visual-check.2048x1320.dark.png
│   └── stt-subsystem-architecture.visual-check.2048x1320.light.png
│
└── text/                                        # Text Generation & Summarization Subsystem
    ├── text-subsystem-architecture.html         # Interactive standalone HTML diagram
    ├── text-subsystem-architecture.json         # Archify architecture IR specification
    ├── text-subsystem-architecture.visual-check.1440x900.dark.png
    ├── text-subsystem-architecture.visual-check.1440x900.light.png
    ├── text-subsystem-architecture.visual-check.2048x1320.dark.png
    └── text-subsystem-architecture.visual-check.2048x1320.light.png
```

## Available Interactive Architecture Visualizers

| Subsystem | Interactive Diagram | Architecture Spec | Key Focus Areas |
|---|---|---|---|
| **Platform Overview** | [`platform/hope-architecture.html`](platform/hope-architecture.html) | [`platform/hope-architecture.json`](platform/hope-architecture.json) | High-level system topology, Gateway, Async Engine Workers, Storage (Postgres/Redis/MinIO), Identity & KMS |
| **STT Subsystem** | [`stt/stt-subsystem-architecture.html`](stt/stt-subsystem-architecture.html) | [`stt/stt-subsystem-architecture.json`](stt/stt-subsystem-architecture.json) | Fast/Slow RabbitMQ Queues, ASR Worker Pool, Engine Routing (Deepgram / Whisper / Azure), Engine API (`:8860`), Audio Storage |
| **Text Subsystem** | [`text/text-subsystem-architecture.html`](text/text-subsystem-architecture.html) | [`text/text-subsystem-architecture.json`](text/text-subsystem-architecture.json) | SOAP note synthesis, Multi-Provider LLM Routing, Per-Provider Circuit Breakers, Fail-Closed Guardrail Screening (`:8863`), Redis Task Manager & SSE Streaming |

## How to View

Open any `.html` file directly in your web browser:
```bash
open docs/architecture/diagrams/platform/hope-architecture.html
open docs/architecture/diagrams/stt/stt-subsystem-architecture.html
open docs/architecture/diagrams/text/text-subsystem-architecture.html
```

Or view the deployed interactive showcase on GitHub Pages:
**`https://ArcaAI.github.io/vox-platform-study/`**
