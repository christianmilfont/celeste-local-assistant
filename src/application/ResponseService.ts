import { AIProvider } from '../core/types/adapters';
import { EventBus } from '../core/EventBus';
import { StateMachine } from '../core/StateMachine';
import { Logger } from '../infrastructure/logging/Logger';
import { IncomingMessage, MessageIntent } from '../core/types';
import { ConversationContext } from '../core/types/adapters';

export class ResponseService {
  constructor(
    private aiProvider: AIProvider,
    private eventBus: EventBus,
    private stateMachine: StateMachine
  ) {}

  async processVoiceInput(
    transcription: string,
    context?: IncomingMessage
  ): Promise<MessageIntent> {
    try {
      Logger.info('Processing voice input', { transcription });

      // Allow transition from ERROR state
      const currentState = this.stateMachine.getCurrentState();
      if (currentState === 'ERROR') {
        this.stateMachine.transition('IDLE');
      }

      this.stateMachine.transition('GENERATING_RESPONSE');

      const conversationContext: ConversationContext | undefined = context
        ? {
            conversationId: context.chatId,
            recentMessages: [context],
            currentMessage: context,
          }
        : undefined;

      const intent = await this.aiProvider.parseIntent(
        transcription,
        conversationContext
      );

      Logger.info('Intent detected', { intent: intent.intent });

      await this.eventBus.emit('COMMAND_DETECTED', intent);

      return intent;
    } catch (error) {
      Logger.error('Error processing voice input', error);
      await this.eventBus.emit('ERROR', { error });
      this.stateMachine.transition('ERROR');
      throw error;
    }
  }

  async generateResponse(
    userInstruction: string,
    context?: IncomingMessage
  ): Promise<string> {
    try {
      Logger.info('Generating response', { userInstruction });

      const conversationContext: ConversationContext | undefined = context
        ? {
            conversationId: context.chatId,
            recentMessages: [context],
            currentMessage: context,
          }
        : undefined;

      const response = await this.aiProvider.generateResponse(
        userInstruction,
        conversationContext
      );

      this.stateMachine.setPendingResponse(response);

      await this.eventBus.emit('RESPONSE_GENERATED', { response });

      return response;
    } catch (error) {
      Logger.error('Error generating response', error);
      await this.eventBus.emit('ERROR', { error });
      this.stateMachine.transition('ERROR');
      throw error;
    }
  }

  async requestConfirmation(response: string, senderName?: string): Promise<void> {
    const confirmationText = senderName
      ? `Vou responder ao ${senderName}: ${response}. Posso enviar?`
      : `Vou responder: ${response}. Posso enviar?`;

    Logger.info('Requesting confirmation');

    this.stateMachine.transition('WAITING_CONFIRMATION');

    await this.eventBus.emit('RESPONSE_CONFIRMATION_REQUIRED', {
      response,
      confirmationText,
    });
  }

  async handleConfirmation(
    confirmed: boolean
  ): Promise<{ approved: boolean; response?: string }> {
    try {
      if (confirmed) {
        Logger.info('Response confirmed');
        await this.eventBus.emit('RESPONSE_CONFIRMED');
        return {
          approved: true,
          response: this.stateMachine.getPendingResponse(),
        };
      } else {
        Logger.info('Response cancelled');
        await this.eventBus.emit('RESPONSE_CANCELLED');
        this.stateMachine.clearPendingData();
        this.stateMachine.transition('IDLE');
        return { approved: false };
      }
    } catch (error) {
      Logger.error('Error handling confirmation', error);
      await this.eventBus.emit('ERROR', { error });
      this.stateMachine.transition('ERROR');
      throw error;
    }
  }

  isConfirmationCommand(text: string): boolean {
    const positiveCommands = ['pode', 'sim', 'envia', 'enviar', 'ok', 'confirmar'];
    const negativeCommands = ['não', 'cancelar', 'espera', 'parar', 'negar'];

    const lowerText = text.toLowerCase().trim();

    return (
      positiveCommands.some((cmd) => lowerText.includes(cmd)) ||
      negativeCommands.some((cmd) => lowerText.includes(cmd))
    );
  }

  parseConfirmation(text: string): boolean {
    const positiveCommands = ['pode', 'sim', 'envia', 'enviar', 'ok', 'confirmar'];
    const negativeCommands = ['não', 'cancelar', 'espera', 'parar', 'negar'];

    const lowerText = text.toLowerCase().trim();

    if (positiveCommands.some((cmd) => lowerText.includes(cmd))) {
      return true;
    }

    if (negativeCommands.some((cmd) => lowerText.includes(cmd))) {
      return false;
    }

    return false;
  }
}
