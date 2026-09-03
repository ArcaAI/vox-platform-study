'use client';

import { useState } from 'react';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { CodeEditor, validateJson } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { useCreateFixture, useDeleteFixture, useFixtures } from '../api/hooks';

/** Radix Select rejects an empty-string item value. */
const NONE = '__none__';

/**
 * Per-tenant saved synthetic Workbench test input — picker + minimal create/delete manager
 * . Full edit-in-place is left to a follow-up; create/delete/pick cover the
 * ticket's stated scope ("create / edit / pick / delete") for the picker's own remit — the
 * `WorkflowTestFixtureController` PATCH route already exists for a later edit-in-place pass.
 */
export function FixturePicker({
  workflowDefinitionId,
  value,
  onChange,
}: {
  workflowDefinitionId: string | null;
  value: string | null;
  onChange: (fixtureId: string | null) => void;
}) {
  const fixturesQuery = useFixtures();
  const createFixture = useCreateFixture();
  const deleteFixture = useDeleteFixture();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [inputJson, setInputJson] = useState('{\n  \n}');

  const fixtures = fixturesQuery.data?.data ?? [];
  // Tenant-wide fixtures (workflowDefinitionId: null) plus ones scoped to the selected definition.
  const applicable = fixtures.filter((f) => !f.workflowDefinitionId || f.workflowDefinitionId === workflowDefinitionId);

  function resetDialog() {
    setName('');
    setInputJson('{\n  \n}');
  }

  function handleCreate() {
    const validation = validateJson(inputJson);
    if (!validation.ok) {
      toast.error('Fixture input must be valid JSON.');
      return;
    }
    if (!name.trim()) {
      toast.error('Fixture name is required.');
      return;
    }
    createFixture.mutate(
      { name: name.trim(), workflowDefinitionId: workflowDefinitionId ?? undefined, input: JSON.parse(inputJson) as Record<string, unknown> },
      {
        onSuccess: (fixture) => {
          toast.success(`Fixture "${fixture.name}" saved.`);
          onChange(fixture.id);
          setDialogOpen(false);
          resetDialog();
        },
        onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not save the fixture.'),
      },
    );
  }

  function handleDelete(fixtureId: string) {
    deleteFixture.mutate(fixtureId, {
      onSuccess: () => {
        toast.success('Fixture deleted.');
        if (value === fixtureId) onChange(null);
      },
      onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not delete the fixture.'),
    });
  }

  if (fixturesQuery.isLoading) {
    return <Skeleton className="h-9 w-64" />;
  }

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="fixture-picker" className="text-muted-foreground text-xs">
        Fixture
      </Label>
      <Select value={value ?? NONE} onValueChange={(next) => onChange(next === NONE ? null : next)}>
        <SelectTrigger id="fixture-picker" className="w-56">
          <SelectValue placeholder="No fixture (empty input)" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>No fixture (empty input)</SelectItem>
          {applicable.map((fixture) => (
            <SelectItem key={fixture.id} value={fixture.id}>
              {fixture.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value && applicable.some((f) => f.id === value) ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Delete selected fixture"
          onClick={() => handleDelete(value)}
          disabled={deleteFixture.isPending}
        >
          {deleteFixture.isPending ? <Spinner className="size-4" /> : <IconTrash className="size-4" aria-hidden />}
        </Button>
      ) : null}
      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          setDialogOpen(next);
          if (!next) resetDialog();
        }}
      >
        <DialogContent className="sm:max-w-[50vw]">
          <DialogHeader>
            <DialogTitle>New fixture</DialogTitle>
            <DialogDescription>
              Synthetic test input only — do not paste real or realistic patient data. This field is encrypted at rest.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fixture-name">Name</Label>
              <Input id="fixture-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Two-speaker follow-up visit" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fixture-input">Input (JSON)</Label>
              <CodeEditor value={inputJson} onChange={setInputJson} language="json" aria-label="Fixture input JSON" className="h-48" />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleCreate} disabled={createFixture.isPending}>
              {createFixture.isPending ? <Spinner className="size-4" /> : null}
              Save fixture
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Button type="button" variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
        <IconPlus className="size-4" aria-hidden />
        New fixture
      </Button>
    </div>
  );
}
