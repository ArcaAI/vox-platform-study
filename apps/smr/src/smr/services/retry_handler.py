"""Retry logic with exponential backoff for provider errors."""

from __future__ import annotations

import random


def calculate_backoff(attempt: int, base_delay: float = 1.0, max_delay: float = 60.0) -> float:
    """Exponential backoff with jitter, capped at max_delay."""
    delay: float = min(base_delay * (2 ** attempt), max_delay)
    jitter = random.uniform(0.0, delay * 0.1)
    return min(delay + jitter, max_delay)


def should_retry(
    error_type: str,
    retry_on: list[str],
    attempt: int = 0,
    max_retries: int = 3,
) -> bool:
    """Determine if the request should be retried."""
    if attempt >= max_retries:
        return False
    return error_type in retry_on
