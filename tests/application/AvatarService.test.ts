import { AvatarService } from '../../src/application/AvatarService';
import { VoiceService } from '../../src/application/VoiceService';
import { Celeste } from '../../src/core/Celeste';
import { EventBus } from '../../src/core/EventBus';
import { AvatarState } from '../../src/core/types';
import { FakeAI, FakeMessaging, FakeRecorder, FakeSTT, FakeTTS, makeMessage } from '../helpers/fakes';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(errorHoldMs = 50) {
  const eventBus = new EventBus();
  const avatar = new AvatarService(eventBus, errorHoldMs);
  const changes: AvatarState[] = [];
  eventBus.on('AVATAR_STATE_CHANGED', (event) => {
    changes.push(event.data.state);
  });
  return { eventBus, avatar, changes };
}

describe('AvatarService', () => {
  it('starts in IDLE', () => {
    expect(setup().avatar.getState()).toBe('IDLE');
  });

  it('IDLE → LISTENING → THINKING → SPEAKING → IDLE', async () => {
    const { eventBus, avatar, changes } = setup();

    await eventBus.emit('LISTENING_STARTED');
    expect(avatar.getState()).toBe('LISTENING');

    await eventBus.emit('LISTENING_FINISHED', { next: 'PROCESSING_AUDIO' });
    await eventBus.emit('THINKING_STARTED');
    expect(avatar.getState()).toBe('THINKING');

    await eventBus.emit('TTS_STARTED', { text: 'Olá' });
    expect(avatar.getState()).toBe('SPEAKING');

    await eventBus.emit('TTS_FINISHED');
    expect(avatar.getState()).toBe('IDLE');

    expect(changes).toEqual(['LISTENING', 'THINKING', 'SPEAKING', 'IDLE']);
  });

  it('TTS_STARTED → SPEAKING (with the spoken text) and TTS_FINISHED → IDLE', async () => {
    const { eventBus, avatar } = setup();
    const payloads: any[] = [];
    eventBus.on('AVATAR_STATE_CHANGED', (event) => {
      payloads.push(event.data);
    });

    await eventBus.emit('TTS_STARTED', { text: 'Estou online.' });
    expect(avatar.getState()).toBe('SPEAKING');
    expect(payloads[0]).toMatchObject({ state: 'SPEAKING', previous: 'IDLE', text: 'Estou online.' });

    await eventBus.emit('TTS_FINISHED');
    expect(avatar.getState()).toBe('IDLE');
  });

  it('a cancelled recording returns to IDLE', async () => {
    const { eventBus, avatar } = setup();
    await eventBus.emit('LISTENING_STARTED');
    await eventBus.emit('LISTENING_FINISHED', { next: 'IDLE' });
    expect(avatar.getState()).toBe('IDLE');
  });

  it('Ctrl+C while thinking returns to IDLE', async () => {
    const { eventBus, avatar } = setup();
    await eventBus.emit('THINKING_STARTED');
    await eventBus.emit('VOICE_STATE_CHANGED', { from: 'TRANSCRIBING', to: 'IDLE' });
    expect(avatar.getState()).toBe('IDLE');
  });

  it('a speech interrupted by the user does not leave LISTENING', async () => {
    const { eventBus, avatar } = setup();
    await eventBus.emit('TTS_STARTED', { text: 'Você recebeu uma mensagem...' });
    await eventBus.emit('LISTENING_STARTED'); // ENTER durante o anúncio
    await eventBus.emit('TTS_FINISHED'); // a fala interrompida termina depois
    expect(avatar.getState()).toBe('LISTENING');
  });

  it('WhatsApp message: attention (LISTENING) then SPEAKING', async () => {
    const { eventBus, avatar, changes } = setup();
    await eventBus.emit('MESSAGE_RECEIVED', makeMessage());
    expect(avatar.getState()).toBe('LISTENING');
    await eventBus.emit('TTS_STARTED', { text: 'Você recebeu uma mensagem de João' });
    await eventBus.emit('TTS_FINISHED');
    expect(changes).toEqual(['LISTENING', 'SPEAKING', 'IDLE']);
  });

  it('errors: ERROR → SPEAKING (alert) → ERROR → IDLE after the hold time', async () => {
    const { eventBus, avatar, changes } = setup(30);
    const payloads: any[] = [];
    eventBus.on('AVATAR_STATE_CHANGED', (event) => {
      payloads.push(event.data);
    });

    await eventBus.emit('ERROR', { code: 'EMPTY_TRANSCRIPTION', message: 'Não consegui entender o áudio.' });
    expect(avatar.getState()).toBe('ERROR');

    await eventBus.emit('TTS_STARTED', { text: 'Não consegui entender o áudio.' });
    expect(payloads[1]).toMatchObject({ state: 'SPEAKING', alert: true });

    await eventBus.emit('TTS_FINISHED');
    expect(avatar.getState()).toBe('ERROR');

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(avatar.getState()).toBe('IDLE');
    expect(changes).toEqual(['ERROR', 'SPEAKING', 'ERROR', 'IDLE']);
  });

  it('ignores internal errors without a user-facing code', async () => {
    const { eventBus, avatar } = setup();
    await eventBus.emit('ERROR', { error: new Error('db') });
    expect(avatar.getState()).toBe('IDLE');
  });

  it('setState can be driven directly (AvatarController)', () => {
    const { avatar, changes } = setup();
    avatar.setState('THINKING');
    avatar.setState('THINKING');
    expect(avatar.getState()).toBe('THINKING');
    expect(changes).toEqual(['THINKING']);
  });
});

