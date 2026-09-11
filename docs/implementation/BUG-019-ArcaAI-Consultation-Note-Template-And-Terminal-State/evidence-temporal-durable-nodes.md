# BUG-019 — decoded Temporal evidence for §2.8

Captured from `http://localhost:8233/api/v1/namespaces/default/workflows/workflow-interpreter-<runId>/history`
while the dev stack was still running, on 2026-09-11, before the stack was stopped. Only the
**durable-lane** activities are reproduced here; the `base64` `activityTaskScheduledEventAttributes.input`
payloads have been decoded and trimmed to the fields the ticket reasons about
(`node_id`, `node_type`, `config`, `bound_inputs`). Long strings are truncated with `…`.


## Run A — FAILED — run `01a08c97-4de5-7eab-8d6d-74f50c41b396`

| time (UTC) | node_id | node_type | agent | bound_inputs |
|---|---|---|---|---|
| 18:32:01 | `n_trigger` | `core.trigger` | `—` | `{}` |
| 18:34:18 | `n_visit` | `core.condition` | `—` | `{"in": "്ലർ. ആ. Was there anything? Because what we can do is, well, we're talking ്ലർ ആയിൽ നിന്ന് വെച്ചിട്ടുണ്ട്. ്ലർ. ആരെ. ്ലർ. ആ. ്ല്ലോ. ആ. Dr. Sha…` |
| 18:34:18 | `n_finalize` | `core.agent` | `casenote-finalization` | `{"in": ""}` |
| 18:34:18 | `n_output` | `core.output` | `—` | `{}` |

`n_finalize` node config, verbatim:

```json
{
 "agentRef": {
  "slug": "casenote-finalization"
 },
 "dna": {
  "enabled": true
 },
 "execution": {
  "cadence": "onEnd",
  "lane": "durable"
 },
 "guardrail": {
  "enabled": true
 },
 "onError": "fail"
}
```


## Run B — COMPLETED — run `01a08ca7-6325-7faf-b2b2-a1b8ac217447`

| time (UTC) | node_id | node_type | agent | bound_inputs |
|---|---|---|---|---|
| 18:49:35 | `n_trigger` | `core.trigger` | `—` | `{}` |
| 18:57:09 | `n_visit` | `core.condition` | `—` | `{"in": "ത്സ്റെ എന്ന് പറഞ്ഞാൽ നിന്ന് വെച്ചാൽ ത്സ്സേസം. -സ്റ്റെ എന്ന് പറഞ്ഞു. ത്സർത്ത്ത്തോളം"}` |
| 18:57:10 | `n_finalize` | `core.agent` | `casenote-finalization` | `{"in": "The patient reported a terrible headache that looked 'really bad'.\n\nThe patient reported a terrible headache that looked 'really bad'. The p…` |
| 18:57:35 | `n_output` | `core.output` | `—` | `{"in": {"case_note": "The patient reported a terrible headache that looked 'really bad'. The patient elaborated on the headache, stating it started ab…` |

`n_finalize` node config, verbatim:

```json
{
 "agentRef": {
  "slug": "casenote-finalization"
 },
 "dna": {
  "enabled": true
 },
 "execution": {
  "cadence": "onEnd",
  "lane": "durable"
 },
 "guardrail": {
  "enabled": true
 },
 "onError": "fail"
}
```


`n_summary_new` appears in **neither** run's durable schedule: it is `lane: realtime` and the
durable interpreter SKIPs it. The DEGRADED `"core.agent: nothing bound on \`in\`/\`context\`"` on run A
therefore came from `n_finalize`, bound to `{"in": ""}`. See §2.8.
