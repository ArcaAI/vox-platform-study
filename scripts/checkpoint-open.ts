/**
 * Offline opener for a passphrase-protected tenant checkpoint (`.hcp`).
 *
 *   pnpm checkpoint:open <file> --out <dir> [--public-key <file>]
 *
 * Reads the passphrase from HOPE_CHECKPOINT_PASSPHRASE (non-interactive) or a no-echo TTY prompt.
 * No network and no Vault: the data key is unwrapped with the passphrase (Argon2id), every segment
 * is authenticated before its plaintext is written, and the trailer digest is checked. The Vault
 * signature can only be checked with the deployment's exported `hope-checkpoint-sign` public key
 * (PEM, or the raw base64 key Vault returns); without it the report says "present, not verified".
 *
 * Output is staged in a private sibling directory and renamed into place only when the whole
 * archive has been read and authenticated — a wrong passphrase, a corrupt file or an unsafe entry
 * name leaves NO plaintext behind.
 */
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { openArchiveInternal, readHeader } from '../packages/applications/src/services/tenant-checkpoint/archive/reader';
import { CheckpointError, type CheckpointHeader } from '../packages/applications/src/services/tenant-checkpoint/contracts';
import { unwrapDataKeyWithPassphrase } from '../packages/applications/src/services/tenant-checkpoint/sealing/passphrase';

export type SignatureStatus = 'present, not verified' | 'verified' | 'INVALID';

export interface OpenCheckpointArgs {
  file: string;
  out: string;
  passphrase: string;
  /** PEM (SPKI) or the raw base64 Ed25519 key from `transit/keys/hope-checkpoint-sign`. */
  publicKey?: string;
}

export interface OpenCheckpointResult {
  header: Omit<CheckpointHeader, 'keys'>;
  entries: string[];
  signature: SignatureStatus;
  out: string;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function parsePublicKey(input: string): KeyObject {
  const text = input.trim();
  if (text.includes('-----BEGIN')) return createPublicKey(text);
  const raw = Buffer.from(text, 'base64');
  if (raw.length !== 32) throw new Error('public key must be a PEM or a 32-byte base64 Ed25519 key');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function checkSignature(key: KeyObject, digest: Buffer, signature: string): boolean {
  const m = /^vault:v\d+:([A-Za-z0-9+/=]+)$/.exec(signature);
  if (!m) return false;
  try {
    return verifySignature(null, digest, key, Buffer.from(m[1], 'base64'));
  } catch {
    return false;
  }
}

/** Entry names become relative paths: no absolute paths, no `..`/`.`/empty segments, no backslashes. */
function safeRelativePath(root: string, name: string): string {
  const segments = name.split('/');
  const bad =
    name.length === 0 ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    /^[A-Za-z]:/.test(name) ||
    segments.some((s) => s === '' || s === '.' || s === '..');
  const target = resolve(root, ...segments);
  if (bad || !target.startsWith(root + sep)) throw new Error(`unsafe entry name in checkpoint: ${JSON.stringify(name)}`);
  return target;
}

async function prepareOut(out: string): Promise<void> {
  try {
    const s = await stat(out);
    if (!s.isDirectory()) throw new Error(`--out ${out} exists and is not a directory`);
    if ((await readdir(out)).length > 0) throw new Error(`--out ${out} exists and is not empty`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export async function openCheckpointFile(args: OpenCheckpointArgs): Promise<OpenCheckpointResult> {
  const out = resolve(args.out);
  await prepareOut(out);
  const key = args.publicKey ? parsePublicKey(args.publicKey) : null;

  const { header, rest } = await readHeader(createReadStream(args.file));
  rest.destroy();
  const wrap = header.keys.passphrase;
  if (!wrap) {
    throw new CheckpointError('PASSPHRASE_INVALID', 'This checkpoint was sealed without a passphrase; only its own deployment can open it');
  }
  // Wrong passphrase fails here, before anything is created on disk.
  const dataKey = await unwrapDataKeyWithPassphrase(wrap, args.passphrase);

  await mkdir(dirname(out), { recursive: true });
  const staging = await mkdtemp(join(dirname(out), `.${basename(out)}.partial-`));
  try {
    const reader = await openArchiveInternal(createReadStream(args.file), dataKey);
    const entries: string[] = [];
    for await (const e of reader.entries()) {
      const target = safeRelativePath(staging, e.name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await pipeline(e.body, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
      entries.push(e.name);
    }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(reader.manifest(), null, 2), { flag: 'wx', mode: 0o600 });

    let signature: SignatureStatus = 'present, not verified';
    if (key) signature = checkSignature(key, reader.digest(), reader.signature()) ? 'verified' : 'INVALID';

    await rmdir(out).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
    await rename(staging, out);
    const { keys: _keys, ...publicHeader } = header;
    return { header: publicHeader, entries, signature, out };
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  } finally {
    dataKey.fill(0);
  }
}

// ---- CLI ---------------------------------------------------------------------------------------

function parseArgs(argv: string[]): { file: string; out: string; publicKeyFile?: string } {
  let file: string | undefined;
  let out: string | undefined;
  let publicKeyFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--public-key') publicKeyFile = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: pnpm checkpoint:open <file.hcp> --out <dir> [--public-key <pem-file>]\n');
      process.exit(0);
    } else if (!file && !a.startsWith('--')) file = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (!file || !out) throw new Error('usage: pnpm checkpoint:open <file.hcp> --out <dir> [--public-key <pem-file>]');
  return { file, out, publicKeyFile };
}

function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(new Error('no TTY to prompt for the passphrase; set HOPE_CHECKPOINT_PASSPHRASE'));
  }
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolvePrompt, reject) => {
    let value = '';
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
    };
    const onData = (s: string) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          done();
          resolvePrompt(value);
          return;
        }
        if (ch === '\u0003') {
          done();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<number> {
  const { file, out, publicKeyFile } = parseArgs(process.argv.slice(2));
  const publicKey = publicKeyFile ? await readFile(publicKeyFile, 'utf8') : undefined;
  const passphrase = process.env.HOPE_CHECKPOINT_PASSPHRASE ?? (await promptHidden('Checkpoint passphrase: '));
  const r = await openCheckpointFile({ file, out, passphrase, publicKey });
  process.stdout.write(
    [
      `checkpoint: ${r.header.checkpointId}`,
      `tenant:     ${r.header.tenantId} (${r.header.tenantKey})`,
      `created:    ${r.header.createdAt}`,
      `entries:    ${r.entries.length} (+ manifest.json)`,
      `out:        ${r.out}`,
      `signature:  ${r.signature}`,
      '',
    ].join('\n'),
  );
  return r.signature === 'INVALID' ? 2 : 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      const reason = e instanceof CheckpointError ? `${e.reason}: ` : '';
      process.stderr.write(`checkpoint:open failed — ${reason}${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
