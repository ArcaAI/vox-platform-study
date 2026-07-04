# Security Audit Report: Shared/Utility Packages

**Project**: HOPE Healthcare AI Monorepo
**Scope**: `packages/ui`, `packages/utils`, `packages/exceptions`, `packages/logger`, `packages/med-ner`, `packages/pipeline`, `packages/tools`
**Date**: 2026-03-24
**Auditor**: Security Auditor Agent
**Standards**: OWASP Top 10 (2021), HIPAA Technical Safeguards

---

## Executive Summary

This report covers a comprehensive security audit of seven shared/utility packages in the HOPE healthcare AI monorepo. These packages form the foundational layer consumed by all applications (`apps/api`, `apps/smr`, `apps/stt-v2`, `apps/nlp`, `apps/ui-playground`, `apps/example`).

> **Note (2026-04-06)**: `apps/tts` and `apps/admin` referenced in the original audit no longer exist in the monorepo and have been removed from this report's scope.

### Overall Risk Assessment

| Rating | Description |
|--------|-------------|
| **MODERATE-HIGH** | No critical remote code execution vulnerabilities, but systemic gaps in PHI/PII protection, error information leakage, and input validation create a compound risk profile inappropriate for a HIPAA-regulated healthcare platform. |

### Findings by Severity

| Severity | Count | Packages Affected |
|----------|-------|-------------------|
| Critical | 1 | logger |
| High | 8 | ui (1), exceptions (3), logger (3), tools (2) |
| Medium | 18 | ui (4), utils (3), exceptions (3), logger (4), med-ner (4), pipeline (3), tools (4) |
| Low | 18 | ui (4), utils (3), exceptions (1), logger (2), med-ner (4), pipeline (3), tools (4) |
| Info | 16 | ui (3), utils (3), logger (3), med-ner (3), pipeline (4), tools (3) |
| **Total** | **61** | **7 packages** |

### Top 5 Systemic Risks

1. **No PHI/PII redaction in logging** — The logger package has zero sanitization, meaning any medical data passed to `logger.info()` goes to all transports in plaintext (HIPAA violation risk)
2. **Error information leakage pipeline** — Exceptions serialize stack traces, Prisma table/column names, entity IDs, and untyped metadata directly to HTTP responses
3. **XSS in UI components** — `innerHTML` injection in cool-mode, unsanitized `dangerouslySetInnerHTML` fallbacks, and unvalidated `href` props across multiple components
4. **Command injection in development tools** — `child_process.exec()` with string-interpolated user input in the Prisma commander
5. **Missing model integrity verification** — ML model downloads have no checksum verification, allowing compromised models to produce incorrect medical results

---

## Package-by-Package Analysis

---

## 1. `packages/ui/` — @arcaai/ui (Shared React Component Library)

### Summary

| Metric | Value |
|--------|-------|
| Files reviewed | 1,217 source files |
| Components reviewed | ~350+ |
| Dependencies | 63 production, 23 dev |
| Findings | 1 High, 4 Medium, 4 Low, 3 Info |

### Findings

| ID | Severity | Title | File | Lines | OWASP |
|----|----------|-------|------|-------|-------|
| UI-001 | High | `innerHTML` injection in CoolMode particle effect | `registries/magicui/cool-mode.tsx` | 105-110 | A03 |
| UI-002 | Medium | `dangerouslySetInnerHTML` with custom sanitizer in PostDetail | `registries/manifest/post-detail.tsx` | 447 | A03 |
| UI-003 | Medium | Unvalidated `href` props in multiple components | Multiple (6 files) | — | A03 |
| UI-004 | Medium | Unsanitized code in CodeComparison error fallback | `registries/magicui/code-comparison.tsx` | 79-80 | A03 |
| UI-005 | Medium | `window.open()` without URL validation in InvoiceHistory | `registries/billingsdk/invoice-history.tsx` | 139-143 | A03 |
| UI-006 | Low | `dangerouslySetInnerHTML` with Shiki/QR output (accepted risk) | Multiple code-block/QR components | — | A03 |
| UI-007 | Low | Sidebar cookie without `Secure` or `SameSite` flags | `shadcn/sidebar.tsx` | 86 | A05 |
| UI-008 | Low | Broad props spreading to DOM elements | Widespread (shadcn pattern) | — | — |
| UI-009 | Low | Theme toggle uses localStorage without sanitization | `custom/theme-toggle.tsx` | 18, 31 | A05 |
| UI-010 | Info | No hardcoded secrets detected | All files | — | — |
| UI-011 | Info | Well-implemented URL sanitization in tool-ui subsystem | `tool-ui/shared/media/sanitize-href.ts` | — | — |
| UI-012 | Info | No `eval()`, `Function()`, or `document.write()` usage | All files | — | — |

