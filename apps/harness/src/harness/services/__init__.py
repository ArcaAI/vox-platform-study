"""Tool clients + pure loop helpers for the harness durable loop (TASK-330 Lane I).

All network I/O the durable workflow needs lives behind these typed, async httpx
clients (SMR generation, NLP NER, the apps/api internal-harness callbacks). The
Temporal activities (:mod:`harness.temporal.activities`) are thin wrappers around
them so the workflow body stays deterministic.
"""
