---
---

No version bump from this branch.

The `ALL-3.0.0` work (TASK-754 … TASK-768) was versioned by hand before Changesets was
initialized — the SDK family is already at `3.0.0`, and `@arcaai/pipeline` was corrected
from `2.0.6` in the same pass. A real changeset here would bump the family a second time,
to `4.0.0`, for changes already released under `3.0.0`.

This empty changeset records that deliberately, so `changeset status` is green and the
publish job does not stall on the transition. Every change from here on gets a real one:
`pnpm changeset`.
