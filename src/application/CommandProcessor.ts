import { AIProvider } from '../core/types/adapters';
import {
  CommandResult,
  ConversationContext,
  IncomingMessage,
  InputSource,
  IntentType,
  MessageIntent,
  TvCommand,
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
import { capitalizeFirst, countInWords, joinList, normalizeCommand } from './nlu/text';
import type { ContactMatch } from './ContactService';

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
  /** Agenda de contatos do WhatsApp (opcional): permite escrever para qualquer contato. */
  contacts?: {
    search(query: string): ContactMatch[];
    lookupPhone(spoken: string): Promise<ContactMatch | undefined>;
    sync(): Promise<number>;
    count(): number;
  };
  /** Controle de TV pela rede (opcional). */
  tvService?: { execute(command: TvCommand): Promise<string> };
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
  'TV_CONTROL',
];

/** Para quem vai a mensagem: uma conversa recebida (resposta) ou um contato da agenda (nova). */
interface Recipient {
  chatId: string;
  label: string;
  context?: IncomingMessage;
  kind: 'reply' | 'new';
}

/** Perguntas pendentes ("qual Letícia?", "o que dizer?") expiram após 2 minutos. */
const PENDING_TTL_MS = 120000;
const CANCEL_PENDING = /^(?:nao|cancela|cancelar|cancele|deixa|deixa pra la|esquece|esqueca|nada|nenhum|nenhuma)\b/;
/** Com uma pergunta pendente, estes comandos são atendidos normalmente (não viram conteúdo). */
const COMMANDS_WHILE_PENDING: IntentType[] = [
  'STATUS', 'HELP', 'STOP', 'LIST_MESSAGES', 'READ_LAST_MESSAGE', 'TV_CONTROL', 'SYNC_CONTACTS', 'REPEAT',
];
const ORDINALS: Array<[RegExp, number]> = [
  [/\b(primeir[oa]|1)\b/, 0], [/\b(segund[oa]|2)\b/, 1], [/\b(terceir[oa]|3)\b/, 2], [/\b(quart[oa]|4)\b/, 3],
];
const MASCULINE_COUNT = ['zero', 'um', 'dois', 'três', 'quatro'];

const HELP_TEXT =
  'Posso dizer o status do sistema, listar e ler suas mensagens, responder mensagens do WhatsApp ' +
  'sempre pedindo confirmação, enviar mensagens para seus contatos e controlar a TV. ' +
  'Experimente: "leia a última mensagem" ou "desliga a TV".';

/**
 * Ponto único de processamento de comandos. O CLI e a voz chegam aqui com
 * o mesmo texto; a origem é usada apenas para log.
 */
export class CommandProcessor {
  private lastSpoken?: string;
  private draftRecipient?: Recipient;
  private pendingChoice?: { candidates: ContactMatch[]; content: string; expires: number };
  private awaitingContent?: { recipient: Recipient; expires: number };

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
        const confirming = this.deps.stateMachine.getCurrentState() === 'WAITING_CONFIRMATION';
        result = confirming
          ? await this.handleWhileConfirming(text, source, onStage)
          : (await this.handlePendingQuestion(text, onStage)) ?? (await this.handle(text, source, onStage));
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
      case 'SYNC_CONTACTS':
        return { intent: 'SYNC_CONTACTS', reply: await this.syncContacts() };
      case 'TV_CONTROL':
        return { intent: 'TV_CONTROL', reply: await this.controlTv(intent) };
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
   * Destinatário: citado pelo nome (conversa recebida ou contato da agenda) ou, sem nome,
   * a mensagem em foco (a última anunciada/lida).
   */
  private async prepareReply(intent: MessageIntent): Promise<string> {
    const { messageService } = this.deps;

    if (!messageService.isConnected()) {
      return 'O WhatsApp está desconectado, então não consigo enviar mensagens agora.';
    }

    const content = intent.response?.trim() ?? '';
    let recipient: Recipient;
    if (intent.target) {
      const resolved = await this.resolveTarget(intent.target, content);
      if (typeof resolved === 'string') {
        return resolved;
      }
      recipient = resolved;
    } else {
      const message = messageService.getFocusedMessage() ?? messageService.getLatestMessage();
      if (!message) {
        return 'Não há nenhuma mensagem para responder. Para escrever para alguém, diga por exemplo: "envie uma mensagem para a Letícia dizendo que já estou saindo".';
      }
      messageService.setFocusedMessage(message);
      recipient = { chatId: message.chatId, label: recipientLabel(message), context: message, kind: 'reply' };
    }

    return content ? this.draft(recipient, content) : this.askContent(recipient);
  }

