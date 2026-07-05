import { Main } from '@/components/layout/main';
import { QueuesTab } from './queues-tab';
import { SchedulersTab } from './schedulers-tab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { CalendarClock, Layers } from 'lucide-react';

// TASK-250 / TASK-336 OB-03 — GLOBAL_ADMIN console over the queue-admin +
// scheduler-admin backend (BullMQ queues/jobs + @nestjs/schedule crons). The
// route is gated to global scope; this is platform-wide infrastructure.
export default function QueuesPage() {
  return (
    <Main>
      <div className="mb-6">
        <h2 className="text-2xl font-bold tracking-tight">Queues &amp; Jobs</h2>
        <p className="text-muted-foreground mt-1">Inspect and operate the platform&apos;s background queues, jobs, and schedulers (BullMQ + cron).</p>
      </div>

      <Tabs defaultValue="queues" className="gap-4">
        <TabsList>
          <TabsTrigger value="queues">
            <Layers className="mr-1.5 size-4" />
            Queues
          </TabsTrigger>
          <TabsTrigger value="schedulers">
            <CalendarClock className="mr-1.5 size-4" />
            Schedulers
          </TabsTrigger>
        </TabsList>
        <TabsContent value="queues">
          <QueuesTab />
        </TabsContent>
        <TabsContent value="schedulers">
          <SchedulersTab />
        </TabsContent>
      </Tabs>
    </Main>
  );
}
