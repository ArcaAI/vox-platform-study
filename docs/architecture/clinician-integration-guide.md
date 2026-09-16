# Clinician Integration Guide

**Moved.** This guide's content now lives in
[`docs/guides/client-integration-guide.md`](../guides/client-integration-guide.md), the single
Client-side Development & Integration Guide, which covers the same ground and finishes the journey
this document stopped short of: credentials and scope presets (chapter 1), opening a consultation
and choosing its workflow (chapter 3), streaming audio (chapter 5), the live streams including the
proposal-first assist feed (chapters 6 and 10), and the finish this document got wrong — releasing
the review gate, then approving the note, then closing, in that order (chapter 7). Running
workflows, idempotency, the absence of a run listing, inbound webhooks and the known gaps are
chapters 9 and 11. The webhook question this document and the server SDK's README used to answer
differently is settled in chapter 9: a workflow run does fire one, on its terminal transition, and
holding the stream or polling remain available.
