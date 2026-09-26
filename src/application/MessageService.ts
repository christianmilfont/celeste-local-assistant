import { IncomingMessage } from '../core/types';
import { MessagingAdapter } from '../core/types/adapters';
import { EventBus } from '../core/EventBus';
import { StateMachine } from '../core/StateMachine';
import { Logger } from '../infrastructure/logging/Logger';
import { CelesteDatabase } from '../infrastructure/storage/Database';

export class MessageService {
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

      await this.eventBus.emit('MESSAGE_RECEIVED', message);

      this.stateMachine.setPendingMessage(message);
      this.stateMachine.transition('MESSAGE_RECEIVED');

      await this.saveMessage(message);

      this.stateMachine.transition('ANNOUNCING_MESSAGE');
    } catch (error) {
      Logger.error('Error handling incoming message', error);
      await this.eventBus.emit('ERROR', { error });
      this.stateMachine.transition('ERROR');
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
    }
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
      'INSERT INTO messages (id, conversation_id, sender_id, text, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?)'
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
