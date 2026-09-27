import { TextToSpeechProvider } from '../core/types/adapters';
import { EventBus } from '../core/EventBus';
import { Logger } from '../infrastructure/logging/Logger';
import { IncomingMessage } from '../core/types';
import { describeMessage } from './nlu/messageFormat';

/**
 * Saída de voz da Celeste (TTS). A captura do microfone e a transcrição
 * ficam no SpeechInputService.
 */
export class VoiceService {
  constructor(
    private ttsProvider: TextToSpeechProvider,
    private eventBus: EventBus
  ) {}

  /**
   * Emite ASSISTANT_SPEECH (para o terminal exibir) e fala o texto.
   * TTS_STARTED/TTS_FINISHED delimitam o áudio (usados pelo avatar para mexer a boca).
   */
  async speak(text: string): Promise<void> {
    await this.eventBus.emit('ASSISTANT_SPEECH', { text });

    let started = false;
    const markStarted = () => {
      if (!started) {
        started = true;
        void this.eventBus.emit('TTS_STARTED', { text });
      }
    };
    if (!this.ttsProvider.notifiesStart) {
      markStarted();
    }

    try {
      Logger.debug('Speaking text', { textLength: text.length });
      await this.ttsProvider.speak(text, { onStart: markStarted });
    } catch (error) {
      Logger.error('Error speaking text', error);
      throw error;
    } finally {
      await this.eventBus.emit('TTS_FINISHED', { text, started });
    }
  }

  async announceMessage(message: IncomingMessage): Promise<string> {
    const announcement = describeMessage(message);
    await this.speak(announcement);
    return announcement;
  }

  stopSpeaking(): void {
    this.ttsProvider.stop?.();
  }
}
