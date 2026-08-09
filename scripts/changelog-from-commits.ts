#!/usr/bin/env tsx
/**
 * TASK-648 U1 — Changelog generation from Conventional Commits (README §3.5, §5 W12).
 *
 * Two distinct outputs, both derived from the same commit range, never conflated
 * (README §3.5 — conflating them is the usual changelog failure):
 *
 *   1. The TECHNICAL changelog: every commit since the previous tag of the same
 *      SERVICE family, grouped by type. Shape frozen by
 *      `docs/implementation/TASK-648-.../contracts/changelog-entry.schema.json`.
 *      Non-Conventional commits are never dropped — they land in `type: "other"`.
 *
 *   2. On an `ALL-<ver>` platform-train tag only: a DRAFT `ChangelogEntry`
 *      payload (title/summary/body) pulled from the `feat` + breaking items.
 *      This function NEVER sets a publish-shaped field — CI creates drafts
 *      only; publishing is always a human action (README §3.5 rule 5, §6b).
 *
 * Enforcement: `assertBreakingRequiresMajorBump` throws when any entry is
 * `breaking: true` and the release is not a MAJOR bump. This is what makes
 * the SemVer policy of README §3.1 enforced rather than aspirational — wired
 * into the CLI below so a release-tag pipeline fails outright.
 *
 * Git plumbing (`getCommitsInRange`, `getPreviousFamilyTag`) is intentionally
 * separated from the pure parsing/grouping/enforcement functions above so the
 * latter can be unit-tested without touching a real repository — see
 * `scripts/__tests__/changelog-from-commits.test.ts`.
 */

import { execFileSync } from 'node:child_process';
import { parseReleaseTag, RELEASE_TAG_PATTERN, SERVICE_TAG_PREFIXES, type ServiceTagPrefix } from '../packages/utils/src/version-grammar';

// ─── Types (mirrors contracts/changelog-entry.schema.json) ──────────────────

export const CONVENTIONAL_COMMIT_TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'revert'] as const;
export type ConventionalCommitType = (typeof CONVENTIONAL_COMMIT_TYPES)[number];
/** `other` is the bucket for commits that do not parse — never dropped. */
export type ChangelogEntryType = ConventionalCommitType | 'other';

export interface RawCommit {
  /** Full 40-character commit SHA. */
  sha: string;
  subject: string;
  /** Everything after the subject line (blank-line-separated body + footers). */
  body: string;
}

export interface ChangelogEntry {
  type: ChangelogEntryType;
  scope: string | null;
  /** `TASK-nnn` / `BUG-nnn` extracted from the scope, or null. */
  ticket: string | null;
  subject: string;
  sha: string;
  breaking: boolean;
}

export type VersionBump = 'initial' | 'major' | 'minor' | 'patch' | 'none';

interface SemverCore {
  major: number;
  minor: number;
  patch: number;
}

export interface DraftChangelogPayload {
  platformVersion: string;
  title: string;
  summary: string;
  body: string;
}

// ─── Parsing ──────────────────────────────────────────────────────────────

const TICKET_PATTERN = /^(TASK|BUG)-[0-9]+$/;
// `type(scope)!: subject` / `type!: subject` / `type(scope): subject` / `type: subject`.
const CONVENTIONAL_HEADER = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

function isConventionalType(candidate: string): candidate is ConventionalCommitType {
  return (CONVENTIONAL_COMMIT_TYPES as readonly string[]).includes(candidate);
}

/**
 * Parse one commit into a `ChangelogEntry`. Never throws — a commit that does
 * not match the Conventional Commits grammar lands as `type: "other"` with
 * its raw subject preserved verbatim, so the technical changelog is always
 * complete (README §3.5 rule 4).
 */
export function parseConventionalCommit(commit: RawCommit): ChangelogEntry {
  const match = CONVENTIONAL_HEADER.exec(commit.subject.trim());
  const breakingFooter = BREAKING_FOOTER.test(commit.body ?? '');

  if (!match) {
    return {
      type: 'other',
      scope: null,
      ticket: null,
      subject: commit.subject.trim(),
      sha: commit.sha,
      breaking: breakingFooter,
    };
  }

  const [, rawType, rawScope, bang, subject] = match;
  const type = rawType.toLowerCase();

  if (!isConventionalType(type)) {
    return {
      type: 'other',
      scope: null,
      ticket: null,
      subject: commit.subject.trim(),
      sha: commit.sha,
      breaking: breakingFooter,
    };
  }

  const scope = rawScope && rawScope.length > 0 ? rawScope : null;
  const ticket = scope && TICKET_PATTERN.test(scope) ? scope : null;

  return {
    type,
    scope,
    ticket,
    subject: subject.trim(),
    sha: commit.sha,
    breaking: Boolean(bang) || breakingFooter,
  };
}

