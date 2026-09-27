import { Celeste } from '../../src/core/Celeste';
import { VoicePipelineState } from '../../src/core/types';
import { FakeAI, FakeMessaging, FakeRecorder, FakeSTT, FakeTTS, makeMessage, makeWav } from '../helpers/fakes';

/**
 * Pipeline de voz completo com Microfone, Whisper, Ollama, TTS e WhatsApp simulados:
 * nenhum teste depende de hardware ou serviços externos.
 */
async function setup() {
  const messaging = new FakeMessaging();
  const ai = new FakeAI();
  const stt = new FakeSTT();
  const tts = new FakeTTS();
  const recorder = new FakeRecorder();
  const celeste = new Celeste(messaging, ai, stt, tts, recorder);
  await celeste.start();

  const states: VoicePipelineState[] = [];
  celeste.onVoiceStateChange((state) => states.push(state));

  /** Um turno de push-to-talk: ENTER, fala, ENTER. */
  const say = async (transcript: string) => {
    stt.queue(transcript);
    await celeste.startVoiceInput();
    return celeste.finishVoiceInput();
  };

  return { celeste, messaging, ai, stt, tts, recorder, states, say };
}

describe('Voice pipeline', () => {
  it('runs the full flow: mic -> STT -> command -> TTS, passing through every state', async () => {
    const { celeste, tts, states, say } = await setup();
    celeste.waitForVoice();

    const turn = await say('Celeste, status.');

    expect(turn.transcription).toBe('Celeste, status.');
    expect(turn.result?.intent).toBe('STATUS');
    expect(tts.last()).toBe(
      'Estou online. WhatsApp conectado, inteligência artificial disponível e sistema de voz funcionando.'
    );
    expect(states).toEqual([
      'WAITING_FOR_VOICE',
      'RECORDING',
      'PROCESSING_AUDIO',
      'TRANSCRIBING',
      'COMMAND_PROCESSING',
      'ACTION',
      'TTS_RESPONSE',
      'IDLE',
    ]);
  });

  it('voice and CLI share the same command processing', async () => {
    const { celeste, tts, say } = await setup();
    await say('Celeste, ajuda.');
    const voiceReply = tts.last();
    const cli = await celeste.respond('ajuda', 'cli');
    expect(cli.reply).toBe(voiceReply);
  });

  it('WhatsApp message -> announcement -> spoken reply -> confirmation -> sent', async () => {
    const { messaging, ai, tts, say } = await setup();
    ai.replyText = 'Já vou verificar e te retorno.';

    const incoming = makeMessage({ senderName: 'João', text: 'Você conseguiu terminar o projeto?' });
    await messaging.receive(incoming);
    expect(tts.last()).toBe('Você recebeu uma mensagem de João: Você conseguiu terminar o projeto?');

    await say('Leia novamente.');
    expect(tts.last()).toBe('Você recebeu uma mensagem de João: Você conseguiu terminar o projeto?');

    await say('Responde dizendo que já vou verificar.');
    expect(tts.last()).toBe('Preparei esta resposta para João: "Já vou verificar e te retorno.". Posso enviar?');
    expect(messaging.sent).toHaveLength(0);

    await say('Pode enviar.');
    expect(tts.last()).toBe('Mensagem enviada para João.');
    expect(messaging.sent).toEqual([{ chatId: incoming.chatId, text: 'Já vou verificar e te retorno.' }]);
  });

  it('saying "não" at the confirmation does not send', async () => {
    const { messaging, tts, say } = await setup();
    await messaging.receive(makeMessage());
    await say('Responde que já estou chegando.');
    await say('Não.');
    expect(tts.last()).toBe('Tudo bem, não vou enviar a mensagem.');
    expect(messaging.sent).toHaveLength(0);
  });

  it('empty transcription -> ERROR -> spoken "could not understand" -> IDLE', async () => {
    const { celeste, tts, states, say } = await setup();
    const turn = await say('');
    expect(turn.error?.code).toBe('EMPTY_TRANSCRIPTION');
    expect(tts.last()).toBe('Não consegui entender o áudio. Pode repetir?');
    expect(states.slice(-2)).toEqual(['ERROR', 'IDLE']);
    expect(celeste.getVoiceState()).toBe('IDLE');
  });

  it('silent recording is reported without calling the STT', async () => {
    const { recorder, stt, tts, say } = await setup();
    recorder.nextAudio = makeWav(2000, 0);
    const turn = await say('não deveria ser usado');
    expect(turn.error?.code).toBe('SILENT_AUDIO');
    expect(stt.transcribedPaths).toHaveLength(0);
    expect(tts.last()).toContain('Não captei nenhum som');
  });

  it('microphone unavailable is reported and returns to IDLE', async () => {
    const { celeste, recorder, tts } = await setup();
    recorder.startError = new Error('no wave input device');
    const started = await celeste.startVoiceInput();
    expect(started).toBe(false);
    expect(tts.last()).toBe('Não consegui acessar o microfone. Verifique se ele está conectado.');
    expect(celeste.getVoiceState()).toBe('IDLE');
  });

  it('Whisper unavailable is reported', async () => {
    const { stt, tts, say } = await setup();
    stt.error = new Error('faster_whisper not installed');
    const turn = await say('x');
    expect(turn.error?.code).toBe('STT_UNAVAILABLE');
    expect(tts.last()).toBe('O reconhecimento de voz está indisponível no momento.');
  });

  it('TTS failure does not crash: the reply is still produced', async () => {
    const { tts, say } = await setup();
    tts.fail = true;
    const turn = await say('status');
    expect(turn.error).toBeUndefined();
    expect(turn.result?.intent).toBe('STATUS');
  });

  it('Ctrl+C while recording cancels and returns to IDLE without processing', async () => {
    const { celeste, recorder, stt } = await setup();
    stt.queue('status');
    await celeste.startVoiceInput();
    expect(celeste.getVoiceState()).toBe('RECORDING');

    await celeste.cancelVoiceInput();
    expect(celeste.getVoiceState()).toBe('IDLE');
    expect(recorder.cancelCalls).toBe(1);
    expect(recorder.isRecording()).toBe(false);
    expect(stt.transcribedPaths).toHaveLength(0);
  });

  it('messages arriving while the user speaks are announced afterwards', async () => {
    const { celeste, messaging, tts, stt } = await setup();
    stt.queue('status');
    await celeste.startVoiceInput();

    await messaging.receive(makeMessage({ senderName: 'Maria', text: 'Oi!' }));
    expect(tts.spoken.some((text) => text.includes('Maria'))).toBe(false);

    await celeste.finishVoiceInput();
    await new Promise((resolve) => setImmediate(resolve));
    expect(tts.last()).toBe('Você recebeu uma mensagem de Maria: Oi!');
  });

  it('stops recording automatically after the maximum duration', async () => {
    jest.useFakeTimers();
    try {
      const { celeste, stt } = await setup();
      stt.queue('status');
      await celeste.startVoiceInput();
      const turnDone = new Promise((resolve) => celeste.onVoiceTurn(resolve));
      jest.advanceTimersByTime(30000);
      jest.useRealTimers();
      await turnDone;
      expect(celeste.getVoiceState()).toBe('IDLE');
    } finally {
      jest.useRealTimers();
    }
  });
});