### UI-001: `innerHTML` Injection in CoolMode (High)

The `particle` prop is interpolated directly into `innerHTML` via template literals. If a consumer passes user-controlled data, arbitrary HTML/JS executes in the browser.

```105:110:packages/ui/src/components/registries/magicui/cool-mode.tsx
      particle.innerHTML = `<img src="${particleType}" width="${size}" height="${size}" style="border-radius: 50%">`
    } else {
      const fontSizeMultiplier = 3
      const emojiSize = size * fontSizeMultiplier
      particle.innerHTML = `<div style="font-size: ${emojiSize}px; line-height: 1; text-align: center; width: ${size}px; height: ${size}px; display: flex; align-items: center; justify-content: center; transform: scale(${fontSizeMultiplier}); transform-origin: center;">${particleType}</div>`
```

**Fix**: Use DOM APIs (`document.createElement`, `textContent`) instead of `innerHTML`.

### UI-003: Unvalidated `href` Props (Medium)

Multiple components render `<a href={...}>` with user-supplied URLs without protocol validation, enabling `javascript:` URL injection:

| File | Line |
|------|------|
| `registries/magicui/avatar-circles.tsx` | 25 |
| `registries/magicui/bento-grid.tsx` | 79, 98 |
| `registries/prompt-kit/source.tsx` | 61, 103 |
| `registries/ai-elements/sources.tsx` | 66 |
| `registries/tour/tour.tsx` | 345, 362 |
| `registries/blocks/app-sidebar.tsx` | 201 |

**Fix**: Extract and reuse the existing `sanitizeHref()` from `tool-ui/shared/media/sanitize-href.ts` across all components.

### UI-004: Unsanitized CodeComparison Error Fallback (Medium)

```79:80:packages/ui/src/components/registries/magicui/code-comparison.tsx
        setHighlightedBefore(`<pre>${beforeCode}</pre>`)
        setHighlightedAfter(`<pre>${afterCode}</pre>`)
```

When Shiki fails, raw `beforeCode`/`afterCode` are interpolated into HTML and rendered via `dangerouslySetInnerHTML`. The `tool-ui/code-block` correctly escapes in its error handler — this component should follow that pattern.

**Fix**: HTML-escape the fallback content before wrapping in `<pre>` tags.

---

## 2. `packages/utils/` — @arcaai/utils (Shared Utilities)

### Summary

| Metric | Value |
|--------|-------|
| Files reviewed | 20 (14 source + 4 test + 2 config) |
| Lines of code | ~2,150 |
| Dependencies | 1 runtime (`@arcaai/types`) |
| Findings | 0 High, 3 Medium, 3 Low, 3 Info |

### Findings

| ID | Severity | Title | File | Lines | OWASP |
|----|----------|-------|------|-------|-------|
| UTL-001 | Medium | Cryptographically insecure UUID and random string generation | `src/string.ts` | 54-72 | A02 |
| UTL-002 | Medium | No URL validation on model download sources (SSRF) | `src/ModelLoader.ts`, `src/ModelSourceManager.ts` | 74-76, 46-51 | A10 |
| UTL-003 | Medium | HuggingFace token stored in memory without protection | `src/ModelSourceManager.ts` | 16-17 | A02/A07 |
| UTL-004 | Low | Email regex allows some invalid formats | `src/validation.ts` | 9 | A03 |
| UTL-005 | Low | `loadFromPath` has no path sanitization | `src/ModelLoader.ts` | 204-212 | A01 |
| UTL-006 | Low | Model checksum not verified after download | `src/ModelDownloader.ts` | 64-156 | A08 |
| UTL-007 | Info | Console logging of potentially sensitive information | Multiple model files | — | A09 |
| UTL-008 | Info | Non-null assertion on `this.db!` | `src/ModelDownloader.ts` | 171-255 | — |
| UTL-009 | Info | Singleton patterns use module-level mutable state | Multiple files | — | — |

### UTL-001: Insecure Random Generation (Medium)

Both `randomString()` and `generateUUID()` use `Math.random()`, which is not cryptographically secure:

```54:61:packages/utils/src/string.ts
export function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
```

**Fix**: Use `crypto.getRandomValues()` for `randomString()` and `crypto.randomUUID()` for `generateUUID()`.

