export interface LimiterAuditOptions {
  lookaheadMs?: number;
  ceilingDb?: number;
  releaseMs?: number;
  attackMs?: number;
}

export interface LimiterConfigDescription {
  sampleRate: number;
  channels: number;
  lookaheadMs: number;
  ceilingDb: number;
  releaseMs: number;
  attackMs: number;
  lookaheadSamples: number;
  ceiling: number;
  safeCeiling: number;
  ringSize: number;
  scope: string;
  description: string;
}

export interface LimiterAuditFrame {
  index: number;
  inputPeak: number;
  outputPeak: number;
  inputFinite: boolean;
  outputFinite: boolean;
  exceedsCeiling: boolean;
  limitingActive: boolean;
  gainReductionDb: number;
}

export interface LimiterAuditResult {
  config: LimiterConfigDescription;
  frameCount: number;
  frames: LimiterAuditFrame[];
  exceededCeiling: boolean;
  exceededCeilingFrames: number[];
  limitingIntervals: { start: number; end: number }[];
  maxGainReductionDb: number;
  nonFiniteInput: boolean;
  nonFiniteOutput: boolean;
  truePeakRisk: boolean;
  notes: string[];
}

export function describeLimiterConfig(
  sampleRate: number,
  channels?: number,
  options?: LimiterAuditOptions
): LimiterConfigDescription;

export function auditRenderedOutput(
  frames: { input: number[]; output: number[] }[],
  sampleRate: number,
  channels?: number,
  options?: LimiterAuditOptions
): LimiterAuditResult;
