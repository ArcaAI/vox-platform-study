import * as React from 'react'

import {
  ScrubBarContainer,
  ScrubBarTrack,
  ScrubBarProgress,
  ScrubBarThumb,
  ScrubBarTimeLabel,
} from '../../../elevenlabs/scrub-bar'

export function BasicScrubBar({
  duration = 180,
  initialValue = 45,
}: {
  duration?: number
  initialValue?: number
}) {
  const [value, setValue] = React.useState(initialValue)
  return (
    <ScrubBarContainer
      duration={duration}
      value={value}
      onScrub={setValue}
      data-testid="scrub-bar"
    >
      <ScrubBarTimeLabel time={value} data-testid="current-time" />
      <ScrubBarTrack data-testid="track">
        <ScrubBarProgress data-testid="progress" />
        <ScrubBarThumb data-testid="thumb" />
      </ScrubBarTrack>
      <ScrubBarTimeLabel time={duration} data-testid="duration" />
    </ScrubBarContainer>
  )
}

export function ScrubBarAtStart() {
  return <BasicScrubBar initialValue={0} />
}

export function ScrubBarAtEnd() {
  return <BasicScrubBar initialValue={180} />
}

export function ScrubBarWithCallbacks({
  onScrub,
  onScrubStart,
  onScrubEnd,
}: {
  onScrub?: (time: number) => void
  onScrubStart?: () => void
  onScrubEnd?: () => void
}) {
  const [value, setValue] = React.useState(45)
  return (
    <ScrubBarContainer
      duration={180}
      value={value}
      onScrub={(time) => {
        setValue(time)
        onScrub?.(time)
      }}
      onScrubStart={onScrubStart}
      onScrubEnd={onScrubEnd}
    >
      <ScrubBarTrack>
        <ScrubBarProgress />
        <ScrubBarThumb />
      </ScrubBarTrack>
    </ScrubBarContainer>
  )
}
