import { ApiProperty } from '@nestjs/swagger';

/** TASK-1038 (F1) — what `POST /media` answers: the reference a run carries (`{ mediaId, mime }`), plus its size and digest. */
export class MediaUploadResponse {
  @ApiProperty({ description: 'The Media id a run references (`attachments: [{ mediaId }]`, a DOCUMENT/IMAGE kind, an audio blob kind).' })
  mediaId!: string;

  @ApiProperty({ description: 'The stored MIME type, normalised (lower-case; `image/jpg` → `image/jpeg`).', example: 'application/pdf' })
  mime!: string;

  @ApiProperty({ description: 'Size of the stored bytes.', example: 20480 })
  sizeBytes!: number;

  @ApiProperty({ description: 'SHA-256 of the stored bytes, lower-case hex.' })
  sha256!: string;
}
