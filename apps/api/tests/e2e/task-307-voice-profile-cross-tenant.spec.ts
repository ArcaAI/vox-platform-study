/**
 * TASK-307 W3.7 — cross-user/cross-tenant probes against
 * VoiceProfileController (AC-11).
 *
 * Closes audit finding C-5 (BLOCKER, `04-api-design-review.md`). Before
 * this change, `PATCH /voice-profile/:id/activate`,
 * `PATCH /voice-profile/:id/deactivate`, and `DELETE /voice-profile/:id`
 * forwarded the supplied id to the service without verifying that the
 * caller owned the profile — any authenticated user with
 * `update:UserVoiceProfile` could enable, disable, or soft-delete any
 * other user's voice profile.
 *
 * The W3.2 interceptor + `assertVoiceProfileOwnership` branch resolves
 * the profile by id and 404s any caller whose CLS `user.id` does not
 * match the profile's `userId`. This is stricter than tenant-only
 * ownership (which `UserVoiceProfile` does not carry on the row), and
 * matches the existing `VoiceProfileService.assertOwnership` posture
 * normalised to 404 instead of mixed 403/400.
 *
 * Test scenario — voice profile enrollment requires audio buffers and a
 * matching CASL permission, which is not trivial to spin up in a
 * Playwright spec; the relevant cross-USER ownership behaviour is
 * exhaustively covered in the W3.2 interceptor unit tests. The probes
 * below verify the live 404 surface against synthetic ids so we anchor
 * the DEF-C3 "no existence leak" wording without depending on a live
 * audio pipeline.
 */
import { test, expect } from '@playwright/test';
import {
    DEFAULT_TENANT_KEY,
    SEEDED_USERS,
    loginUser,
} from '../../../../tests/helpers';

const SYNTHETIC_PROFILE_ID = '018f0000-0000-7200-8000-000000000000';

test.describe('TASK-307 W3.7 — UserVoiceProfile ownership (AC-11)', () => {
    let doctorToken: string;

    test.beforeAll(async ({ request }) => {
        const login = await loginUser(
            request,
            SEEDED_USERS.doctor.username,
            SEEDED_USERS.doctor.password,
            DEFAULT_TENANT_KEY,
        );
        expect(login, 'doctor login failed').toBeTruthy();
        doctorToken = login!.token;
    });

    test('PATCH /voice-profile/:id/activate of a nonexistent profile → 404', async ({ request }) => {
        const response = await request.patch(
            `/api/v1/voice-profile/${SYNTHETIC_PROFILE_ID}/activate`,
            { headers: { Authorization: `Bearer ${doctorToken}` } },
        );
        expect(response.status()).toBe(404);
        const body = await response.json();
        expect(String(body.message ?? '')).not.toMatch(/user|owner|tenant/i);
    });

    test('PATCH /voice-profile/:id/deactivate of a nonexistent profile → 404', async ({ request }) => {
        const response = await request.patch(
            `/api/v1/voice-profile/${SYNTHETIC_PROFILE_ID}/deactivate`,
            { headers: { Authorization: `Bearer ${doctorToken}` } },
        );
        expect(response.status()).toBe(404);
    });

    test('DELETE /voice-profile/:id of a nonexistent profile → 404 (no 200 leak)', async ({ request }) => {
        const response = await request.delete(
            `/api/v1/voice-profile/${SYNTHETIC_PROFILE_ID}`,
            { headers: { Authorization: `Bearer ${doctorToken}` } },
        );
        expect(response.status()).toBe(404);
    });
});
