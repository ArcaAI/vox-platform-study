import {
  SpeechInput,
  SpeechInputRecordButton,
  SpeechInputPreview,
  SpeechInputCancelButton,
} from '../../../elevenlabs/speech-input'

const mockGetToken = async () => 'mock-token'

export function BasicSpeechInput() {
  return (
    <SpeechInput getToken={mockGetToken}>
      <SpeechInputRecordButton data-testid="record-button" />
      <SpeechInputPreview data-testid="preview" />
      <SpeechInputCancelButton data-testid="cancel-button" />
    </SpeechInput>
  )
}

export function RecordOnlySpeechInput() {
  return (
    <SpeechInput getToken={mockGetToken}>
      <SpeechInputRecordButton data-testid="record-button" />
    </SpeechInput>
  )
}

export function SmallSpeechInput() {
  return (
    <SpeechInput getToken={mockGetToken} size="sm">
      <SpeechInputRecordButton />
    </SpeechInput>
  )
}

export function LargeSpeechInput() {
  return (
    <SpeechInput getToken={mockGetToken} size="lg">
      <SpeechInputRecordButton />
    </SpeechInput>
  )
}
