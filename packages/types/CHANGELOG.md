# @arcaai/types — Changelog

## 4.0.1

No changes in this release.

## 4.0.0

### Major Changes

- TASK-1006 — `@arcaai/types` joins the vox SDK family's Changesets `fixed` group and versions in
  lockstep with it. `@arcaai/vox` depends on it (its declarations import from it), but the registry
  held only `0.1.0` while the source moved on, so a vox consumer resolved types that no longer
  matched — `consultation-context`, `api-key-presets`, `asr-model-profile` and more were missing.
  4.0.0 publishes the current surface. The manifest now carries the family's `publishConfig`
  (restricted, GitHub Packages) and `repository`, and ships only `dist` + `README.md`.
