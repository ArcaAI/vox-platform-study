/**
 * `manifest.json` builder — the Merkle-root record published alongside a
 * model's weights in `hope-models` (`infrastructure/docker/minio/README.md`
 * Pure function over already-fetched (staged) files' facts; no I/O.
 *
 * Deliberately populates only what this lane's inputs can derive:
 * `schemaVersion`, `slug`, `version`, `quantization`, `format`,
 * `primaryObject`, `projectorObject`, `shardCount`, `totalBytes`,
 * `objects[]` (path/role/bytes/sha256), `upstream.sourceUri`,
 * `publishedAt`/`publishedBy`. `contextLength`, `engine.minVersion`,
 * `upstream.revision`/`license` have no source in an `AiModel` row and are
 * OMITTED rather than guessed — see the ticket report for this open
 * question.
 */
/**
 * One published object: its size comes from `size` (a file staged on disk,
 * TASK-1019) or, for an in-memory caller, from `data`.
 */
export interface AiModelManifestInputFile {
  path: string;
  sha256: string;
  size?: number;
  data?: Buffer;
}

export type AiModelManifestObjectRole = 'weights' | 'projector' | 'config';

export interface AiModelManifestObject {
  path: string;
  role: AiModelManifestObjectRole;
  bytes: number;
  sha256: string;
}

export interface AiModelManifest {
  schemaVersion: 1;
  slug: string;
  version: string;
  quantization: string | null;
  format: string;
  primaryObject: string | null;
  projectorObject: string | null;
  shardCount: number;
  totalBytes: number;
  objects: AiModelManifestObject[];
  upstream: { sourceUri: string };
  publishedAt: string;
  publishedBy: string;
}

const WEIGHT_EXTENSIONS = ['.gguf', '.safetensors', '.bin', '.onnx', '.pt', '.npz'];

function roleFor(path: string): AiModelManifestObjectRole {
  const base = (path.split('/').pop() ?? path).toLowerCase();
  if (base.includes('mmproj')) return 'projector';
  if (WEIGHT_EXTENSIONS.some((ext) => base.endsWith(ext))) return 'weights';
  return 'config';
}

export function buildAiModelManifest(params: {
  slug: string;
  version: string;
  quant: string | null;
  format: string;
  sourceUri: string;
  files: ReadonlyArray<AiModelManifestInputFile>;
  publishedBy: string;
  now?: Date;
}): AiModelManifest {
  const objects: AiModelManifestObject[] = params.files.map((f) => ({
    path: f.path,
    role: roleFor(f.path),
    bytes: f.size ?? f.data?.length ?? 0,
    sha256: f.sha256,
  }));

  const weightObjects = objects.filter((o) => o.role === 'weights').sort((a, b) => a.path.localeCompare(b.path));
  const projectorObjects = objects.filter((o) => o.role === 'projector');

  return {
    schemaVersion: 1,
    slug: params.slug,
    version: params.version,
    quantization: params.quant,
    format: params.format,
    primaryObject: weightObjects[0]?.path ?? null,
    projectorObject: projectorObjects[0]?.path ?? null,
    shardCount: weightObjects.length,
    totalBytes: objects.reduce((sum, o) => sum + o.bytes, 0),
    objects,
    upstream: { sourceUri: params.sourceUri },
    publishedAt: (params.now ?? new Date()).toISOString(),
    publishedBy: params.publishedBy,
  };
}
