import { SummaryCard } from './SummaryCard';
import { SUMMARIZATION_EXAMPLE_FILES, TabExampleCode } from './TabExampleCode';
import { usePlaygroundSession } from '../context/playground-session';

/**
 * Tab 3 — summarization.
 *
 * The transcript is NOT passed down from here: `SummaryCard` reads it straight
 * out of `usePlaygroundSession()`. That is the whole reason session state was
 * lifted above the tabs — the live caption produced on the Live-transcription
 * tab has to be readable here even though the two panels are isolated.
 *
 * Lane F decomposes `SummaryCard` (context form / transcript source / result
 * view) and wires the streaming toggle; this wrapper stays a layout shell.
 */
export function SummarizationTab() {
  const { config } = usePlaygroundSession();

  return (
    <div className="mx-auto flex w-full max-w-[72rem] flex-col gap-4">
      <SummaryCard config={config} />
      {/* R2 — the tab ends with its own source, nothing from the other two tabs. */}
      <TabExampleCode
        files={SUMMARIZATION_EXAMPLE_FILES}
        description="How useText() is driven: department/visit/context inputs, the transcript source selector, and both the streaming and single-response paths."
      />
    </div>
  );
}