  /** Nome falado → destinatário. Retorna texto quando precisa perguntar ou não encontrou. */
  private async resolveTarget(target: string, content: string): Promise<Recipient | string> {
    const { messageService, contacts } = this.deps;

    // Quem mandou mensagem nesta sessão: responde na mesma conversa.
    const fromInbox = messageService.findLatestFrom(target);
    if (fromInbox) {
      messageService.setFocusedMessage(fromInbox);
      return { chatId: fromInbox.chatId, label: recipientLabel(fromInbox), context: fromInbox, kind: 'reply' };
    }

    let matches = contacts?.search(target) ?? [];
    if (!matches.length && target.replace(/\D/g, '').length >= 8) {
      const byPhone = await contacts?.lookupPhone(target);
      if (!byPhone) return `O número ${target} não tem WhatsApp ou não consegui verificá-lo.`;
      matches = [byPhone];
    }

    if (!matches.length) {
      if (!contacts || contacts.count() === 0) {
        return 'Ainda não conheço seus contatos. Diga "atualizar contatos" para eu sincronizar a agenda do WhatsApp.';
      }
      return `Não encontrei ${target} nos seus contatos.`;
    }

    if (matches.length > 1) {
      this.pendingChoice = { candidates: matches, content, expires: Date.now() + PENDING_TTL_MS };
      const count = MASCULINE_COUNT[matches.length] ?? String(matches.length);
      return `Encontrei ${count} contatos com esse nome: ${joinList(matches.map((m) => m.label))}. Para qual deles?`;
    }

    return { chatId: matches[0].contact.id, label: matches[0].label, kind: 'new' };
  }

  private askContent(recipient: Recipient): string {
    this.awaitingContent = { recipient, expires: Date.now() + PENDING_TTL_MS };
    return recipient.kind === 'reply'
      ? `O que você quer responder para ${recipient.label}?`
      : `O que você quer dizer para ${recipient.label}?`;
  }

  private async draft(recipient: Recipient, content: string): Promise<string> {
    const { responseService, stateMachine, eventBus } = this.deps;
    this.pendingChoice = undefined;
    this.awaitingContent = undefined;

    // Um novo pedido substitui o rascunho anterior.
    if (stateMachine.getCurrentState() === 'WAITING_CONFIRMATION') {
      stateMachine.clearPendingData();
      stateMachine.transition('IDLE');
    }

    stateMachine.transition('GENERATING_RESPONSE');
    const text = await responseService.composeReply(content, recipient.context);
    stateMachine.setTargetChatId(recipient.chatId);
    this.draftRecipient = recipient;
    await eventBus.emit('RESPONSE_GENERATED', { response: text });

    return responseService.requestConfirmation(text, recipient.label, recipient.kind === 'new' ? 'mensagem' : 'resposta');
  }

