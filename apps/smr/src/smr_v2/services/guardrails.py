"""Prompt injection scanner for input/output guardrails.

Lightweight regex-based scanner that catches common prompt injection
patterns at near-zero latency cost. All patterns are pre-compiled at
init time.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

from smr_v2.core.logging import get_logger

logger = get_logger(__name__)

RISK_ORDER = {"none": 0, "low": 1, "medium": 2, "high": 3}


@dataclass
class ScanResult:
    is_suspicious: bool = False
    matched_patterns: list[str] = field(default_factory=list)
    risk_level: str = "none"

    def merge(self, other: ScanResult) -> ScanResult:
        combined_patterns = self.matched_patterns + other.matched_patterns
        is_suspicious = self.is_suspicious or other.is_suspicious
        risk_level = (
            self.risk_level
            if RISK_ORDER.get(self.risk_level, 0) >= RISK_ORDER.get(other.risk_level, 0)
            else other.risk_level
        )
        return ScanResult(
            is_suspicious=is_suspicious,
            matched_patterns=combined_patterns,
            risk_level=risk_level,
        )


_INPUT_PATTERNS: list[tuple[str, re.Pattern, str]] = [
    (
        "system_prompt_override",
        re.compile(
            r"ignore\s+(?:(?:all|any|previous|above|prior)\s+)*(instructions|prompts|rules|guidelines|constraints)",
            re.IGNORECASE,
        ),
        "medium",
    ),
    (
        "role_hijacking",
        re.compile(
            r"you are now|act as|pretend to be|from now on you|new persona|new role",
            re.IGNORECASE,
        ),
        "medium",
    ),
    (
        "instruction_injection",
        re.compile(
            r"\[INST\]|\[/INST\]|<<SYS>>|<\|im_start\|>|<\|im_end\|>",
            re.IGNORECASE,
        ),
        "high",
    ),
    (
        "data_exfiltration",
        re.compile(
            r"(reveal|show|display|output|print|repeat)\s+(the\s+|your\s+)?(system prompt|instructions|rules|initial prompt|hidden|secret|confidential)",
            re.IGNORECASE,
        ),
        "high",
    ),
    (
        "jailbreak_marker",
        re.compile(
            r"DAN|Do Anything Now|JAILBREAK|jailbroken|developer mode|god mode",
            re.IGNORECASE,
        ),
        "high",
    ),
    (
        "encoding_evasion",
        re.compile(
            r"base64|rot13|hex encode|url encode|unicode escape",
            re.IGNORECASE,
        ),
        "low",
    ),
    (
        "delimiter_injection",
        re.compile(
            r"[-=#{*}]{10,}",
        ),
        "low",
    ),
]

_OUTPUT_PATTERNS: list[tuple[str, re.Pattern]] = [
    (
        "leaked_api_key",
        re.compile(r"sk-[a-zA-Z0-9]{20,}"),
    ),
    (
        "leaked_aws_key",
        re.compile(r"AKIA[A-Z0-9]{16}"),
    ),
    (
        "leaked_private_key",
        re.compile(r"-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----"),
    ),
]


class PromptInjectionScanner:
    """Scans prompts for injection patterns and outputs for credential leaks."""

    def __init__(
        self,
        *,
        enabled: bool = True,
        mode: Literal["log", "block"] = "log",
    ) -> None:
        self.enabled = enabled
        self.mode = mode

    def scan(self, text: str) -> ScanResult:
        if not self.enabled:
            return ScanResult()

        matched: list[str] = []
        highest_risk = "none"

        for name, pattern, risk in _INPUT_PATTERNS:
            if pattern.search(text):
                matched.append(name)
                if RISK_ORDER[risk] > RISK_ORDER[highest_risk]:
                    highest_risk = risk

        if matched:
            return ScanResult(
                is_suspicious=True,
                matched_patterns=matched,
                risk_level=highest_risk,
            )
        return ScanResult()

    def scan_output(self, text: str) -> ScanResult:
        if not self.enabled:
            return ScanResult()

        matched: list[str] = []

        for name, pattern in _OUTPUT_PATTERNS:
            if pattern.search(text):
                matched.append(name)

        if matched:
            return ScanResult(
                is_suspicious=True,
                matched_patterns=matched,
                risk_level="high",
            )
        return ScanResult()