### UTL-006: Model Checksum Not Verified (Low)

The `ModelConfig` interface defines an optional `checksum` field that is never verified after download. In a healthcare AI platform, a tampered model could produce incorrect medical transcriptions.

```10:16:packages/utils/src/ModelDownloader.ts
export interface ModelConfig {
  name: string;
  url: string;
  version: string;
  size?: number;
  checksum?: string; // NEVER VERIFIED
}
```

**Fix**: Verify SHA-256 checksum via `crypto.subtle.digest()` after every download.

---

## 3. `packages/exceptions/` — @arcaai/exceptions (Exception Handling)

### Summary

| Metric | Value |
|--------|-------|
| Files reviewed | 28 (package) + 2 (upstream consumers) |
| Dependencies | 1 runtime (`nestjs-cls`) |
| Findings | 3 High, 3 Medium, 1 Low |

### Findings

| ID | Severity | Title | File | Lines | OWASP |
|----|----------|-------|------|-------|-------|
| EXC-001 | High | Stack trace exposed in non-production environments | `common/base.exception.ts` | 51-53 | A05 |
| EXC-002 | High | Untyped `metadata` passthrough to client responses | `common/base.exception.ts` | 9, 31, 56 | A01/A04 |
| EXC-003 | High | Raw Prisma error messages and meta forwarded to client | `apps/api/src/interceptors/exception.interceptor.ts` | 65-74 | A05/A03 |
| EXC-004 | Medium | Full cause chain serialized via `JSON.stringify` | `common/base.exception.ts` | 55 | A05 |
| EXC-005 | Medium | Entity ID exposure in persistence exception messages | `backend/persistence/dataNotFound.exception.ts` | 21 | A01 |
| EXC-006 | Medium | Silent CLS failure with no fallback in BaseException | `common/base.exception.ts` | 35-36 | A09 |
| EXC-007 | Low | Application exceptions lack cause/metadata support | `backend/application/*.exception.ts` | — | A04 |

### EXC-001: Stack Trace Exposure (High)

The `toJSON()` method exposes full stack traces in any environment where `NODE_ENV !== 'production'` — including staging, QA, and development:

```51:53:packages/exceptions/src/common/base.exception.ts
            stack:
                process.env['NODE_ENV'] === 'production'
                    ? undefined
                    : this.stack,
```

**Fix**: Default to NOT including stack traces. Use an explicit opt-in flag (`ENABLE_DEBUG_ERRORS=true`).

### EXC-002: Untyped Metadata Passthrough (High)

The `metadata` property is typed as `unknown` and serialized directly into HTTP responses. A developer writing `throw new BusinessException('Validation failed', undefined, { patientId, diagnosis })` would expose PHI to the client:

```46:58:packages/exceptions/src/common/base.exception.ts
    public toJSON(): SerializedException {
        return {
            message: this.message,
            code: this.code,
            correlationId: this.correlationId,
            // ...
            metadata: this.metadata, // UNFILTERED
        };
    }
```

**Fix**: Separate client-facing serialization (`toJSON` with only message + code + correlationId) from logging serialization (`toLogJSON` with full details).

### EXC-003: Raw Prisma Errors to Client (High)

The exception interceptor forwards raw Prisma error messages containing table names, column names, and constraint names to HTTP responses:

```65:71:apps/api/src/interceptors/exception.interceptor.ts
                    const errorResponse = {
                        status: HttpStatus.BAD_REQUEST,
                        error: 'Prisma Error',
                        message: err.message,  // Contains table/column names
                        meta: err.meta,         // Contains model names
                        correlationId: requestId,
                    };
```

**Fix**: Return generic error messages to clients. Log detailed Prisma errors server-side only.

---

## 4. `packages/logger/` — @arcaai/logger (Logging)

### Summary

| Metric | Value |
|--------|-------|
| Files reviewed | 7 |
| Lines of code | ~600 |
| Dependencies | 3 runtime (winston, winston-daily-rotate-file, winston-s3-transport) |
| Findings | 1 Critical, 3 High, 4 Medium, 2 Low, 3 Info |

### Findings

