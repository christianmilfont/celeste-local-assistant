import { AIProvider } from '../core/types/adapters';
import {
  CommandResult,
  ConversationContext,
  IncomingMessage,
  InputSource,
  IntentType,
  MessageIntent,
} from '../core/types';
import { EventBus } from '../core/EventBus';
import { StateMachine } from '../core/StateMachine';
import { CelesteError } from '../core/errors';
import { Logger } from '../infrastructure/logging/Logger';
import { MessageService } from './MessageService';
import { ResponseService } from './ResponseService';
import { IntentClassifier } from './IntentClassifier';
import { ConfirmationService } from './ConfirmationService';
import { describeMessage, recipientLabel, senderLabel } from './nlu/messageFormat';
import { capitalizeFirst, countInWords, joinList } from './nlu/text';

export interface StatusSnapshot {
  whatsapp: boolean;
  ai: boolean;
  stt: boolean;
  tts: boolean;
  mic?: boolean;
  state: string;
}

export interface CommandProcessorDeps {
  messageService: MessageService;
  responseService: ResponseService;
  stateMachine: StateMachine;
  eventBus: EventBus;
  intentClassifier: IntentClassifier;
  confirmationService: ConfirmationService;
  aiProvider: AIProvider;
  /** Status atualizado dos serviços (usado pela intenção STATUS). */
  getStatus: () => Promise<StatusSnapshot>;
}

/** Notificado quando a intenção foi entendida e a ação vai ser executada. */
export type CommandStageListener = (stage: 'ACTION') => void;

/** Intenções que podem ser atendidas enquanto uma resposta aguarda confirmação. */
const ALLOWED_WHILE_CONFIRMING: IntentType[] = [
  'STATUS',
  'HELP',
  'STOP',
  'LIST_MESSAGES',
  'READ_LAST_MESSAGE',
  'REPEAT',
  'REPLY_TO_MESSAGE',
];

const HELP_TEXT =
  'Posso dizer o status do sistema, listar e ler suas mensagens e responder mensagens do WhatsApp, ' +
  'sempre pedindo confirmação antes de enviar. Experimente: "leia a última mensagem" ou ' +
  '"responde para o João dizendo que já vou verificar".';

/**
 * Ponto único de processamento de comandos. O CLI e a voz chegam aqui com
 * o mesmo texto; a origem é usada apenas para log.
 */
export class CommandProcessor {
  private lastSpoken?: string;

  constructor(private deps: CommandProcessorDeps) {}

  async processCommand(
    input: string,
    source: InputSource = 'cli',
    onStage?: CommandStageListener
  ): Promise<CommandResult> {
    const text = input.trim();
    Logger.info('Processing command', { source, text });

    let result: CommandResult;
    try {
      if (!text) {
        result = { intent: 'UNKNOWN', reply: 'Não recebi nenhum comando.' };
      } else {
        this.recoverFromError();
        result =
          this.deps.stateMachine.getCurrentState() === 'WAITING_CONFIRMATION'
            ? await this.handleWhileConfirming(text, source, onStage)
            : await this.handle(text, source, onStage);
      }
    } catch (error) {
      Logger.error('Error processing command', error);
      this.recoverFromError();
      result = { intent: 'UNKNOWN', reply: CelesteError.from(error).userMessage };
    }

    if (result.intent !== 'REPEAT') {
      this.lastSpoken = result.reply;
    }
    return result;
  }

  /** Registra algo falado fora de um comando (ex.: anúncio de mensagem) para o REPEAT. */
  rememberSpoken(text: string): void {
    this.lastSpoken = text;
  }

  private async handle(
    text: string,
    source: InputSource,
    onStage?: CommandStageListener
  ): Promise<CommandResult> {
    const intent = await this.deps.intentClassifier.classify(text, this.buildContext());
    await this.deps.eventBus.emit('COMMAND_DETECTED', { ...intent, input: source });
    onStage?.('ACTION');
    return this.execute(intent);
  }

  /**
   * Regra de segurança: com uma resposta pendente, só um "sim" inequívoco envia.
   * Frases ambíguas nunca confirmam; o LLM não é consultado aqui.
   */
  private async handleWhileConfirming(
    text: string,
    source: InputSource,
    onStage?: CommandStageListener
  ): Promise<CommandResult> {
    const decision = this.deps.confirmationService.parse(text);
    await this.deps.eventBus.emit('COMMAND_DETECTED', { intent: decision, source: 'rule', input: source });

    if (decision === 'CONFIRM') {
      onStage?.('ACTION');
      return this.confirmAndSend();
    }
    if (decision === 'DENY' || decision === 'CANCEL') {
      onStage?.('ACTION');
      await this.deps.responseService.handleConfirmation(false);
      return { intent: decision, reply: 'Tudo bem, não vou enviar a mensagem.' };
    }

    const intent = this.deps.intentClassifier.classifyDeterministic(text);
    if (intent && ALLOWED_WHILE_CONFIRMING.includes(intent.intent)) {
      onStage?.('ACTION');
      const result = await this.execute(intent);
      if (this.deps.stateMachine.getCurrentState() === 'WAITING_CONFIRMATION' && intent.intent !== 'REPLY_TO_MESSAGE') {
        result.reply += ` Ainda aguardo sua confirmação para enviar a resposta para ${this.pendingRecipient()}.`;
      }
      return result;
    }

    return {
      intent: 'UNKNOWN',
      reply: `Não entendi. Posso enviar a resposta para ${this.pendingRecipient()}? Diga "sim" para enviar ou "não" para cancelar.`,
    };
  }

