import { describe, expect, it } from 'vitest';
import { RELEASE_TAG_PATTERN, SERVICE_TAG_PREFIXES, formatUntaggedVersion, isPlatformTrainTag, parseReleaseTag } from '../version-grammar';

// The frozen version grammar.
// Every consumer (CI tag gate, build-info readers, release rows, console badges)
// resolves a version through THIS module. It is the contract, so its tests are
// written against the documented grammar, not against an implementation.

describe('parseReleaseTag', () => {
  it('parses a service release tag', () => {
    expect(parseReleaseTag('TEXT-2.1.0')).toEqual({
      service: 'TEXT',
      version: '2.1.0',
      major: 2,
      minor: 1,
      patch: 0,
      prerelease: null,
      isPlatformTrain: false,
    });
  });

  it('parses the platform train tag', () => {
    const parsed = parseReleaseTag('ALL-1.0.0');
    expect(parsed?.service).toBe('ALL');
    expect(parsed?.isPlatformTrain).toBe(true);
  });

  it('parses a pre-release', () => {
    const parsed = parseReleaseTag('STT-3.0.0-rc.1');
    expect(parsed?.version).toBe('3.0.0-rc.1');
    expect(parsed?.prerelease).toBe('rc.1');
    expect(parsed?.patch).toBe(0);
  });

  it.each(['alpha.1', 'beta.12', 'rc.1'])('accepts the %s pre-release family', (pre) => {
    expect(parseReleaseTag(`API-1.2.3-${pre}`)?.prerelease).toBe(pre);
  });

  it.each([
    ['TEXT-2.1', 'a two-part version is not SemVer'],
    ['text-2.1.0', 'the service prefix is upper-case'],
    ['v2.1.0', 'no service prefix'],
    ['2.1.0', 'no service prefix at all'],
    ['TEXT-2.1.0.1', 'four-part versions are not SemVer'],
    ['TEXT-02.1.0', 'leading zeros are not SemVer'],
    ['UNKNOWN-1.0.0', 'not a known service prefix'],
    ['COMPAT-1.0.0', 'compat-playground prefix retired'],
    ['TEXT-', 'no version'],
    ['', 'empty'],
  ])('rejects %s (%s)', (tag) => {
    expect(parseReleaseTag(tag)).toBeNull();
  });

  it('exposes a pattern consistent with the parser, for the CI shell gate', () => {
    expect(RELEASE_TAG_PATTERN.test('TEXT-2.1.0')).toBe(true);
    expect(RELEASE_TAG_PATTERN.test('TEXT-2.1')).toBe(false);
  });

  it('covers every prefix the CI build rules trigger on', () => {
    // Keep in lockstep with .gitlab/ci/build.yml — a prefix that builds an image
    // but is missing here would produce a release the console cannot name.
    expect(SERVICE_TAG_PREFIXES).toEqual(['ALL', 'API', 'ADMIN', 'GUARD', 'HARNESS', 'NLP', 'TEXT', 'STT', 'TTS']);
  });
});

describe('isPlatformTrainTag', () => {
  it('is true only for ALL-', () => {
    expect(isPlatformTrainTag('ALL-2.1.0')).toBe(true);
    expect(isPlatformTrainTag('TEXT-2.1.0')).toBe(false);
    expect(isPlatformTrainTag('ALL-nonsense')).toBe(false);
  });
});

describe('formatUntaggedVersion', () => {
  it('produces a pre-release-shaped identity that can never be mistaken for a release', () => {
    expect(formatUntaggedVersion('dev-2.1', '0ab258f9c1d2e3f4')).toBe('0.0.0-dev-2-1.0ab258f9');
  });

  it('sanitises branch characters that SemVer forbids', () => {
    expect(formatUntaggedVersion('feat/FOO_BAR+x', 'ABCDEF1234')).toBe('0.0.0-feat-FOO-BAR-x.abcdef12');
  });

  it('truncates the sha to 8 characters and lower-cases it', () => {
    expect(formatUntaggedVersion('main', 'ABCDEF1234567890')).toBe('0.0.0-main.abcdef12');
  });

  it('sorts below every real release, which is the whole point of 0.0.0', () => {
    const untagged = formatUntaggedVersion('dev-2.1', '0ab258f9');
    expect(untagged.startsWith('0.0.0-')).toBe(true);
    // and is never parseable as a release tag
    expect(parseReleaseTag(untagged)).toBeNull();
  });

  it('falls back to a placeholder rather than throwing when git data is missing', () => {
    // A build-info reader must never crash a service boot.
    expect(formatUntaggedVersion('', '')).toBe('0.0.0-unknown.unknown');
  });
});
