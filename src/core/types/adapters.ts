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
}

export interface SpeechToTextProvider {
  transcribe(audioPath: string): Promise<string>;
  isAvailable(): boolean;
}

export interface TextToSpeechProvider {
  speak(text: string): Promise<void>;
  isAvailable(): boolean;
}
