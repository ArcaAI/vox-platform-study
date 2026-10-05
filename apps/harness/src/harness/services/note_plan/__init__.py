"""NotePlan execution: run a composed plan's calls, merge their sections, check coverage.

apps/api composes the plan (one implementation, so the Prompt Inspector shows what is sent); the
harness only executes it, on both the default ``harness-doc`` engine and the governed lane.
"""
