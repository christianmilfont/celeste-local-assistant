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
  /** Nome do contato citado no comando (ex.: "João" em "responde para o João..."). */
  target?: string;
  response?: string;
  confidence: number;
  /** Indica se a intenção veio das regras determinísticas ou do LLM. */
  source?: 'rule' | 'ai';
  /** READ_LAST_MESSAGE: reler a mensagem em foco ("leia novamente"). */
  again?: boolean;
}

export type IntentType =
  | 'STATUS'
  | 'HELP'
  | 'STOP'
  | 'READ_LAST_MESSAGE'
  | 'LIST_MESSAGES'
  | 'REPLY_TO_MESSAGE'
  | 'CANCEL'
  | 'CONFIRM'
  | 'DENY'
  | 'REPEAT'
  | 'UNKNOWN';

/** Origem de um comando: todas convergem para o mesmo CommandProcessor. */
export type InputSource = 'cli' | 'voice';

export interface CommandResult {
  intent: IntentType;
  /** Texto que a Celeste deve falar/exibir. */
  reply: string;
  /** true quando o usuário pediu para encerrar a Celeste. */
  shouldStop?: boolean;
}

/** Estados do fluxo de interação por voz (push-to-talk). */
export type VoicePipelineState =
  | 'IDLE'
  | 'WAITING_FOR_VOICE'
  | 'RECORDING'
  | 'PROCESSING_AUDIO'
  | 'TRANSCRIBING'
  | 'COMMAND_PROCESSING'
  | 'ACTION'
  | 'TTS_RESPONSE'
  | 'ERROR';

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
  | 'STATE_CHANGED'
  | 'VOICE_STATE_CHANGED'
  | 'ASSISTANT_SPEECH';
