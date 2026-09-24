"""stt's model-residency wiring (TASK-1005).

* ``wiring`` — the device, metrics and `CacheResidency` the model cache is built
  with. Imported by ``stt.models.cache``, so it must never import that module back.
* ``agent`` — the residency agent over stt's cache and its router, mounted by
  ``stt.main``. The Dramatiq worker builds the same cache (so it emits the
  residency metrics) but serves no routes.

Deliberately imports nothing here: ``stt.models.cache`` → ``stt.residency.wiring``
must not drag in ``agent`` (which imports the cache).
"""