  private async execute(intent: MessageIntent): Promise<CommandResult> {
    switch (intent.intent) {
      case 'STATUS':
        return { intent: 'STATUS', reply: await this.describeStatus() };
      case 'HELP':
        return { intent: 'HELP', reply: HELP_TEXT };
      case 'STOP':
        return this.stop(intent);
      case 'LIST_MESSAGES':
        return { intent: 'LIST_MESSAGES', reply: this.listMessages() };
      case 'READ_LAST_MESSAGE':
        return { intent: 'READ_LAST_MESSAGE', reply: this.readMessage(intent) };
      case 'REPLY_TO_MESSAGE':
        return { intent: 'REPLY_TO_MESSAGE', reply: await this.prepareReply(intent) };
      case 'CONFIRM':
        return { intent: 'CONFIRM', reply: 'Não há nenhuma resposta aguardando confirmação.' };
      case 'DENY':
        return { intent: 'DENY', reply: 'Tudo bem.' };
      case 'CANCEL':
        return { intent: 'CANCEL', reply: 'Não há nada para cancelar.' };
      case 'REPEAT':
        return { intent: 'REPEAT', reply: this.lastSpoken ?? 'Ainda não disse nada para repetir.' };
      default:
        return { intent: 'UNKNOWN', reply: this.unknownReply() };
    }
  }

  private async describeStatus(): Promise<string> {
    const status = await this.deps.getStatus();

    let voice: string;
    if (status.stt && status.tts) {
      voice = 'sistema de voz funcionando';
    } else if (!status.stt && !status.tts) {
      voice = 'sistema de voz indisponível';
    } else {
      voice = status.stt ? 'síntese de voz indisponível' : 'reconhecimento de voz indisponível';
    }

    const parts = [
      status.whatsapp ? 'WhatsApp conectado' : 'WhatsApp desconectado',
      status.ai ? 'inteligência artificial disponível' : 'inteligência artificial indisponível',
      voice,
    ];
    if (status.mic === false) {
      parts.push('microfone indisponível');
    }

    let reply = `Estou online. ${capitalizeFirst(joinList(parts))}.`;

    const unread = this.deps.messageService.getUnreadMessages().length;
    if (unread > 0) {
      reply += ` Você tem ${countInWords(unread)} ${unread === 1 ? 'mensagem não lida' : 'mensagens não lidas'}.`;
    }
    if (this.deps.stateMachine.getCurrentState() === 'WAITING_CONFIRMATION') {
      reply += ' Há uma resposta aguardando sua confirmação.';
    }
    return reply;
  }

  private stop(intent: MessageIntent): CommandResult {
    // Encerrar o programa por um palpite do LLM seria inesperado demais.
    if (intent.source === 'ai') {
      return { intent: 'UNKNOWN', reply: 'Se quiser me desligar, diga "desligar".' };
    }
    return { intent: 'STOP', reply: 'Até logo!', shouldStop: true };
  }

  private listMessages(): string {
    const { messageService } = this.deps;
    const unread = messageService.getUnreadMessages();

    if (unread.length === 0) {
      const latest = messageService.getLatestMessage();
      return latest
        ? `Você não tem mensagens novas. A última foi de ${senderLabel(latest)}.`
        : 'Você não recebeu nenhuma mensagem desde que eu fui iniciada.';
    }

    messageService.setFocusedMessage(unread[unread.length - 1]);

    if (unread.length === 1) {
      return `Você recebeu uma mensagem nova, de ${senderLabel(unread[0])}. Diga "leia a última mensagem" para ouvir.`;
    }

    const bySender = new Map<string, number>();
    unread.forEach((message) => {
      const name = senderLabel(message);
      bySender.set(name, (bySender.get(name) ?? 0) + 1);
    });
    const summary = joinList(
      Array.from(bySender.entries()).map(([name, count]) => `${countInWords(count)} de ${name}`)
    );
    return `Você recebeu ${countInWords(unread.length)} mensagens novas: ${summary}. Diga "leia a última mensagem" para ouvir.`;
  }

