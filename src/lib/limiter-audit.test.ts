import { describe, expect, it } from 'vitest';
import { LookaheadLimiter } from '../../public/limiter-core.js';
import { auditRenderedOutput, describeLimiterConfig } from '../../public/limiter-audit.js';

// Render `input` through a real LookaheadLimiter in uneven blocks (same shape as
// limiter.test.ts) while recording, per render instant, every channel's input sample and the
// limiter's actual output sample — exactly the recording format auditRenderedOutput consumes.
function renderAndRecord(input: Float32Array[], sampleRate = 48000, options = {}) {
  const limiter = new LookaheadLimiter(sampleRate, input.length, options);
  const length = input[0].length + limiter.delaySamples;
  const output = input.map(() => new Float32Array(length));
  const frames: { input: number[]; output: number[] }[] = [];
  for (let at = 0; at < length; at += 127) {
    const size = Math.min(127, length - at);
    const block = input.map(channel => Float32Array.from({ length: size }, (_, i) => channel[at + i] ?? 0));
    const result = input.map(() => new Float32Array(size));
    limiter.process(block, result);
    result.forEach((channel, i) => output[i].set(channel, at));
    for (let f = 0; f < size; f++) {
      frames.push({ input: block.map(channel => channel[f]), output: result.map(channel => channel[f]) });
    }
  }
  return { limiter, output, frames };
}

describe('describeLimiterConfig', () => {
  it('agrees field-by-field with a really constructed LookaheadLimiter', () => {
    for (const [sampleRate, options] of [
      [48000, {}],
      [44100, { lookaheadMs: 2.5, ceilingDb: -3, releaseMs: 120, attackMs: 0.5 }],
      [96000, { lookaheadMs: 0.04 }]
    ] as const) {
      const limiter = new LookaheadLimiter(sampleRate, 2, options);
      const config = describeLimiterConfig(sampleRate, 2, options);
      expect(config.lookaheadSamples).toBe(limiter.delaySamples);
      expect(config.ceiling).toBe(limiter.ceiling);
      expect(config.safeCeiling).toBe(limiter.safeCeiling);
      expect(config.ringSize).toBe(limiter.ringSize);
    }
  });

  it('states the sample-peak vs true-peak scope in its description', () => {
    const config = describeLimiterConfig(48000, 2, {});
    expect(config.description).toContain('sample peak');
    expect(config.description).toContain('true');
    expect(() => JSON.stringify(config)).not.toThrow();
  });
});

describe('auditRenderedOutput — normal path (transient spike)', () => {
  const sampleRate = 48000;
  const input = new Float32Array(4800).fill(0.2);
  input[1200] = 8; // instantaneous spike far above the -1 dBFS ceiling
  const { limiter, output, frames } = renderAndRecord([input], sampleRate);
  const audit = auditRenderedOutput(frames, sampleRate, 1, {});

  it('reports the same lookahead, ceiling and safeCeiling as the real limiter', () => {
    expect(audit.config.lookaheadSamples).toBe(limiter.delaySamples);
    expect(audit.config.ceiling).toBe(limiter.ceiling);
    expect(audit.config.safeCeiling).toBe(limiter.safeCeiling);
    expect(audit.config.ringSize).toBe(limiter.ringSize);
    expect(audit.config).toEqual(describeLimiterConfig(sampleRate, 1, {}));
  });

  it('flags ceiling exceedances frame-by-frame exactly as the real render produced them', () => {
    expect(frames).toHaveLength(output[0].length);
    frames.forEach((frame, i) => {
      const realExceeds = frame.output.some(v => Math.abs(v) > limiter.ceiling);
      expect(audit.frames[i].exceedsCeiling).toBe(realExceeds);
    });
    // A healthy limiter never exceeds its own ceiling, and the audit agrees.
    expect(audit.exceededCeiling).toBe(false);
    expect(audit.exceededCeilingFrames).toEqual([]);
  });

  it('locates limiting around the (delayed) spike and measures the attenuation in dB', () => {
    expect(audit.limitingIntervals.length).toBeGreaterThan(0);
    const spikeOut = 1200 + limiter.delaySamples;
    expect(audit.limitingIntervals.some(iv => iv.start <= spikeOut && spikeOut <= iv.end)).toBe(true);
    // 8 -> ~0.891 is about 19 dB of gain reduction at the spike itself.
    expect(audit.maxGainReductionDb).toBeGreaterThan(15);
    expect(audit.nonFiniteInput).toBe(false);
    expect(audit.nonFiniteOutput).toBe(false);
    expect(JSON.parse(JSON.stringify(audit))).toEqual(audit);
  });

  it('flags a recording whose output really does exceed the ceiling', () => {
    // Simulates a broken/passthrough limiter: full-scale input comes straight back out.
    const broken = auditRenderedOutput([{ input: [2, -2], output: [2, -2] }], sampleRate, 2, {});
    expect(broken.exceededCeiling).toBe(true);
    expect(broken.frames[0].exceedsCeiling).toBe(true);
    expect(broken.exceededCeilingFrames).toEqual([0]);
  });
});

