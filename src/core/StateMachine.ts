import { StateType, IncomingMessage } from './types';

type StateTransitionCallback = (from: StateType, to: StateType) => void;

export class StateMachine {
  private currentState: StateType = 'IDLE';
  private transitionCallbacks: Set<StateTransitionCallback> = new Set();
  private pendingMessage?: IncomingMessage;
  private pendingResponse?: string;
  private targetChatId?: string;

  constructor() {
    this.currentState = 'IDLE';
  }

  getCurrentState(): StateType {
    return this.currentState;
  }

  setPendingMessage(message: IncomingMessage): void {
    this.pendingMessage = message;
  }

  getPendingMessage(): IncomingMessage | undefined {
    return this.pendingMessage;
  }

  setPendingResponse(response: string): void {
    this.pendingResponse = response;
  }

  getPendingResponse(): string | undefined {
    return this.pendingResponse;
  }

  setTargetChatId(chatId: string): void {
    this.targetChatId = chatId;
  }

  getTargetChatId(): string | undefined {
    return this.targetChatId;
  }

  clearPendingData(): void {
    this.pendingMessage = undefined;
    this.pendingResponse = undefined;
    this.targetChatId = undefined;
  }

  transition(newState: StateType): boolean {
    const oldState = this.currentState;

    if (!this.isValidTransition(oldState, newState)) {
      throw new Error(
        `Invalid state transition from ${oldState} to ${newState}`
      );
    }

    this.currentState = newState;
    this.notifyTransition(oldState, newState);
    return true;
  }

  private isValidTransition(from: StateType, to: StateType): boolean {
    const validTransitions: Record<StateType, StateType[]> = {
      IDLE: ['MESSAGE_RECEIVED', 'LISTENING', 'GENERATING_RESPONSE', 'ERROR'],
      MESSAGE_RECEIVED: ['ANNOUNCING_MESSAGE', 'ERROR'],
      ANNOUNCING_MESSAGE: ['IDLE', 'LISTENING', 'GENERATING_RESPONSE', 'ERROR'],
      LISTENING: ['PROCESSING_VOICE', 'IDLE', 'ERROR'],
      PROCESSING_VOICE: ['GENERATING_RESPONSE', 'IDLE', 'ERROR'],
      GENERATING_RESPONSE: ['WAITING_CONFIRMATION', 'IDLE', 'ERROR'],
      WAITING_CONFIRMATION: ['SENDING_MESSAGE', 'IDLE', 'ERROR'],
      SENDING_MESSAGE: ['COMPLETED', 'ERROR'],
      COMPLETED: ['IDLE'],
      ERROR: ['IDLE'],
    };

    return validTransitions[from]?.includes(to) ?? false;
  }

  onTransition(callback: StateTransitionCallback): void {
    this.transitionCallbacks.add(callback);
  }

  private notifyTransition(from: StateType, to: StateType): void {
    this.transitionCallbacks.forEach((callback) => callback(from, to));
  }

  reset(): void {
    this.currentState = 'IDLE';
    this.clearPendingData();
  }
}
