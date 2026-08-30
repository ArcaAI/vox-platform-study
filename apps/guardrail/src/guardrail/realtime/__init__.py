"""The realtime consultation guardrail plane (TASK-829).

`services/screening.py` answers *"is this one string safe to send?"*. A live
consultation asks a different question: a transcript ARRIVES IN PIECES, and
several tasks — partial summarization, NER, grammar/spelling — each want to read
it. Validating every piece for every task is N times the cost and produces N
inconsistent verdicts on the same text; validating each piece ONCE and declaring
it clean is the *Prompt Overflow* vulnerability, bypassed 82-100% against exactly
this streaming-segment shape.

This package is the middle path the ticket's five conditions describe: validate
once at the producer boundary for what is genuinely a property of the text, and
re-decide at the CONSUMPTION boundary for everything that is not.

Read the modules in this order:

* :mod:`verdict` — the three-axis artifact and its two cache scopes (C-1),
* :mod:`deterministic` — T0, a persistent-state automaton that is invariant to
  where the stream happened to be chopped,
* :mod:`session_state` — the stateful aggregation that is the actual defence
  against evidence dispersed below any single window's threshold,
* :mod:`consumption` — C-2 and C-3, the gate that decides whether a downstream
  task may read,
* :mod:`output_checks` — C-4, which the input verdict cannot cover.

**C-5 is the invariant that outranks all of them**: nothing in this package
returns text, and nothing in it can express "remove this". Guardrails constrain
what the agentic loop consumes and emits; they do not edit the clinical record.
"""
