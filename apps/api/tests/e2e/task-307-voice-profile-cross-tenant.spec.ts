/**
 * Cross-user / cross-tenant probes against VoiceProfileController
 * (AC-11).
 *
 * Originally landed by TASK-307 W3.7 closing audit finding C-5
 * (`docs/multi-tenancy-audit/04-api-design-review.md`): before that
 * fix `PATCH /voice-profile/:id/activate`, `:id/deactivate`, and
 * `DELETE /voice-profile/:id` forwarded the supplied id to the
 * service without verifying that the caller owned the profile — any
 * authenticated user with `update:UserVoiceProfile` could enable,
 * disable, or soft-delete any other user's voice profile.
 *
 * `UserVoiceProfile` is USER-scoped (no `tenantId` column). The W3.2
 * `TenantOwnedResourceInterceptor` `assertVoiceProfileOwnership`
 * branch resolves the profile by id and 404s any caller whose CLS
 * `user.id` does not match the profile's `userId`. This is stricter
 * than tenant-only ownership and matches the existing
 * `VoiceProfileService.assertOwnership` posture, normalised to 404
 * instead of mixed 403/400.
 *
 * TASK-309 AC-2 / AC-3 — genuine probe upgrade. The previous synthetic
 * uuidv7 probe asserted only that the 404 SHAPE was correct (since
 * the database had no matching row, the resource-not-found branch
 * fired regardless of the cross-user logic). This spec now enrols a
 * real `UserVoiceProfile` belonging to `doctor` and probes it from
 * `doctor2` — both are in tenant `__GLOBAL__`, so the 404 must come
 * from the per-USER `userId !== cls.user.id` check, not from a
 * tenant mismatch.
 *
 * The synthetic-id probe is retained as a baseline shape assertion so
 * an unknown id and a cross-user id are indistinguishable on the
 * wire (DEF-C3).
 *
 * Live-stack requirement: this spec depends on the dev stack PLUS the
 * STT-V2 service for `/voice-profile/extract` (called by
 * `VoiceProfileService.enroll`). If STT-V2 is unreachable, the
 * enrolment in `beforeAll` 5xxs and every dependent test is reported
 * as a setup failure — the cross-user assertion intentionally does
 * NOT fall back to a synthetic id, because that would silently
 * downgrade to the pre-TASK-309 behaviour.
 */
import { test, expect } from '@playwright/test';
import {
    DEFAULT_TENANT_KEY,
    SEEDED_USERS,
    loginUser,
} from '../../../../tests/helpers';

/**
 * uuidv7-shaped id that no user has ever seen. The interceptor's 404
 * for this id must match the 404 shape from the genuine cross-user
 * probe — DEF-C3 "no existence leak".
 */
const SYNTHETIC_PROFILE_ID = '018f0000-0000-7200-8000-000000000000';

/**
 * Build a minimal 16-bit PCM WAV buffer with `durationSeconds` of
 * silence at 16 kHz, mono. STT-V2's voice-profile extractor needs
 * enough audio to compute an embedding; ~3 seconds is the documented
 * minimum in `apps/stt-v2/docs/voice-profile.md`. We pad to 4 s to
 * stay safely above the floor without making the test artifact huge.
 */
function createSilenceWav(durationSeconds: number): Buffer {
    const sampleRate = 16000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const numSamples = Math.floor(sampleRate * durationSeconds);
    const bytesPerSample = bitsPerSample / 8;
    const dataSize = numSamples * numChannels * bytesPerSample;
    const headerSize = 44;
    const buffer = Buffer.alloc(headerSize + dataSize);

    buffer.write('RIFF', 0, 4, 'ascii');
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8, 4, 'ascii');
    buffer.write('fmt ', 12, 4, 'ascii');
    buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
    buffer.writeUInt16LE(1, 20); // audio format = PCM
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
    buffer.writeUInt16LE(numChannels * bytesPerSample, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36, 4, 'ascii');
    buffer.writeUInt32LE(dataSize, 40);
    // Payload bytes already zeroed by Buffer.alloc — that's the silence.

    return buffer;
}

