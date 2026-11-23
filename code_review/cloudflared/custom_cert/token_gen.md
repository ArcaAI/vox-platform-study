# token_gen.md — Free wildcard TLS for `*.vox2.arcaai.com`

Runbook to fix HTTPS for **all** two-level `*.vox2.arcaai.com` hosts by issuing a
**free Let's Encrypt wildcard certificate** and uploading it to Cloudflare as a
**custom edge certificate**. No renaming, no Ingress/rebuild/CORS changes.

---

## Why this is needed

Cloudflare's free **Universal SSL** certificate covers only:

```
subject = CN=arcaai.com
SAN     = *.arcaai.com, arcaai.com
```

`*.arcaai.com` matches **one** label. So:

| Hostname | Covered? | TLS result |
|---|---|---|
| `arcaai.com` | ✅ | works |
| `vox2.arcaai.com` (1 label) | ✅ | works (307) |
| `grafana.vox2.arcaai.com` (2 labels) | ❌ | **handshake failure (alert 40)** |
| `vault.vox2`, `temporal.vox2`, `api.vox2`, `guardrail.vox2`, `harness.vox2`, `nlp.vox2`, `stt.vox2`, `text.vox2`, `tts.vox2`, `prometheus.vox2`, `alertmanager.vox2`, `admin.vox2` | ❌ | **handshake failure** |

The paid fix is **Total TLS** / **Advanced Certificate Manager**. This runbook is
the **free** fix: upload a wildcard cert that covers `*.vox2.arcaai.com`, so
Cloudflare serves it for every `x.vox2.arcaai.com` name. The cluster side
(Ingresses, Traefik, tunnel routes) is already correct — only the cert is missing.