  private readMessage(intent: MessageIntent): string {
    const { messageService } = this.deps;

    let message: IncomingMessage | undefined;
    if (intent.target) {
      message = messageService.findLatestFrom(intent.target);
      if (!message) {
        return `Não encontrei nenhuma mensagem de ${intent.target}.`;
      }
    } else if (intent.again) {
      message = messageService.getFocusedMessage() ?? messageService.getLatestMessage();
    } else {
      message = messageService.getLatestMessage();
    }

    if (!message) {
      return 'Você ainda não recebeu nenhuma mensagem.';
    }

    messageService.markAsRead(message.id);
    messageService.setFocusedMessage(message);
    return describeMessage(message);
  }

  /**
   * Prepara o rascunho e pede confirmação. Nunca envia diretamente.
   * Sem destinatário explícito, usa a mensagem em foco (a última anunciada/lida).
   */
  private async prepareReply(intent: MessageIntent): Promise<string> {
    const { messageService, responseService, stateMachine, eventBus } = this.deps;

    if (!messageService.isConnected()) {
      return 'O WhatsApp está desconectado, então não consigo responder agora.';
    }

    let message: IncomingMessage | undefined;
    if (intent.target) {
      message = messageService.findLatestFrom(intent.target);
      if (!message) {
        return `Não encontrei nenhuma mensagem recente de ${intent.target}. Só consigo responder mensagens recebidas enquanto estou ligada.`;
      }
    } else {
      message = messageService.getFocusedMessage() ?? messageService.getLatestMessage();
    }

    if (!message) {
      return 'Não há nenhuma mensagem para responder.';
    }

    messageService.setFocusedMessage(message);
    const recipient = recipientLabel(message);

    const content = intent.response?.trim();
    if (!content) {
      return `O que você quer responder para ${recipient}? Diga, por exemplo: "responde que já vou verificar".`;
    }

    // Um novo pedido de resposta substitui o rascunho anterior.
    if (stateMachine.getCurrentState() === 'WAITING_CONFIRMATION') {
      stateMachine.clearPendingData();
      stateMachine.transition('IDLE');
    }

    stateMachine.transition('GENERATING_RESPONSE');
    const reply = await responseService.composeReply(content, message);
    stateMachine.setTargetChatId(message.chatId);
    await eventBus.emit('RESPONSE_GENERATED', { response: reply });

    return responseService.requestConfirmation(reply, recipient);
  }

  private async confirmAndSend(): Promise<CommandResult> {
    const { messageService, responseService, stateMachine } = this.deps;
    const chatId = stateMachine.getTargetChatId();
    const response = stateMachine.getPendingResponse();

    if (!chatId || !response) {
      stateMachine.clearPendingData();
      stateMachine.transition('IDLE');
      return { intent: 'CONFIRM', reply: 'Não há nenhuma resposta aguardando confirmação.' };
    }

    const recipient = this.pendingRecipient();

    if (!messageService.isConnected()) {
      return {
        intent: 'CONFIRM',
        reply: 'O WhatsApp está desconectado. A resposta continua pendente: diga "pode enviar" quando ele reconectar, ou "cancela".',
      };
    }

    await responseService.handleConfirmation(true);
    stateMachine.transition('SENDING_MESSAGE');

    try {
      await messageService.sendMessage(chatId, response);
    } catch (error) {
      Logger.error('Failed to send confirmed reply', error);
      // Mantém o rascunho para permitir uma nova tentativa.
      this.recoverFromError();
      stateMachine.transition('GENERATING_RESPONSE');
      stateMachine.setTargetChatId(chatId);
      stateMachine.setPendingResponse(response);
      stateMachine.transition('WAITING_CONFIRMATION');
      return { intent: 'CONFIRM', reply: 'Não consegui enviar a mensagem. Quer que eu tente de novo?' };
    }

    return { intent: 'CONFIRM', reply: `Mensagem enviada para ${recipient}.` };
  }

  private pendingRecipient(): string {
    const chatId = this.deps.stateMachine.getTargetChatId();
    const focused = this.deps.messageService.getFocusedMessage();
    if (focused && focused.chatId === chatId) {
      return recipientLabel(focused);
    }
    return (chatId && this.deps.messageService.getDisplayName(chatId)) || 'o contato';
  }

  private unknownReply(): string {
    if (!this.deps.aiProvider.isAvailable()) {
      return 'Não entendi o comando. A inteligência artificial está indisponível no momento, então só entendo comandos simples. Diga "ajuda" para ver o que posso fazer.';
    }
    return 'Não entendi. Pode repetir de outro jeito? Diga "ajuda" para ver o que posso fazer.';
  }

  private buildContext(): ConversationContext | undefined {
    const message =
      this.deps.messageService.getFocusedMessage() ?? this.deps.messageService.getLatestMessage();
    return message
      ? { conversationId: message.chatId, recentMessages: [message], currentMessage: message }
      : undefined;
  }

  private recoverFromError(): void {
    if (this.deps.stateMachine.getCurrentState() === 'ERROR') {
      this.deps.stateMachine.transition('IDLE');
    }
  }
}
