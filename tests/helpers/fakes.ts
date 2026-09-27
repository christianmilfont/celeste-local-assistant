import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AIProvider,
  AudioRecorder,
  MessagingAdapter,
  SpeechToTextProvider,
  TextToSpeechProvider,
} from '../../src/core/types/adapters';
import { ConversationContext, IncomingMessage } from '../../src/core/types';

const TMP_DIR = path.join(os.tmpdir(), 'celeste-tests');

/** Gera um WAV PCM 16 bits mono 16 kHz. amplitude 0 = silêncio. */
export function makeWav(durationMs: number, amplitude = 8000): Buffer {
  const sampleRate = 16000;
  const samples = Math.round((sampleRate * durationMs) / 1000);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    data.writeInt16LE(value, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byteRate
  header.writeUInt16LE(2, 32); // blockAlign
  header.writeUInt16LE(16, 34); // bitsPerSample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Microfone falso: grava o WAV configurado em um arquivo temporário. */
export class FakeRecorder implements AudioRecorder {
  nextAudio: Buffer = makeWav(1500);
  startError?: Error;
  stopError?: Error;
  recording = false;
  available = true;
  startCalls = 0;
  cancelCalls = 0;
  createdFiles: string[] = [];

  async start(): Promise<void> {
    this.startCalls++;
    if (this.startError) {
      throw this.startError;
    }
    this.recording = true;
  }

  async stop(): Promise<string> {
    if (this.stopError) {
      this.recording = false;
      throw this.stopError;
    }
    this.recording = false;
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const file = path.join(TMP_DIR, `rec_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
    fs.writeFileSync(file, this.nextAudio);
    this.createdFiles.push(file);
    return file;
  }

  async cancel(): Promise<void> {
    this.cancelCalls++;
    this.recording = false;
  }

  isRecording(): boolean {
    return this.recording;
  }

  isAvailable(): boolean {
    return this.available;
  }
}

/** Whisper falso: devolve as transcrições enfileiradas. */
export class FakeSTT implements SpeechToTextProvider {
  transcripts: string[] = [];
  error?: Error;
  transcribedPaths: string[] = [];

  queue(...texts: string[]): this {
    this.transcripts.push(...texts);
    return this;
  }

  async transcribe(audioPath: string): Promise<string> {
    this.transcribedPaths.push(audioPath);
    if (this.error) {
      throw this.error;
    }
    return this.transcripts.shift() ?? '';
  }

  isAvailable(): boolean {
    return true;
  }
}

/** TTS falso: registra tudo o que seria falado. */
export class FakeTTS implements TextToSpeechProvider {
  spoken: string[] = [];
  fail = false;
  stopCalls = 0;

  async speak(text: string): Promise<void> {
    if (this.fail) {
      throw new Error('TTS offline');
    }
    this.spoken.push(text);
  }

  stop(): void {
    this.stopCalls++;
  }

  isAvailable(): boolean {
    return !this.fail;
  }

  last(): string | undefined {
    return this.spoken[this.spoken.length - 1];
  }
}

/** Ollama falso. */
export class FakeAI implements AIProvider {
  available = true;
  intentResult: any = { intent: 'UNKNOWN', confidence: 0 };
  replyText?: string;
  generateCalls: string[] = [];
  intentCalls: string[] = [];

  async generateResponse(prompt: string, _context?: ConversationContext): Promise<string> {
    this.generateCalls.push(prompt);
    if (!this.available) {
      throw new Error('Ollama offline');
    }
    return this.replyText ?? prompt;
  }

  async parseIntent(transcription: string): Promise<any> {
    this.intentCalls.push(transcription);
    if (!this.available) {
      throw new Error('Ollama offline');
    }
    return this.intentResult;
  }

  isAvailable(): boolean {
    return this.available;
  }
}

/** WhatsApp falso: permite simular mensagens recebidas e inspecionar os envios. */
export class FakeMessaging implements MessagingAdapter {
  connected = true;
  sent: Array<{ chatId: string; text: string }> = [];
  sendError?: Error;
  private callback?: (message: IncomingMessage) => Promise<void>;

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(callback: (message: IncomingMessage) => Promise<void>): void {
    this.callback = callback;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (this.sendError) {
      throw this.sendError;
    }
    this.sent.push({ chatId, text });
  }

  async receive(message: IncomingMessage): Promise<void> {
    await this.callback?.(message);
  }
}

let messageCounter = 0;

export function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  messageCounter++;
  return {
    id: `msg-${messageCounter}`,
    chatId: '5585999990000@s.whatsapp.net',
    senderId: '5585999990000@s.whatsapp.net',
    senderName: 'João',
    text: 'Você conseguiu terminar o projeto?',
    timestamp: new Date(),
    isGroup: false,
    ...overrides,
  };
}

/** Banco em memória mínimo para o MessageService. */
export function fakeDatabase(): any {
  const statement = { get: () => undefined, run: () => undefined };
  return { getDatabase: () => ({ prepare: () => statement }) };
}