> **Cost:** $0. **Trade-off:** manually renew + re-upload roughly every 90 days
> (Let's Encrypt validity), see "Renewal".

---

## What you will produce

- `fullchain.pem` + `privkey.pem` for `vox2.arcaai.com` **and** `*.vox2.arcaai.com`
- The certificate uploaded to Cloudflare → served for all `x.vox2.arcaai.com` hosts.

---

## Prerequisites

- **Docker** running locally (`docker version`).
- Access to the Cloudflare **`arcaai.com`** zone (to create a token and upload the cert).
- An **email address** for the Let's Encrypt account (expiry notices only).

Set a working directory once (adjust if you like):

```bash
export WORK="$HOME/cf-le"
mkdir -p "$WORK/letsencrypt"
```

---

## Step 1 — Create a scoped Cloudflare API token

DNS-01 needs a token that can create the `_acme-challenge` TXT record. Keep it
minimal.

1. Go to <https://dash.cloudflare.com> and log in.
2. Top-right profile icon → **My Profile** → **API Tokens** → **Create Token**.
3. Choose the template **"Edit zone DNS"** → **Use template**.
4. Set:
   - **Permissions:** `Zone` → `DNS` → `Edit`
   - **Zone Resources:** `Include` → `Specific zone` → **`arcaai.com`**
   - Client IP Address Filtering / TTL: leave default (or restrict if you know your egress IP).
5. **Continue to summary** → **Create Token**.
6. **Copy** the token (shown once). It looks like a long string.

> The token only needs **DNS:Edit on `arcaai.com`**. Never use a Global API Key.

---

## Step 2 — Store the token securely

Put **only** the token in a file with `600` perms (do not paste it into chat):

```bash
printf '%s' 'PASTE_THE_TOKEN_HERE' > "$WORK/cf.ini.part"
chmod 600 "$WORK/cf.ini.part"
```

Create the certbot credentials file (this exact format):

```bash
printf 'dns_cloudflare_api_token = %s\n' "$(cat "$WORK/cf.ini.part")" > "$WORK/cf.ini"
chmod 600 "$WORK/cf.ini"
rm -f "$WORK/cf.ini.part"
cat "$WORK/cf.ini"   # sanity check: one line, your token
```

---

## Step 3 — Issue the wildcard certificate (Docker, DNS-01)

Uses the official `certbot/dns-cloudflare` image. Replace `you@example.com`.

```bash
docker run --rm \
  -v "$WORK/letsencrypt:/etc/letsencrypt" \
  -v "$WORK/cf.ini:/cloudflare.ini:ro" \
  certbot/dns-cloudflare certonly \
    --dns-cloudflare \
    --dns-cloudflare-credentials /cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 \
    -d 'vox2.arcaai.com' -d '*.vox2.arcaai.com' \
    --agree-tos --no-eff-email \
    -m 'you@example.com'
```

- **DNS-01** creates a temporary `_acme-challenge.vox2.arcaai.com` TXT record,
  waits 30s, and deletes it. Nothing else on the zone is touched.
- On Apple Silicon, if the image errors on architecture, add
  `--platform linux/amd64` right after `docker run --rm`.

Expect output ending with:

```
Successfully received certificate.
Certificate is saved at: /etc/letsencrypt/live/vox2.arcaai.com/fullchain.pem
Key is saved at:         /etc/letsencrypt/live/vox2.arcaai.com/privkey.pem
```

---

## Step 4 — Verify the issued files

```bash
ls -l "$WORK/letsencrypt/live/vox2.arcaai.com/"
# expect: cert.pem  chain.pem  fullchain.pem  privkey.pem
openssl x509 -in "$WORK/letsencrypt/live/vox2.arcaai.com/fullchain.pem" \
  -noout -subject -ext subjectAltName
# expect: DNS:vox2.arcaai.com, DNS:*.vox2.arcaai.com
```

---

## Step 5 — Upload the certificate to Cloudflare

1. <https://dash.cloudflare.com> → open the **`arcaai.com`** zone.
2. Go to **SSL/TLS → Edge Certificates**.
3. Find **Custom Certificates** → **Upload Custom Certificate**
   (button label may be **Upload Custom Certificate** / **Upload**).
4. Fill in:
   - **Certificate:** paste the whole contents of `fullchain.pem`
     ```bash
     cat "$WORK/letsencrypt/live/vox2.arcaai.com/fullchain.pem"
     ```
   - **Private Key:** paste the whole contents of `privkey.pem`
     ```bash
     cat "$WORK/letsencrypt/live/vox2.arcaai.com/privkey.pem"
     ```
   - **Name / label:** `vox2-wildcard-le` (any).
   - Leave the method as default; **Save**.
5. Cloudflare should show the certificate as **Active** for
   `vox2.arcaai.com` and `*.vox2.arcaai.com`.

> If **Upload Custom Certificate** isn't offered on your plan, use
> **SSL/TLS → Custom Hostnames (Cloudflare for SaaS)** for the individual hosts
> (free tier includes 100), or order an **Advanced Certificate** for
> `vox2.arcaai.com` + `*.vox2.arcaai.com` (paid).

---

## Step 6 — Verify the fix

From any machine with internet:

```bash
# cert now covers the two-level names
printf '' | openssl s_client -connect grafana.vox2.arcaai.com:443 \
  -servername grafana.vox2.arcaai.com 2>/dev/null \
  | openssl x509 -noout -ext subjectAltName
# expect: DNS:vox2.arcaai.com, DNS:*.vox2.arcaai.com

# each host now completes TLS + reaches Traefik
for h in grafana.vox2.arcaai.com prometheus.vox2.arcaai.com \
         alertmanager.vox2.arcaai.com vault.vox2.arcaai.com \
         temporal.vox2.arcaai.com api.vox2.arcaai.com; do
  printf '%-30s ' "$h"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 "https://$h"
done
```

Expected: TLS no longer `alert 40`; codes are 200/302 (Grafana `/login`,
Prometheus `/graph`, Alertmanager `/`, etc.). `curl` returning `000` meant a TLS
handshake failure — that should be gone.

---

## Step 7 — Clean up the token

Once the cert is issued and uploaded, delete the token file (and optionally revoke
the token in the dashboard):

```bash
rm -f "$WORK/cf.ini"
```

---

## Renewal (every ~90 days)

Let's Encrypt certs last 90 days. Before expiry, re-issue and re-upload:

1. Re-create `$WORK/cf.ini` (Step 2) with a token (reuse the same token if it
   still exists, otherwise create a new one per Step 1).
2. Re-run Step 3 **with `--force-renewal`**:
   ```bash
   docker run --rm \
     -v "$WORK/letsencrypt:/etc/letsencrypt" \
     -v "$WORK/cf.ini:/cloudflare.ini:ro" \
     certbot/dns-cloudflare certonly \
       --dns-cloudflare \
       --dns-cloudflare-credentials /cloudflare.ini \
       --dns-cloudflare-propagation-seconds 30 \
       -d 'vox2.arcaai.com' -d '*.vox2.arcaai.com' \
       --agree-tos --no-eff-email --force-renewal \
       -m 'you@example.com'
   ```
3. In Cloudflare → **SSL/TLS → Edge Certificates → Custom Certificates**, open
   `vox2-wildcard-le` → **Replace** / re-upload the new `fullchain.pem` +
   `privkey.pem`.
4. Delete `$WORK/cf.ini` again.

Set a calendar reminder ~75 days after upload. (This manual renewal is the only
downside versus the paid Total TLS option.)

---

## Rollback

- Cloudflare → **SSL/TLS → Edge Certificates → Custom Certificates** → delete
  `vox2-wildcard-le`. The zone reverts to the Universal SSL `*.arcaai.com` cert
  (two-level hosts fail TLS again, exactly as before). No cluster change is
  involved.

---

## Reference — hosts this certificate fixes

Served by Traefik (traefik IngressClass) in namespaces
`project-hope-vox` and `project-hope-vox-infra`:

```
api.vox2.arcaai.com          text.vox2.arcaai.com
tts.vox2.arcaai.com          guardrail.vox2.arcaai.com
nlp.vox2.arcaai.com          harness.vox2.arcaai.com
stt.vox2.arcaai.com          vault.vox2.arcaai.com
temporal.vox2.arcaai.com     grafana.vox2.arcaai.com
prometheus.vox2.arcaai.com   alertmanager.vox2.arcaai.com
admin.vox2.arcaai.com  (defined in the tunnel; add an Ingress to route it)
```

`vox2.arcaai.com` (apex/one-label) already works and is unaffected.
All tunnel public hostnames point at
`http://traefik.project-hope-vox.svc.cluster.local:80` with `httpHostHeader`
**not** set.
