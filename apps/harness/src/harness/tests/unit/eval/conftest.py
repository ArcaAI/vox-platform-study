"""Eval-test fixtures/setup.

DeepEval phones home (PostHog/Sentry) and prints a banner on import. Opt out
*before* deepeval is imported anywhere so the unit suite stays hermetic and
offline. These env vars are read by deepeval at import time.
"""

from __future__ import annotations

import os

os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "YES")
os.environ.setdefault("ERROR_REPORTING", "NO")
os.environ.setdefault("DEEPEVAL_DISABLE_PROGRESS_BAR", "YES")
