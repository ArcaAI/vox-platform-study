"""Phase-2 egress guards (TASK-330).

Guards sit on the boundary between the harness loop and anything that could send
clinical text off-box. The first guard is :mod:`harness.guards.phi` — a
fail-closed PHI redactor that must clear (or refuse) text before it egresses to a
cloud model/provider.
"""
