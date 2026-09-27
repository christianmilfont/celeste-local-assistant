import { IncomingMessage } from '../core/types';
import { MessagingAdapter } from '../core/types/adapters';
import { EventBus } from '../core/EventBus';
import { StateMachine } from '../core/StateMachine';
import { Logger } from '../infrastructure/logging/Logger';
import { CelesteDatabase } from '../infrastructure/storage/Database';
import { nameMatches } from './nlu/text';

const MAX_RECENT_MESSAGES = 50;

export class MessageService {
  /** Mensagens recebidas nesta sessão (mais recente por último). */
  private recentMessages: IncomingMessage[] = [];
  private unreadIds = new Set<string>();
  /** Mensagem sobre a qual a conversa está acontecendo ("responde que..."). */
  private focusedMessageId?: string;

  constructor(
    private messagingAdapter: MessagingAdapter,
    private eventBus: EventBus,
    private stateMachine: StateMachine,
    private database: CelesteDatabase
  ) {}

  async handleIncomingMessage(message: IncomingMessage): Promise<void> {
    try {
      Logger.info('Message received', {
        from: message.senderName,
        text: message.text.substring(0, 50),
      });

      this.remember(message);

      await this.eventBus.emit('MESSAGE_RECEIVED', message);

      this.stateMachine.setPendingMessage(message);

      // Se a Celeste estiver ocupada (ex.: aguardando confirmação de outra resposta),
      // a mensagem é registrada sem interromper o fluxo atual.
      if (this.stateMachine.getCurrentState() === 'IDLE') {
        this.stateMachine.transition('MESSAGE_RECEIVED');
        this.stateMachine.transition('ANNOUNCING_MESSAGE');
      }

      await this.saveMessage(message);
    } catch (error) {
      Logger.error('Error handling incoming message', error);
      await this.eventBus.emit('ERROR', { error });
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      Logger.info('Sending message', { chatId, textLength: text.length });

      await this.messagingAdapter.sendMessage(chatId, text);

      await this.eventBus.emit('MESSAGE_SENT', { chatId, text });

      this.stateMachine.transition('COMPLETED');
      this.stateMachine.clearPendingData();
      this.stateMachine.transition('IDLE');
    } catch (error) {
      Logger.error('Error sending message', error);
      await this.eventBus.emit('ERROR', { error });
      this.stateMachine.transition('ERROR');
      throw error;
    }
  }

  isConnected(): boolean {
    return this.messagingAdapter.isConnected();
  }

  getRecentMessages(): IncomingMessage[] {
    return [...this.recentMessages];
  }

  getLatestMessage(): IncomingMessage | undefined {
    return this.recentMessages[this.recentMessages.length - 1];
  }

  getUnreadMessages(): IncomingMessage[] {
    return this.recentMessages.filter((message) => this.unreadIds.has(message.id));
  }

  markAsRead(messageId: string): void {
    this.unreadIds.delete(messageId);
  }

  getFocusedMessage(): IncomingMessage | undefined {
    return this.recentMessages.find((message) => message.id === this.focusedMessageId);
  }

  setFocusedMessage(message: IncomingMessage): void {
    this.focusedMessageId = message.id;
  }

  /** Mensagem mais recente de um contato/grupo, comparando nomes sem acento. */
  findLatestFrom(name: string): IncomingMessage | undefined {
    for (let i = this.recentMessages.length - 1; i >= 0; i--) {
      const message = this.recentMessages[i];
      if (nameMatches(message.senderName, name) || nameMatches(message.groupName, name)) {
        return message;
      }
    }
    return undefined;
  }

  /** Nome para falar/exibir de uma conversa, a partir das mensagens recebidas. */
  getDisplayName(chatId: string): string | undefined {
    const message = [...this.recentMessages].reverse().find((m) => m.chatId === chatId);
    if (!message) {
      return undefined;
    }
    return message.isGroup ? message.groupName || message.senderName : message.senderName;
  }

  private remember(message: IncomingMessage): void {
    this.recentMessages = this.recentMessages.filter((m) => m.id !== message.id);
    this.recentMessages.push(message);
    if (this.recentMessages.length > MAX_RECENT_MESSAGES) {
      const removed = this.recentMessages.shift();
      if (removed) {
        this.unreadIds.delete(removed.id);
      }
    }
    this.unreadIds.add(message.id);
    this.focusedMessageId = message.id;
  }

  private async saveMessage(message: IncomingMessage): Promise<void> {
    const db = this.database.getDatabase();

    const conversationId = message.chatId;
    const existingConversation = db
      .prepare('SELECT id FROM conversations WHERE chat_id = ?')
      .get(conversationId) as any;

    if (!existingConversation) {
      db.prepare(
        'INSERT INTO conversations (id, chat_id, is_group, group_name) VALUES (?, ?, ?, ?)'
      ).run(
        conversationId,
        message.chatId,
        message.isGroup ? 1 : 0,
        message.groupName || null
      );
    }

    db.prepare(
      'INSERT OR IGNORE INTO messages (id, conversation_id, sender_id, text, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      message.id,
      conversationId,
      message.senderId,
      message.text,
      message.timestamp.toISOString(),
      0
    );
  }
}