/** Parse every commit in a range into the technical changelog array. */
export function buildChangelog(commits: RawCommit[]): ChangelogEntry[] {
  return commits.map(parseConventionalCommit);
}

/** Group parsed entries by type, preserving within-group order. */
export function groupByType(entries: ChangelogEntry[]): Partial<Record<ChangelogEntryType, ChangelogEntry[]>> {
  const grouped: Partial<Record<ChangelogEntryType, ChangelogEntry[]>> = {};
  for (const entry of entries) {
    (grouped[entry.type] ??= []).push(entry);
  }
  return grouped;
}

// ─── SemVer bump detection + enforcement (README §3.1, §3.5 rule 2) ─────────

/**
 * Classify the bump from `previous` to `current`. `null` previous means no
 * prior tag of the same family exists — an initial release, which the
 * breaking-commit gate never blocks (there is nothing to break yet).
 */
export function determineVersionBump(previous: SemverCore | null, current: SemverCore): VersionBump {
  if (!previous) return 'initial';
  if (current.major > previous.major) return 'major';
  if (current.major === previous.major && current.minor > previous.minor) return 'minor';
  if (current.major === previous.major && current.minor === previous.minor && current.patch > previous.patch) return 'patch';
  return 'none';
}

/**
 * THE enforcement gate: fails the pipeline when any entry is `breaking: true`
 * and the release is not a MAJOR (or initial) bump. Without this, §3.1's
 * "MAJOR = breaking change" rule is just a comment nobody has to honour.
 */
export function assertBreakingRequiresMajorBump(entries: ChangelogEntry[], bump: VersionBump): void {
  if (bump === 'major' || bump === 'initial') return;

  const breaking = entries.filter((e) => e.breaking);
  if (breaking.length === 0) return;

  const shas = breaking.map((e) => e.sha).join(', ');
  const subjects = breaking.map((e) => `  - ${e.sha.slice(0, 8)} ${e.subject}`).join('\n');
  throw new Error(
    `Release contains ${breaking.length} breaking commit(s) but the tag is only a ${bump.toUpperCase()} bump. ` +
      `A breaking change requires a MAJOR version bump (README §3.1).\n${subjects}\nSHAs: ${shas}`,
  );
}

// ─── Draft ChangelogEntry payload (ALL- tags only, README §3.5 rule 5) ──────

/**
 * Curated draft payload for a platform-train (`ALL-`) release: the `feat` and
 * breaking items only — a `fix` alone is not "what's new" copy. Deliberately
 * has NO publish-shaped field: CI creates a DRAFT via `POST /admin/changelog`
 * and a human edits + publishes it (README §3.5, §6b). Never throws.
 */
export function buildDraftChangelogPayload(entries: ChangelogEntry[], platformVersion: string): DraftChangelogPayload {
  const highlights = entries.filter((e) => e.type === 'feat' || e.breaking);
  const breaking = highlights.filter((e) => e.breaking);

  const bodyLines = highlights.map((e) => {
    const prefix = e.breaking ? '**BREAKING:** ' : '';
    const ticketSuffix = e.ticket ? ` (${e.ticket})` : '';
    return `- ${prefix}${e.subject}${ticketSuffix}`;
  });

  const summary =
    highlights.length > 0
      ? `${highlights.length} change(s), ${breaking.length} breaking, in ${platformVersion}.`
      : `Maintenance release ${platformVersion} — no user-visible changes.`;

  return {
    platformVersion,
    title: `HOPE ${platformVersion}`,
    summary,
    body: bodyLines.length > 0 ? bodyLines.join('\n') : '_No user-visible changes in this release._',
  };
}

// ─── Git plumbing (not unit-tested — see file header) ───────────────────────

const COMMIT_FIELD_SEP = '\x1f';
const COMMIT_RECORD_SEP = '\x1e';

