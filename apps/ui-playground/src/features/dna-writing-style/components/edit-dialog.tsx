import { useCallback, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@arcaai/ui/form';
import { Input } from '@arcaai/ui/input';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { Separator } from '@arcaai/ui/separator';
import { Textarea } from '@arcaai/ui/textarea';
import { Loader2, Pencil } from 'lucide-react';

import { zodResolver } from '@/lib/zod-resolver';
import { useUpdateDnaReport, type DnaReport, type DnaReportData } from '../api/dna-writing-styles';

const updateSchema = z.object({
  styleText: z.string().optional(),
  changeReason: z.string().min(1, 'Change reason is required'),
  formality: z.string().optional(),
  sentenceLength: z.string().optional(),
  medicalTermUsage: z.string().optional(),
  abbreviationStyle: z.string().optional(),
  tone: z.string().optional(),
  vocabulary: z.string().optional(),
  structure: z.string().optional(),
});

export type UpdateFormValues = z.infer<typeof updateSchema>;

const ATTR_FIELDS = ['tone', 'vocabulary', 'structure', 'formality', 'sentenceLength', 'medicalTermUsage', 'abbreviationStyle'] as const;

/**
 * TASK-329 P5 — Map a report (or null) to the edit form's values.
 *
 * Extracted so the prefill mapping is independently testable and so the dialog
 * and its controller share one source of truth. `changeReason` always starts
 * blank: each edit must carry its own justification.
 */
export function buildEditFormValues(report: DnaReport | null): UpdateFormValues {
  const data = report?.reportData ?? null;
  return {
    styleText: report?.styleText ?? '',
    changeReason: '',
    formality: data?.formality ?? '',
    sentenceLength: data?.sentenceLength ?? '',
    medicalTermUsage: data?.medicalTermUsage ?? '',
    abbreviationStyle: data?.abbreviationStyle ?? '',
    tone: data?.tone ?? '',
    vocabulary: data?.vocabulary ?? '',
    structure: data?.structure ?? '',
  };
}

interface EditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  report: DnaReport | null;
}

export function EditDialog({ open, onOpenChange, report }: EditDialogProps) {
  const updateMutation = useUpdateDnaReport();

  const form = useForm<UpdateFormValues>({
    resolver: zodResolver(updateSchema),
    defaultValues: buildEditFormValues(report),
  });

  // Re-seed whenever the dialog opens for a (possibly different) report so the
  // form always reflects the selected report rather than a stale/empty state.
  useEffect(() => {
    if (open && report) {
      form.reset(buildEditFormValues(report));
    }
  }, [open, report, form]);

  const handleSubmit = useCallback(
    (values: UpdateFormValues) => {
      if (!report) return;
      const reportData: Partial<DnaReportData> = {};
      if (values.formality) reportData.formality = values.formality;
      if (values.sentenceLength) reportData.sentenceLength = values.sentenceLength;
      if (values.medicalTermUsage) reportData.medicalTermUsage = values.medicalTermUsage;
      if (values.abbreviationStyle) reportData.abbreviationStyle = values.abbreviationStyle;
      if (values.tone) reportData.tone = values.tone;
      if (values.vocabulary) reportData.vocabulary = values.vocabulary;
      if (values.structure) reportData.structure = values.structure;

      updateMutation.mutate(
        {
          reportId: report.id,
          // TASK-331 doc-02 F12 — echo the loaded report's row version as the RFC
          // 7232 `If-Match: "<version>"` so the `@RequiresIfMatch()` route's
          // compare-and-set can detect drift (412).
          ifMatch: report.version != null ? `"${report.version}"` : undefined,
          styleText: values.styleText || undefined,
          reportData: Object.keys(reportData).length > 0 ? reportData : undefined,
          changeReason: values.changeReason,
        },
        {
          onSuccess: () => {
            toast.success('DNA report updated successfully');
            onOpenChange(false);
          },
          onError: (err) => toast.error(`Failed to update report: ${err.message}`),
        },
      );
    },
    [report, updateMutation, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="size-5" />
            Edit DNA Writing Style
          </DialogTitle>
          <DialogDescription>Update the writing style attributes and provide a reason for the change.</DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 pr-4">
          <Form {...form}>
            <form id="edit-dna-form" onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="styleText"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>Style Text</FormLabel>
                    <FormControl>
                      <Textarea placeholder="Descriptive text about the writing style..." className="min-h-25" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Separator />
              <p className="text-sm font-medium">Style Attributes</p>

              <div className="grid grid-cols-2 gap-4">
                {ATTR_FIELDS.map((fieldName) => (
                  <FormField
                    key={fieldName}
                    control={form.control}
                    name={fieldName}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    render={({ field }: { field: any }) => (
                      <FormItem>
                        <FormLabel className="capitalize">{fieldName.replace(/([A-Z])/g, ' $1').trim()}</FormLabel>
                        <FormControl>
                          <Input placeholder={`e.g., ${fieldName}`} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ))}
              </div>

              <Separator />

              <FormField
                control={form.control}
                name="changeReason"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render={({ field }: { field: any }) => (
                  <FormItem>
                    <FormLabel>Change Reason</FormLabel>
                    <FormControl>
                      <Input placeholder="Why are you making this change?" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </form>
          </Form>
        </ScrollArea>

        <DialogFooter className="pt-4 border-t">
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={updateMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form="edit-dna-form" disabled={updateMutation.isPending}>
            {updateMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
