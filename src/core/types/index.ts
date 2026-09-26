export interface IncomingMessage {
  id: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: Date;
  isGroup: boolean;
  groupName?: string;
}

export interface ConversationContext {
  conversationId: string;
  recentMessages: IncomingMessage[];
  currentMessage?: IncomingMessage;
}

export interface MessageIntent {
  intent: IntentType;
  targetMessageId?: string;
  response?: string;
  confidence: number;
}

export type IntentType =
  | 'REPLY_TO_MESSAGE'
  | 'CANCEL'
  | 'CONFIRM'
  | 'DENY'
  | 'REPEAT'
  | 'HELP'
  | 'UNKNOWN';

export interface AssistantState {
  currentState: StateType;
  pendingMessage?: IncomingMessage;
  pendingResponse?: string;
  targetChatId?: string;
}

export type StateType =
  | 'IDLE'
  | 'MESSAGE_RECEIVED'
  | 'ANNOUNCING_MESSAGE'
  | 'LISTENING'
  | 'PROCESSING_VOICE'
  | 'GENERATING_RESPONSE'
  | 'WAITING_CONFIRMATION'
  | 'SENDING_MESSAGE'
  | 'COMPLETED'
  | 'ERROR';

export interface AssistantEvent {
  type: EventType;
  data?: any;
  timestamp: Date;
}

export type EventType =
  | 'MESSAGE_RECEIVED'
  | 'MESSAGE_READ'
  | 'VOICE_INPUT_STARTED'
  | 'VOICE_INPUT_RECEIVED'
  | 'VOICE_TRANSCRIBED'
  | 'COMMAND_DETECTED'
  | 'RESPONSE_GENERATED'
  | 'RESPONSE_CONFIRMATION_REQUIRED'
  | 'RESPONSE_CONFIRMED'
  | 'RESPONSE_CANCELLED'
  | 'MESSAGE_SENT'
  | 'ERROR'
  | 'STATE_CHANGED';
