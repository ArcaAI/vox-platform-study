# Custom certificate — wildcard TLS for `*.vox2.arcaai.com`

Docs for the **custom-certificate** approach to HTTPS on two-level
`x.vox2.arcaai.com` hosts: issue a certificate covering `*.vox2.arcaai.com` and
upload it to Cloudflare as a **custom edge certificate**.

## Contents

| File | What |
|---|---|
| `token_gen.md` | Step-by-step runbook: scoped Cloudflare API token → `certbot/dns-cloudflare` DNS-01 issuance → upload to Cloudflare → verify → renewal → rollback. |

## Status: superseded by the rename

This approach was **not** used. The chosen fix is to rename the in-cluster
hostnames to **single-label** names (`grafana-vox2.arcaai.com`, `api-vox2.arcaai.com`,
…) so Cloudflare's free **Universal SSL** (`*.arcaai.com`) covers them — no
custom certificate, no ~90-day manual renewal. See
[`../vox2-arcaai-com-routing.md`](../vox2-arcaai-com-routing.md).

Keep this folder as the **fallback** if you ever need to keep the two-level
`x.vox2.arcaai.com` hostnames without a paid Total TLS / Advanced Certificate
Manager plan (the trade-off is manual renewal every ~90 days).

For the current, routing-focused docs, see the parent folder
[`../`](../) (`vox2-arcaai-com-routing.md`, `steps_to_follow.md`, `README.md`,
`manifests/`).
