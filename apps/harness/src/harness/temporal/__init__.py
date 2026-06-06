"""Temporal durable-workflow substrate for the harness control loop.

The clinical-documentation loop (guides → generate → sensors → gate) will run
as a Temporal durable workflow: each guide/generate/sensor is an Activity
(non-deterministic LLM/tool I/O), the workflow body stays deterministic, and
the clinician sign-off gate is a ``wait_condition()`` on an approval Signal.

This module currently ships a trivial ping workflow/activity that proves the
substrate end-to-end.
"""