/** Every service prefix that can own a tag family, `ALL` included. */
export function tagFamilyOf(tag: string): ServiceTagPrefix | null {
  return parseReleaseTag(tag)?.service ?? null;
}

/**
 * The most recent tag of the same family as `currentTag` that is not
 * `currentTag` itself, reachable from `untilRef`. Returns null when this is
 * the first release of the family (an initial release).
 */
export function getPreviousFamilyTag(family: ServiceTagPrefix, currentTag: string | null, cwd: string): string | null {
  const pattern = `${family}-*`;
  const raw = execFileSync('git', ['tag', '--list', pattern, '--sort=-v:refname'], { cwd, encoding: 'utf8' });
  const candidates = raw
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t !== currentTag)
    .filter((t) => RELEASE_TAG_PATTERN.test(t));
  return candidates[0] ?? null;
}

/** Commits in `(sinceRef, untilRef]`, oldest first, each with its full SHA + full body. */
export function getCommitsInRange(sinceRef: string | null, untilRef: string, cwd: string): RawCommit[] {
  const range = sinceRef ? `${sinceRef}..${untilRef}` : untilRef;
  const format = ['%H', '%s', '%b'].join(COMMIT_FIELD_SEP);
  const raw = execFileSync('git', ['log', '--reverse', `--format=${format}${COMMIT_RECORD_SEP}`, range], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  return raw
    .split(COMMIT_RECORD_SEP)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha, subject, body] = record.split(COMMIT_FIELD_SEP);
      return { sha: sha.trim(), subject: (subject ?? '').trim(), body: (body ?? '').trim() };
    });
}

// ─── CLI entrypoint ──────────────────────────────────────────────────────────
// `npx tsx scripts/changelog-from-commits.ts [<tag>] [--since <ref>] [--cwd <dir>]`
//
//   <tag>          A release tag (`SMR-2.1.0`, `ALL-2.1.0`, …). When present,
//                   the previous tag of the same family is auto-detected and
//                   the breaking/major gate runs — a real release-tag pipeline
//                   invocation.
//   --since <ref>  Explicit base ref, overriding tag auto-detection. Lets this
//                   run against a repo with NO release tags yet (this repo,
//                   today) to inspect real commit history.
//   --cwd <dir>    Repo root (default: process.cwd()).

function parseCliArgs(argv: string[]): { tag: string | null; since: string | null; cwd: string } {
  let tag: string | null = null;
  let since: string | null = null;
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--since') {
      since = argv[++i] ?? null;
    } else if (arg === '--cwd') {
      cwd = argv[++i] ?? cwd;
    } else if (!arg.startsWith('--') && tag === null) {
      tag = arg;
    }
  }
  return { tag, since, cwd };
}

function main(): void {
  const { tag, since, cwd } = parseCliArgs(process.argv.slice(2));

  const parsedTag = tag ? parseReleaseTag(tag) : null;
  if (tag && !parsedTag) {
    console.error(`"${tag}" does not match the release tag grammar ${RELEASE_TAG_PATTERN}. Service prefixes: ${SERVICE_TAG_PREFIXES.join(', ')}.`);
    process.exit(1);
  }

  const previousTag = since ? null : parsedTag ? getPreviousFamilyTag(parsedTag.service, tag, cwd) : null;
  const sinceRef = since ?? previousTag;

  const commits = getCommitsInRange(sinceRef, 'HEAD', cwd);
  const entries = buildChangelog(commits);

  console.log(`# Changelog since ${sinceRef ?? '(repo start)'} → HEAD`);
  console.log(`# ${commits.length} commit(s), ${entries.length} entries`);
  console.log(JSON.stringify(entries, null, 2));

  if (parsedTag) {
    const bump = determineVersionBump(previousTag ? parseReleaseTag(previousTag) : null, parsedTag);
    console.log(`# Previous tag: ${previousTag ?? '(none — initial release)'}`);
    console.log(`# Version bump: ${bump}`);

    assertBreakingRequiresMajorBump(entries, bump);

    if (parsedTag.isPlatformTrain) {
      const draft = buildDraftChangelogPayload(entries, parsedTag.version);
      console.log('# Draft ChangelogEntry payload (ALL- tag — never auto-published, README §3.5 rule 5):');
      console.log(JSON.stringify(draft, null, 2));
    }
  }
}

// Only run the CLI when this file is the entrypoint (not when imported by tests).
if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
