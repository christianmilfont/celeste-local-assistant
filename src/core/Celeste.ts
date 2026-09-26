import { EventBus } from './EventBus';
import { StateMachine } from './StateMachine';
import { MessageService } from '../application/MessageService';
import { VoiceService } from '../application/VoiceService';
import { ResponseService } from '../application/ResponseService';
import { MessagingAdapter } from './types/adapters';
import { AIProvider } from './types/adapters';
import { SpeechToTextProvider } from './types/adapters';
import { TextToSpeechProvider } from './types/adapters';
import { CelesteDatabase } from '../infrastructure/storage/Database';
import { Logger } from '../infrastructure/logging/Logger';
import { IncomingMessage } from './types';

export class Celeste {
  private eventBus: EventBus;
  private stateMachine: StateMachine;
  private messageService: MessageService;
  private voiceService: VoiceService;
  private responseService: ResponseService;
  private database: CelesteDatabase;

  constructor(
    private messagingAdapter: MessagingAdapter,
    private aiProvider: AIProvider,
    private sttProvider: SpeechToTextProvider,
    private ttsProvider: TextToSpeechProvider
  ) {
    this.eventBus = new EventBus();
    this.stateMachine = new StateMachine();
    this.database = CelesteDatabase.getInstance();

    this.messageService = new MessageService(
      messagingAdapter,
      this.eventBus,
      this.stateMachine,
      this.database
    );

    this.voiceService = new VoiceService(
      sttProvider,
      ttsProvider,
      this.eventBus,
      this.stateMachine
    );

    this.responseService = new ResponseService(
      aiProvider,
      this.eventBus,
      this.stateMachine
    );

    this.setupEventListeners();
  }

  async start(): Promise<void> {
    try {
      Logger.info('Starting Celeste...');

      await this.messagingAdapter.connect();
      this.messagingAdapter.onMessage((message) =>
        this.handleIncomingMessage(message)
      );

      this.setupEventLogging();

      Logger.info('Celeste started successfully');
    } catch (error) {
      Logger.error('Failed to start Celeste', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      Logger.info('Stopping Celeste...');

      await this.messagingAdapter.disconnect();
      this.eventBus.removeAllListeners();

      Logger.info('Celeste stopped');
    } catch (error) {
      Logger.error('Error stopping Celeste', error);
      throw error;
    }
  }

  private async handleIncomingMessage(message: IncomingMessage): Promise<void> {
    await this.messageService.handleIncomingMessage(message);

    const pendingMessage = this.stateMachine.getPendingMessage();
    if (pendingMessage) {
      await this.voiceService.announceMessage(pendingMessage);
      this.stateMachine.transition('IDLE');
    }
  }

  async startVoiceInput(): Promise<void> {
    try {
      Logger.info('Starting voice input');

      const currentState = this.stateMachine.getCurrentState();
      if (currentState !== 'IDLE') {
        Logger.warn('Cannot start voice input in current state', {
          currentState,
        });
        return;
      }

      await this.voiceService.startListening();
    } catch (error) {
      Logger.error('Error starting voice input', error);
      throw error;
    }
  }

  async processVoiceTranscription(transcription: string): Promise<void> {
    try {
      Logger.info('Processing voice transcription', { transcription });

      const pendingMessage = this.stateMachine.getPendingMessage();
      const currentState = this.stateMachine.getCurrentState();

      // Reset from ERROR state if needed
      if (currentState === 'ERROR') {
        this.stateMachine.transition('IDLE');
      }

      if (currentState === 'WAITING_CONFIRMATION') {
        const confirmed = this.responseService.parseConfirmation(transcription);
        const result = await this.responseService.handleConfirmation(confirmed);

        if (result.approved && result.response) {
          const chatId = this.stateMachine.getTargetChatId();
          if (chatId) {
            this.stateMachine.transition('SENDING_MESSAGE');
            await this.messageService.sendMessage(chatId, result.response);
          }
        }
      } else if (pendingMessage) {
        const intent = await this.responseService.processVoiceInput(
          transcription,
          pendingMessage
        );

        if (intent.intent === 'REPLY_TO_MESSAGE' && intent.response) {
          this.stateMachine.setTargetChatId(pendingMessage.chatId);
          await this.responseService.generateResponse(
            intent.response,
            pendingMessage
          );
          const pendingResponse = this.stateMachine.getPendingResponse();
          if (pendingResponse) {
            await this.responseService.requestConfirmation(
              pendingResponse,
              pendingMessage.senderName
            );
            await this.voiceService.speak(
              `Vou responder ao ${pendingMessage.senderName}: ${pendingResponse}. Posso enviar?`
            );
          }
        } else if (intent.intent === 'CANCEL') {
          this.stateMachine.clearPendingData();
          this.stateMachine.transition('IDLE');
          await this.voiceService.speak('Cancelado.');
        } else if (intent.intent === 'HELP') {
          await this.voiceService.speak(
            'Diga "responde" seguido da sua resposta para responder a uma mensagem.'
          );
          this.stateMachine.transition('IDLE');
        } else {
          await this.voiceService.speak('Não entendi. Tente novamente.');
          this.stateMachine.transition('IDLE');
        }
      } else {
        await this.voiceService.speak('Não há mensagem pendente para responder.');
        this.stateMachine.transition('IDLE');
      }
    } catch (error) {
      Logger.error('Error processing voice transcription', error);
      await this.voiceService.speak('Ocorreu um erro. Tente novamente.');
      this.stateMachine.transition('ERROR');
    }
  }

  getStatus(): {
    whatsapp: boolean;
    ai: boolean;
    stt: boolean;
    tts: boolean;
    state: string;
  } {
    return {
      whatsapp: this.messagingAdapter.isConnected(),
      ai: this.aiProvider.isAvailable(),
      stt: this.sttProvider.isAvailable(),
      tts: this.ttsProvider.isAvailable(),
      state: this.stateMachine.getCurrentState(),
    };
  }

  private setupEventListeners(): void {
    this.stateMachine.onTransition((from, to) => {
      Logger.debug('State transition', { from, to });
      this.eventBus.emit('STATE_CHANGED', { from, to });
    });
  }

  private setupEventLogging(): void {
    const eventTypes = [
      'MESSAGE_RECEIVED',
      'MESSAGE_SENT',
      'VOICE_INPUT_STARTED',
      'VOICE_TRANSCRIBED',
      'COMMAND_DETECTED',
      'RESPONSE_GENERATED',
      'RESPONSE_CONFIRMED',
      'RESPONSE_CANCELLED',
      'ERROR',
    ];

    eventTypes.forEach((eventType) => {
      this.eventBus.on(eventType as any, (event) => {
        Logger.info(`Event: ${eventType}`, event.data);
      });
    });
  }
}
