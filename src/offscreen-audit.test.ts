import { describe, expect, it, vi } from 'vitest';
import offscreenSource from '../public/offscreen.js?raw';
import { describeLimiterConfig } from '../public/limiter-audit.js';
import { LookaheadLimiter } from '../public/limiter-core.js';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

// Boot the shipped offscreen.js with mocked browser APIs, like offscreen.test.ts, but with a
// configurable audioWorklet.addModule so the engine can be held mid-initialization or failed.
// Importing limiter-audit.js above attaches globalThis.LimiterAudit, the same way the
// <script type="module"> tag does in offscreen.html.
function boot(addModule: () => Promise<void>) {
  let receive: (message: any, sender: any, response: Function) => void = () => {};
  const parameter = () => ({ value: 0, cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() });
  const node = () => ({
    connect: vi.fn(), disconnect: vi.fn(),
    gain: parameter(), frequency: parameter(), Q: parameter(),
    getFloatTimeDomainData: vi.fn((buf: Float32Array) => buf.fill(0))
  });
  class Context {
    sampleRate = 48000;
    currentTime = 0;
    state = 'suspended';
    destination = node();
    audioWorklet = { addModule: vi.fn(addModule) };
    suspend = vi.fn(async () => {});
    resume = vi.fn(async () => {});
    createGain = node;
    createBiquadFilter = node;
    createAnalyser = node;
    createChannelSplitter = node;
    createMediaStreamSource = node;
  }
  class Worklet {
    connect = vi.fn();
    port = { postMessage: vi.fn() };
  }
  new Function('window', 'AudioWorkletNode', 'chrome', 'navigator', 'self', 'setInterval', 'setTimeout', 'console', offscreenSource)(
    { AudioContext: Context }, Worklet,
    { runtime: {
      getURL: (path: string) => path,
      onMessage: { addListener: (handler: typeof receive) => { receive = handler; } },
      sendMessage: async () => {}
    } },
    { mediaDevices: { getUserMedia: vi.fn() } }, { addEventListener: vi.fn() }, vi.fn(), vi.fn(), { error: vi.fn(), log: vi.fn() }
  );
  return {
    askAudit: () => {
      const response = vi.fn();
      receive({ target: 'offscreen', type: 'auditLimiter' }, {}, response);
      return response;
    }
  };
}

describe('offscreen auditLimiter message', () => {
  it('returns a non-auditable result with a readable reason while the engine is uninitialized', () => {
    // addModule never resolves: the engine stays mid-initialization (no outputLimiter) forever.
    const { askAudit } = boot(() => new Promise<void>(() => {}));
    // The handler must answer even though `ready` is still pending.
    const response = askAudit();
    expect(response).toHaveBeenCalledOnce();
    const result = response.mock.calls[0][0];
    expect(result.auditable).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('returns a non-auditable result after the engine has failed', async () => {
    const { askAudit } = boot(async () => { throw new Error('worklet load blocked'); });
    await flush(); // let setupAudioNodes reject and engineFailure be recorded
    const response = askAudit();
    expect(response).toHaveBeenCalledOnce();
    const result = response.mock.calls[0][0];
    expect(result.auditable).toBe(false);
    expect(result.reason).toContain('worklet load blocked');
  });

  it('returns a config snapshot matching a real LookaheadLimiter once the engine is up', async () => {
    const { askAudit } = boot(async () => {});
    await flush();
    const response = askAudit();
    expect(response).toHaveBeenCalledOnce();
    const result = response.mock.calls[0][0];
    expect(result.auditable).toBe(true);
    // The snapshot mirrors the worklet's LookaheadLimiter(sampleRate, 2) with default options.
    const limiter = new LookaheadLimiter(48000, 2);
    expect(result.config.lookaheadSamples).toBe(limiter.delaySamples);
    expect(result.config.ceiling).toBe(limiter.ceiling);
    expect(result.config.safeCeiling).toBe(limiter.safeCeiling);
    expect(result.config.ringSize).toBe(limiter.ringSize);
    expect(result.config).toEqual(describeLimiterConfig(48000, 2, {}));
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
