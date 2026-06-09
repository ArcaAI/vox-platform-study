"""GLiNER ONNX provider for content safety, adversarial, and PII detection.

Runs `hivetrace/gliner-guard-uniencoder-onnx` via gliner2-onnx (no PyTorch).
CPU-bound inference is offloaded to a thread-pool executor so it never blocks
the asyncio event loop.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Any, cast

from guardrail.core.config import GlinerConfig
from guardrail.core.logging import get_logger

logger = get_logger(__name__)

# ── Label taxonomies (mirrors hivetrace/gliner-guard-uniencoder) ──────────

SAFETY_LABELS = ["safe", "unsafe"]

PII_LABELS = [
    "person", "first_name", "last_name", "email", "phone",
    "address", "city", "country", "card_number", "bank_account",
    "crypto_wallet", "passport", "national_id", "date_of_birth",
]

ADVERSARIAL_LABELS = [
    "jailbreak_persona", "jailbreak_hypothetical", "jailbreak_roleplay",
    "prompt_injection", "indirect_prompt_injection", "instruction_override",
    "data_exfiltration", "system_prompt_extraction",
    "context_manipulation", "token_manipulation",
    "tool_abuse", "social_engineering", "multi_turn_escalation",
    "schema_poisoning", "none",
]

HARMFUL_LABELS = [
    "harassment", "hate_speech", "discrimination",
    "violence", "dangerous_instructions", "weapons",
    "sexual_content", "child_exploitation",
    "fraud", "scam", "misinformation",
    "none",
]


class GlinerProvider:
    """GLiNER ONNX provider — replaces Ollama for all content safety checks."""

    def __init__(self, config: GlinerConfig) -> None:
        self.config = config

        if not config.enabled:
            logger.info("gliner.disabled", model_id=config.model_id)
            self.runtime: Any = None
            self._executor = None
            return

        from gliner2_onnx import GLiNER2ONNXRuntime

        logger.info(
            "gliner.loading",
            model_id=config.model_id,
            precision=config.precision,
            providers=config.providers,
        )
        self.runtime = GLiNER2ONNXRuntime.from_pretrained(
            config.model_id,
            precision=config.precision,
            providers=config.providers,
        )
        self._executor = ThreadPoolExecutor(
            max_workers=config.max_workers,
            thread_name_prefix="gliner",
        )
        logger.info("gliner.ready", model_id=config.model_id)

    # ── Synchronous inference (runs in thread pool) ───────────────────────

    def _sync_analyze(self, text: str, guardrail_type: str) -> dict[str, Any]:
        """Run GLiNER checks synchronously — called via run_in_executor."""
        threshold = self.config.classification_threshold
        issues: list[str] = []
        safe = True
        confidence_scores: list[float] = []

        run_safety = guardrail_type in ("comprehensive", "content_safety")
        run_harmful = guardrail_type in ("comprehensive", "content_safety")
        run_adversarial = guardrail_type in ("comprehensive", "prompt_injection")
        run_pii = guardrail_type in ("comprehensive", "pii_detection")

        if run_safety:
            safety_scores = self.runtime.classify(text, SAFETY_LABELS)
            if safety_scores:
                top_label = max(safety_scores, key=safety_scores.__getitem__)
                confidence_scores.append(safety_scores[top_label])
                if top_label == "unsafe":
                    safe = False
                    issues.append("unsafe_content")

        if run_harmful:
            harmful_scores = self.runtime.classify(
                text, HARMFUL_LABELS, threshold=threshold, multi_label=True,
            )
            active = [f for f in (harmful_scores or {}) if f != "none"]
            if active:
                safe = False
                issues.extend(active)
                confidence_scores.extend(harmful_scores[f] for f in active)

        if run_adversarial:
            adv_scores = self.runtime.classify(
                text, ADVERSARIAL_LABELS, threshold=threshold, multi_label=True,
            )
            active = [f for f in (adv_scores or {}) if f != "none"]
            if active:
                safe = False
                issues.extend(active)
                confidence_scores.extend(adv_scores[f] for f in active)

        if run_pii:
            entities = self.runtime.extract_entities(text, PII_LABELS)
            pii = [e for e in (entities or []) if e.score >= self.config.pii_threshold]
            if pii:
                safe = False
                issues.append("pii_detected")
                confidence_scores.append(max(e.score for e in pii))

        confidence = (
            round(sum(confidence_scores) / len(confidence_scores), 3)
            if confidence_scores
            else 0.8
        )

        return {
            "safe": safe,
            "issues": issues,
            "confidence": confidence,
        }

    # ── Async public API (same shape as OllamaProvider) ───────────────────

    async def analyze_content(
        self,
        text: str,
        guardrail_type: str = "comprehensive",
    ) -> dict[str, Any]:
        """Offload CPU-bound GLiNER inference to the thread pool."""
        if not self.config.enabled:
            return {"safe": True, "issues": [], "confidence": 1.0, "error": "GLiNER disabled"}

        try:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(
                self._executor,
                self._sync_analyze,
                text,
                guardrail_type,
            )
        except Exception as e:
            logger.error("gliner.error", error=str(e), guardrail_type=guardrail_type)
            return {
                "safe": True,  # Fail open
                "issues": ["error"],
                "confidence": 0.0,
                "error": str(e),
            }

    async def batch_analyze(
        self,
        texts: list[str],
        guardrail_type: str = "comprehensive",
    ) -> list[dict[str, Any]]:
        """Analyze multiple texts concurrently via the thread pool."""
        tasks = [self.analyze_content(text, guardrail_type) for text in texts]
        return cast(list[dict[str, Any]], await asyncio.gather(*tasks, return_exceptions=True))

    def health_check(self) -> dict[str, Any]:
        """Synchronous health check — model is loaded on startup."""
        return {
            "healthy": self.config.enabled and self.runtime is not None,
            "model_id": self.config.model_id,
            "precision": self.config.precision,
            "enabled": self.config.enabled,
        }

    def shutdown(self) -> None:
        """Shutdown the thread pool executor on service teardown."""
        if self._executor is not None:
            self._executor.shutdown(wait=False)