| ID | Severity | Title | File | Lines | OWASP |
|----|----------|-------|------|-------|-------|
| LOG-001 | **Critical** | No PHI/PII redaction — arbitrary medical data logged | `src/index.ts` | 202-232 | A02/A04 |
| LOG-002 | High | Log injection — no CRLF or control character sanitization | `src/index.ts` | 143-150 | A03 |
| LOG-003 | High | S3 credentials accepted as plaintext constructor arguments | `src/index.ts` | 16-27, 49-61 | A02/A07 |
| LOG-004 | High | Credentials logged in test code | `src/__tests__/log.test.ts` | 39-67 | A05 |
| LOG-005 | Medium | No log level enforcement for production | `src/index.ts` | 69-97 | A05 |
| LOG-006 | Medium | No file permission controls on log transports | `src/index.ts` | 162-172 | A01/A05 |
| LOG-007 | Medium | `maxSize` parsing silently discards unit suffix | `src/index.ts` | 166-167 | A05 |
| LOG-008 | Medium | Transitive dependency vulnerability (CVE-2026-22036) | `package.json` | 18 | A06 |
| LOG-009 | Low | No audit trail / security event logging API | `src/index.ts` | — | A09 |
| LOG-010 | Low | `addTransport` allows arbitrary transport injection | `src/index.ts` | 198-200 | A04 |
| LOG-011 | Info | `@ts-ignore` suppresses type safety for S3 transport | `src/index.ts` | 3-4 | — |
| LOG-012 | Info | S3Transport imported but never used | `src/index.ts` | 4 | — |
| LOG-013 | Info | Default logger singleton is mutable global state | `src/index.ts` | 236-244 | — |

### LOG-001: No PHI/PII Redaction (Critical)

Every logging method accepts untyped `meta?: Record<string, any>` and passes it directly to Winston with zero inspection or redaction:

```202:232:packages/logger/src/index.ts
  error(message: string, meta?: Record<string, any> | any): void {
    this.logger.error(message, meta);
  }
```

The `printf` formatter serializes the entire `rest` spread via `JSON.stringify(rest)` without filtering:

```143:150:packages/logger/src/index.ts
    formatters.push(winston.format.printf((info: winston.Logform.TransformableInfo) => {
      const { timestamp, level, message, service, ...rest } = info;
      const metaStr = Object.keys(rest).length ? JSON.stringify(rest) : '';
      return `${timestampStr}${level}: ${serviceStr}${message} ${metaStr}`.trim();
    }));
```

A caller doing `logger.info("Patient lookup", { ssn: "123-45-6789", diagnosis: "Type 2 Diabetes" })` writes PHI to every configured transport in plaintext. **This is a HIPAA violation risk.**

**Fix**: Add a mandatory PHI/PII redaction Winston format that scrubs known-sensitive field patterns (`ssn`, `dob`, `patientName`, `diagnosis`, `medication`, etc.) and regex patterns (SSN: `\d{3}-\d{2}-\d{4}`, DOB: `\d{2}/\d{2}/\d{4}`) before any transport writes.

### LOG-002: Log Injection (High)

The `message` parameter on every log method is a raw string interpolated into log lines without sanitization. An attacker controlling input that reaches a log call can inject newline characters to forge log entries:

```
Input: "normal request\n2026-03-24 error: [auth] ADMIN ACCESS GRANTED"
```

This produces a forged log line indistinguishable from a real one.

**Fix**: Sanitize control characters (`\r`, `\n`, `\t`, `\x00-\x1f`) in the `printf` formatter before output.

### LOG-007: `maxSize` Parsing Bug (Medium)

`parseInt('10m')` returns `10` (bytes, not megabytes). Winston's File transport interprets `maxsize` as bytes, causing log rotation at 10 bytes instead of 10MB:

```165:168:packages/logger/src/index.ts
        maxsize: this.options.transports.file.maxSize
          ? parseInt(this.options.transports.file.maxSize)
          : undefined,
```

**Fix**: Parse human-readable sizes correctly with unit multipliers (b/k/m/g).

---

## 5. `packages/med-ner/` — @arcaai/med-ner (Medical NER)

### Summary

| Metric | Value |
|--------|-------|
| Files reviewed | 26 |
| Dependencies | 1 runtime (`@huggingface/transformers`) |
| Findings | 2 High, 4 Medium, 4 Low, 3 Info |

### Findings

