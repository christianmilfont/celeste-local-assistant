import * as fs from 'fs';
import { AudioRecorder, SpeechToTextProvider } from '../core/types/adapters';
import { EventBus } from '../core/EventBus';
import { CelesteError } from '../core/errors';
import { Config } from '../infrastructure/config/Config';
import { Logger } from '../infrastructure/logging/Logger';

export interface CapturedAudio {
  path: string;
  durationMs: number;
  /** Maior amplitude encontrada (0-32767 para PCM 16 bits). */
  peak: number;
}

export interface SpeechInputOptions {
  minDurationMs: number;
  silenceThreshold: number;
  keepAudioFiles: boolean;
}

/** Frases que o Whisper costuma "alucinar" em áudio sem fala. */
const HALLUCINATIONS = [
  /amara\.org/i,
  /legendas? (?:pela|por|feitas)/i,
  /inscreva-se/i,
  /obrigad[oa] por assistir/i,
];

/**
 * Entrada de voz: microfone (AudioRecorder) -> validação do áudio -> STT.
 * Não conhece o domínio da Celeste: só devolve texto.
 */
export class SpeechInputService {
  private options: SpeechInputOptions;

  constructor(
    private recorder: AudioRecorder,
    private sttProvider: SpeechToTextProvider,
    private eventBus: EventBus,
    options: Partial<SpeechInputOptions> = {}
  ) {
    this.options = {
      minDurationMs: Config.voiceMinRecordingMs,
      silenceThreshold: Config.voiceSilenceThreshold,
      keepAudioFiles: Config.keepAudioFiles,
      ...options,
    };
  }

  isRecording(): boolean {
    return this.recorder.isRecording();
  }

  async startRecording(): Promise<void> {
    if (this.recorder.isRecording()) {
      throw new CelesteError('ALREADY_RECORDING');
    }
    try {
      await this.recorder.start();
    } catch (error) {
      throw this.asMicError(error);
    }
    await this.eventBus.emit('VOICE_INPUT_STARTED');
  }

  /** Finaliza a gravação e valida o áudio (vazio/curto/silencioso). */
  async stopRecording(): Promise<CapturedAudio> {
    if (!this.recorder.isRecording()) {
      throw new CelesteError('NOT_RECORDING');
    }

    let audioPath: string;
    try {
      audioPath = await this.recorder.stop();
    } catch (error) {
      throw this.asMicError(error);
    }

    try {
      const audio = this.inspect(audioPath);
      await this.eventBus.emit('VOICE_INPUT_RECEIVED', {
        durationMs: Math.round(audio.durationMs),
      });
      return audio;
    } catch (error) {
      this.discard(audioPath);
      throw error;
    }
  }

  /** Transcreve e sempre apaga o arquivo temporário. */
  async transcribe(audio: CapturedAudio): Promise<string> {
    try {
      let text: string;
      try {
        text = await this.sttProvider.transcribe(audio.path);
      } catch (error) {
        throw error instanceof CelesteError
          ? error
          : new CelesteError('STT_UNAVAILABLE', String(error));
      }

      const transcription = this.cleanTranscription(text);
      if (!transcription) {
        throw new CelesteError('EMPTY_TRANSCRIPTION', `Raw transcription: "${text}"`);
      }

      await this.eventBus.emit('VOICE_TRANSCRIBED', { transcription });
      return transcription;
    } finally {
      this.discard(audio.path);
    }
  }

  async cancel(): Promise<void> {
    await this.recorder.cancel();
  }

  discard(audioPath: string): void {
    if (this.options.keepAudioFiles) {
      return;
    }
    try {
      if (fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }
    } catch (error) {
      Logger.warn('Could not delete temporary audio', { audioPath, error: String(error) });
    }
  }

  private inspect(audioPath: string): CapturedAudio {
    if (!fs.existsSync(audioPath)) {
      throw new CelesteError('EMPTY_AUDIO', 'Audio file not found');
    }
    const buffer = fs.readFileSync(audioPath);
    if (buffer.length <= 44) {
      throw new CelesteError('EMPTY_AUDIO', `Audio file has ${buffer.length} bytes`);
    }

    const wav = parseWav(buffer);
    if (!wav) {
      // Formato desconhecido: deixa o STT decidir.
      return { path: audioPath, durationMs: NaN, peak: NaN };
    }

    const durationMs = (wav.dataLength / wav.byteRate) * 1000;
    if (durationMs < this.options.minDurationMs) {
      throw new CelesteError('EMPTY_AUDIO', `Recording too short (${Math.round(durationMs)} ms)`);
    }

    const peak = wav.bitsPerSample === 16 ? peak16(buffer, wav.dataOffset, wav.dataLength) : NaN;
    if (peak < this.options.silenceThreshold) {
      throw new CelesteError('SILENT_AUDIO', `Peak amplitude ${peak}`);
    }

    Logger.debug('Audio captured', { durationMs: Math.round(durationMs), peak });
    return { path: audioPath, durationMs, peak };
  }

  private cleanTranscription(text: string): string {
    const trimmed = (text || '').trim();
    if (!/[\p{L}\p{N}]/u.test(trimmed)) {
      return '';
    }
    if (HALLUCINATIONS.some((pattern) => pattern.test(trimmed)) || isRepetitionLoop(trimmed)) {
      Logger.debug('Discarding hallucinated transcription', { text: trimmed });
      return '';
    }
    return trimmed;
  }

  private asMicError(error: unknown): CelesteError {
    if (error instanceof CelesteError) {
      return error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    const code = /permiss|denied|negad|access/i.test(detail) ? 'MIC_PERMISSION_DENIED' : 'MIC_UNAVAILABLE';
    return new CelesteError(code, detail);
  }
}

/** "O que é isso? O que é isso? O que é isso?" — laço típico do Whisper em áudio ruim. */
function isRepetitionLoop(text: string): boolean {
  const sentences = text
    .split(/[.!?…]+/)
    .map((sentence) => sentence.trim().toLowerCase())
    .filter(Boolean);
  return sentences.length >= 3 && new Set(sentences).size === 1;
}

interface WavInfo {
  byteRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
}

function parseWav(buffer: Buffer): WavInfo | null {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let offset = 12;
  let byteRate = 0;
  let bitsPerSample = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(body + 8);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (!byteRate) {
        return null;
      }
      return {
        byteRate,
        bitsPerSample,
        dataOffset: body,
        dataLength: Math.min(size, buffer.length - body),
      };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

function peak16(buffer: Buffer, offset: number, length: number): number {
  let peak = 0;
  const end = offset + length - (length % 2);
  for (let i = offset; i < end; i += 2) {
    const sample = Math.abs(buffer.readInt16LE(i));
    if (sample > peak) {
      peak = sample;
    }
  }
  return peak;
}
