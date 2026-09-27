import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FallbackTTSProvider } from '../../src/adapters/tts/FallbackTTSProvider';
import { KokoroTTSProvider } from '../../src/adapters/tts/KokoroTTSProvider';
import { SpeakHooks, TextToSpeechProvider } from '../../src/core/types/adapters';

class ScriptedVoice implements TextToSpeechProvider {
  spoken: string[] = [];
  fail?: 'before' | 'after-start';
  constructor(readonly notifiesStart = true) {}
  async speak(text: string, hooks: SpeakHooks = {}) {
    if (this.fail === 'before') throw new Error('modelo indisponível');
    hooks.onStart?.();
    if (this.fail === 'after-start') throw new Error('caiu no meio');
    this.spoken.push(text);
  }
  isAvailable() {
    return !this.fail;
  }
}

describe('FallbackTTSProvider', () => {
  it('uses the neural voice when it works', async () => {
    const neural = new ScriptedVoice();
    const system = new ScriptedVoice();
    const tts = new FallbackTTSProvider(neural, system);
    const onStart = jest.fn();
    await tts.speak('Olá', { onStart });
    expect(neural.spoken).toEqual(['Olá']);
    expect(system.spoken).toEqual([]);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(tts.describe()).toBe('neural (Kokoro)');
  });

  it('falls back to the system voice when the neural voice fails', async () => {
    const neural = new ScriptedVoice();
    neural.fail = 'before';
    const system = new ScriptedVoice();
    const tts = new FallbackTTSProvider(neural, system);
    await tts.speak('Olá');
    await tts.speak('De novo');
    expect(system.spoken).toEqual(['Olá', 'De novo']);
    expect(tts.describe()).toBe('sistema (Windows)');
  });

  it('does not repeat a sentence already partially spoken', async () => {
    const neural = new ScriptedVoice();
    neural.fail = 'after-start';
    const system = new ScriptedVoice();
    const tts = new FallbackTTSProvider(neural, system);
    await tts.speak('Olá');
    expect(system.spoken).toEqual([]);
  });

  it('signals the start before speaking when the fallback cannot notify it', async () => {
    const neural = new ScriptedVoice();
    neural.fail = 'before';
    const order: string[] = [];
    const system: TextToSpeechProvider = {
      notifiesStart: false,
      isAvailable: () => true,
      speak: async () => {
        order.push('speak');
      },
    };
    await new FallbackTTSProvider(neural, system).speak('Olá', { onStart: () => order.push('start') });
    expect(order).toEqual(['start', 'speak']);
  });
});

describe('KokoroTTSProvider (worker simulado)', () => {
  // Worker falso em Node com o mesmo protocolo do scripts/tts/kokoro_worker.py.
  const fakeWorker = path.join(os.tmpdir(), 'celeste-fake-kokoro-worker.js');
  beforeAll(() => {
    fs.writeFileSync(
      fakeWorker,
      `const rl = require('readline').createInterface({ input: process.stdin });
       const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
       const timers = new Map();
       out({ ready: true });
       rl.on('line', (line) => {
         const m = JSON.parse(line);
         if (m.type === 'speak') {
           if (m.text === 'erro') return out({ id: m.id, event: 'error', error: 'falhou' });
           out({ id: m.id, event: 'started', voice: m.voice });
           timers.set(m.id, setTimeout(() => out({ id: m.id, event: 'done' }), m.text.length * 5));
         } else if (m.type === 'stop') {
           for (const [id, t] of timers) { clearTimeout(t); out({ id, event: 'done' }); }
           timers.clear();
         }
       });`
    );
  });

  it('speaks, signals the real start and finishes', async () => {
    const tts = new KokoroTTSProvider(process.execPath, fakeWorker);
    const onStart = jest.fn();
    await tts.speak('Olá, eu sou a Celeste.', { onStart });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(tts.isAvailable()).toBe(true);
    tts.dispose();
  });

  it('stop() releases the pending speech immediately', async () => {
    const tts = new KokoroTTSProvider(process.execPath, fakeWorker);
    await tts.warmUp();
    const started = Date.now();
    const speech = tts.speak('x'.repeat(2000)); // ~10 s no worker falso
    setTimeout(() => tts.stop(), 50);
    await speech;
    expect(Date.now() - started).toBeLessThan(1000);
    tts.dispose();
  });

  it('propagates worker errors (so the fallback voice can take over)', async () => {
    const tts = new KokoroTTSProvider(process.execPath, fakeWorker);
    await expect(tts.speak('erro')).rejects.toThrow('falhou');
    tts.dispose();
  });
});