| ID | Severity | Title | File | Lines | OWASP |
|----|----------|-------|------|-------|-------|
| NER-001 | High | XSS via `highlightEntities()` — entity text injected as raw HTML | `src/utils/entityUtils.ts` | 238-257 | A03 |
| NER-002 | High | `MedNERResult` stores and broadcasts full original text (PHI exposure) | `src/types/index.ts`, `src/processors/MedNERProcessor.ts` | 284-295, 310-321 | A02/A01 |
| NER-003 | Medium | No input length validation — potential resource exhaustion | `src/processors/MedNERProcessor.ts` | 274-288 | A04 |
| NER-004 | Medium | Error messages leak model identity and internal details | `src/processors/MedNERProcessor.ts` | 256-259, 325-329 | A05 |
| NER-005 | Medium | E2E fixture contains hardcoded clinical sample data | `e2e/fixtures/index.html` | 338-352 | A05 |
| NER-006 | Medium | E2E Playwright config disables web security | `e2e/playwright.config.ts` | 26-27 | A05 |
| NER-007 | Low | `console.error` in event emitter leaks error context | `src/processors/MedNERProcessor.ts` | 604 | A09 |
| NER-008 | Low | `logBrowserSupport()` logs device fingerprinting data | `src/utils/browserSupport.ts` | 189-213 | A09 |
| NER-009 | Low | Model ID accepts arbitrary HuggingFace identifiers | `src/types/index.ts` | 173-177 | A08 |
| NER-010 | Low | Package published as `private: false` with `src` in files | `package.json` | 5, 16-20 | A05 |
| NER-011 | Info | No rate limiting on `extract()` calls | `src/processors/MedNERProcessor.ts` | 274 | A04 |
| NER-012 | Info | `extractBatch()` processes sequentially without limits | `src/hooks/useMedNER.ts` | 316-322 | A04 |
| NER-013 | Info | Stats accumulate without bounds | `src/processors/MedNERProcessor.ts` | 445-461 | A04 |

### NER-001: XSS in `highlightEntities()` (High)

Entity text is interpolated directly into HTML without escaping, then consumed via `innerHTML` in the E2E fixture:

```238:257:packages/med-ner/src/utils/entityUtils.ts
export function highlightEntities(text: string, entities: EntitySpan[], classPrefix = 'ner-entity'): string {
  // ...
  result = `${before}<span class="${classPrefix} ${typeClass}" data-entity-type="${entity.type}" data-score="${entity.score.toFixed(2)}">${entityText}</span>${after}`;
  // ...
}
```

**Fix**: HTML-escape the text before inserting into the HTML string.

### NER-002: Full Original Text in Results (High)

The `MedNERResult` includes the raw medical narrative text and broadcasts it to all event listeners and callbacks:

```284:295:packages/med-ner/src/types/index.ts
export interface MedNERResult {
  text: string;           // Full original medical text (PHI)
  entities: EntitySpan[];
  processingTime: number;
  model: string;
  timestamp: number;
}
```

**Fix**: Add an `includeOriginalText: boolean` option (default `false`). When disabled, omit or hash the `text` field before emission.

---

## 6. `packages/pipeline/` — @arcaai/pipeline (Data Processing Pipeline)

### Summary

| Metric | Value |
|--------|-------|
| Files reviewed | 22 |
| Lines of code | ~5,000+ (source + tests + E2E) |
| Dependencies | 1 runtime (`eventemitter3`) |
| Findings | 0 High, 3 Medium, 3 Low, 4 Info |

### Findings

| ID | Severity | Title | File | Lines | OWASP |
|----|----------|-------|------|-------|-------|
| PIP-001 | Medium | Sensitive data exposure in error events and messages | `src/core/SequentialPipeline.ts`, `src/types/index.ts` | 209-233, 177 | A09/A05 |
| PIP-002 | Medium | No input validation / schema enforcement on pipeline input | `src/core/SequentialPipeline.ts`, `src/types/index.ts` | 132-155, 101-112 | A03/A04 |
| PIP-003 | Medium | Unbounded retry without circuit breaker | `src/core/PipelineStage.ts` | 162-191 | A04 |
| PIP-004 | Low | Weak run ID generation (predictable identifiers) | `src/core/SequentialPipeline.ts` | 417-419 | A02 |
| PIP-005 | Low | Timeout does not respect AbortSignal | `src/core/PipelineStage.ts` | 137-157 | A04 |
| PIP-006 | Low | Timeout and retry are mutually exclusive (logic bug) | `src/core/PipelineStage.ts` | 115-132 | A04 |
| PIP-007 | Info | Package published publicly (`private: false`) | `package.json` | 6 | — |
| PIP-008 | Info | EventEmitter listener accumulation | `src/core/PipelineOrchestrator.ts` | 155-167 | — |
| PIP-009 | Info | ParallelPipeline retains input reference after execution | `src/core/ParallelPipeline.ts` | 83-84, 197-198 | A04 |
| PIP-010 | Info | E2E fixture HTML uses `innerHTML` with stage data | `e2e/fixtures/index.html` | 643-779 | A03 |

