/**
 * Wire types mirroring the own-account voice-profile plane
 * (VoiceProfileController + VoiceProfileResponse — the console cannot import
 * the gateway packages, so the shapes are declared here once). Rows are
 * strictly user-owned (`user-profile-own`, userId = ${user.id}); there is
 * deliberately NO admin surface over other users' voice biometrics.
 */

/** VoiceProfileResponse — GET /voice-profile rows, enroll/delete payloads. */
export interface VoiceProfile {
    id: string;
    userId: string;
    /** Active profiles auto-attach to live-transcription sessions (voiceProfileSeeded). */
    isActive: boolean;
    label: string | null;
    modelId: string | null;
    createdAt: string;
    updatedAt: string;
}

/** POST /voice-profile/enroll multipart input (field `files`, optional `label`). */
export interface EnrollVoiceProfileInput {
    /** 1..3 audio samples (`audio/*`, ≤10 MB each — gateway-validated). */
    files: File[];
    /** Optional human label, ≤100 chars (EnrollBodyDto). */
    label?: string;
}

/** PATCH :id/activate | :id/deactivate acknowledgement. */
export interface VoiceProfileToggleResponse {
    success: boolean;
}
