"""Make the hyphenated tool dirs importable for the pure-function tests."""

import sys
from pathlib import Path

PERF = Path(__file__).resolve().parents[1]
ROOT = PERF.parents[1]
for p in (
    PERF / "_perfkit",
    PERF / "screening-replay",
    PERF / "screening-load",
    ROOT / "apps" / "nlp" / "scripts",
):
    sys.path.insert(0, str(p))
