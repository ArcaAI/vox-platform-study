import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TranscriptColumn, type TranscriptLine } from '../TranscriptColumn';

/**
 * Mic attribution on the timeline (carried from lane C).
 *
 * The per-mic metadata rows send the LITERAL keys `mic` and `speaker`
 * (`buildRowMetadata` in `context/playground-session.tsx`), which is exactly
 * the shape of the reference screenshot. Before this, `MetadataCell` only had
 * badges for `speaker_id`/`detected_language`/`chunk_id`/`startTime`/`endTime`,
 * so the one thing the screenshot is about — which mic said this line — was
 * visible only after expanding the raw-JSON `<details>`.
*/

const line = (meta: Record<string, unknown>): TranscriptLine => ({ text: 'വേദന ഉണ്ടോ?', meta, timestamp: '00:03.120' });

describe('TranscriptColumn — metadata badges', () => {
  it('renders visible mic and speaker badges for the per-mic row keys', () => {
    render(<TranscriptColumn lines={[line({ mic: '2', speaker: '2' })]} interim="" isPreSession={false} />);

    expect(screen.getByText('mic: 2')).toBeInTheDocument();
    expect(screen.getByText('speaker: 2')).toBeInTheDocument();
  });

  it('keeps `speaker_id` distinct from the row-level `speaker` key', () => {
    render(<TranscriptColumn lines={[line({ speaker_id: 'doctor', speaker: '1' })]} interim="" isPreSession={false} />);

    expect(screen.getByText('speaker_id: doctor')).toBeInTheDocument();
    expect(screen.getByText('speaker: 1')).toBeInTheDocument();
  });

  it('shows no mic badge when the line carries no mic attribution', () => {
    render(<TranscriptColumn lines={[line({ chunk_id: 7 })]} interim="" isPreSession={false} />);

    expect(screen.queryByText(/^mic: /)).not.toBeInTheDocument();
    expect(screen.getByText('chunk: 7')).toBeInTheDocument();
  });
});
