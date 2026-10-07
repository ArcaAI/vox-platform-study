"""TASK-1049 Track P — PII/PHI detection and masking evaluation harness.

Dataset generator (deterministic, gold spans exact by construction), a model-agnostic
`Detector` protocol, and the scorer: span P/R/F1, residual PHI after the production
`Pseudonymizer`, clinical over-mask, restore round trip, surrogate consistency.

Nothing in this package loads a model on import; the model adapters refuse to load
unless the owner's approval switch (`HOPE_1049_ALLOW_MODEL_LOAD=1`) is set.
"""
