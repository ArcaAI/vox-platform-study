'use client';

/**
 * The Pins rail — what this workflow is pinned to, in one glance (TASK-1036 §3.6).
 *
 * One row per `core.agent` step: the agent's slug and either its pinned version or "Active at
 * publish". Prompt templates are not pinned on the step; they are pinned with the agent version,
 * which the rail says once per row rather than leave a reader hunting for a prompt pin that
 * does not exist.
 */
import { IconPin } from '@tabler/icons-react';
import { Badge, Button, Popover, PopoverContent, PopoverTrigger } from '@arcaai/ui';
import type { AgentPin } from './agent-pins';

export function PinsRail({ pins }: { pins: readonly AgentPin[] }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" title="What each agent step is pinned to">
          <IconPin aria-hidden="true" />
          Pins
          {pins.length > 0 ? <Badge variant="secondary">{pins.length}</Badge> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96" aria-label="Pins">
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-medium">Pins</h2>
            <p className="text-muted-foreground text-xs">Publishing freezes these. A step with no pin runs the agent&apos;s active version at publish.</p>
          </div>
          {pins.length === 0 ? (
            <p className="text-muted-foreground text-sm">No agent steps yet — add an Agent node to pin one.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {pins.map((pin) => (
                <li key={pin.nodeId} className="flex flex-col gap-0.5 rounded-md border p-2">
                  <span className="text-xs font-medium">{pin.nodeLabel}</span>
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    {pin.agentSlug ? <span className="font-mono text-xs">{pin.agentSlug}</span> : <span className="text-muted-foreground text-xs">No agent chosen</span>}
                    {pin.agentSlug ? (
                      pin.versionNumber !== null ? (
                        <Badge variant="secondary">{`v${pin.versionNumber}`}</Badge>
                      ) : (
                        <Badge variant="outline">Active at publish</Badge>
                      )
                    ) : null}
                  </span>
                  {pin.agentSlug ? <span className="text-muted-foreground text-xs">Prompts are pinned with the agent.</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
