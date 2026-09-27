import * as fs from 'fs';
import { SpeechInputService } from '../../src/application/SpeechInputService';
import { EventBus } from '../../src/core/EventBus';
import { CelesteError } from '../../src/core/errors';
import { FakeRecorder, FakeSTT, makeWav } from '../helpers/fakes';

function setup() {
  const recorder = new FakeRecorder();
  const stt = new FakeSTT();
  const eventBus = new EventBus();
  const events: string[] = [];
  (['VOICE_INPUT_STARTED', 'VOICE_INPUT_RECEIVED', 'VOICE_TRANSCRIBED'] as const).forEach((type) =>
    eventBus.on(type, () => {
      events.push(type);
    })
  );
  const service = new SpeechInputService(recorder, stt, eventBus, {
    minDurationMs: 400,
    silenceThreshold: 400,
    keepAudioFiles: false,
  });
  return { recorder, stt, service, events };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(CelesteError);
  await promise.catch((error: CelesteError) => expect(error.code).toBe(code));
}

describe('SpeechInputService', () => {
  it('starts recording', async () => {
    const { service, recorder, events } = setup();
    await service.startRecording();
    expect(recorder.isRecording()).toBe(true);
    expect(service.isRecording()).toBe(true);
    expect(events).toEqual(['VOICE_INPUT_STARTED']);
  });

  it('stops recording, transcribes and deletes the temporary file', async () => {
    const { service, recorder, stt, events } = setup();
    stt.queue('Celeste, status.');

    await service.startRecording();
    const audio = await service.stopRecording();
    expect(recorder.isRecording()).toBe(false);
    expect(audio.durationMs).toBeCloseTo(1500, -1);

    const text = await service.transcribe(audio);
    expect(text).toBe('Celeste, status.');
    expect(fs.existsSync(audio.path)).toBe(false);
    expect(events).toEqual(['VOICE_INPUT_STARTED', 'VOICE_INPUT_RECEIVED', 'VOICE_TRANSCRIBED']);
  });

  it('rejects starting twice', async () => {
    const { service } = setup();
    await service.startRecording();
    await expectCode(service.startRecording(), 'ALREADY_RECORDING');
  });

  it('rejects stopping when not recording', async () => {
    const { service } = setup();
    await expectCode(service.stopRecording(), 'NOT_RECORDING');
  });

  it('treats a too short recording as empty audio (and deletes it)', async () => {
    const { service, recorder } = setup();
    recorder.nextAudio = makeWav(100);
    await service.startRecording();
    await expectCode(service.stopRecording(), 'EMPTY_AUDIO');
    expect(fs.existsSync(recorder.createdFiles[0])).toBe(false);
  });

  it('treats a header-only file as empty audio', async () => {
    const { service, recorder } = setup();
    recorder.nextAudio = makeWav(0);
    await service.startRecording();
    await expectCode(service.stopRecording(), 'EMPTY_AUDIO');
  });

  it('detects silence (muted mic / permission denied)', async () => {
    const { service, recorder, stt } = setup();
    recorder.nextAudio = makeWav(2000, 0);
    await service.startRecording();
    await expectCode(service.stopRecording(), 'SILENT_AUDIO');
    expect(stt.transcribedPaths).toHaveLength(0);
  });

  it('maps microphone failures', async () => {
    const { service, recorder } = setup();
    recorder.startError = new Error('MCI 328: no wave input device');
    await expectCode(service.startRecording(), 'MIC_UNAVAILABLE');

    recorder.startError = new Error('Access denied by privacy settings');
    await expectCode(service.startRecording(), 'MIC_PERMISSION_DENIED');
  });

  it('handles an empty transcription', async () => {
    const { service, stt } = setup();
    stt.queue('   ');
    await service.startRecording();
    const audio = await service.stopRecording();
    await expectCode(service.transcribe(audio), 'EMPTY_TRANSCRIPTION');
    expect(fs.existsSync(audio.path)).toBe(false);
  });

  it('discards known Whisper hallucinations', async () => {
    const { service, stt } = setup();
    stt.queue('Legendas pela comunidade Amara.org');
    await service.startRecording();
    await expectCode(service.transcribe(await service.stopRecording()), 'EMPTY_TRANSCRIPTION');
  });

  it('discards repetition loops ("O que é isso? O que é isso? ...")', async () => {
    const { service, stt } = setup();
    stt.queue('O que é isso? O que é isso? O que é isso? O que é isso?');
    await service.startRecording();
    await expectCode(service.transcribe(await service.stopRecording()), 'EMPTY_TRANSCRIPTION');
  });

  it('handles STT errors and still deletes the audio', async () => {
    const { service, stt } = setup();
    stt.error = new Error('python not found');
    await service.startRecording();
    const audio = await service.stopRecording();
    await expectCode(service.transcribe(audio), 'STT_UNAVAILABLE');
    expect(fs.existsSync(audio.path)).toBe(false);
  });

  it('cancels a recording', async () => {
    const { service, recorder } = setup();
    await service.startRecording();
    await service.cancel();
    expect(recorder.cancelCalls).toBe(1);
    expect(service.isRecording()).toBe(false);
  });
});
