import { temperatureUnitOf } from '../context/client-clinical-context';

/**
 * The vital readings an encounter's transcript STATES ("your blood pressure today is 152/94 and your
 * pulse is 88"), each with the transcript line that states it.
 *
 * Used to mark the clinic's typed vitals set as superseded for the encounter: a reading the doctor
 * reads out in the room is today's, a set the clinic sent at open may be a year old. Deterministic
 * and deliberately narrow — a vital keyword followed, within a short clause, by its value — so a
 * number that is not a reading is never mistaken for one.
 */

export type StatedVital = 'BP' | 'HR' | 'RR' | 'Temp' | 'SpO2';

export interface StatedReading {
  vital: StatedVital;
  /** As the clinic line prints it: `BP 152/94 mmHg`, `HR 88 bpm`, `Temp 98.6 °F`. */
  text: string;
  /** The citation label of the line that states it: `S17 E1`. */
  label: string;
}

const NO_LETTER_BEFORE = '(?<![a-z])';
const NO_LETTER_AFTER = '(?![a-z])';
/** The clause between the keyword and its value: no sentence end, no other number. */
const GAP = '[^.;!?\\d]{0,30}?';

const PATTERNS: ReadonlyArray<{ vital: StatedVital; pattern: RegExp; render: (match: RegExpExecArray) => string | null }> = [
  {
    vital: 'BP',
    pattern: new RegExp(
      `${NO_LETTER_BEFORE}(?:bp|b\\.p\\.?|blood pressure)${NO_LETTER_AFTER}${GAP}(\\d{2,3})\\s*(?:/|over|by)\\s*(\\d{2,3})(?!\\d)`,
      'g',
    ),
    render: (m) => `BP ${m[1]}/${m[2]} mmHg`,
  },
  {
    vital: 'HR',
    pattern: new RegExp(`${NO_LETTER_BEFORE}(?:pulse(?: rate)?|heart rate|hr)${NO_LETTER_AFTER}${GAP}(\\d{2,3})(?!\\d|\\.\\d|\\s*/)`, 'g'),
    render: (m) => `HR ${m[1]} bpm`,
  },
  {
    vital: 'RR',
    pattern: new RegExp(
      `${NO_LETTER_BEFORE}(?:respiratory rate|respiration rate|breathing rate|rr)${NO_LETTER_AFTER}${GAP}(\\d{1,2})(?!\\d|\\.\\d)`,
      'g',
    ),
    render: (m) => `RR ${m[1]} /min`,
  },
  {
    vital: 'Temp',
    pattern: new RegExp(
      `${NO_LETTER_BEFORE}(?:temperature|temp)${NO_LETTER_AFTER}${GAP}(\\d{2,3}(?:\\.\\d)?)(?!\\d)\\s*(?:°\\s*|degrees?\\s*)?(celsius|fahrenheit|c|f)?${NO_LETTER_AFTER}`,
      'g',
    ),
    render: (m) => {
      const value = Number(m[1]);
      const stated = m[2]?.[0];
      const unit = stated === 'c' ? '°C' : stated === 'f' ? '°F' : temperatureUnitOf(value);
      return unit ? `Temp ${m[1]} ${unit}` : null;
    },
  },
  {
    vital: 'SpO2',
    pattern: new RegExp(
      `${NO_LETTER_BEFORE}(?:spo2|sp o2|oxygen saturation|o2 saturation|saturation|sats)${NO_LETTER_AFTER}${GAP}(\\d{2,3})(?!\\d|\\.\\d)`,
      'g',
    ),
    render: (m) => `SpO2 ${m[1]} %`,
  },
];

/**
 * Every reading the lines state, first statement of each vital and value only, in line order.
 * `lines` are the encounter's transcript lines with the label each is cited by.
 */
export function readingsStatedIn(lines: ReadonlyArray<{ label: string; text: string }>): StatedReading[] {
  const readings: StatedReading[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const text = line.text.toLowerCase().replace(/\s+/g, ' ');
    for (const { vital, pattern, render } of PATTERNS) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        const rendered = render(match);
        if (!rendered || seen.has(rendered)) continue;
        seen.add(rendered);
        readings.push({ vital, text: rendered, label: line.label });
      }
    }
  }
  return readings;
}

/** The vitals a clinic line carries, by the prefix its renderer prints (`BP `, `HR `, …). */
function vitalsCarriedBy(clinicLine: string): Set<StatedVital> {
  const carried = new Set<StatedVital>();
  for (const vital of ['BP', 'HR', 'RR', 'Temp', 'SpO2'] as const) {
    if (new RegExp(`(?:^|[\\s:·])${vital} `).test(clinicLine)) carried.add(vital);
  }
  return carried;
}

/**
 * The clinic's vitals line with the readings the latest encounter states appended, each cited, and
 * marked as the ones for this encounter. Unchanged when the encounter states none the line carries.
 */
export function withSupersedingReadings(clinicLine: string, readings: readonly StatedReading[]): string {
  const carried = vitalsCarriedBy(clinicLine);
  const superseding = readings.filter((reading) => carried.has(reading.vital));
  if (superseding.length === 0) return clinicLine;
  const stated = superseding.map((reading) => `${reading.text} [${reading.label}]`).join(', ');
  return `${clinicLine} — clinic record; this encounter's transcript states ${stated}, which supersede it for this encounter.`;
}
