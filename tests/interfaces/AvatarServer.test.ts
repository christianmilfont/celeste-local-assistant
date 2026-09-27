import * as http from 'http';
import * as path from 'path';
import { AvatarServer } from '../../src/interfaces/avatar/AvatarServer';
import { EventBus } from '../../src/core/EventBus';
import { AvatarService } from '../../src/application/AvatarService';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LipSync = require('../../avatar/lipsync.js');

function get(url: string): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body, type: res.headers['content-type'] }));
      })
      .on('error', reject);
  });
}

describe('AvatarServer', () => {
  let eventBus: EventBus;
  let avatar: AvatarService;
  let server: AvatarServer;
  let baseUrl: string;

  beforeEach(async () => {
    eventBus = new EventBus();
    avatar = new AvatarService(eventBus);
    const source = {
      getAvatarState: () => avatar.getState(),
      on: (type: any, cb: any) => eventBus.on(type, cb),
    };
    server = new AvatarServer(source, path.resolve(__dirname, '../../avatar'));
    baseUrl = await server.start(0, '127.0.0.1');
  });

  afterEach(async () => {
    await server.stop();
  });

  it('serves the avatar page and assets', async () => {
    const page = await get(baseUrl);
    expect(page.status).toBe(200);
    expect(page.type).toContain('text/html');
    expect(page.body).toContain('CELESTE');

    const script = await get(`${baseUrl}avatar.js`);
    expect(script.status).toBe(200);
    expect(script.type).toContain('javascript');
  });

  it('does not serve files outside the avatar folder', async () => {
    expect((await get(`${baseUrl}..%2Fpackage.json`)).status).toBe(404);
    expect((await get(`${baseUrl}../.env`)).status).toBe(404);
  });

  it('exposes the current state', async () => {
    avatar.setState('THINKING');
    await new Promise((resolve) => setImmediate(resolve));
    const state = JSON.parse((await get(`${baseUrl}state`)).body);
    expect(state.state).toBe('THINKING');
  });

  it('streams state changes over SSE', async () => {
    const received: any[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`${baseUrl}events`, (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk;
          const events = buffer.split('\n\n');
          buffer = events.pop() || '';
          events
            .filter((block) => block.includes('event: state'))
            .forEach((block) => received.push(JSON.parse(block.split('data: ')[1])));

          if (received.length === 1) {
            avatar.setState('SPEAKING', { text: 'Olá' });
          }
          if (received.length === 2) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on('error', (error) => (received.length >= 2 ? resolve() : reject(error)));
    });

    expect(received[0]).toMatchObject({ state: 'IDLE', initial: true });
    expect(received[1]).toMatchObject({ state: 'SPEAKING', previous: 'IDLE', text: 'Olá' });
  });
});

describe('LipSync', () => {
  it('opens on vowels, closes on m/b/p and pauses on punctuation', () => {
    expect(LipSync.shapeFor('a')).toBe('MOUTH_OPEN');
    expect(LipSync.shapeFor('o')).toBe('MOUTH_MEDIUM');
    expect(LipSync.shapeFor('i')).toBe('MOUTH_SMALL');
    expect(LipSync.shapeFor('m')).toBe('MOUTH_CLOSED');

    const sequence = LipSync.sequence('Olá. Tudo bem?');
    const shapes = sequence.map((segment: any) => segment.shape);
    expect(shapes).toContain('MOUTH_OPEN');
    expect(shapes).toContain('MOUTH_CLOSED');
    expect(shapes[shapes.length - 1]).toBe('MOUTH_CLOSED');
  });

  it('keeps the mouth update rate low (~12 changes per second)', () => {
    const sequence = LipSync.sequence('Estou online e todos os serviços principais estão funcionando.', 30);
    const totalMs = sequence.reduce((sum: number, segment: any) => sum + segment.ms, 0);
    sequence.forEach((segment: any) => expect(segment.ms).toBeGreaterThanOrEqual(LipSync.MIN_SEGMENT_MS / 2));
    expect(sequence.length / (totalMs / 1000)).toBeLessThanOrEqual(1000 / LipSync.MIN_SEGMENT_MS);
  });

  it('alternates shapes within words (the mouth keeps moving)', () => {
    const shapes = LipSync.sequence('Estou online e todos os serviços estão funcionando.').map((s: any) => s.shape);
    expect(new Set(shapes).size).toBeGreaterThanOrEqual(3);
    expect(shapes.length).toBeGreaterThan(15);
  });

  it('handles empty text', () => {
    expect(LipSync.sequence('')).toEqual([]);
  });
});
