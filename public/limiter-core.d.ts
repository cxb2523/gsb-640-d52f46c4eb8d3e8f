export class LookaheadLimiter {
  constructor(sampleRate: number, channels?: number, options?: {lookaheadMs?: number; attackMs?: number; releaseMs?: number; ceilingDb?: number});
  readonly delaySamples: number;
  readonly ceiling: number;
  readonly safeCeiling: number;
  readonly ringSize: number;
  process(input: Float32Array[], output: Float32Array[]): void;
}