  /**
   * Respostas às perguntas da própria Celeste: "qual Letícia?" e "o que dizer?".
   * Retorna null quando o texto não é uma resposta a elas (segue o fluxo normal).
   */
  private async handlePendingQuestion(text: string, onStage?: CommandStageListener): Promise<CommandResult | null> {
    const now = Date.now();
    if (this.pendingChoice && now > this.pendingChoice.expires) this.pendingChoice = undefined;
    if (this.awaitingContent && now > this.awaitingContent.expires) this.awaitingContent = undefined;
    if (!this.pendingChoice && !this.awaitingContent) return null;

    const normalized = normalizeCommand(text);
    const intent = this.deps.intentClassifier.classifyDeterministic(text);
    const isCommand =
      (intent && COMMANDS_WHILE_PENDING.includes(intent.intent)) ||
      (intent?.intent === 'REPLY_TO_MESSAGE' && Boolean(intent.target));
    if (isCommand) {
      this.pendingChoice = undefined;
      this.awaitingContent = undefined;
      return null;
    }
    if (CANCEL_PENDING.test(normalized) && (this.pendingChoice || normalized.split(' ').length <= 3)) {
      this.pendingChoice = undefined;
      this.awaitingContent = undefined;
      onStage?.('ACTION');
      return { intent: 'CANCEL', reply: 'Tudo bem, cancelei a mensagem.' };
    }

    if (this.pendingChoice) {
      const { candidates, content } = this.pendingChoice;
      const choice = this.pickCandidate(normalized, candidates);
      if (!choice) {
        return {
          intent: 'UNKNOWN',
          reply: `Não entendi qual deles. Diga o nome completo ou "o primeiro", "o segundo"... Opções: ${joinList(candidates.map((c) => c.label))}.`,
        };
      }
      this.pendingChoice = undefined;
      onStage?.('ACTION');
      const recipient: Recipient = { chatId: choice.contact.id, label: choice.label, kind: 'new' };
      return { intent: 'REPLY_TO_MESSAGE', reply: content ? await this.draft(recipient, content) : this.askContent(recipient) };
    }

    // Aguardando o conteúdo: o que foi dito É a mensagem.
    const { recipient } = this.awaitingContent!;
    this.awaitingContent = undefined;
    const content =
      intent?.intent === 'REPLY_TO_MESSAGE' && intent.response
        ? intent.response
        : text.trim().replace(/^(?:celeste[\s,]+)?(?:(?:diga|diz|fala|fale|dizendo|avisa|avise)\s+)?que\s+/i, '');
    onStage?.('ACTION');
    return { intent: 'REPLY_TO_MESSAGE', reply: await this.draft(recipient, content) };
  }

  private pickCandidate(normalized: string, candidates: ContactMatch[]): ContactMatch | undefined {
    for (const [pattern, index] of ORDINALS) {
      if (pattern.test(normalized) && candidates[index]) return candidates[index];
    }
    if (/\bultim[oa]\b/.test(normalized)) return candidates[candidates.length - 1];
    const words = new Set(normalized.split(' '));
    const scored = candidates
      .map((candidate) => ({
        candidate,
        shared: normalizeCommand(candidate.label).split(' ').filter((token) => words.has(token)).length,
      }))
      .sort((a, b) => b.shared - a.shared);
    if (scored[0]?.shared && scored[0].shared > (scored[1]?.shared ?? 0)) return scored[0].candidate;
    return undefined;
  }

  private async syncContacts(): Promise<string> {
    const { contacts, messageService } = this.deps;
    if (!contacts) return 'A agenda de contatos não está disponível.';
    if (!messageService.isConnected()) return 'O WhatsApp está desconectado, então não consigo sincronizar os contatos agora.';
    try {
      const count = await contacts.sync();
      return `Sincronizei sua agenda: conheço ${count} contatos.`;
    } catch (error) {
      Logger.warn('Contact sync failed', { error: String(error) });
      return `Não consegui sincronizar a agenda agora. Conheço ${contacts.count()} contatos.`;
    }
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
    if (this.draftRecipient && this.draftRecipient.chatId === chatId) {
      return this.draftRecipient.label;
    }
    const focused = this.deps.messageService.getFocusedMessage();
    if (focused && focused.chatId === chatId) {
      return recipientLabel(focused);
    }
    return (chatId && this.deps.messageService.getDisplayName(chatId)) || 'o contato';
  }

  private async controlTv(intent: MessageIntent): Promise<string> {
    if (!this.deps.tvService) {
      return 'O controle de TV está desativado.';
    }
    if (!intent.tv) {
      return 'O que você quer que eu faça com a TV?';
    }
    return this.deps.tvService.execute(intent.tv);
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
