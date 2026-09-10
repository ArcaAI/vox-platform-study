---
'@arcaai/vox-node': patch
---

**`RealtimeSttSocket#stop()` is renamed to `finalize()` — its old doc comment was wrong, and it cost real consultations.** `stop()` documented itself as "finalize the current utterance. The SESSION stays open — this is not a close." That was never true: the `{type:'stop'}` frame it sends is forwarded by the gateway to the tenant's ASR service as a `finalize` control command, which flushes the tail of the utterance and then CLOSES the session (observed live: `status finalizing` → `status closed`, the session's Redis status ending `closed`). Two integrators called `stop()` mid-consultation expecting to keep streaming and lost the rest of the session.

`finalize()` carries the corrected doc and is now the primary name; `stop()` is kept as a `@deprecated` alias that delegates to it and sends the exact same wire frame — no wire-protocol change, this is a documentation and naming fix. Existing callers of `stop()` are unaffected functionally and should migrate to `finalize()` at their own pace.
