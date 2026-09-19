/**
 * Think time, and the arrival model built on top of it.
 *
 * ## Why not a hot loop
 *
 * A hot loop measures the rate limiter and nothing else: it saturates the
 * 60-second window in the first second, every subsequent request is refused,
 * and the "capacity" the run reports is just the limit that was configured.
 * TASK-993 needs the opposite — the load a REAL population produces — so a
 * virtual user reads a screen, pauses, and navigates.
 *
 * ## Why log-normal
 *
 * Human inter-action delay is not uniform and not exponential: it is bounded
 * below (nobody clicks in 0 ms), unbounded above, and right-skewed. Log-normal
 * is the standard fit. With `median = 4_000 ms` and `sigma = 0.6`, ~68% of
 * pauses land in 2.2-7.3 s and a long tail runs past 15 s — which is what
 * produces a realistic MIX of idle and busy users rather than 1,000 users all
 * navigating in lockstep.
 *
 * ## Why the burst matters more than the mean
 *
 * OD-1 revised the load model up because a console screen fires 10-15 TanStack
 * queries. Those do not arrive spread over a minute; they arrive within a few
 * hundred ms of the navigation. A limiter with a 60-second FIXED window is far
 * more sensitive to that burstiness than to the mean rate, so the driver keeps
 * the burst intact (see `scenario.ts`) and only the pause BETWEEN bursts is
 * randomised.
 *
 * ## Coordinated omission
 *
 * In a closed loop, a slow response delays the next request, so the load
 * offered falls exactly when the system is struggling and the run silently
 * under-reports the pressure. Two mitigations here, both cheap:
 *   - `open` arrival advances the schedule from the PREVIOUS DUE TIME, not from
 *     "now", so lag accumulates and is visible.
 *   - every sample carries `scheduleDelayMs`, so even a closed run reports how
 *     far behind its own plan it fell.
 */

/** Deterministic PRNG. A load run has to be reproducible, and `Math.random()` is not seedable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller. Guards the log(0) pole that a raw `random()` can hit. */
export function standardNormal(random: () => number): number {
  let u = random();
  while (u <= Number.EPSILON) u = random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A log-normal think time in ms, clamped to a sane operating range.
 *
 * `medianMs` is the median (= exp(mu)), NOT the mean — the mean of a log-normal
 * is `median * exp(sigma^2/2)`, which for sigma 0.6 is ~20% higher. Stating the
 * median keeps the knob meaning what an operator expects when they set it.
 *
 * The clamp floor (250 ms) stops a pathological draw from turning one virtual
 * user into a hot loop; the ceiling (10x the median) stops one from parking for
 * the whole run and quietly reducing the concurrency the run claims to apply.
 */
export function thinkTimeMs(random: () => number, medianMs: number, sigma: number): number {
  const raw = medianMs * Math.exp(sigma * standardNormal(random));
  return Math.min(Math.max(raw, 250), medianMs * 10);
}

export interface ScheduleState {
  /** Epoch ms at which the next iteration is DUE. */
  dueAtMs: number;
}

/** How late an iteration starting at `nowMs` is against its own plan. Never negative: early is not late. */
export function lateness(state: ScheduleState, nowMs: number): number {
  return Math.max(0, nowMs - state.dueAtMs);
}

/**
 * Set when this user's NEXT iteration is due.
 *
 * `closed` anchors on `nowMs` — call it once the burst has finished, and you
 * have a fixed population of users who each wait for their own page before
 * thinking. Under load the offered rate then falls, which is real user
 * behaviour and also the coordinated-omission trap; `lateness()` is what keeps
 * it visible.
 *
 * `open` anchors on the PREVIOUS due time, so the cadence is fixed and lag
 * accumulates whatever the platform does. That is the model that actually
 * locates a breaking point, because the offered load does not politely retreat
 * the moment the system starts to struggle.
 */
export function advance(state: ScheduleState, nowMs: number, thinkMs: number, arrival: 'closed' | 'open'): void {
  state.dueAtMs = (arrival === 'open' ? state.dueAtMs : nowMs) + thinkMs;
}

/**
 * Per-user ramp offset, so 1,000 virtual users do not all issue their first
 * burst in the same millisecond. Spread evenly rather than randomly — an even
 * spread is reproducible and hits the target concurrency exactly on time.
 */
export function rampOffsetMs(userIndex: number, totalUsers: number, rampSeconds: number): number {
  if (rampSeconds <= 0 || totalUsers <= 1) return 0;
  return Math.round((userIndex / totalUsers) * rampSeconds * 1000);
}
