// Pure audit helpers for the shared output LookaheadLimiter (public/limiter-core.js).
//
// This module is deliberately side-effect free: it never creates an AudioContext, never touches
// window/document, and never performs I/O. Every return value is plain JSON-serializable data,
// so results can be shipped through chrome.runtime messages or written to a diagnostic log.
//
// Two entry points:
//   describeLimiterConfig(sampleRate, channels, options) — what a configuration means, in numbers.
//   auditRenderedOutput(frames, sampleRate, channels, options) — what a recording of the
//     limiter's actual input/output pairs shows, frame by frame.
//
// SCOPE: the limiter bounds DIGITAL SAMPLE PEAKS only. It does not measure or constrain
// inter-sample ("true") peaks of the reconstructed analogue waveform, and nothing here claims
// true-peak compliance.

const DEFAULT_LOOKAHEAD_MS = 5;
const DEFAULT_CEILING_DB = -1;
const DEFAULT_RELEASE_MS = 80;
const DEFAULT_ATTACK_MS = 1;

// Frames whose |input| sits at full scale (|s| >= 1) and alternates sign sample-to-sample can
// reconstruct to an inter-sample true peak ABOVE the digital ceiling (classic Nyquist square
// wave). The limiter cannot see that, so the audit flags it instead of claiming safety.
const FULL_SCALE = 1;

const TRUE_PEAK_SCOPE_NOTE =
  'Scope: this audit covers digital sample peaks only. The limiter constrains sample values, ' +
  'not the reconstructed inter-sample (true) peak, so sample-peak compliance does NOT certify ' +
  'true-peak compliance after D/A reconstruction.';

const TRUE_PEAK_RISK_NOTE =
  'Input contains adjacent full-scale samples of alternating sign: the reconstructed waveform ' +
  'can exceed the digital ceiling between samples. This audit reports sample-peak limiting only ' +
  'and does NOT claim the true peak is bounded or that reconstruction distortion is eliminated.';

// Mirrors the LookaheadLimiter constructor exactly — keep the three formulas in lock-step with
// public/limiter-core.js so an audit always agrees with a really-constructed limiter.
export function describeLimiterConfig(sampleRate, channels = 2, options = {}) {
  const lookaheadMs = options.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS;
  const ceilingDb = options.ceilingDb ?? DEFAULT_CEILING_DB;
  const releaseMs = options.releaseMs ?? DEFAULT_RELEASE_MS;
  const attackMs = options.attackMs ?? DEFAULT_ATTACK_MS;
  const lookaheadSamples = Math.max(1, Math.ceil(sampleRate * lookaheadMs / 1000));
  const ceiling = Math.pow(10, ceilingDb / 20);
  // One Float32 rounding margin below the advertised ceiling, same as the limiter.
  const safeCeiling = ceiling * (1 - 1e-7);
  const ringSize = lookaheadSamples + 1;
  return {
    sampleRate,
    channels,
    lookaheadMs,
    ceilingDb,
    releaseMs,
    attackMs,
    lookaheadSamples,
    ceiling,
    safeCeiling,
    ringSize,
    scope: 'digital-sample-peak',
    description:
      `Lookahead limiter at ${sampleRate} Hz, ${channels} channel(s): ` +
      `${lookaheadMs} ms lookahead = ${lookaheadSamples} sample(s), ceiling ${ceilingDb} dBFS ` +
      `(linear ${ceiling}), safe ceiling ${safeCeiling} (one Float32 rounding margin below), ` +
      `delay ring of ${ringSize} sample(s), ${releaseMs} ms release, ${attackMs} ms attack ` +
      `weighting. Output is delayed by exactly the lookahead. ` + TRUE_PEAK_SCOPE_NOTE
  };
}

