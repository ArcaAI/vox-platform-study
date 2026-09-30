'use client';

import { useId, useState } from 'react';
import { IconInfoCircle } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { EmptyState } from '@/shared/state/empty-state';
import type { ModelRegistrationSource } from '@arcaai/types';
import { RegisterHfPanel, useHfRegistration } from './register-hf-panel';
import { RegisterLocalPanel, useLocalRegistration } from './register-local-panel';

export interface RegisterModelSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which source tab opens first. Default Hugging Face. */
  initialTab?: ModelRegistrationSource;
  /** Bucket-relative path to preselect on the Local tab (the "In bucket, not registered" hand-off). */
  initialLocalPath?: string;
}

/**
 * The ONE way to register a model (TASK-1023): three sources, no hyperparameters.
 * Hugging Face needs a repository id, Local path is picked from the model bucket, and MLflow is shown but
 * not available yet. Everything else is derived by the gateway; overrides sit behind "Advanced" and are only
 * sent when the admin changed them. Mount it with a `key` that changes per open to start from a clean form.
 */
export function RegisterModelSheet({ open, onOpenChange, initialTab = 'HUGGINGFACE', initialLocalPath = '' }: RegisterModelSheetProps) {
  const uid = useId();
  const [tab, setTab] = useState<ModelRegistrationSource>(initialLocalPath ? 'LOCAL' : initialTab);

  // The sheet is re-mounted per open (see above), so a successful registration only has to close it.
  const hf = useHfRegistration(open, () => onOpenChange(false));
  const local = useLocalRegistration(open, initialLocalPath, () => onOpenChange(false));
  const close = () => {
    hf.reset();
    local.reset();
    onOpenChange(false);
  };

  const pending = hf.isPending || local.isPending;
  const active = tab === 'HUGGINGFACE' ? hf : tab === 'LOCAL' ? local : null;
  const formId = `${uid}-${tab}`;
  const reasonId = `${uid}-reason`;
  const disabledReason = active?.disabledReason ?? null;

  function handleOpenChange(next: boolean) {
    if (next) return onOpenChange(true);
    if (pending) return;
    close();
  }

  return (
    <Tabs value={tab} onValueChange={(next) => setTab(next as ModelRegistrationSource)} className="contents">
      <DetailDrawer
        open={open}
        onOpenChange={handleOpenChange}
        closeBlockedReason={pending ? 'Registering the model — wait for it to finish.' : undefined}
        size="md"
        title="Register model"
        meta={<span>Add a model to the platform registry. The platform works out the rest.</span>}
        tabs={
          <TabsList variant="line" className="mt-1">
            <TabsTrigger value="HUGGINGFACE">Hugging Face</TabsTrigger>
            <TabsTrigger value="MLFLOW">MLflow</TabsTrigger>
            <TabsTrigger value="LOCAL">Local path</TabsTrigger>
          </TabsList>
        }
        footer={
          <div className="flex w-full flex-col gap-2">
            {disabledReason ? (
              <p id={reasonId} className="text-muted-foreground text-xs">
                {disabledReason}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
                Cancel
              </Button>
              {active ? (
                <Button type="submit" form={formId} disabled={pending || disabledReason !== null} aria-describedby={disabledReason ? reasonId : undefined}>
                  {pending ? <Spinner /> : null}
                  {tab === 'HUGGINGFACE' ? 'Register and download' : 'Register'}
                </Button>
              ) : null}
            </div>
          </div>
        }
      >
        <TabsContent value="HUGGINGFACE">
          <RegisterHfPanel hf={hf} formId={`${uid}-HUGGINGFACE`} />
        </TabsContent>
        <TabsContent value="MLFLOW">
          <EmptyState
            icon={IconInfoCircle}
            title="Not available yet"
            description="Registering from the internal MLflow registry is not available yet."
          />
        </TabsContent>
        <TabsContent value="LOCAL">
          <RegisterLocalPanel local={local} formId={`${uid}-LOCAL`} />
        </TabsContent>
      </DetailDrawer>
    </Tabs>
  );
}
