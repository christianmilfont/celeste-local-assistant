import { AIProvider } from '../core/types/adapters';
import { EventBus } from '../core/EventBus';
import { StateMachine } from '../core/StateMachine';
import { Logger } from '../infrastructure/logging/Logger';
import { Config } from '../infrastructure/config/Config';
import { IncomingMessage } from '../core/types';
import { ConversationContext } from '../core/types/adapters';
import { ConfirmationService } from './ConfirmationService';
import { toSentence } from './nlu/text';

export class ResponseService {
  constructor(
    private aiProvider: AIProvider,
    private eventBus: EventBus,
    private stateMachine: StateMachine,
    private confirmationService: ConfirmationService = new ConfirmationService()
  ) {}

  async generateResponse(
    userInstruction: string,
    context?: IncomingMessage
  ): Promise<string> {
    try {
      Logger.info('Generating response', { userInstruction });

      const response = await this.aiProvider.generateResponse(
        userInstruction,
        this.toConversationContext(context)
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

  /**
   * Redige o texto a ser enviado a partir do que o usuário ditou.
   * Usa o LLM quando habilitado e disponível; caso contrário (ou em falha),
   * usa o próprio texto ditado. Nunca envia nada: só prepara o rascunho.
   */
  async composeReply(dictated: string, context?: IncomingMessage): Promise<string> {
    const literal = toSentence(dictated);

    if (!Config.aiRewriteReplies || !this.aiProvider.isAvailable()) {
      return literal;
    }

    try {
      const generated = await this.aiProvider.generateResponse(
        dictated,
        this.toConversationContext(context)
      );
      const cleaned = this.sanitizeGenerated(generated);

      // Resposta vazia ou longa demais indica que o modelo fugiu da instrução.
      if (!cleaned || cleaned.length > Math.max(200, dictated.length * 4)) {
        Logger.warn('Discarding AI reply, using dictated text', { generated });
        return literal;
      }
      return cleaned;
    } catch (error) {
      Logger.warn('AI reply generation failed, using dictated text', { error: String(error) });
      return literal;
    }
  }

  async requestConfirmation(
    response: string,
    senderName?: string,
    kind: 'resposta' | 'mensagem' = 'resposta'
  ): Promise<string> {
    const confirmationText = senderName
      ? `Preparei esta ${kind} para ${senderName}: "${response}". Posso enviar?`
      : `Preparei esta ${kind}: "${response}". Posso enviar?`;

    Logger.info('Requesting confirmation');

    this.stateMachine.setPendingResponse(response);
    this.stateMachine.transition('WAITING_CONFIRMATION');

    await this.eventBus.emit('RESPONSE_CONFIRMATION_REQUIRED', {
      response,
      confirmationText,
    });

    return confirmationText;
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
    return this.confirmationService.parse(text) !== 'UNKNOWN';
  }

  parseConfirmation(text: string): boolean {
    return this.confirmationService.parse(text) === 'CONFIRM';
  }

  private sanitizeGenerated(text: string): string {
    const firstParagraph = text.trim().split(/\n\s*\n/)[0];
    return firstParagraph
      .replace(/^(?:resposta|mensagem|mensagem a enviar|texto)\s*:\s*/i, '')
      .replace(/^["'“]+|["'”]+$/g, '')
      .trim();
  }

  private toConversationContext(context?: IncomingMessage): ConversationContext | undefined {
    return context
      ? {
          conversationId: context.chatId,
          recentMessages: [context],
          currentMessage: context,
        }
      : undefined;
  }
}
