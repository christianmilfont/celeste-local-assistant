import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  BaileysEventMap,
} from '@whiskeysockets/baileys';
import { MessagingAdapter } from '../../core/types/adapters';
import { ContactRecord, IncomingMessage } from '../../core/types';
import { Config } from '../../infrastructure/config/Config';
import { Logger } from '../../infrastructure/logging/Logger';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

export class BaileysWhatsAppAdapter implements MessagingAdapter {
  private socket: WASocket | null = null;
  private messageCallback: ((message: IncomingMessage) => Promise<void>) | null =
    null;
  private connected: boolean = false;
  private contactsCallback: ((contacts: ContactRecord[]) => void) | null = null;

  async connect(): Promise<void> {
    try {
      Logger.info('Connecting to WhatsApp...');

      const sessionPath = Config.whatsappSessionPath;
      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

      this.socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'error' }),
        browser: ['Celeste Assistant', 'Chrome', '1.0.0'],
      });

      this.socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          Logger.info('QR Code received! Scan with WhatsApp:');
          qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
          const shouldReconnect =
            (lastDisconnect?.error as any)?.output?.statusCode !==
            DisconnectReason.loggedOut;

          const error = lastDisconnect?.error as any;
          const isConflict = error?.reasonNode?.tag === 'conflict';

          if (isConflict) {
            Logger.error('Connection conflict detected. Please close WhatsApp Web or other connected devices.');
            this.connected = false;
            return;
          }

          Logger.info(
            `Connection closed. Reconnect: ${shouldReconnect}`
          );

          if (shouldReconnect) {
            this.connect();
          } else {
            this.connected = false;
            Logger.error('Connection logged out, please re-scan QR code');
          }
        } else if (connection === 'open') {
          this.connected = true;
          Logger.info('WhatsApp connection established');
        }
      });

      this.socket.ev.on('creds.update', saveCreds);

      // Contatos: agenda do celular (sincronização de estado), histórico e atualizações.
      this.socket.ev.on('contacts.upsert', (contacts) => this.emitContacts(contacts));
      this.socket.ev.on('contacts.update', (contacts) => this.emitContacts(contacts as any[]));
      this.socket.ev.on('messaging-history.set', ({ contacts }) => this.emitContacts(contacts || []));

      this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
          for (const message of messages) {
            const isStatusBroadcast = message.key.remoteJid === 'status@broadcast';
            if (!message.key.fromMe && message.message && !isStatusBroadcast) {
              await this.handleIncomingMessage(message);
            }
          }
        }
      });

      Logger.info('WhatsApp adapter initialized');
    } catch (error) {
      Logger.error('Failed to connect to WhatsApp', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
      this.connected = false;
      Logger.info('WhatsApp disconnected');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(callback: (message: IncomingMessage) => Promise<void>): void {
    this.messageCallback = callback;
  }

  onContacts(callback: (contacts: ContactRecord[]) => void): void {
    this.contactsCallback = callback;
  }

  /** Baixa de novo a coleção de estado que contém a agenda (nomes salvos no celular). */
  async syncContacts(): Promise<void> {
    if (!this.socket || !this.connected) {
      throw new Error('WhatsApp not connected');
    }
    await this.socket.resyncAppState(['critical_unblock_low'], true);
  }

  async lookupPhone(phone: string): Promise<string | undefined> {
    if (!this.socket || !this.connected) {
      return undefined;
    }
    const [result] = (await this.socket.onWhatsApp(phone)) || [];
    return result?.exists ? result.jid : undefined;
  }

  private emitContacts(contacts: Array<Partial<ContactRecord> & { id?: string }>): void {
    if (!this.contactsCallback || !contacts?.length) return;
    const records = contacts
      .filter((c): c is ContactRecord => typeof c.id === 'string')
      .map((c) => ({ id: c.id, name: c.name, notify: c.notify, phoneNumber: c.phoneNumber }));
    if (records.length) this.contactsCallback(records);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.socket || !this.connected) {
      throw new Error('WhatsApp not connected');
    }

    try {
      await this.socket.sendMessage(chatId, { text });
      Logger.info(`Message sent to ${chatId}`);
    } catch (error) {
      Logger.error('Failed to send message', error);
      throw error;
    }
  }

  private async handleIncomingMessage(
    baileysMessage: any
  ): Promise<void> {
    try {
      const message = this.convertToIncomingMessage(baileysMessage);

      // Quem manda mensagem também vira contato conhecido (com o nome do perfil).
      if (!message.isGroup && message.senderName) {
        this.emitContacts([{ id: message.chatId, notify: message.senderName }]);
      }

      // Reações, confirmações de leitura e mensagens de protocolo não têm texto.
      if (!message.text) {
        return;
      }

      if (this.messageCallback) {
        await this.messageCallback(message);
      }
    } catch (error) {
      Logger.error('Error handling incoming message', error);
    }
  }

  private convertToIncomingMessage(baileysMessage: any): IncomingMessage {
    const key = baileysMessage.key;
    const messageContent = baileysMessage.message;
    const text = this.extractText(messageContent);

    const chatId = key.remoteJid;
    const senderId = key.participant || key.remoteJid;
    const isGroup = chatId?.includes('@g.us') || false;

    let senderName: string | undefined;
    let groupName: string | undefined;

    if (baileysMessage.pushName) {
      senderName = baileysMessage.pushName;
    }

    if (isGroup && baileysMessage.pushName) {
      groupName = baileysMessage.pushName;
    }

    return {
      id: key.id || '',
      chatId: chatId || '',
      senderId: senderId || '',
      senderName,
      text,
      // messageTimestamp vem em segundos (number ou Long).
      timestamp: baileysMessage.messageTimestamp
        ? new Date(Number(baileysMessage.messageTimestamp) * 1000)
        : new Date(),
      isGroup,
      groupName,
    };
  }

  private extractText(content: any): string {
    if (!content) {
      return '';
    }
    const text =
      content.conversation ||
      content.extendedTextMessage?.text ||
      content.imageMessage?.caption ||
      content.videoMessage?.caption ||
      content.documentMessage?.caption;
    if (text) {
      return text;
    }
    if (content.imageMessage) return '[imagem]';
    if (content.videoMessage) return '[vídeo]';
    if (content.audioMessage) return '[mensagem de áudio]';
    if (content.documentMessage) return '[documento]';
    if (content.stickerMessage) return '[figurinha]';
    if (content.locationMessage) return '[localização]';
    if (content.contactMessage) return '[contato]';
    return '';
  }
}
