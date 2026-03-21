import { TranscriptViewer, type TranscriptEntry } from '../../../custom/transcript-viewer'

const entries: TranscriptEntry[] = [
  { id: '1', text: 'Hello, how are you?', timestamp: '09:00:00', speaker: 'Doctor', isFinal: true },
  { id: '2', text: 'I am doing well, thank you.', timestamp: '09:00:05', speaker: 'Patient', isFinal: true },
]

export function DefaultViewer() {
  return <TranscriptViewer entries={entries} />
}

export function EmptyViewer() {
  return <TranscriptViewer entries={[]} />
}

export function WithLiveTranscript() {
  return (
    <TranscriptViewer
      entries={entries}
      currentTranscript="I have been feeling a bit tired lately..."
    />
  )
}

export function WithPartialEntry() {
  const partial: TranscriptEntry[] = [
    ...entries,
    { id: '3', text: 'Let me check your...', speaker: 'Doctor', isFinal: false },
  ]
  return <TranscriptViewer entries={partial} />
}

export function WithoutTimestamps() {
  const noTimestamps = entries.map(({ timestamp: _, ...rest }) => rest)
  return <TranscriptViewer entries={noTimestamps} />
}

export function WithoutSpeakers() {
  const noSpeakers = entries.map(({ speaker: _, ...rest }) => rest)
  return <TranscriptViewer entries={noSpeakers} />
}

export function CustomHeightViewer() {
  return <TranscriptViewer entries={entries} maxHeight="150px" />
}

export function LongConversationViewer() {
  const longEntries: TranscriptEntry[] = Array.from({ length: 20 }, (_, i) => ({
    id: String(i),
    text: `Message number ${i + 1} in the conversation.`,
    timestamp: `09:${String(Math.floor(i / 2)).padStart(2, '0')}:00`,
    speaker: i % 2 === 0 ? 'Doctor' : 'Patient',
    isFinal: true,
  }))
  return <TranscriptViewer entries={longEntries} maxHeight="200px" />
}
