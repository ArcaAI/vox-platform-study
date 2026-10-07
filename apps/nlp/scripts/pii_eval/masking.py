"""Apply TEXT's real `Pseudonymizer` (TASK-1035) to detected spans.

The module is loaded from its file in `apps/text` rather than copied, so the evaluation
masks exactly as cloud egress does. It is stdlib-only. The two private members used
(`_intervals`, `_token`) are covered by a reconstruction test so a change upstream fails
loudly instead of skewing the numbers.
"""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

from .spans import Detection

_PSEUDONYMIZER_PATH = (
    Path(__file__).resolve().parents[4] / "apps/text/src/text/services/pseudonymizer.py"
)
_MODULE_NAME = "_hope_text_pseudonymizer"


def load_pseudonymizer_module() -> ModuleType:
    module = sys.modules.get(_MODULE_NAME)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(_MODULE_NAME, _PSEUDONYMIZER_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {_PSEUDONYMIZER_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_MODULE_NAME] = module  # dataclasses resolve annotations through sys.modules
    spec.loader.exec_module(module)
    return module


@dataclass
class MaskResult:
    masked: list[str]
    #: Per text: the replaced intervals `(start, end, label)` actually chosen by the
    #: Pseudonymizer (known-value / overlap resolution included).
    intervals: list[list[tuple[int, int, str]]]
    pseudonymizer: object

    def token_for(self, label: str, value: str) -> str:
        return self.pseudonymizer._token(label, value)  # type: ignore[attr-defined]

    def restore(self, text: str) -> str:
        return self.pseudonymizer.restore(text)[0]  # type: ignore[attr-defined]


def mask_consultation(
    texts: Sequence[str], detections: Sequence[Sequence[Detection]]
) -> MaskResult:
    """Mask every text of ONE consultation with ONE Pseudonymizer (as one request would)."""
    mod = load_pseudonymizer_module()
    ps = mod.Pseudonymizer(known_phi=[])
    masked: list[str] = []
    intervals: list[list[tuple[int, int, str]]] = []
    for text, dets in zip(texts, detections, strict=True):
        spans = [mod.Span(label=d.raw_label, start=d.start, end=d.end) for d in dets]
        intervals.append(list(ps._intervals(text, spans)))
        masked.append(ps.pseudonymize(text, spans))
    return MaskResult(masked=masked, intervals=intervals, pseudonymizer=ps)