### PIP-001: Sensitive Data in Events (Medium)

Stage results (potentially containing PHI) are emitted as raw `unknown` data in `StageCompleted` events to all listeners:

```209:213:packages/pipeline/src/core/SequentialPipeline.ts
          this.emit(PipelineEvent.StageCompleted, {
            stageName: stage.name,
            durationMs,
            result: currentOutput,  // May contain PHI
          });
```

**Fix**: Do not include raw `result` data in events by default. Add an opt-in `emitResults` config.

### PIP-006: Timeout/Retry Mutual Exclusion (Low)

When both `timeout` and `retry` are configured, only `timeout` is applied. The `if/else` structure silently skips retry:

```115:132:packages/pipeline/src/core/PipelineStage.ts
  async execute(input: TInput, context: PipelineContext): Promise<TOutput> {
    if (this.config.timeout) {
      return this.executeWithTimeout(input, context, this.config.timeout);
    }
    if (this.config.retry) {
      return this.executeWithRetry(input, context);
    }
    return this.onExecute(input, context);
  }
```

**Fix**: Compose timeout and retry together — wrap retried calls with timeout per attempt.

---

## 7. `packages/tools/` — @arcaai/tools (Development Utilities)

### Summary

| Metric | Value |
|--------|-------|
| Files reviewed | 37 |
| Dependencies | 12 production, 9 dev |
| Findings | 2 High, 4 Medium, 4 Low, 3 Info |

### Findings

| ID | Severity | Title | File | Lines | OWASP |
|----|----------|-------|------|-------|-------|
| TLS-001 | High | Command injection via unsanitized input in `runCommand` | `src/utils/runCommand.ts` | 1-40 | A03 |
| TLS-002 | High | Hardcoded default tenant ID in API key generator | `src/gen-api-key/generate.ts` | 107 | A07 |
| TLS-003 | Medium | Sensitive environment variables logged to console | `src/utils/Logger.ts` | 24-40 | A09 |
| TLS-004 | Medium | Raw API key printed to console output | `src/gen-api-key/index.ts` | 87 | A02 |
| TLS-005 | Medium | Dynamic `import()` with path-derived input | `src/utils/getPrismaDMMF.ts` | 49 | A03 |
| TLS-006 | Medium | Path traversal in `clearDirectory` utility | `src/utils/clearDirectory.ts` | 4-8 | A01 |
| TLS-007 | Low | Hardcoded user IDs in dev token users | `src/gen-dev-token/users.ts` | 25-56 | A07 |
| TLS-008 | Low | Weak JWT secret validation (warning only) | `src/gen-dev-token/generate.ts` | 46-52 | A02 |
| TLS-009 | Low | `.env` loaded with override by default | `src/utils/loadEnv.ts` | 98 | A05 |
| TLS-010 | Low | No `--schema` path sanitization in Prisma commands | `src/prisma-commander/utils/activities.ts` | 53-143 | A03 |
| TLS-011 | Info | `rimraf` package not in package.json dependencies | `src/utils/clearDirectory.ts` | 2 | — |
| TLS-012 | Info | `typescript` imported directly (not in deps) | `src/utils/parseEntityClassFile.ts` | 1 | — |
| TLS-013 | Info | Transitive dependency vulnerabilities (semver, minimatch ReDoS) | — | — | A06 |

### TLS-001: Command Injection in `runCommand` (High)

`child_process.exec()` with shell interpretation is used with string-interpolated values including user-provided migration names:

```100:106:packages/tools/src/prisma-commander/utils/activities.ts
async function executeCreateMigration(domain: Domain, migrationName?: string): Promise<void> {
    const name = migrationName || `migration_${Date.now()}`;
    const command = `pnpm exec prisma migrate dev --schema=${relativeSchemaPath} --name=${name}`;
    await runCommand({ command, cwd: monorepoRoot });
}
```

**Fix**: Replace `exec()` with `execFile()`/`spawn()` which bypass the shell. Validate all interpolated values against `^[a-zA-Z0-9_\-\.\/]+$`.

### TLS-006: Path Traversal in `clearDirectory` (Medium)

`clearDirectory` calls `rimraf.sync(outputPath)` with no boundary validation:

```1:10:packages/tools/src/utils/clearDirectory.ts
export function clearDirectory(outputPath: string): void {
    console.log('Cleaning directory: ', outputPath);
    rimraf.sync(outputPath);
    fs.mkdirSync(outputPath, { recursive: true });
}
```

