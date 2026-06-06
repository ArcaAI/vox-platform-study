"""Clinical Documentation Harness (TASK-330).

A Python/FastAPI orchestrator that runs the bounded
``guides → generate → sensors → gate`` clinical-documentation loop as a
Temporal durable workflow. ``apps/api`` remains the gateway / system-of-record.
"""

__version__ = "0.1.0"
