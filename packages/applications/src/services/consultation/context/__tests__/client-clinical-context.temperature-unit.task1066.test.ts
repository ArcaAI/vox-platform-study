/**
 * A temperature is labelled with the unit its VALUE is in, not the unit the kind declares.
 *
 * Live failure (cluster, ArcaAI): the clinic's EMR records temperature in Fahrenheit with no unit
 * (`"Temperature (T)": "97.8"`), the client copies it into the kind's `temperature` field, and the
 * renderer printed `Temp 97.8 °C` — a reading of severe hyperthermia the note then repeated. The
 * Celsius and Fahrenheit ranges a living patient can read in do not overlap, so the value itself
 * says which scale it is on; a value in neither range is printed without a unit rather than with a
 * wrong one.
 */
import { describe, expect, it } from 'vitest';

import { formatClientVitalsForPrompt, temperatureUnitOf } from '../client-clinical-context';

describe('temperature unit', () => {
  it('labels a Fahrenheit value °F', () => {
    expect(formatClientVitalsForPrompt({ heartRate: 74, temperature: 97.8 })).toBe('HR 74 bpm · Temp 97.8 °F');
  });

  it('keeps a Celsius value °C', () => {
    expect(formatClientVitalsForPrompt({ temperature: 36.8 })).toBe('Temp 36.8 °C');
  });

  it('prints a value on neither scale without a unit', () => {
    expect(formatClientVitalsForPrompt({ temperature: 61 })).toBe('Temp 61 (unit not stated)');
  });

  it.each([
    [25, '°C'],
    [45, '°C'],
    [36.6, '°C'],
    [77, '°F'],
    [113, '°F'],
    [104.2, '°F'],
    [24.9, null],
    [50, null],
    [120, null],
  ])('%s reads as %s', (value, unit) => {
    expect(temperatureUnitOf(value)).toBe(unit);
  });
});
