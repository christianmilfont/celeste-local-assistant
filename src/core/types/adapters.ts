import { IncomingMessage, ConversationContext } from './index';

export type { IncomingMessage, ConversationContext };

export interface MessagingAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  onMessage(callback: (message: IncomingMessage) => Promise<void>): void;
  sendMessage(chatId: string, text: string): Promise<void>;
}

export interface AIProvider {
  generateResponse(
    prompt: string,
    context?: ConversationContext
  ): Promise<string>;
  parseIntent(transcription: string, context?: ConversationContext): Promise<any>;
  isAvailable(): boolean;
  /** Verifica ativamente se o provider está acessível e atualiza isAvailable(). */
  checkAvailability?(): Promise<boolean>;
  /** Carrega o modelo em segundo plano para o primeiro comando não esperar. */
  warmUp?(): Promise<void>;
}

export interface SpeechToTextProvider {
  transcribe(audioPath: string): Promise<string>;
  isAvailable(): boolean;
  checkAvailability?(): Promise<boolean>;
  /** Pré-carrega o modelo para que o primeiro comando de voz seja rápido. */
  warmUp?(): Promise<void>;
  /** Libera processos/recursos (ex.: worker do Whisper). */
  dispose?(): void;
}

export interface SpeakHooks {
  /** Chamado quando o áudio realmente começa (após a inicialização do sintetizador). */
  onStart?: () => void;
}

export interface TextToSpeechProvider {
  speak(text: string, hooks?: SpeakHooks): Promise<void>;
  /** true se o provider chama hooks.onStart; caso contrário o início é assumido imediatamente. */
  readonly notifiesStart?: boolean;
  isAvailable(): boolean;
  checkAvailability?(): Promise<boolean>;
  /** Interrompe a fala em andamento, se houver. */
  stop?(): void;
}

/**
 * Captura de áudio do microfone (push-to-talk).
 * start() inicia a gravação; stop() finaliza e devolve o caminho do WAV gerado.
 */
export interface AudioRecorder {
  start(): Promise<void>;
  stop(): Promise<string>;
  cancel(): Promise<void>;
  isRecording(): boolean;
  isAvailable(): boolean;
  checkAvailability?(): Promise<boolean>;
  dispose?(): void;
}
