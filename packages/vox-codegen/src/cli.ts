/**
 * `vox-codegen` — the `bin` entry.
 *
 * TWO modes, mutually exclusive by construction:
 *
 * ```
 * npx @arcaai/vox-codegen --tenant <id> --token <jwt> [--watch] [--out <path>]
 * npx @arcaai/vox-codegen --tenant <id> --client-id <id> --client-secret <secret> [--watch]
 * npx @arcaai/vox-codegen --api-key <key> [--agents] [--workflows] [--out <dir>]
 * ```
 *
 * The first two type a tenant's consultation CONTEXT SCHEMA; the third (TASK-931) types what the
 * tenant PUBLISHES, from the API key an integrator actually holds. Mixing them is a refusal
 * rather than a guess: they authenticate differently, read different routes, and answer different
 * questions, so "which did you mean" has no safe default.
 *
 * The context-schema mode accepts either of TWO credential classes (TASK-933). A super-admin JWT
 * was the original and only one, which put a HUMAN's token — with a human's expiry — in the
 * middle of a build pipeline. A SERVICE ACCOUNT (`--client-id` / `--client-secret`, exchanged for
 * a short-lived opaque token) is the machine credential that route now accepts, under
 * `svc:tenant:context-schema:read`. Supplying both is a refusal, for the same reason as above.
 *
 * Zero CLI-parsing dependencies: `node:util`'s `parseArgs` (Node >= 18) is
 * enough for this flag set, and this package otherwise carries zero runtime
 * dependencies (matches `@arcaai/vox-node`'s posture — see the package
 * README's placement decision).
 */

import { parseArgs } from 'node:util';
import process from 'node:process';
import { CodegenError } from './errors';
import { exchangeServiceAccountToken } from './exchange-service-token';
import { checkCodegenOnce, runCodegenOnce } from './run';
import { checkCatalogueCodegenOnce, runCatalogueCodegenOnce } from './run-catalogue';
import { watchCodegen } from './watch';

const DEFAULT_BASE_URL = 'http://localhost:8868';
const DEFAULT_OUT_FILE = './consultation-context-schema.generated.ts';
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_OUT_DIR = './generated';

const HELP_TEXT = `vox-codegen — emit TypeScript types from a tenant's HOPE configuration

Two modes, one per credential class. They are mutually exclusive.

CONSULTATION CONTEXT SCHEMA (super-admin JWT, or a service account)
  vox-codegen --tenant <id> --token <jwt> [options]
  vox-codegen --tenant <id> --client-id <id> --client-secret <secret> [options]

  --tenant <id>          Tenant id to generate types for (required)
  --token <jwt>          Bearer token for a SUPER_ADMIN user (or set HOPE_API_TOKEN)
  --client-id <id>       Service-account client id (or set HOPE_SVC_CLIENT_ID)
  --client-secret <s>    Service-account secret (or set HOPE_SVC_CLIENT_SECRET). Prefer the
                         environment variable: an argv secret is visible in \`ps\`.
  --working-tenant <id>  Tenant to bind the service-account token to (default: --tenant)
  --department <id>      Prefer this department's schema default, falling back to the tenant default
  --out <path>           Output FILE path (default: ${DEFAULT_OUT_FILE})
  --watch                Keep polling and regenerate whenever the schema changes
  --interval <ms>        Poll interval in watch mode (default: ${DEFAULT_INTERVAL_MS})
  --check                Regenerate in memory and compare against --out; exit 1 on drift, without writing

PUBLISHED AGENTS AND WORKFLOWS (API key — the business plane)
  vox-codegen --api-key <key> [--agents] [--workflows] [options]

  --api-key <key>      Tenant API key (or set HOPE_API_KEY). Never reaches an admin route.
  --agents             Emit Agent_<Slug>_Input / _Output for every published agent
  --workflows          Emit Workflow_<Slug>_Input / _Output for every published workflow
  --out <dir>          Output DIRECTORY (default: ${DEFAULT_OUT_DIR})
  --check              Regenerate in memory and compare against --out; exit 1 on drift, without writing

COMMON
  --base-url <url>     Gateway origin (default: ${DEFAULT_BASE_URL}, or HOPE_API_BASE_URL)
  -h, --help           Show this help

Generated files are a build-time convenience, never a replacement for runtime
discovery (\`useConsultationSchema()\`, \`hope.agents.list()\`). Commit them like any
other source file; regenerate whenever the tenant changes what it publishes.
`;

interface ParsedArgs {
  tenant?: string;
  token?: string;
  'client-id'?: string;
  'client-secret'?: string;
  'working-tenant'?: string;
  'api-key'?: string;
  agents: boolean;
  workflows: boolean;
  'base-url'?: string;
  department?: string;
  out?: string;
  watch: boolean;
  interval?: string;
  check: boolean;
  help: boolean;
}