**Fix**: Validate that the resolved path is within the workspace root before deletion.

---

## Cross-Cutting Concerns

### 1. Healthcare Data Protection (HIPAA)

The most pervasive concern across the codebase is the lack of systematic PHI/PII protection:

| Package | Issue | Severity |
|---------|-------|----------|
| logger | No redaction in any log method | Critical |
| exceptions | Untyped metadata flows to HTTP responses | High |
| med-ner | Full medical text in NER results broadcast to all listeners | High |
| pipeline | Stage results (potentially PHI) emitted to all event subscribers | Medium |
| exceptions | Entity names/IDs in error messages reach clients | Medium |

**Recommendation**: Implement a centralized PHI/PII redaction library (`@arcaai/phi-redactor`) that provides:
- Field-name pattern matching (ssn, dob, patientName, etc.)
- Regex-based value detection (SSN patterns, DOB patterns)
- Integration as a Winston format for the logger
- Integration as a `toJSON` filter for exceptions
- Integration as an event filter for pipeline and med-ner

### 2. XSS / HTML Injection

| Package | Issue | Severity |
|---------|-------|----------|
| ui | `innerHTML` in cool-mode particle system | High |
| med-ner | `highlightEntities()` outputs unescaped HTML | High |
| ui | `dangerouslySetInnerHTML` without DOMPurify in PostDetail | Medium |
| ui | Unvalidated `href` props in 6+ components | Medium |
| ui | CodeComparison error fallback unescaped | Medium |

**Recommendation**:
- Standardize on `sanitizeHref()` from `tool-ui/shared/media/` for all link rendering
- Replace custom HTML sanitizer in PostDetail with DOMPurify
- Add an ESLint rule to flag `innerHTML` assignments

### 3. Error Information Leakage Pipeline

The exception → interceptor → HTTP response pipeline has multiple leakage points:

```
BaseException.toJSON() → stack traces, metadata, cause chain
ExceptionInterceptor → Prisma table/column names, meta objects
PrismaFilter → raw Prisma messages with schema details
DataNotFoundException → entity names + IDs
```

**Recommendation**: Implement a two-tier serialization:
- `toJSON()`: message + code + correlationId only (client-facing)
- `toLogJSON()`: full details including stack, metadata, cause (server-side logging)

### 4. Cryptographic Weakness

| Package | Issue | Severity |
|---------|-------|----------|
| utils | `Math.random()` for UUID/random string generation | Medium |
| pipeline | `Date.now()` + `Math.random()` for run IDs | Low |
| tools | JWT secret validation is warning-only | Low |

**Recommendation**: Replace all `Math.random()` usage with `crypto.getRandomValues()` / `crypto.randomUUID()`. Enforce minimum JWT secret lengths.

### 5. Dependency Vulnerabilities

| Package | Dependency | Issue |
|---------|-----------|-------|
| logger | `winston-daily-rotate-file` → `undici` | CVE-2026-22036 (DoS) |
| tools | `rollup-plugin-node-builtins` → `semver` | ReDoS |
| tools | `@typescript-eslint` → `minimatch` | ReDoS (3 advisories) |

**Recommendation**: Add `pnpm.overrides` in root `package.json`:

```json
{
  "pnpm": {
    "overrides": {
      "semver": ">=7.5.4",
      "minimatch": ">=9.0.7",
      "undici": ">=6.23.0"
    }
  }
}
```

---

## OWASP Top 10 Coverage

| OWASP Category | Findings | Key Packages |
|----------------|----------|--------------|
| A01: Broken Access Control | 5 | exceptions, tools, logger |
| A02: Cryptographic Failures | 6 | utils, logger, tools, med-ner |
| A03: Injection | 14 | ui, tools, med-ner, logger |
| A04: Insecure Design | 10 | exceptions, pipeline, med-ner |
| A05: Security Misconfiguration | 12 | exceptions, logger, med-ner, tools, ui |
| A06: Vulnerable Components | 2 | logger, tools |
| A07: Auth Failures | 2 | tools, utils |
| A08: Integrity Failures | 2 | utils, med-ner |
| A09: Logging & Monitoring Failures | 7 | logger, exceptions, med-ner, tools |
| A10: SSRF | 1 | utils |

---

## Prioritized Remediation Plan

### Immediate (This Week)

