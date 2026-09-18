"""DEPRECATED shim — STT's logging now lives entirely in `hope_obs` (TASK-987).

`get_logger` is kept as a thin re-export because it is imported from three
call sites (`stt.main`, `stt.worker`, `stt.core.middleware.auth`) that would
otherwise need touching for no behavioural change. `redact_id` moved to
`hope_obs` outright — it had exactly one caller
(`stt.diarization.preseed`), which now imports it directly.

Do not add new call sites against this module; import from `hope_obs`.
"""

from __future__ import annotations

from hope_obs import get_logger

__all__ = ["get_logger"]
