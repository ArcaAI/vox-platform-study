'use client';

import { useState } from 'react';
import { IconAlertTriangle, IconBrandGithub, IconExternalLink } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect } from '@arcaai/ui/components/shadcn/native-select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { useRegisterCatalogueModel } from '../api/catalogue-client';

/**
 * Formats a Hub repo can carry that this platform can serve. Authored here
 * rather than fetched because it is the console's own picker vocabulary, and it
 * is the same closed enum the gateway validates `format` against — an
 * unrecognised value is a 400 either way.
 */
const FORMATS = ['SAFETENSOR', 'GGUF', 'ONNX', 'PYTORCH', 'CTRANSLATE2', 'FASTER_WHISPER', 'MLX', 'NEMO', 'WHISPER_CPP'] as const;

/** `hf:<org>/<repo>` or a bare Hub id — the grammar every service resolver honours. */
function normaliseRepoId(raw: string): string {
  const trimmed = raw.trim().replace(/^https?:\/\/huggingface\.co\//i, '').replace(/\/+$/, '');
  return trimmed.startsWith('hf:') ? trimmed : `hf:${trimmed}`;
}

function hubUrl(raw: string): string {
  return `https://huggingface.co/${raw.trim.replace(/^hf:/, '').replace(/^https?:\/\/huggingface\.co\//i, '')}`;
}

/**
 * FETCH FROM HUGGINGFACE — the model-store acquisition flow ( step 7,
 * bounded by OD-2: HuggingFace is a model SOURCE, never an inference provider).
 *
 * ## What this actually does, and why it is not a download button
 *
 * On this platform a Hub model is brought in by CATALOGUING it —
 * `source: HUGGINGFACE`, `sourceUri: hf:<org>/<repo>` — after which the STT
 * weight fetcher resolves the Hub token and the model-store S3 pair through
 * `model-registry:huggingface` / `model-registry:s3` and pulls the weights on
 * first use. There is no synchronous download endpoint, and there should not
 * be one: a multi-gigabyte LFS transfer belongs in a job, not on a request
 * thread (this ticket's own risk table says so). So this drawer submits the
 * acquisition INTENT to the surface that exists, rather than shipping a button
 * wired to an endpoint nobody has written.
 *
 * ## Gated repositories
 *
 * A gated repo requires a human to accept its terms on the Hub, per repo, under
 * the account whose token the platform holds. That cannot be automated —
 * accepting a licence on someone's behalf is the thing the gate exists to
 * prevent — so the flow states it as a REQUIRED acknowledgement before it will
 * submit, and surfaces a 401/403 from the fetch path as an explicit, actionable
 * error naming the repo and linking to it. Silent failure is the outcome this
 * design exists to rule out.
 */
export function HuggingFaceFetchDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [repo, setRepo] = useState('');
  const [revision, setRevision] = useState('');
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [taskType, setTaskType] = useState('TEXT_GENERATION');
  const [format, setFormat] = useState<string>('SAFETENSOR');
  const [termsAccepted, setTermsAccepted] = useState(false);

  const register = useRegisterCatalogueModel();

  const trimmedRepo = repo.trim();
  const canSubmit = trimmedRepo !== '' && slug.trim() !== '' && name.trim() !== '' && termsAccepted && !register.isPending;

  const reset = () => {
    setRepo('');
    setRevision('');
    setSlug('');
    setName('');
    setTermsAccepted(false);
  };

  const gatedFailure =
    register.error instanceof GatewayError && (register.error.status === 401 || register.error.status === 403) ? register.error : null;

  return (
    <DetailDrawer
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Fetch a model from HuggingFace"
      size="lg"
      meta={<span>HuggingFace is a model SOURCE, never an inference provider — this catalogues a Hub repo so the weight fetcher can pull it.</span>}
      footer={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={() =>
              register.mutate(
                {
                  slug: slug.trim(),
                  name: name.trim(),
                  category: 'NLP',
                  taskType,
                  modelType: 'BASE_MODEL',
                  source: 'HUGGINGFACE',
                  sourceUri: normaliseRepoId(trimmedRepo),
                  sourceRevision: revision.trim() || undefined,
                  format,
                },
                {
                  onSuccess: (model) => {
                    toast.success(`${model.slug} catalogued. The weight fetcher will pull it into the model store on first use.`);
                    reset();
                    onOpenChange(false);
                  },
                  onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not catalogue this repository.'),
                },
              )
            }
          >
            {register.isPending ? <Spinner /> : null}
            Catalogue repository
          </Button>
          {trimmedRepo ? (
            <Button asChild variant="outline" size="sm">
              <a href={hubUrl(trimmedRepo)} target="_blank" rel="noreferrer noopener">
                Open on the Hub
                <IconExternalLink aria-hidden />
              </a>
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {gatedFailure ? (
          <Alert variant="destructive">
            <IconAlertTriangle aria-hidden />
            <AlertTitle>This repository is gated</AlertTitle>
            <AlertDescription>
              The Hub refused access to <span className="font-mono">{trimmedRepo}</span>. Gated repositories require a person to accept the model’s terms on
              huggingface.co, per repository, using the account whose token this platform holds. That step cannot be automated. Accept the terms, then try
              again.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hf-repo">
            Repository <span aria-hidden>*</span>
          </Label>
          <Input
            id="hf-repo"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="openai/whisper-large-v3"
            className="font-mono"
            aria-describedby="hf-repo-help"
          />
          <p id="hf-repo-help" className="text-muted-foreground text-xs">
            An org/repo id, or a full huggingface.co URL. Stored as <span className="font-mono">{normaliseRepoId(trimmedRepo || 'org/repo')}</span>.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hf-revision">Revision</Label>
            <Input id="hf-revision" value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="main" className="font-mono" />
            <p className="text-muted-foreground text-xs">A branch, tag or commit. Leave empty to track the repository default.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hf-format">Format</Label>
            <NativeSelect id="hf-format" value={format} onChange={(event) => setFormat(event.target.value)}>
              {FORMATS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hf-slug">
              Catalogue slug <span aria-hidden>*</span>
            </Label>
            <Input id="hf-slug" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="whisper-large-v3" className="font-mono" />
            <p className="text-muted-foreground text-xs">The portable identity a provider configuration selects by.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hf-name">
              Display name <span aria-hidden>*</span>
            </Label>
            <Input id="hf-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Whisper Large v3" />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hf-task">Task type</Label>
          <Input id="hf-task" value={taskType} onChange={(event) => setTaskType(event.target.value)} className="font-mono" />
          <p className="text-muted-foreground text-xs">The gateway’s task-type enum (46 values); it is validated server-side.</p>
        </div>

        <div className="flex items-start gap-2 rounded-md border p-3">
          <Checkbox id="hf-terms" checked={termsAccepted} onCheckedChange={(next) => setTermsAccepted(next === true)} className="mt-0.5" />
          <Label htmlFor="hf-terms" className="text-xs leading-relaxed font-normal">
            I have checked whether this repository is <strong>gated</strong>, and if it is, its terms have been accepted on huggingface.co under the account
            whose token this platform holds. This cannot be done automatically, and a gated repository will fail to download without it.
          </Label>
        </div>

        <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
          <IconBrandGithub aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Cataloguing does not transfer bytes here and now. The weight fetcher pulls the repository into the model store on first use, resolving the Hub
            token and the store credentials through the <span className="font-mono">model-registry</span> connections — large LFS transfers belong in a job,
            not in this request.
          </span>
        </p>
      </div>
    </DetailDrawer>
  );
}
