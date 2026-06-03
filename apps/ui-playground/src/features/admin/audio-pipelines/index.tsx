import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';

import { Main } from '@/components/layout/main';

import { BackendPipelinesTab } from './backend-pipelines-tab';
import { FrontendPipelineTab } from './frontend-pipeline-tab';

/**
 * TASK-331 doc-03 #2 — consolidated Audio Pipelines console.
 *
 * The three former pipeline nav entries (Audio Pipelines / Frontend Pipeline /
 * Backend Pipeline) are unified into ONE page with two sub-administration tabs:
 *
 *   - Frontend Pipeline: per-tenant capture defaults that run on LOCAL models
 *     (`TenantFrontendConfig`).
 *   - Backend Pipelines: backend ASR YAML model management (`AsrPipeline`) —
 *     list / create / edit / delete + set-default / enable-disable / versions.
 *
 * Both tabs are tenant-scoped via the header ScopeSwitcher (store `tenantId`)
 * and show the editing tenant by name.
 */
export default function AudioPipelinesPage() {
  return (
    <Main>
      <div className="mb-4">
        <h2 className="text-2xl font-bold tracking-tight">Audio Pipelines</h2>
        <p className="text-muted-foreground mt-1">Manage per-tenant frontend capture defaults and backend ASR pipelines.</p>
      </div>

      <Tabs defaultValue="frontend" className="gap-4">
        <TabsList>
          <TabsTrigger value="frontend">Frontend Pipeline</TabsTrigger>
          <TabsTrigger value="backend">Backend Pipelines</TabsTrigger>
        </TabsList>
        <TabsContent value="frontend">
          <FrontendPipelineTab />
        </TabsContent>
        <TabsContent value="backend">
          <BackendPipelinesTab />
        </TabsContent>
      </Tabs>
    </Main>
  );
}
