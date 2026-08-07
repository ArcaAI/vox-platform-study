# TASK-628 Reference — WebSocket Backpressure & Kubernetes Session Lifecycle

**Researched**: 2026-08-07 · Primary sources only; verified negatives and unverified claims are flagged explicitly.

---

## 0. The operational headline — and why HOPE dodged it

**`ingress-nginx` was retired in March 2026.** Per the Kubernetes [Steering Committee and Security Response Committee](https://www.kubernetes.io/blog/2026/01/29/ingress-nginx-statement/) (2026-01-29): *"There will be no more releases for bug fixes, security patches, or any updates of any kind after the project is retired."*

**HOPE is unaffected** — verified live: the cluster runs the k3s-bundled **Traefik** (`kubectl get ingressclass` → `traefik.io/ingress-controller`, 142 d), and the repo's only Ingress is `ingressClassName: traefik`.

This **withdraws** the suggestion in [Appendix A §A5](../TASK-616-Deployment-CICD-Observability-Modernization/sota-research-2026.md) to consider `--disable traefik` in favour of ingress-nginx for prod parity. Keeping Traefik is now correct. Future migrations should target **Gateway API**.

---

## 1. Backpressure — the protocol gives you nothing

### RFC 6455 is silent, and that is a verified negative
The full RFC (3,979 lines) was grepped: **zero occurrences of "flow control", "backpressure", or "congestion"**. There is no section to cite because none exists.

§1.7 is the operative statement: *"The WebSocket Protocol is an independent TCP-based protocol."* **Flow control is inherited from TCP and only TCP.**

**The consequence that matters**: a fast producer's only protocol-level backpressure is the TCP receive window. Everything above it — browser `bufferedAmount`, `ws`'s internal queue, uWS's buffer — is *userspace* buffering that will happily grow until memory is exhausted before TCP ever pushes back on the application.

### What the browser spec does say
[WHATWG WebSockets](https://websockets.spec.whatwg.org/) (Living Standard, 15 Mar 2026 — note the API split out of the HTML spec; `html.spec.whatwg.org/multipage/web-sockets.html` now 301s here).

There **is** a normative overflow rule, repeated for all four `send()` overloads:

> "…if the data cannot be sent, e.g. because it would need to be buffered but **the buffer is full**, the user agent must **flag the WebSocket as full** and then **close the WebSocket connection**."

So the spec's answer to "what if I keep sending?" is: **the UA closes the connection.** It deliberately specifies **no numeric threshold** — no watermark, no `drain` event. The only guidance is a non-normative example using `bufferedAmount == 0` as a gate, with the admission that saturating the link *"requires more careful monitoring of the value of the attribute over time."*

Two precision points:
- `bufferedAmount` is `unsigned long long` in the IDL. **MDN says `unsigned long` — that is stale/wrong**, and MDN omits the "buffer full → close" rule entirely. Do not treat MDN as authoritative here.
- **Browser JS cannot send close codes 1001/1011/1012** — `close()` throws `InvalidAccessError` unless the code is 1000 or 3000–4999. Those are **server→client only**.

### WebSocketStream is not an option
Chrome-only (`chrome: 124` per browser-compat-data — a widely-repeated "119" is wrong), **`firefox: false`, `safari: false`**, `standard_track: false`, `spec_url: null`. MDN carries a **"Non-standard"** banner. The WHATWG PR ([whatwg/websockets#48](https://github.com/whatwg/websockets/pull/48)) has been **open and untouched since 2024-10-13**. Not viable for a cross-browser clinical app.

### Node / `ws` — there is no `drain`
[Node streams](https://nodejs.org/api/stream.html) define the canonical mechanism: `write()` returns `false` past `highWaterMark` (default **16 KB**), emit `'drain'` when it's safe to resume, and *"Never call `.write()` after it returns false."* Critically: *"`highWaterMark` is **a threshold, not a limit**… It does not enforce a strict memory limitation."*

But **`ws` does not expose it.** Verified negative: the strings `backpressure`, `drain`, and `highWaterMark` **do not appear anywhere in `ws`'s documentation**, and `ws.send()` returns `undefined`, not a boolean. The maintainer's own answer ([websockets/ws#1218](https://github.com/websockets/ws/issues/1218)):

> "Currently the proper way to handle this is by using the `WebSocket#send()` callback which is invoked when the data is written out."

The sanctioned alternative is `createWebSocketStream(ws)`, which gives real `write()`/`drain()` semantics. Also note `ws`'s `bufferedAmount` **deviates from the HTML standard** — it returns 0 if data was sent immediately, and it *includes* framing bytes.

⚠️ Reported bug worth testing in your own stack rather than trusting: [ws#1643](https://github.com/websockets/ws/issues/1643) claims **`drain` never fires over `wss`/TLS**. Existence verified; thread contents not.

### What production systems actually do — four documented strategies

| Strategy | Source |
|---|---|
| **Drop the frame, keep the connection** | uWebSockets: `send()` returns `BACKPRESSURE \| SUCCESS \| DROPPED`; with `maxBackpressure` set, an oversized send is *"canceled and send will return DROPPED"* — *"essential when using pub/sub as a slow receiver otherwise could build up a lot of backpressure"* |
| **Close the connection** | WHATWG spec, above |
| **Rate-limit the producer by contract** | Deepgram: *"a maximum of 1.25x realtime"*, buffers *"between 20 and 100 milliseconds of audio"* ⚠️ what the server does on over-rate is undocumented |
| **Pause the producer via stream `drain`** | Node streams; `ws` only via `createWebSocketStream` |

**Relevance to HOPE**: the gateway relays STT results to the browser over WS. If a client stalls, the server-side buffer grows unbounded with no signal. uWS's drop-the-frame posture is the closest match to clinical semantics — losing a *partial* caption frame is far better than closing a consultation's socket. HOPE already has a `{type:'gap'}` message for exactly this; TASK-628 found the SDK has no handler for it.

---

## 2. Kubernetes pod lifecycle — the documented races

### The deregistration race is official, not folklore
[Pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination):

> "**At the same time as** the kubelet is starting graceful shutdown of the Pod, the control plane evaluates whether to remove that shutting-down Pod from EndpointSlice objects…"

> "Pods that shut down slowly should not continue to serve regular traffic and **should start terminating and finish processing open connections. Some applications need to go beyond finishing open connections and need more graceful termination, for example, session draining and completion.**"

> "Terminating endpoints always have their `ready` status as `false`… **If traffic draining on terminating Pod is needed, the actual readiness can be checked as a condition `serving`.**"

Also documented: container stop requests are processed **asynchronously with no ordering guarantee**; and if the kubelet restarts mid-termination, *"the cluster retries from the start including the full original grace period."*

### `preStop` semantics that are easy to get wrong
[Container lifecycle hooks](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/):

> "**The Pod's termination grace period countdown begins before the `PreStop` hook is executed**."
> "**`PreStop` hooks are not executed asynchronously from the signal to stop the Container; the hook must complete its execution before the TERM signal can be sent.**"

So `preStop` **eats into** `terminationGracePeriodSeconds` — it does not extend it. (The kubelet grants a one-off 2 s extension if the hook overruns.) The native **`Sleep`** handler is the modern, shell-free form — relevant because HOPE currently uses `exec: ["sh","-c","sleep 10"]`, which needs a shell in the image.

The [official drain tutorial](https://kubernetes.io/docs/tutorials/services/pods-and-endpoint-termination-flow/) deliberately sets `preStop` sleep **longer** than the grace period (180 s vs 120 s) — *"all this time nginx will keep processing requests"* — because the container keeps serving normally until SIGKILL.

### A trap worth knowing
[Graceful node shutdown](https://kubernetes.io/docs/concepts/cluster-administration/node-shutdown/) is feature-gated **on** by default since 1.21 — but *"by default, both `shutdownGracePeriod` and `shutdownGracePeriodCriticalPods` are set to zero, **thus not activating** the graceful node shutdown functionality."* Enabled-but-inert unless explicitly configured. Worth checking on VM 200 before assuming a node reboot drains anything.

---

## 3. Session affinity — and why it barely matters for WebSockets

`Service.spec.sessionAffinity: ClientIP` with `.spec.sessionAffinityConfig.**clientIP**.timeoutSeconds` (default **10800** = 3 h; unsupported on Windows). ⚠️ Note the nested `clientIP` level, which third-party writeups routinely omit. And `ClientIP` is near-useless behind a proxy or NAT — every client presents the LB's address. *(Operational fact; the K8s docs don't say it.)*

**On AWS ALB, stickiness is a non-issue for WebSockets** — this is documented verbatim:

> "**WebSocket connections are inherently sticky. If the client requests a connection upgrade to WebSockets, the target that returns an HTTP 101 status code to accept the connection upgrade is the target used in the WebSockets connection. After the WebSockets upgrade is complete, cookie-based stickiness is not used.**"

The knob that *does* matter on ALB is `deregistration_delay.timeout_seconds` (**default 300 s**), and there is a sharp failure mode:

> "**If a deregistering target terminates the connection before the deregistration delay elapses, the client receives a 500-level error response.**"

**So on EKS the pod's `terminationGracePeriodSeconds` must be ≥ the deregistration delay, or clients get 500s during every rollout.** This is the concrete version of the warning in [Appendix G §G7](../TASK-616-Deployment-CICD-Observability-Modernization/component-design-zero-downtime-ha.md).

⚠️ **Verified negative, and important**: ingress-nginx's docs contain **no statement that NGINX config reloads drop WebSocket connections**. The behavior is well-attested in issues (#2461, #7115, #2647, #9516, #5167 — existence verified, threads not read) but **undocumented**. `worker-shutdown-timeout` (default `240s`) is the (undocumented-for-this-purpose) mitigation. Moot for HOPE given Traefik, but relevant if an ingress migration is ever considered.

---

## 4. Close codes — 1012 confirmed, with a precision correction

RFC 6455 §7.4.1 defines exactly: 1000, 1001, 1002, 1003, 1004(reserved), 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1015. **1012, 1013, 1014 are absent — verified by reading the full section.**

The [IANA registry](https://www.iana.org/assignments/websocket/close-code-number.csv) (updated 2026-06-10) registers them separately:

```
1012, Service Restart,   [Alexey_Melnikov], [IETF mail-archive message]
1013, Try Again Later,   [Alexey_Melnikov], [IETF mail-archive message]
1014, Bad Gateway,       [Alexey_Melnikov], [IETF mail-archive message]
```

So **1012 "Service Restart" is IANA-registered but not RFC-defined**, and its reference is a mailing-list message, not an RFC. ⚠️ Precision correction to a common framing: 1000–2999 is reserved for *"this protocol, its future revisions, and extensions"* — **3000–3999** is the range reserved for libraries/frameworks/applications, and 4000–4999 for private use.

**Practical consequence for HOPE's drain design**: 1012 is a sound choice for a server-initiated restart close — but it is **server→client only** (browsers cannot send it), and you must **verify the client library surfaces `event.code === 1012` rather than collapsing it to 1006**. If it collapses, the SDK cannot distinguish "planned restart, reconnect immediately" from "network died."

---

## 5. Externalizing session state — genuinely undocumented territory

⚠️ **This is the single biggest primary-source gap found.** There is **no RFC, no Kubernetes doc, no CNCF whitepaper, and no AWS/Azure/GCP architecture page** addressing WebSocket session continuity across pod restarts. Everything on the specific pattern — Redis connection registries, transient-drop vs pod-eviction discrimination, TTL-keyed resume, sequence replay — is **blogs and one product doc**.

What *is* primary:

- **[12-Factor, Factor VI](https://12factor.net/processes)**: *"Twelve-factor processes are stateless and share-nothing… **Sticky sessions are a violation of twelve-factor and should never be used or relied upon.**"* Session state belongs in *"a datastore that offers time-expiration, such as Memcached or Redis."*
- **[Socket.IO](https://socket.io/docs/v4/using-multiple-nodes/)** — the best framework-level source, and it separates two concerns HOPE should keep separate too:
  - *"**When you configure the Socket.IO client to not use HTTP long-polling (using only WebSocket or WebTransport), sticky sessions are no longer required.**"* — stickiness solves *handshake/transport continuity*.
  - The **Redis adapter** solves *cross-instance message fan-out*. It does **not** make a connection survive a pod restart.

**The defensible position** is the composition of three separately-documented facts: (1) endpoints deregister concurrently with SIGTERM, so you need `preStop` + adequate grace; (2) signal a restart with **1001** (RFC) or **1012** (IANA) so the client reconnects rather than erroring; (3) state that must outlive the process goes in a time-expiring external store.

Anything more specific — the reconnect state machine, resume tokens, sequence replay — **is industry folklore, not documented practice.** Design it deliberately; don't cite a spec for it. HOPE's `{type:'resume', sessionId, lastSeq}` protocol is genuinely novel work, which is consistent with the [vendor survey](./vendor-reconnect-research.md) finding that no ASR vendor ships resumption at all.

---

## 6. Unverified — do not cite as primary

1. Envoy's "1 MiB default `per_connection_buffer_limit_bytes`" — asserted in search results; **absent** from the Envoy flow-control FAQ.
2. ingress-nginx reloads dropping WS connections — issues exist; **undocumented**; threads unread.
3. WebKit's / Mozilla's stated position on WebSocketStream — issue exists, text unread.
4. Deepgram's server behavior when audio exceeds 1.25× realtime — undocumented.
5. OpenAI Realtime backpressure/rate guidance — **verified negative**; only a 15 MB per-chunk cap exists.
6. Envoy Gateway's WebSocket/long-lived-stream behavior and its `terminationGracePeriodSeconds` relationship — **verified negative** on the official page; circulating claims are blog-sourced.
7. Envoy's treatment of connections still open when `--drain-time-s` expires — the draining page does not say.
8. Any official source for WebSocket session-state externalization across pod restarts — **none found**.
