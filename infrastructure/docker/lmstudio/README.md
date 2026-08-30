# `hope-lmstudio` — LM Studio (`llmster`) headless GPU serving image

Ticket: **TASK-824**. Engine choice is an owner decision (ticket README §0):
**LM Studio + vLLM**. A prior lane recommended llama.cpp; that was considered and
overruled. Do not re-open it here.

> **CI IS THE ONLY BUILDER.** Owner directive, 2026-08-30. Do not run
> `docker build` for this image on a workstation — see §2 for why that is a
> correctness rule here and not a policy preference.
>
> Built by `.gitlab/ci/build.yml` → `build-lmstudio`, gated by
> `verify-lmstudio-runtime`.

> **PRIVATE REGISTRY ONLY.** The image embeds a proprietary binary we hold no
> redistribution right to (ticket §0 risk A-5, §5 L-2). Never push it to a
> public registry or mirror.

---

## 1. Files

| File | What |
|---|---|
| `Dockerfile` | Single-stage. Pinned + SHA-512-verified `llmster` bundle on a CUDA runtime base |
| `entrypoint.sh` | The boot contract: eight ordered assertions, each fail-closed with exit 78 |
| `.dockerignore` | Context is these two files and nothing else |

Deployment manifests are staged separately, at
`docs/implementation/TASK-824-LM-Studio-Service/deployment-llmster/`.

---

## 2. The silent-CPU trap, and the three places it is closed

`curl -fsSL https://lmstudio.ai/install.sh | bash` chooses its bundle by probing
the **build host**. Re-verified against the live script on 2026-08-30:

```
install.sh:243  get_release_name()   "Linux x86_64" -> full${_bundle_suffix}
install.sh:594  get_linux_x86_full_bundle_suffix()
                  -> "+cuda12" if supports_cuda_12_4_or_newer, else ""
install.sh:586  _minimum_driver_version="550.54.14"
install.sh:447  if ! check_cmd nvidia-smi; then echo ""; return 0
install.sh:442  if ! check_cmd timeout;    then echo ""; return 0
```

That last line is a **second trigger the ticket did not record**: a builder
lacking coreutils `timeout` gets the CPU bundle **even on a GPU host**. So there
are two independent ways to silently produce a CPU-only image — and such an
image *starts, serves and answers requests*, just far slower.

A GPU-less CI runner (or any laptop) hits this every single time. Hence: never
pipe the installer. The three layers that close it:

| Layer | Closes | Mechanism |
|---|---|---|
| **Dockerfile** | wrong bundle downloaded | Fetch one pinned URL; verify a pinned SHA-512. The CPU and CUDA bundles are provably different artifacts, so a CPU tarball cannot satisfy the check and the build aborts |
| **CI `verify-lmstudio-runtime`** | wrong bundle shipped | Runs the built image and asserts `lms runtime ls` lists a CUDA engine. Red pipeline ⇒ never promoted |
| **`entrypoint.sh` A-2** | right image, wrong **node** | Selects the CUDA engine and asserts a GPU is actually present. Exit 78 |

Published SHA-512 values, fetched 2026-08-30:

```
0.0.23-1-linux-x64.full+cuda12.tar.gz   145d84440b8797614edb39b1019085c90fbc215c…  <- pinned
0.0.23-1-linux-x64.full.tar.gz          29464e0cc52bdf31f6feb9d280d1f499cbef494f…  <- CPU
```

**Mirror the tarball into our own artifact store.** There is no guarantee
`0.0.23-1` stays fetchable, and the version is a literal in the installer with
no env override.

### Why the third layer is not redundant

Ticket §8.4 establishes that a CPU-only deployment is **undetectable over
HTTP**: `/api/v1/models` reports `format: "gguf"` — a weights format, not an
accelerator — and no `/api/v1/(runtime|engine|system|server)` path exists.
Runtime introspection lives only on the WebSocket RPC channel. So if a correct
image lands on a node without `runtimeClassName: nvidia`, without the
`nvidia.com/gpu` resource, or below the 550.54.14 driver floor, **nothing
downstream can ever tell**. A-2 is the only place it is catchable.

---

## 3. Measured facts about `llmster` 0.0.23-1

Observed by running the **vendor's own binary** in a container, 2026-08-30
(arm64 bundle — see §4 for what that qualifies). Several correct the ticket.

### 3.1 `lms` exits 0 whether or not the thing you asked about is true