// Audit a frame-by-frame recording of the limiter in action.
//
// `frames[i]` = { input: number[], output: number[] } — per-channel samples captured at the SAME
// render instant (input what was fed in, output what the limiter actually produced at that time).
// Samples may be NaN/Infinity; they are excluded from peaks and reported via flags instead, so
// the result stays JSON-serializable. Because the limiter delays output by `lookaheadSamples`,
// the gain applied to frame t is recovered by comparing output[t] against input[t - lookahead].
export function auditRenderedOutput(frames, sampleRate, channels = 2, options = {}) {
  const config = describeLimiterConfig(sampleRate, channels, options);
  const list = Array.isArray(frames) ? frames : [];
  const notes = [TRUE_PEAK_SCOPE_NOTE];

  const perFrame = new Array(list.length);
  let nonFiniteInput = false;
  let nonFiniteOutput = false;
  let truePeakRisk = false;

  for (let i = 0; i < list.length; i++) {
    const frame = list[i] || {};
    let inputPeak = 0;
    let outputPeak = 0;
    let inputFinite = true;
    let outputFinite = true;
    const input = Array.isArray(frame.input) ? frame.input : [];
    const output = Array.isArray(frame.output) ? frame.output : [];
    for (const v of input) {
      if (Number.isFinite(v)) inputPeak = Math.max(inputPeak, Math.abs(v));
      else inputFinite = false;
    }
    for (const v of output) {
      if (Number.isFinite(v)) outputPeak = Math.max(outputPeak, Math.abs(v));
      else outputFinite = false;
    }
    if (!inputFinite) nonFiniteInput = true;
    if (!outputFinite) nonFiniteOutput = true;
    // Adjacent full-scale samples of alternating sign, per channel position.
    if (i > 0) {
      const prev = Array.isArray(list[i - 1]?.input) ? list[i - 1].input : [];
      for (let ch = 0; ch < Math.min(prev.length, input.length); ch++) {
        const a = prev[ch];
        const b = input[ch];
        if (Number.isFinite(a) && Number.isFinite(b) &&
            Math.abs(a) >= FULL_SCALE && Math.abs(b) >= FULL_SCALE && Math.sign(a) !== Math.sign(b)) {
          truePeakRisk = true;
        }
      }
    }
    perFrame[i] = {
      index: i,
      inputPeak,
      outputPeak,
      inputFinite,
      outputFinite,
      // Any rendered frame whose absolute value exceeds the advertised ceiling is a violation.
      exceedsCeiling: outputPeak > config.ceiling,
      limitingActive: false, // filled in below, once the delay-aligned gain is known
      gainReductionDb: 0
    };
  }

  // Recover the applied gain per frame: output[t] = input[t - lookaheadSamples] * gain(t).
  const limitingIntervals = [];
  let maxGainReductionDb = 0;
  let intervalStart = -1;
  for (let t = 0; t < perFrame.length; t++) {
    const f = perFrame[t];
    const source = t - config.lookaheadSamples;
    const alignedInputPeak = source >= 0 ? perFrame[source].inputPeak : 0;
    if (f.outputFinite && alignedInputPeak > 0) {
      const gain = f.outputPeak / alignedInputPeak;
      // Float32 storage makes "no limiting" exactly 1; allow a small margin below it.
      if (gain < 1 - 1e-6) {
        f.limitingActive = true;
        // gain == 0 means total suppression; cap the reported attenuation to stay finite.
        f.gainReductionDb = gain > 0 ? -20 * Math.log10(gain) : 400;
        maxGainReductionDb = Math.max(maxGainReductionDb, f.gainReductionDb);
      }
    }
    if (f.limitingActive && intervalStart < 0) intervalStart = t;
    if (!f.limitingActive && intervalStart >= 0) {
      limitingIntervals.push({ start: intervalStart, end: t - 1 });
      intervalStart = -1;
    }
  }
  if (intervalStart >= 0) limitingIntervals.push({ start: intervalStart, end: perFrame.length - 1 });

  const exceededCeilingFrames = perFrame.filter((f) => f.exceedsCeiling).map((f) => f.index);
  if (nonFiniteInput) {
    notes.push('Non-finite input samples (NaN/Infinity) were recorded; they are excluded from ' +
      'input peaks. A healthy limiter sanitizes them instead of propagating them.');
  }
  if (nonFiniteOutput) {
    notes.push('WARNING: non-finite values (NaN/Infinity) reached the limiter output.');
  }
  if (truePeakRisk) notes.push(TRUE_PEAK_RISK_NOTE);

  return {
    config,
    frameCount: perFrame.length,
    frames: perFrame,
    exceededCeiling: exceededCeilingFrames.length > 0,
    exceededCeilingFrames,
    limitingIntervals,
    maxGainReductionDb,
    nonFiniteInput,
    nonFiniteOutput,
    truePeakRisk,
    notes
  };
}

// offscreen.js is a classic (non-module) script, so it cannot `import` this file. The offscreen
// document loads this module alongside it and this line hands the classic script the same API.
// Tests import the named exports above directly; both paths share one implementation.
if (typeof globalThis !== 'undefined') {
  globalThis.LimiterAudit = { describeLimiterConfig, auditRenderedOutput };
}