describe('VoiceService TTS events', () => {
  it('emits TTS_STARTED before and TTS_FINISHED after speaking', async () => {
    const eventBus = new EventBus();
    const tts = new FakeTTS();
    const order: string[] = [];
    eventBus.on('TTS_STARTED', () => {
      order.push(`started:${tts.spoken.length}`);
    });
    eventBus.on('TTS_FINISHED', () => {
      order.push(`finished:${tts.spoken.length}`);
    });

    await new VoiceService(tts, eventBus).speak('Olá');
    expect(order).toEqual(['started:0', 'finished:1']);
  });

  it('waits for the provider start notification when supported', async () => {
    const eventBus = new EventBus();
    const events: string[] = [];
    eventBus.on('TTS_STARTED', () => {
      events.push('started');
    });
    const provider = {
      notifiesStart: true,
      isAvailable: () => true,
      speak: async (_text: string, hooks?: { onStart?: () => void }) => {
        events.push('synth-loading');
        hooks?.onStart?.();
        events.push('audio');
      },
    };
    await new VoiceService(provider, eventBus).speak('Olá');
    expect(events).toEqual(['synth-loading', 'started', 'audio']);
  });

  it('emits TTS_FINISHED even when the TTS fails', async () => {
    const eventBus = new EventBus();
    const tts = new FakeTTS();
    tts.fail = true;
    let finished = false;
    eventBus.on('TTS_FINISHED', () => {
      finished = true;
    });
    await expect(new VoiceService(tts, eventBus).speak('Olá')).rejects.toThrow();
    expect(finished).toBe(true);
  });
});

describe('Avatar + voice pipeline (Celeste with fakes)', () => {
  async function celesteSetup() {
    const messaging = new FakeMessaging();
    const stt = new FakeSTT();
    const recorder = new FakeRecorder();
    const celeste = new Celeste(messaging, new FakeAI(), stt, new FakeTTS(), recorder);
    await celeste.start();
    const states: AvatarState[] = [];
    celeste.on('AVATAR_STATE_CHANGED', (event) => {
      states.push(event.data.state);
    });
    return { celeste, messaging, stt, states };
  }

  it('"Celeste, status." → LISTENING → THINKING → SPEAKING → IDLE', async () => {
    const { celeste, stt, states } = await celesteSetup();
    stt.queue('Celeste, status.');
    await celeste.startVoiceInput();
    expect(celeste.getAvatarState()).toBe('LISTENING');
    await celeste.finishVoiceInput();
    await flush();
    expect(states).toEqual(['LISTENING', 'THINKING', 'SPEAKING', 'IDLE']);
    expect(celeste.getAvatarState()).toBe('IDLE');
  });

  it('typed commands also go THINKING → SPEAKING → IDLE', async () => {
    const { celeste, states } = await celesteSetup();
    await celeste.respond('ajuda', 'cli');
    await flush();
    expect(states).toEqual(['THINKING', 'SPEAKING', 'IDLE']);
  });

  it('reacts to WhatsApp messages', async () => {
    const { messaging, states } = await celesteSetup();
    await messaging.receive(makeMessage({ text: 'Oi, você está disponível?' }));
    await flush();
    expect(states).toEqual(['LISTENING', 'SPEAKING', 'IDLE']);
  });

  it('shows ERROR when the audio cannot be understood', async () => {
    const { celeste, stt, states } = await celesteSetup();
    stt.queue('');
    await celeste.startVoiceInput();
    await celeste.finishVoiceInput();
    await flush();
    expect(states).toEqual(['LISTENING', 'THINKING', 'ERROR', 'SPEAKING', 'ERROR']);
  });
});