describe('auditRenderedOutput — negative path (non-finite input)', () => {
  it('marks non-finite input while the real limiter output stays entirely finite', () => {
    const input = new Float32Array(256).fill(0.1);
    input[3] = NaN;
    input[40] = Infinity;
    input[120] = -Infinity;
    const { output, frames } = renderAndRecord([input]);
    const audit = auditRenderedOutput(frames, 48000, 1, {});
    expect(audit.nonFiniteInput).toBe(true);
    expect(audit.nonFiniteOutput).toBe(false);
    expect(output[0].every(Number.isFinite)).toBe(true);
    expect(audit.frames.some(f => !f.inputFinite)).toBe(true);
    expect(audit.frames.every(f => f.outputFinite)).toBe(true);
    expect(audit.notes.some(n => /non-finite input/i.test(n))).toBe(true);
    // Non-finite samples are excluded from peaks, so the result is still JSON-safe.
    expect(JSON.parse(JSON.stringify(audit))).toEqual(audit);
  });

  it('reports non-finite values that were propagated to the output', () => {
    const audit = auditRenderedOutput([{ input: [NaN], output: [NaN] }], 48000, 1, {});
    expect(audit.nonFiniteOutput).toBe(true);
    expect(audit.notes.some(n => /non-finite values.*output/i.test(n))).toBe(true);
    expect(() => JSON.stringify(audit)).not.toThrow();
  });
});

describe('auditRenderedOutput — boundary configurations', () => {
  it('handles lookaheadMs 0 and ceilingDb 0 without throwing, matching real construction', () => {
    const options = { lookaheadMs: 0, ceilingDb: 0 };
    const limiter = new LookaheadLimiter(44100, 2, options);
    const config = describeLimiterConfig(44100, 2, options);
    expect(config.lookaheadSamples).toBe(limiter.delaySamples); // max(1, ceil(0)) = 1
    expect(config.lookaheadSamples).toBe(1);
    expect(config.ceiling).toBe(1);
    expect(config.safeCeiling).toBe(limiter.safeCeiling);
    expect(config.ringSize).toBe(limiter.ringSize);
    expect(() => auditRenderedOutput([], 44100, 2, options)).not.toThrow();
    const audit = auditRenderedOutput(
      [{ input: [0.5], output: [0] }, { input: [0.5], output: [0.5] }],
      44100, 2, options
    );
    expect(audit.frameCount).toBe(2);
    expect(audit.exceededCeiling).toBe(false);
  });
});

describe('auditRenderedOutput — true-peak scope', () => {
  it('annotates adjacent full-scale alternating input instead of claiming distortion is gone', () => {
    // ±1 square wave at Nyquist: sample peaks sit at full scale, but the reconstructed
    // inter-sample true peak overshoots. The audit must flag the risk, not certify compliance.
    const frames = Array.from({ length: 8 }, (_, i) => ({
      input: [i % 2 === 0 ? 1 : -1],
      output: [0]
    }));
    const audit = auditRenderedOutput(frames, 48000, 1, {});
    expect(audit.truePeakRisk).toBe(true);
    expect(audit.notes.some(n => /true.?peak/i.test(n) && /not/i.test(n))).toBe(true);
    expect(audit.notes.some(n => /does NOT claim|does not certify|NOT certify/i.test(n))).toBe(true);
  });

  it('does not flag ordinary material', () => {
    const frames = Array.from({ length: 64 }, (_, i) => ({
      input: [0.3 * Math.sin(i * 0.2)],
      output: [0.3 * Math.sin(i * 0.2)]
    }));
    const audit = auditRenderedOutput(frames, 48000, 1, {});
    expect(audit.truePeakRisk).toBe(false);
  });
});