function readArgs(argv: string[]): ParsedArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      tenant: { type: 'string' },
      token: { type: 'string' },
      'client-id': { type: 'string' },
      'client-secret': { type: 'string' },
      'working-tenant': { type: 'string' },
      'api-key': { type: 'string' },
      agents: { type: 'boolean', default: false },
      workflows: { type: 'boolean', default: false },
      'base-url': { type: 'string' },
      department: { type: 'string' },
      out: { type: 'string' },
      watch: { type: 'boolean', default: false },
      interval: { type: 'string' },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  return values as ParsedArgs;
}

/**
 * The business-plane mode: read the published catalogue with an API key, write one file per
 * requested plane. Returns the process exit code, like {@link main}, and never throws for an
 * operator error — those are messages on stderr, which is what an operator can act on.
 */
async function runBusinessPlane(options: {
  apiKey: string | undefined;
  baseUrl: string;
  agents: boolean;
  workflows: boolean;
  outDir: string;
  watch: boolean;
  check: boolean;
}): Promise<number> {
  if (!options.apiKey) {
    process.stderr.write('vox-codegen: --agents / --workflows need a tenant API key — pass --api-key or set HOPE_API_KEY\n');
    return 1;
  }
  if (!options.agents && !options.workflows) {
    process.stderr.write('vox-codegen: --api-key needs at least one of --agents / --workflows to know what to emit\n');
    return 1;
  }
  if (options.watch) {
    // Not an omission: the context-schema mode polls one endpoint and compares its `etag`.
    // A published catalogue is N definitions with no aggregate validator, so a watch here
    // would be an N-request poll that cannot tell "unchanged" from "not read yet" — which is
    // also why there is no separate "--check and --watch are mutually exclusive" message here:
    // --watch is refused on this plane regardless of --check.
    process.stderr.write(
      'vox-codegen: --watch is only supported for the consultation-context mode (--tenant); a published catalogue has no aggregate etag to poll\n',
    );
    return 1;
  }

  try {
    if (options.check) {
      const result = await checkCatalogueCodegenOnce({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        agents: options.agents,
        workflows: options.workflows,
        outDir: options.outDir,
      });
      let drifted = false;
      for (const file of result.files) {
        if (file.check.matches) {
          process.stdout.write(`vox-codegen: ${file.path} is up to date\n`);
        } else {
          drifted = true;
          process.stderr.write(`vox-codegen: ${file.path} is OUT OF DATE — run without --check to regenerate it\n${file.check.diff}\n`);
        }
      }
      return drifted ? 1 : 0;
    }

    const result = await runCatalogueCodegenOnce({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      agents: options.agents,
      workflows: options.workflows,
      outDir: options.outDir,
    });
    for (const file of result.files) {
      process.stdout.write(`vox-codegen: wrote ${file.path} (${file.count} ${file.surface})\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof CodegenError) {
      process.stderr.write(`vox-codegen: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

/** Runs one CLI invocation and returns the process exit code. Never calls `process.exit` itself — the caller decides when that happens. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: ParsedArgs;
  try {
    args = readArgs(argv);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`vox-codegen: ${reason}\n`);
    return 1;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const tenantId = args.tenant;
  const token = args.token ?? process.env.HOPE_API_TOKEN;
  // Env fallbacks mirror HOPE_API_KEY's, and for the secret the environment is
  // the RECOMMENDED path: a secret passed on argv is visible in `ps` to every
  // process on the machine for as long as the command runs.
  const clientId = args['client-id'] ?? process.env.HOPE_SVC_CLIENT_ID;
  const clientSecret = args['client-secret'] ?? process.env.HOPE_SVC_CLIENT_SECRET;
  const apiKey = args['api-key'] ?? process.env.HOPE_API_KEY;
  const baseUrl = args['base-url'] ?? process.env.HOPE_API_BASE_URL ?? DEFAULT_BASE_URL;
  const departmentId = args.department;
  const wantsCatalogue = args.agents || args.workflows;

  // The two modes authenticate differently and read different routes. Refuse the combination
  // rather than pick one: a run that silently ignored half the flags would emit a file the
  // operator did not ask for, and they would find out at review time or not at all.
  if (apiKey !== undefined && (clientId !== undefined || clientSecret !== undefined)) {
    process.stderr.write(
      'vox-codegen: --api-key and a service account (--client-id/--client-secret) are mutually exclusive. The API key reads the ' +
        'published business plane; the service account reads a tenant context schema. Run one, then the other.\n',
    );
    return 1;
  }

  if (apiKey !== undefined && tenantId !== undefined) {
    process.stderr.write(
      'vox-codegen: --api-key and --tenant are mutually exclusive. --tenant reads a consultation context schema ' +
        'with a SUPER_ADMIN JWT; --api-key reads the published agents and workflows on the business plane. Run one, then the other.\n',
    );
    return 1;
  }

  if (apiKey !== undefined || wantsCatalogue) {
    return runBusinessPlane({
      apiKey,
      baseUrl,
      agents: args.agents,
      workflows: args.workflows,
      outDir: args.out ?? DEFAULT_OUT_DIR,
      watch: args.watch,
      check: args.check,
    });
  }

  const outFile = args.out ?? DEFAULT_OUT_FILE;

  if (!tenantId) {
    process.stderr.write('vox-codegen: --tenant <id> is required\n');
    return 1;
  }
  // ── Which credential class reads the schema ────────────────────────────────
  const wantsServiceAccount = clientId !== undefined || clientSecret !== undefined;

  if (token && wantsServiceAccount) {
    process.stderr.write(
      'vox-codegen: a super-admin JWT (--token) and a service account (--client-id/--client-secret) are mutually exclusive — ' +
        'the gateway rejects a request carrying two credential classes. Pick one credential.\n',
    );
    return 1;
  }
  if (wantsServiceAccount && (clientId === undefined || clientSecret === undefined)) {
    process.stderr.write(
      'vox-codegen: a service account needs BOTH halves — pass --client-id and --client-secret ' +
        '(or set HOPE_SVC_CLIENT_ID and HOPE_SVC_CLIENT_SECRET)\n',
    );
    return 1;
  }
  if (!token && !wantsServiceAccount) {
    process.stderr.write(
      'vox-codegen: a credential is required — pass --token (or HOPE_API_TOKEN) for a super-admin JWT, ' +
        'or --client-id/--client-secret (or HOPE_SVC_CLIENT_ID/HOPE_SVC_CLIENT_SECRET) for a service account\n',
    );
    return 1;
  }

  let intervalMs = DEFAULT_INTERVAL_MS;
  if (args.interval !== undefined) {
    intervalMs = Number(args.interval);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      process.stderr.write(`vox-codegen: --interval must be a positive number of milliseconds, got ${args.interval}\n`);
      return 1;
    }
  }
  if (args.check && args.watch) {
    process.stderr.write('vox-codegen: --check and --watch are mutually exclusive — check compares one snapshot, it does not poll\n');
    return 1;
  }

  try {
    // The exchange happens ONCE, before the (possibly long-lived) watch loop.
    // A service-account token is short-lived by design, so a watch that outran
    // its token would fail mid-run — see the note in the watch branch below.
    const serviceAccountToken = wantsServiceAccount
      ? (
          await exchangeServiceAccountToken({
            baseUrl,
            clientId: clientId!,
            clientSecret: clientSecret!,
            // The working tenant defaults to the tenant being generated: that
            // is what a platform account is here to read. A tenant-BOUND
            // account may only ever act on its own tenant, and the gateway
            // ignores the field for one, so this is harmless there.
            workingTenantId: args['working-tenant'] ?? tenantId,
          })
        ).accessToken
      : undefined;

    const common = { tenantId, token, serviceAccountToken, baseUrl, departmentId, outFile };

    if (args.check) {
      const result = await checkCodegenOnce(common);
      if (result.check.matches) {
        process.stdout.write(`vox-codegen: ${outFile} is up to date\n`);
        return 0;
      }
      process.stderr.write(`vox-codegen: ${outFile} is OUT OF DATE — run without --check to regenerate it\n${result.check.diff}\n`);
      return 1;
    }

    if (args.watch) {
      // A service-account token is minted once, above, and is NOT refreshed by
      // this loop: the gateway's default TTL is 15 minutes, so a long watch in
      // service-account mode will eventually 401 and stop. That is deliberate
      // for now — `--watch` is a local authoring affordance, and a build
      // pipeline runs the one-shot form.
      process.stdout.write(`vox-codegen: watching tenant ${tenantId} every ${intervalMs}ms → ${outFile} (Ctrl+C to stop)\n`);
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      process.once('SIGTERM', () => controller.abort());
      await watchCodegen({
        ...common,
        intervalMs,
        signal: controller.signal,
        onCycle: ({ changed, etag }) => {
          if (changed) process.stdout.write(`vox-codegen: regenerated ${outFile} (etag ${etag})\n`);
        },
      });
    } else {
      const result = await runCodegenOnce(common);
      process.stdout.write(`vox-codegen: wrote ${outFile} (etag ${result.bundle.etag})\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof CodegenError) {
      process.stderr.write(`vox-codegen: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

/* c8 ignore start -- exercised via process spawn / manual runs, not unit tests */
if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console -- last-resort crash reporter, not the normal CLI output path
      console.error(error);
      process.exitCode = 1;
    });
}
/* c8 ignore stop */