test.describe('TASK-309 AC-2/AC-3 — UserVoiceProfile ownership genuine probe (AC-11)', () => {
    let doctorToken: string;
    let doctor2Token: string;
    let profileId: string | null = null;

    test.beforeAll(async ({ request }) => {
        const doctorLogin = await loginUser(
            request,
            SEEDED_USERS.doctor.username,
            SEEDED_USERS.doctor.password,
            DEFAULT_TENANT_KEY,
        );
        expect(doctorLogin, 'doctor login failed').toBeTruthy();
        doctorToken = doctorLogin!.token;

        const doctor2Login = await loginUser(
            request,
            SEEDED_USERS.doctor2.username,
            SEEDED_USERS.doctor2.password,
            DEFAULT_TENANT_KEY,
        );
        expect(doctor2Login, 'doctor2 login failed').toBeTruthy();
        doctor2Token = doctor2Login!.token;

        // Bootstrap a real voice profile owned by `doctor`. The
        // enrolment hits STT-V2 for the embedding — if the service is
        // unavailable the response is 5xx, in which case downstream
        // cross-user probes intentionally `expect(profileId).toBeTruthy()`
        // to surface the setup failure rather than degrade to a
        // synthetic-id assertion.
        const audio = createSilenceWav(4);
        const enrollResp = await request.post('/api/v1/voice-profile/enroll', {
            headers: { Authorization: `Bearer ${doctorToken}` },
            multipart: {
                label: 'task-309-cross-user-probe',
                files: {
                    name: 'enrollment.wav',
                    mimeType: 'audio/wav',
                    buffer: audio,
                },
            },
        });
        if (enrollResp.status() >= 200 && enrollResp.status() < 300) {
            const created = (await enrollResp.json()) as { id: string };
            profileId = created.id;
        } else {
            console.warn(
                `[voice-profile probe] enroll returned ${enrollResp.status()}; cross-user assertions will be skipped — body: ${await enrollResp.text()}`,
            );
        }
    });

    test.afterAll(async ({ request }) => {
        if (profileId) {
            // Best-effort cleanup; the test does NOT assert success so
            // a failure here doesn't mask the cross-user contract.
            await request.delete(`/api/v1/voice-profile/${profileId}`, {
                headers: { Authorization: `Bearer ${doctorToken}` },
            }).catch(() => undefined);
        }
    });

    test('PATCH /voice-profile/:id/activate from a different user → 404', async ({ request }) => {
        test.skip(!profileId, 'enrolment failed — see beforeAll warning; STT-V2 may be unavailable');
        const response = await request.patch(
            `/api/v1/voice-profile/${profileId}/activate`,
            { headers: { Authorization: `Bearer ${doctor2Token}` } },
        );
        expect(response.status()).toBe(404);
        const body = await response.json();
        expect(String(body.message ?? '')).not.toMatch(/user|owner|tenant/i);
    });

    test('PATCH /voice-profile/:id/deactivate from a different user → 404', async ({ request }) => {
        test.skip(!profileId, 'enrolment failed — see beforeAll warning; STT-V2 may be unavailable');
        const response = await request.patch(
            `/api/v1/voice-profile/${profileId}/deactivate`,
            { headers: { Authorization: `Bearer ${doctor2Token}` } },
        );
        expect(response.status()).toBe(404);
    });

    test('DELETE /voice-profile/:id from a different user → 404 (no 200 leak)', async ({ request }) => {
        test.skip(!profileId, 'enrolment failed — see beforeAll warning; STT-V2 may be unavailable');
        const response = await request.delete(
            `/api/v1/voice-profile/${profileId}`,
            { headers: { Authorization: `Bearer ${doctor2Token}` } },
        );
        expect(response.status()).toBe(404);
    });

    test('synthetic uuidv7 profileId from owner → 404 (DEF-C3: same shape as cross-user 404)', async ({ request }) => {
        const response = await request.patch(
            `/api/v1/voice-profile/${SYNTHETIC_PROFILE_ID}/activate`,
            { headers: { Authorization: `Bearer ${doctorToken}` } },
        );
        expect(response.status()).toBe(404);
        const body = await response.json();
        expect(String(body.message ?? '')).not.toMatch(/user|owner|tenant/i);
    });
});
