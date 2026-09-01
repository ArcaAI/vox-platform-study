'use client';

import { useState } from 'react';
import { IconAlertTriangle, IconDownload, IconKey, IconUpload } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { useConfigurationExport, useImportConfigurations } from '../api/hooks';
import type { ProviderConfigurationExport } from '../api/types';
import type { ResolvedAiPlatformScope } from './use-ai-platform-scope';

/**
 * EXPORT / IMPORT of provider configurations — TASK-845 step 6.
 *
 * ## The one rule this component exists to keep
 *
 * **No secret is ever rendered here, in any form, including a hint.** The
 * artifact the gateway produces carries no credential material and no
 * characters of any key: each configuration that needs a secret carries a
 * `credentialRef` LOCATOR built only from (service, provider, keyVersion),
 * plus a `hasCredential` boolean. TASK-844 deliberately refused to emit a
 * "last 4" — producing one would mean decrypting a live key on a path whose
 * purpose is to not handle key material, and four known characters of a
 * structured vendor key are a partial disclosure, not a mask.
 *
 * The UI must not re-add what the contract refused. So this component renders
 * the locator and the boolean and nothing else, and
 * `__tests__/configuration-transfer-drawer.test.tsx` asserts that a credential
 * placed anywhere in the artifact does not reach the DOM.
 *
 * ## What an import can and cannot restore
 *
 * It cannot restore a credential — the artifact carries none. Rows bind to the
 * TARGET tenant's own connection for the named (service, provider); where the
 * source had a credential and the target has none, the row still lands and its
 * locator comes back in `requiresCredential` so the operator is told which
 * secrets to supply rather than discovering it as a 503 later. Every imported
 * row lands as a DRAFT and is never elected, so an import cannot unseat a
 * default the target tenant already chose. The drawer says all of this in the
 * UI, because an operator who has to read a ticket to learn it will not.
 */
