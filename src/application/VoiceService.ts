import { SpeechToTextProvider, TextToSpeechProvider } from '../core/types/adapters';
import { EventBus } from '../core/EventBus';
import { StateMachine } from '../core/StateMachine';
import { Logger } from '../infrastructure/logging/Logger';
import { IncomingMessage } from '../core/types';
import * as fs from 'fs';
import * as path from 'path';
import { Config } from '../infrastructure/config/Config';

export class VoiceService {
  private isRecording: boolean = false;
  private recordingProcess: any = null;

  constructor(
    private sttProvider: SpeechToTextProvider,
    private ttsProvider: TextToSpeechProvider,
    private eventBus: EventBus,
    private stateMachine: StateMachine
  ) {}

  async speak(text: string): Promise<void> {
    try {
      Logger.debug('Speaking text', { textLength: text.length });
      await this.ttsProvider.speak(text);
    } catch (error) {
      Logger.error('Error speaking text', error);
      throw error;
    }
  }

  async announceMessage(message: IncomingMessage): Promise<void> {
    let announcement: string;

    if (message.isGroup) {
      announcement = `Mensagem no grupo ${message.groupName || 'desconhecido'}, enviada por ${message.senderName || 'desconhecido'}: ${message.text}`;
    } else {
      announcement = `Você recebeu uma mensagem de ${message.senderName || 'desconhecido'}: ${message.text}`;
    }

    await this.speak(announcement);
  }

  async startListening(): Promise<void> {
    try {
      if (this.isRecording) {
        Logger.warn('Already recording');
        return;
      }

      Logger.info('Starting voice input');
      this.isRecording = true;

      await this.eventBus.emit('VOICE_INPUT_STARTED');

      this.stateMachine.transition('LISTENING');

      const audioPath = await this.recordAudio();

      this.isRecording = false;
      this.stateMachine.transition('PROCESSING_VOICE');

      await this.eventBus.emit('VOICE_INPUT_RECEIVED', { audioPath });

      const transcription = await this.sttProvider.transcribe(audioPath);

      Logger.info('Voice transcribed', { transcription });

      await this.eventBus.emit('VOICE_TRANSCRIBED', { transcription });

      if (!Config.keepAudioFiles && fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }
    } catch (error) {
      Logger.error('Error in voice input', error);
      this.isRecording = false;
      await this.eventBus.emit('ERROR', { error });
      this.stateMachine.transition('ERROR');
    }
  }

  private async recordAudio(): Promise<string> {
    const tempDir = Config.audioTempDir;
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const audioPath = path.join(tempDir, `recording_${Date.now()}.wav`);

    Logger.info('Recording audio for 5 seconds...');
    Logger.warn('Note: For MVP, this is a placeholder. Install audio recording tools for actual STT.');

    await new Promise((resolve) => setTimeout(resolve, 5000));

    fs.writeFileSync(audioPath, Buffer.alloc(0));

    return audioPath;
  }

  stopListening(): void {
    if (this.recordingProcess) {
      this.recordingProcess.kill();
      this.recordingProcess = null;
    }
    this.isRecording = false;
  }

  isListening(): boolean {
    return this.isRecording;
  }
}
