import { ApiProperty } from '@nestjs/swagger';

/**
 * TASK-396 — the decrypted plaintext for ONE secret setting.
 *
 * Returned ONLY by the gated `POST /admin/settings/:id/reveal` endpoint. This
 * shape is intentionally minimal (no version/timestamps/audit fields) — it is a
 * transient payload the admin console shows briefly and never persists. The
 * `value` here is the sole place the server emits a secret's plaintext; every
 * other read (`GET /admin/settings`) masks it.
 */
export class RevealGlobalSettingResponse {
  @ApiProperty({ description: 'ID of the revealed setting' })
  id!: string;

  @ApiProperty({ description: 'Key of the revealed setting' })
  key!: string;

  @ApiProperty({ description: 'Decrypted plaintext value (transient — do not persist).' })
  value!: string;

  @ApiProperty({ description: 'ISO-8601 timestamp of when the reveal occurred.' })
  revealedAt!: string;

  constructor(init: RevealGlobalSettingResponse) {
    this.id = init.id;
    this.key = init.key;
    this.value = init.value;
    this.revealedAt = init.revealedAt;
  }
}