export function ConfigurationTransferDrawer({
  open,
  onOpenChange,
  scope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: ResolvedAiPlatformScope;
}) {
  const [tab, setTab] = useState('export');
  const [artifactText, setArtifactText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);

  const exportQuery = useConfigurationExport(scope.tenantId, undefined, open && tab === 'export');
  const importMutation = useImportConfigurations(scope.tenantId);

  const download = () => {
    if (!exportQuery.data) return;
    const blob = new Blob([JSON.stringify(exportQuery.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `provider-configurations-${scope.tenantId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const submitImport = () => {
    let parsed: ProviderConfigurationExport;
    try {
      parsed = JSON.parse(artifactText) as ProviderConfigurationExport;
    } catch {
      setParseError('That is not valid JSON. Paste the artifact exactly as it was exported.');
      return;
    }
    if (parsed?.formatVersion !== 1 || !Array.isArray(parsed.configurations)) {
      setParseError('Unrecognised artifact. Expected a formatVersion 1 export with a `configurations` array.');
      return;
    }
    setParseError(null);
    importMutation.mutate(parsed, {
      onSuccess: (result) => {
        toast.success(`Imported ${result.imported} configuration(s); skipped ${result.skipped}.`);
        setArtifactText('');
      },
      onError: (error) => toast.error(error instanceof Error ? error.message : 'Import failed.'),
    });
  };

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <DetailDrawer
        open={open}
        onOpenChange={onOpenChange}
        title="Transfer provider configurations"
        size="xl"
        meta={<span className="font-mono">{scope.label}</span>}
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="export">Export</TabsTrigger>
            <TabsTrigger value="import">Import</TabsTrigger>
          </TabsList>
        }
        footer={
          tab === 'export' ? (
            <Button size="sm" disabled={!exportQuery.data} onClick={download}>
              <IconDownload aria-hidden />
              Download JSON
            </Button>
          ) : (
            <Button size="sm" disabled={artifactText.trim() === '' || importMutation.isPending} onClick={submitImport}>
              {importMutation.isPending ? <Spinner /> : <IconUpload aria-hidden />}
              Import configurations
            </Button>
          )
        }
      >
        <TabsContent value="export" className="flex flex-col gap-4">
          <Alert>
            <IconKey aria-hidden />
            <AlertTitle>This artifact contains no credentials</AlertTitle>
            <AlertDescription>
              Not even a masked hint. Each configuration that needs a secret names it with a locator — service, provider and key version — so an importing
              operator knows <em>which</em> secret to supply. Showing part of a live key would be a disclosure, not a mask.
            </AlertDescription>
          </Alert>

          {exportQuery.isPending ? (
            <div className="flex flex-col gap-2" aria-hidden>
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-3/4" />
            </div>
          ) : exportQuery.error ? (
            <p className="text-destructive text-sm">{exportQuery.error instanceof Error ? exportQuery.error.message : 'Could not build the export.'}</p>
          ) : !exportQuery.data || exportQuery.data.configurations.length === 0 ? (
            <p className="text-muted-foreground text-sm">There is nothing to export in this scope.</p>
          ) : (
            <div className="rounded-md border">
              <Table aria-label="Configurations in this export">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Task</TableHead>
                    <TableHead scope="col">Configuration</TableHead>
                    <TableHead scope="col">Connection</TableHead>
                    <TableHead scope="col">Model</TableHead>
                    <TableHead scope="col">Credential</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exportQuery.data.configurations.map((config, index) => (
                    <TableRow key={`${config.taskKey}-${config.displayName ?? index}`}>
                      <TableCell className="font-mono text-xs">{config.taskKey}</TableCell>
                      <TableCell className="text-xs">
                        {config.displayName ?? '—'}
                        {config.isDefault ? (
                          <Badge variant="default" className="ml-2">
                            Default
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {config.connection ? `${config.connection.service}:${config.connection.provider}` : '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{config.modelSlug ?? config.modelRef ?? '—'}</TableCell>
                      <TableCell className="text-xs">
                        {config.hasCredential ? (
                          // The LOCATOR, and only the locator.
                          <span className="font-mono break-all">{config.credentialRef ?? 'required'}</span>
                        ) : (
                          <span className="text-muted-foreground">None needed</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="import" className="flex flex-col gap-4">
          <Alert variant="destructive">
            <IconAlertTriangle aria-hidden />
            <AlertTitle>An import cannot restore credentials</AlertTitle>
            <AlertDescription>
              The artifact carries none. Imported configurations bind to this tenant’s own connection for each named provider; anything that needed a secret
              the tenant does not have comes back in the list below for you to supply out of band. Every imported row lands as a DRAFT and is never elected,
              so importing cannot change what currently serves traffic.
            </AlertDescription>
          </Alert>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="artifact-json">Exported artifact (JSON)</Label>
            <Textarea
              id="artifact-json"
              value={artifactText}
              onChange={(event) => {
                setArtifactText(event.target.value);
                setParseError(null);
              }}
              className="min-h-48 resize-none font-mono text-xs"
              placeholder='{"formatVersion":1,…}'
              aria-describedby={parseError ? 'artifact-json-error' : undefined}
              aria-invalid={parseError !== null}
            />
            {parseError ? (
              <p id="artifact-json-error" className="text-destructive text-sm">
                {parseError}
              </p>
            ) : null}
          </div>

          {importMutation.data ? (
            <div className="flex flex-col gap-2 rounded-md border p-3 text-xs">
              <p>
                Imported <strong>{importMutation.data.imported}</strong>, skipped <strong>{importMutation.data.skipped}</strong>.
              </p>
              {importMutation.data.requiresCredential.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="font-medium">Credentials still to supply:</p>
                  <ul className="flex flex-col gap-1">
                    {importMutation.data.requiresCredential.map((ref) => (
                      <li key={ref} className="font-mono break-all">
                        {ref}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-muted-foreground">No credentials are outstanding.</p>
              )}
            </div>
          ) : null}
        </TabsContent>
      </DetailDrawer>
    </Tabs>
  );
}