| Priority | Finding | Package | Effort |
|----------|---------|---------|--------|
| P0 | LOG-001: PHI/PII redaction in logger | logger | Medium |
| P0 | EXC-002: Strip metadata from client responses | exceptions | Low |
| P0 | EXC-003: Stop forwarding Prisma errors to clients | exceptions (+ api interceptor) | Low |
| P1 | LOG-002: CRLF sanitization in log messages | logger | Low |
| P1 | UI-001: Replace innerHTML in cool-mode | ui | Low |
| P1 | NER-001: HTML-escape in highlightEntities | med-ner | Low |
| P1 | TLS-001: Replace exec() with execFile() | tools | Medium |

### This Sprint

| Priority | Finding | Package | Effort |
|----------|---------|---------|--------|
| P2 | EXC-001: Stack trace exposure controls | exceptions | Low |
| P2 | LOG-003: Remove plaintext S3 credentials from config | logger | Medium |
| P2 | LOG-007: Fix maxSize parsing bug | logger | Low |
| P2 | UTL-001: Replace Math.random() | utils | Low |
| P2 | UTL-002: URL allowlisting for model sources | utils | Medium |
| P2 | UI-003: Standardize href validation | ui | Medium |
| P2 | NER-002: Add includeOriginalText option | med-ner | Medium |
| P2 | TLS-002: Remove hardcoded tenant ID default | tools | Low |

### Next Sprint

| Priority | Finding | Package | Effort |
|----------|---------|---------|--------|
| P3 | UI-002: Replace custom sanitizer with DOMPurify | ui | Low |
| P3 | UI-004: Escape CodeComparison fallback | ui | Low |
| P3 | EXC-004: Remove cause chain from client responses | exceptions | Low |
| P3 | EXC-005: Generic persistence error messages | exceptions | Medium |
| P3 | LOG-005: Environment-aware log level enforcement | logger | Low |
| P3 | LOG-006: Set restrictive file permissions | logger | Low |
| P3 | NER-003: Input length validation | med-ner | Low |
| P3 | PIP-001: Sanitize event data hook | pipeline | Medium |
| P3 | PIP-003: Cap retries and add max backoff | pipeline | Low |
| P3 | TLS-006: Path boundary validation | tools | Low |
| P3 | UTL-006: Model checksum verification | utils | Medium |

### Backlog

| Priority | Finding | Package | Effort |
|----------|---------|---------|--------|
| P4 | LOG-009: Structured audit event API | logger | High |
| P4 | EXC-006: Defensive CLS handling | exceptions | Low |
| P4 | EXC-007: Standardize exception constructors | exceptions | Medium |
| P4 | PIP-002: Runtime input validation hook | pipeline | Medium |
| P4 | NER-006: Remove --disable-web-security from Playwright | med-ner | Low |
| P4 | NER-010: Remove src from published files | med-ner | Low |
| P4 | Dependency overrides (semver, minimatch, undici) | Root | Low |

---

## Positive Security Observations

Several packages demonstrate good security practices that should be replicated:

1. **`tool-ui/shared/media/sanitize-href.ts`** — Robust URL validation allowing only `http:`/`https:` protocols, blocking `javascript:` and `data:` schemes. Should be extracted and used project-wide.
2. **No `eval()` or `Function()` anywhere** — Zero instances across all 7 packages.
3. **No hardcoded production secrets** — All credential management is via environment variables or config objects.
4. **TypeScript strict typing** — Strong use of generics, interfaces, and type guards across all packages.
5. **AbortController support** — The pipeline package supports cancellation via AbortSignal.
6. **Minimal runtime dependencies** — Most packages have 0-3 runtime dependencies, reducing supply chain risk.
7. **Zod validation in utils** — The utils package uses Zod for schema validation, a security-positive pattern.

---

## Appendix: Files Reviewed by Package

| Package | Source Files | Test Files | Total Files | Total Lines |
|---------|-------------|------------|-------------|-------------|
| ui | 1,217 | — | 1,217+ | ~150,000+ |
| utils | 14 | 4 | 20 | ~2,150 |
| exceptions | 27 | — | 28 | ~500 |
| logger | 2 | 1 | 7 | ~600 |
| med-ner | 11 | 5 | 26 | ~4,500 |
| pipeline | 8 | 5 | 22 | ~5,000+ |
| tools | 37 | — | 37 | ~6,000+ |
| **Total** | **1,316** | **15** | **1,357+** | **~168,750+** |

---

*Report generated by Security Auditor Agent. All findings should be validated by the development team and triaged according to the project's risk tolerance and compliance requirements.*
