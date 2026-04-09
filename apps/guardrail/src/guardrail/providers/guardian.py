"""Guardian provider for medical context validation using Ollama."""

from __future__ import annotations

import json
from typing import Any

import httpx

from guardrail.core.config import OllamaConfig
from guardrail.core.logging import get_logger

logger = get_logger(__name__)


class GuardianProvider:
    """Dedicated guardian provider for medical context validation."""

    def __init__(self, settings: OllamaConfig, http_client: httpx.AsyncClient) -> None:
        self.settings = settings
        self.http_client = http_client
        self.base_url = settings.base_url.rstrip("/")
        self.model = settings.guardian_model
        self.enabled = settings.guardian_enabled
        self.guardian_temperature = settings.guardian_temperature
        self.guardian_max_tokens = settings.guardian_max_tokens
        self.guardian_min_confidence = settings.guardian_min_confidence

        # Medical context validation system prompt
        self.medical_validation_prompt = (
            "You are a medical context validator. Your task is to determine if the provided text "
            "is related to medical documentation, clinical notes, patient care, or healthcare services. "
            "Analyze the text and respond ONLY with a JSON object in this exact format:\n"
            '{"is_medical": true/false, "confidence": 0.0-1.0, "context_type": "clinical/administrative/general", '
            '"reasoning": "brief explanation"}\n\n'
            "Medical context includes: patient records, clinical notes, diagnoses, treatments, medications, "
            "symptoms, medical procedures, healthcare consultations, referrals, prescriptions, vital signs, "
            "medical history, physical examinations, lab results, imaging reports, care plans, discharge summaries.\n\n"
            "Non-medical context includes: general conversation, business documents, technical documentation, "
            "entertainment content, personal communications unrelated to healthcare."
        )

    async def validate_medical_context(
        self,
        text: str,
        include_reasoning: bool = False,
    ) -> dict[str, Any]:
        """Validate if text contains medical context using the guardian model."""

        if not self.enabled:
            return {
                "is_medical": True,  # Fail open when disabled
                "confidence": 1.0,
                "context_type": "unknown",
                "reasoning": "Guardian validation disabled",
            }

        try:
            # Truncate text for validation (first 2000 chars should be sufficient)
            text_sample = text[:2000]

            payload = {
                "model": self.model,
                "system": self.medical_validation_prompt,
                "prompt": f"Analyze this text for medical context:\n\n{text_sample}",
                "stream": False,
                "options": {
                    "temperature": self.guardian_temperature,
                    "num_predict": self.guardian_max_tokens,
                },
                "format": "json",  # Request JSON format from Ollama
            }

            response = await self.http_client.post(
                f"{self.base_url}/api/generate",
                json=payload,
                timeout=self.settings.timeout_s,
            )
            response.raise_for_status()

            result = response.json()
            content = result.get("response", "").strip()

            # Parse JSON response
            validation_result = self._parse_validation_response(content)

            # Apply confidence threshold
            if validation_result["confidence"] < self.guardian_min_confidence:
                logger.warning(
                    "guardian.low_confidence",
                    confidence=validation_result["confidence"],
                    threshold=self.guardian_min_confidence,
                )

            return validation_result

        except httpx.TimeoutException:
            logger.error("guardian.timeout", model=self.model)
            return {
                "is_medical": True,  # Fail open on timeout
                "confidence": 0.0,
                "context_type": "unknown",
                "reasoning": "Validation timeout",
                "error": "timeout",
            }
        except Exception as e:
            logger.error("guardian.error", error=str(e), model=self.model)
            return {
                "is_medical": True,  # Fail open on error
                "confidence": 0.0,
                "context_type": "unknown",
                "reasoning": "Validation error",
                "error": str(e),
            }

    def _parse_validation_response(self, content: str) -> dict[str, Any]:
        """Parse JSON response from guardian model."""
        try:
            # Try to parse as JSON
            result = json.loads(content)

            # Validate required fields
            is_medical = result.get("is_medical", False)
            confidence = float(result.get("confidence", 0.0))
            context_type = result.get("context_type", "unknown")
            reasoning = result.get("reasoning", "")

            # Ensure confidence is in valid range
            confidence = max(0.0, min(1.0, confidence))

            return {
                "is_medical": bool(is_medical),
                "confidence": confidence,
                "context_type": context_type,
                "reasoning": reasoning,
            }

        except (json.JSONDecodeError, KeyError, ValueError) as e:
            logger.warning("guardian.invalid_response", content=content[:200], error=str(e))

            # Fallback: use keyword-based heuristic
            return self._keyword_based_validation(content)

    def _keyword_based_validation(self, text: str) -> dict[str, Any]:
        """Fallback keyword-based medical context validation."""

        medical_keywords = [
            'patient', 'diagnosis', 'treatment', 'medication', 'clinical',
            'medical', 'doctor', 'physician', 'nurse', 'hospital', 'clinic',
            'symptom', 'condition', 'prescription', 'therapy', 'examination',
            'vital signs', 'chief complaint', 'history of present illness',
            'assessment', 'plan', 'transcript', 'case note', 'summary',
            'referral', 'visit', 'encounter', 'procedure', 'surgery',
            'lab', 'imaging', 'radiology', 'pathology', 'biopsy',
            'discharge', 'admission', 'consultation', 'follow-up'
        ]

        text_lower = text.lower()
        matched_keywords = [kw for kw in medical_keywords if kw in text_lower]

        # Calculate confidence based on keyword matches
        match_count = len(matched_keywords)
        confidence = min(match_count / 5.0, 1.0)  # 5+ matches = 100% confidence

        is_medical = match_count >= 2  # At least 2 medical keywords

        return {
            "is_medical": is_medical,
            "confidence": confidence,
            "context_type": "clinical" if is_medical else "general",
            "reasoning": f"Keyword-based validation: {match_count} medical terms found",
            "matched_keywords": matched_keywords[:5],  # Top 5 matches
        }

    async def batch_validate(
        self,
        texts: list[str],
    ) -> list[dict[str, Any]]:
        """Validate multiple texts for medical context."""
        import asyncio

        tasks = [self.validate_medical_context(text) for text in texts]
        return await asyncio.gather(*tasks, return_exceptions=True)

    async def health_check(self) -> dict[str, Any]:
        """Check guardian service health."""
        try:
            response = await self.http_client.get(
                f"{self.base_url}/api/tags",
                timeout=10.0,
            )
            response.raise_for_status()

            models = response.json().get("models", [])
            model_available = any(model.get("name") == self.model for model in models)

            return {
                "healthy": True,
                "guardian_enabled": self.enabled,
                "model": self.model,
                "model_available": model_available,
                "base_url": self.base_url,
            }
        except Exception as e:
            return {
                "healthy": False,
                "guardian_enabled": self.enabled,
                "model": self.model,
                "error": str(e),
                "base_url": self.base_url,
            }
