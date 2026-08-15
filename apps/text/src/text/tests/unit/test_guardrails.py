"""Retirement contract for the inline regex guardrails.

The inline regex-based prompt-injection scanner and its guardrail audit
logger have been retired from the SMR service. The harness
(Granite Guardian safety + groundedness + fail-closed PHI) is now the
authoritative safety/guardrail layer, so SMR no longer ships its own
regex content filters.

These tests pin the removal so the regex guardrail surface is not
reintroduced.
"""

from __future__ import annotations

import importlib.util

from text.core import metrics
from text.core.config import Settings


class TestInlineRegexGuardrailsRetired:
    def test_regex_guardrail_scanner_module_removed(self):
        """text.services.guardrails (PromptInjectionScanner) is gone."""
        assert importlib.util.find_spec("text.services.guardrails") is None

    def test_guardrail_audit_module_removed(self):
        """text.services.audit (GuardrailAuditLogger) is gone."""
        assert importlib.util.find_spec("text.services.audit") is None

    def test_settings_have_no_guardrail_flags(self):
        """The regex guardrail config flags are removed from Settings."""
        fields = set(Settings.model_fields)
        assert "guardrail_mode" not in fields
        assert "guardrail_enabled" not in fields

    def test_guardrail_scan_metric_removed(self):
        """The orphaned regex-scan Prometheus counter is removed."""
        assert not hasattr(metrics, "GUARDRAIL_SCANS")
