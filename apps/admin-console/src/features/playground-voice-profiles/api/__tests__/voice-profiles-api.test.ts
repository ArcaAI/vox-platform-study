/**
 * Frame 52 — voice profiles API layer (matrix row 36). fetch is stubbed at the
 * network boundary and every call is asserted as an exact
 * "METHOD /api/hope/<path>" string against VoiceProfileController. These are
 * OWN-ACCOUNT routes: no `admin/` prefix, no tenant param — the gateway scopes
 * rows to the caller (`user-profile-own`, userId = ${user.id}).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SAMPLES,
  MAX_SAMPLE_BYTES,
  activateVoiceProfile,
  deactivateVoiceProfile,
  deleteVoiceProfile,
  enrollVoiceProfile,
  listVoiceProfiles,
} from '../client';
import { voiceProfileKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

function installFetchMock(response: () => Response = () => Response.json({})): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      return response();
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function audioFile(name: string, bytes = 16, type = 'audio/webm'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('voiceProfileKeys', () => {
  it('is stable across calls and rooted under the domain namespace', () => {
    expect(voiceProfileKeys.list()).toEqual(voiceProfileKeys.list());
    for (const key of [voiceProfileKeys.list()]) {
      expect(key[0]).toBe('playground-voice-profiles');
    }
    expect(voiceProfileKeys.list()[0]).toBe(voiceProfileKeys.root[0]);
  });
});

describe('enrollment constraints', () => {
  it('mirrors the gateway caps (3 files, 10 MB each)', () => {
    expect(MAX_SAMPLES).toBe(3);
    expect(MAX_SAMPLE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('voice profiles client', () => {
  it('lists the caller profiles (own-account plane, no admin prefix)', async () => {
    const calls = installFetchMock(() => Response.json([]));
    await listVoiceProfiles();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/voice-profiles']);
  });

  it('enrolls with a multipart body: repeated `files` field plus optional `label`', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'vp-1' }, { status: 201 }));
    await enrollVoiceProfile({ files: [audioFile('greeting.wav', 8, 'audio/wav'), audioFile('reading.webm')], label: 'Quiet room' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/hope/voice-profiles/enroll']);

    const body = calls[0].body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    const files = form.getAll('files');
    expect(files).toHaveLength(2);
    expect(files.every((entry) => entry instanceof File)).toBe(true);
    expect((files[0] as File).name).toBe('greeting.wav');
    expect((files[1] as File).name).toBe('reading.webm');
    expect(form.get('label')).toBe('Quiet room');
    // fetch must derive the multipart boundary itself — no manual content-type.
    expect(calls[0].headers.has('content-type')).toBe(false);
  });

  it('omits the label field when not provided', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'vp-1' }, { status: 201 }));
    await enrollVoiceProfile({ files: [audioFile('solo.ogg', 4, 'audio/ogg')] });
    const form = calls[0].body as FormData;
    expect(form.getAll('files')).toHaveLength(1);
    expect(form.has('label')).toBe(false);
  });

  it('activates and deactivates a profile via the per-id PATCH routes', async () => {
    const calls = installFetchMock(() => Response.json({ success: true }));
    const activated = await activateVoiceProfile('vp-1');
    const deactivated = await deactivateVoiceProfile('vp-2');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'PATCH /api/hope/voice-profiles/vp-1/activate',
      'PATCH /api/hope/voice-profiles/vp-2/deactivate',
    ]);
    expect(activated.success).toBe(true);
    expect(deactivated.success).toBe(true);
  });

  it('deletes a profile and returns the removed row', async () => {
    const calls = installFetchMock(() => Response.json({ id: 'vp-1', isActive: false }));
    const removed = await deleteVoiceProfile('vp-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['DELETE /api/hope/voice-profiles/vp-1']);
    expect(removed.id).toBe('vp-1');
  });

  it('escapes path params', async () => {
    const calls = installFetchMock(() => Response.json({ success: true }));
    await activateVoiceProfile('vp/1');
    await deactivateVoiceProfile('vp 2');
    await deleteVoiceProfile('vp#3');
    expect(calls.map((call) => call.url)).toEqual([
      '/api/hope/voice-profiles/vp%2F1/activate',
      '/api/hope/voice-profiles/vp%202/deactivate',
      '/api/hope/voice-profiles/vp%233',
    ]);
  });
});