| Command | Situation | Exit | Output |
|---|---|---|---|
| `lms server status` | daemon not started at all | **0** | — |
| `lms daemon status` | daemon down | **0** | `LM Studio is not running` |
| `lms daemon status` | daemon up | **0** | `llmster v0.0.23+1 is running (PID: 16)` |
| `lms runtime select <cuda>` | **no GPU in the machine** | **0** | `Selected …` |

**Every gate must match output text, never `$?`.** This is the same failure
shape as §4.11's HTTP hazard (200 for unknown paths → check the body) one layer
down in the CLI.

⚠️ **The ticket's published §4.7 wait-loop is broken by exactly this:**

```sh
for _ in $(seq 1 60); do lms server status >/dev/null 2>&1 && break; sleep 1; done
```

`lms server status` exits 0 immediately, so the loop breaks on its **first
iteration** and never waits for anything. Every later `lms` call then races the
daemon. `entrypoint.sh` A-1 uses `lms daemon status | grep -q 'is running'`.

### 3.2 The bundle ships BOTH engines and selects the CPU one by default

A fresh container reports:

```
LLM ENGINE                                    SELECTED    MODEL FORMAT
llama.cpp-linux-arm64@2.31.2                     ✓            GGUF
llama.cpp-linux-arm64-nvidia-cuda13@2.31.2                    GGUF
```

**Shipping the right bundle is necessary but not sufficient.** Without an
explicit `lms runtime select`, a correct CUDA image runs on CPU. This is a
second, independent silent-CPU path that §4.1 does not describe, and it is why
A-2 selects before it asserts.

Note the engine is named **cuda13**, not cuda12 — hence open item OI-4 on the
base-image minor. The entrypoint matches `cuda` generically.

### 3.3 GPU presence is readable, and only this way

`lms runtime survey --json` on a GPU-less host:

```json
"gpuSurveyResult": { "result": { "code": "noDevicesFound", … }, "gpuInfo": [] },
"memoryInfo": { "ramCapacity": 16820555776, "vramCapacity": 0, … }
```

`vramCapacity: 0` / `noDevicesFound` are the assertion targets. Plain
`lms runtime survey` prints `No GPUs detected`.

### 3.4 There IS directory discovery — §4.10's conclusion does not hold

The ticket establishes, three independent ways, that there is no rescan **verb**
(no CLI subcommand, no RPC method, no docs concept) and infers that a GGUF
dropped on the volume "is simply not visible". The evidence is correct; the
inference is not.

| Test | Result |
|---|---|
| GGUF at `<models>/<publisher>/<model>/x.gguf` **before** daemon start | **indexed at start** — `lms ls` shows it |
| GGUF dropped there **while the daemon runs**, no import, no restart | **indexed within seconds** — `lms ls` shows it |

There is no rescan command because the daemon watches the directory. "No rescan
API" and "no discovery" are different claims, and only the first was evidenced.

`entrypoint.sh` therefore **prefers the simple mechanism and verifies it**,
keeping `lms import` as the repair path — because bug #844 ("models missing
until the application is restarted") is open, so the watch is observed
behaviour, not a guarantee. The gate that matters is the assertion that every
expected key is visible before the server takes traffic.

### 3.5 `lms import`: `-L` works; omitting it **crashes**, it does not move

```
$ stat -c '%i %h %n' /data/staging/hope-test-model.gguf
62642053 1 /data/staging/hope-test-model.gguf
$ lms import … --user-repo hopetest/imported-model -y -L
Hard link created at /home/llmster/.lmstudio/models/hopetest/imported-model/hope-test-model.gguf
$ stat -c '%i %h %n' /data/staging/hope-test-model.gguf
62642053 2 /data/staging/hope-test-model.gguf      <- same inode, link count 1 -> 2
```

Control, **without** `-L`, in a TTY-less container:

```
W Warning about move suppressed by the --yes flag.
BadResource: ENOTTY: Not a typewriter
    at Stdin.setRaw (ext:deno_io/12_io.js:177:5)
… exit 1, nothing imported, staging untouched
```

So `-y` suppresses the *warning text* but the CLI still opens a TTY prompt and
dies without one. `-L`/`-c`/`-l` is mandatory — for a **different reason** than
the ticket gives (a hard failure, not a silent staging wipe), but mandatory
either way. A hard link cannot cross filesystems, so staging and the models tree
must be on the same PVC; A-3 asserts that with `stat -c %d` rather than
discovering it at 3am.

### 3.6 The model key comes from the directory, not the filename

Importing `hope-test-model.gguf` as `hopetest/imported-model` produced the key
`text-embedding-imported-model`.

Two consequences:

- The `<model>` segment of `--user-repo` **must equal the seed row's
  `sourceUri`**, because `resolveTextSelectionForKey` puts `sourceUri` on the
  wire as the OpenAI `model` field. A mismatch 404s every generation (§7.4).
- **LM Studio prepends `text-embedding-` for embedding models.** Directory
  `hope-embed-test` → key `text-embedding-hope-embed-test`. Naming a directory
  with the prefix already on it would double it.

### 3.7 Defaults are loopback on a random port

A fresh container's `~/.lmstudio/.internal/http-server.json`:

```json
{ "host": "127.0.0.1", "pid": 13, "port": 41343 }
```

`lms server start --help` says the port defaults to "the same port as the last
time it was started", and a fresh container has no last time. **Omitting
`--port` does not fall back to 1234.** Both `--port` and `--bind` are passed
explicitly.

Also: that file is **not** the live serving address — it still read
`127.0.0.1:41343` after `lms server start --port 1234 --bind 0.0.0.0` succeeded.
Never read the serving port from it.

### 3.8 Every unknown path returns HTTP 200

| Path | Status | Body |
|---|---|---|
| `/lmstudio-greeting` | 200 | `{"lmstudio":true}` |
| `/this-path-does-not-exist` | **200** | `{"error":"Unexpected endpoint or method…"}` |
| `/health` | **200** | `{"error":"Unexpected endpoint or method…"}` |
| `/metrics` | **200** | `{"error":"Unexpected endpoint or method…"}` |
| `/totally/bogus` | **200** | `{"error":"Unexpected endpoint or method…"}` |

**No k8s `httpGet` probe on this server can ever fail** — httpGet inspects only
the status code. Every probe in `lmstudio.yaml` is therefore an `exec` that
greps the body. Do not "simplify" them.

`/metrics` returning 200-with-an-error also settles the observability question:
**LM Studio exposes no Prometheus endpoint.** A regression versus llama.cpp,
recorded rather than hidden.

### 3.9 Readiness cannot be `/v1/models`

§4.3 proposes turning JIT off and gating on `/v1/models`. **There is no JIT
control anywhere in the CLI** — not on `lms server start`, not on `lms load`,
not on `lms server`. With JIT on, `/v1/models` lists every model *on disk*
regardless of load state (both test models appeared with nothing loaded),
exactly as §4.3 warns it would.

The working signal is `GET /api/v1/models` → per-model `loaded_instances[]`,
which is empty for a model merely on disk:

```json
{ "key": "text-embedding-hope-embed-test",
  "loaded_instances": [ { "id": "hope-ready-probe", "config": { "context_length": 2048 } } ] }
```

Passing a stable `lms load --identifier` makes that greppable, which is what the
readinessProbe does.

### 3.10 `$HOME` is respected as non-root

Bug #2093 reports `llmster` hardcoding `/root/.lmstudio` and ignoring `$HOME` in
containers. Not reproduced: as uid 10001 with `HOME=/home/llmster`, the install
landed in `/home/llmster/.lmstudio` with `.internal/llmster-install-location.json`
present, and the daemon started, served and ran inference from there.

⚠️ Qualified by §4 below — this is the finding most in need of CI re-confirmation,
because it is a property of *our image* rather than of the vendor CLI.

---

## 4. What these findings do and do not cover

**They were observed on the `linux-arm64` bundle**, in containers built locally
*before* the CI-only directive. They are retained because they are facts about
**the vendor's CLI and server**, and because several of them correct claims in
the ticket that the entrypoint would otherwise have been built on.

They are **not** evidence about the production artifact. Specifically **discarded**:
any claim that this image builds, its size, or that it runs non-root in the
shipped form.

The production image is `linux-x64` + `full+cuda12` on a CUDA base — a
**different bundle on a different architecture**. CI must confirm, on the first
`build-lmstudio` pipeline:

1. the pinned SHA-512 still matches (the build fails loudly if not);
2. `verify-lmstudio-runtime` finds a CUDA engine, and **which one** — this
   settles OI-4 (cuda12 vs cuda13) and therefore whether the CUDA 12.8 base is
   the right minor;
3. the x64 bundle runs on `nvidia/cuda:12.8.1-runtime-ubuntu24.04` at all
   (§4.9 item 4 — glibc and CUDA-runtime linkage are unverified);
4. the image runs as uid 10001 (bug #2093, on the x64 bundle).

Everything requiring an actual GPU — offload, VRAM residency, throughput, the
co-tenancy plan, and A-2 firing in its *positive* direction — remains unproven
until it runs on the node.
