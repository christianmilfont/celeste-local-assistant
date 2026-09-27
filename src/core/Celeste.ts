import { EventBus } from './EventBus';
import { StateMachine } from './StateMachine';
import { MessageService } from '../application/MessageService';
import { VoiceService } from '../application/VoiceService';
import { ResponseService } from '../application/ResponseService';
import { ConfirmationService } from '../application/ConfirmationService';
import { IntentClassifier } from '../application/IntentClassifier';
import {
  CommandProcessor,
  CommandStageListener,
  StatusSnapshot,
} from '../application/CommandProcessor';
import { SpeechInputService } from '../application/SpeechInputService';
import { AvatarService } from '../application/AvatarService';
import { TvService } from '../application/TvService';
import { ContactService } from '../application/ContactService';
import { SqliteContactStore } from '../infrastructure/storage/ContactStore';
import { TvDevice } from './types/tv';
import { VoicePipeline, VoiceTurnResult } from '../application/VoicePipeline';
import { describeMessage } from '../application/nlu/messageFormat';
import {
  AudioRecorder,
  MessagingAdapter,
  AIProvider,
  SpeechToTextProvider,
  TextToSpeechProvider,
} from './types/adapters';
import { CelesteDatabase } from '../infrastructure/storage/Database';
import { Logger } from '../infrastructure/logging/Logger';
import {
  AssistantEvent,
  AvatarState,
  CommandResult,
  EventType,
  IncomingMessage,
  InputSource,
  VoicePipelineState,
} from './types';

export interface CelesteStatus extends StatusSnapshot {
  mic: boolean;
  voice: VoicePipelineState | 'DISABLED';
}

export class Celeste {
  private eventBus: EventBus;
  private stateMachine: StateMachine;
  private messageService: MessageService;
  private voiceService: VoiceService;
  private responseService: ResponseService;
  private commandProcessor: CommandProcessor;
  private speechInputService?: SpeechInputService;
  private voicePipeline?: VoicePipeline;
  private database: CelesteDatabase;
  private avatarService: AvatarService;
  private contactService: ContactService;

  /** Serializa comandos e anúncios para que não disputem o estado nem o alto-falante. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Mensagens que chegaram enquanto o usuário falava: anunciadas ao final. */
  private deferredAnnouncements: IncomingMessage[] = [];

  constructor(
    private messagingAdapter: MessagingAdapter,
    private aiProvider: AIProvider,
    private sttProvider: SpeechToTextProvider,
    private ttsProvider: TextToSpeechProvider,
    private audioRecorder?: AudioRecorder,
    private tvService?: TvService
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

    this.voiceService = new VoiceService(ttsProvider, this.eventBus);
    this.avatarService = new AvatarService(this.eventBus);

    const confirmationService = new ConfirmationService();

    this.contactService = new ContactService(new SqliteContactStore(this.database), messagingAdapter);
    messagingAdapter.onContacts?.((contacts) => this.contactService.upsert(contacts));

    this.responseService = new ResponseService(
      aiProvider,
      this.eventBus,
      this.stateMachine,
      confirmationService
    );

    this.commandProcessor = new CommandProcessor({
      messageService: this.messageService,
      responseService: this.responseService,
      stateMachine: this.stateMachine,
      eventBus: this.eventBus,
      intentClassifier: new IntentClassifier(aiProvider, confirmationService),
      confirmationService,
      aiProvider,
      getStatus: () => this.refreshStatus(),
      contacts: this.contactService,
      tvService,
    });

    if (audioRecorder) {
      this.speechInputService = new SpeechInputService(audioRecorder, sttProvider, this.eventBus);
      this.voicePipeline = new VoicePipeline(this.speechInputService, this, this.eventBus);
      this.voicePipeline.onStateChange((state) => this.flushDeferredAnnouncements(state));
    }

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

      await this.checkServices();

      // Carrega os modelos (Whisper, voz e LLM) em segundo plano para o primeiro comando ser rápido.
      void this.ttsProvider.warmUp?.();
      this.sttProvider.warmUp?.().catch((error) => {
        Logger.warn('Whisper warm-up failed', { error: String(error) });
      });
      void this.aiProvider.warmUp?.();
      // Agenda de contatos: se ainda conhece poucos, sincroniza assim que o WhatsApp conectar.
      void this.ensureContacts();
      // Procura as TVs da rede local se ainda não conhece nenhuma.
      void this.tvService?.init();

      Logger.info('Celeste started successfully');
    } catch (error) {
      Logger.error('Failed to start Celeste', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      Logger.info('Stopping Celeste...');

      await this.voicePipeline?.cancel();
      this.dispose();
      await this.messagingAdapter.disconnect();
      this.eventBus.removeAllListeners();

      Logger.info('Celeste stopped');
    } catch (error) {
      Logger.error('Error stopping Celeste', error);
      throw error;
    }
  }

  /** Finaliza processos filhos (microfone, Whisper, TTS). Seguro para chamar no 'exit'. */
  dispose(): void {
    this.avatarService.dispose();
    this.voiceService.stopSpeaking();
    this.ttsProvider.dispose?.();
    this.audioRecorder?.dispose?.();
    this.sttProvider.dispose?.();
  }

  /**
   * Entrada única de comandos: CLI e voz chegam aqui com o mesmo texto.
   * Retorna a resposta sem falar (quem chama decide quando falar).
   */
  processCommand(
    input: string,
    source: InputSource = 'cli',
    onStage?: CommandStageListener
  ): Promise<CommandResult> {
    return this.exclusive(() => this.commandProcessor.processCommand(input, source, onStage));
  }

  /** Processa o comando e fala a resposta. */
  async respond(input: string, source: InputSource = 'cli'): Promise<CommandResult> {
    return this.exclusive(async () => {
      await this.eventBus.emit('THINKING_STARTED', { source });
      const result = await this.commandProcessor.processCommand(input, source);
      await this.speak(result.reply);
      return result;
    });
  }

  /** Compatibilidade com a API anterior: texto (transcrito ou digitado) -> resposta falada. */
  async processVoiceTranscription(transcription: string): Promise<void> {
    await this.respond(transcription, 'voice');
  }

  /** Fala um texto. Se o TTS falhar, o texto continua visível no terminal. */
  async speak(text: string): Promise<void> {
    try {
      await this.voiceService.speak(text);
    } catch (error) {
      Logger.warn('TTS failed; response shown only in terminal', { error: String(error) });
      await this.eventBus.emit('ERROR', {
        code: 'TTS_UNAVAILABLE',
        message: 'A síntese de voz está indisponível; a resposta foi apenas exibida.',
      });
    }
  }

  stopSpeaking(): void {
    this.voiceService.stopSpeaking();
  }

  // ---- Voz (push-to-talk) ------------------------------------------------

  isVoiceEnabled(): boolean {
    return Boolean(this.voicePipeline);
  }

  getVoiceState(): VoicePipelineState | 'DISABLED' {
    return this.voicePipeline?.getState() ?? 'DISABLED';
  }

  onVoiceStateChange(
    listener: (state: VoicePipelineState, previous: VoicePipelineState) => void
  ): () => void {
    return this.voicePipeline?.onStateChange(listener) ?? (() => undefined);
  }

  onVoiceTurn(listener: (result: VoiceTurnResult) => void): () => void {
    return this.voicePipeline?.onTurnComplete(listener) ?? (() => undefined);
  }

  waitForVoice(): void {
    this.voicePipeline?.waitForVoice();
  }

  /** Começa a gravar (push-to-talk). Retorna false se não foi possível. */
  async startVoiceInput(): Promise<boolean> {
    if (!this.voicePipeline) {
      Logger.warn('Voice input is not configured (no audio recorder)');
      return false;
    }
    return this.voicePipeline.startRecording();
  }

  /** Para de gravar e executa: STT -> comando -> resposta falada. */
  async finishVoiceInput(): Promise<VoiceTurnResult> {
    if (!this.voicePipeline) {
      return {};
    }
    return this.voicePipeline.stopAndProcess();
  }

  /** Interrompe gravação/processamento/fala e volta para IDLE. */
  async cancelVoiceInput(): Promise<void> {
    await this.voicePipeline?.cancel();
  }

  // ---- Estado -------------------------------------------------------------

  /** Quantos contatos (com nome) a Celeste conhece. */
  getContactCount(): number {
    return this.contactService.count();
  }

  private async ensureContacts(): Promise<void> {
    if (this.contactService.count() >= 10 || !this.messagingAdapter.syncContacts) return;
    const deadline = Date.now() + 90000;
    while (!this.messagingAdapter.isConnected() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!this.messagingAdapter.isConnected()) return;
    try {
      const count = await this.contactService.sync();
      Logger.info('Contacts synced', { count });
    } catch (error) {
      Logger.warn('Automatic contact sync failed', { error: String(error) });
    }
  }

  /** TVs conhecidas (controle pela rede local). */
  getTvs(): TvDevice[] {
    return this.tvService?.list() ?? [];
  }

  getAvatarState(): AvatarState {
    return this.avatarService.getState();
  }

  on(eventType: EventType, callback: (event: AssistantEvent) => void | Promise<void>): void {
    this.eventBus.on(eventType, callback);
  }

  getStatus(): CelesteStatus {
    return {
      whatsapp: this.messagingAdapter.isConnected(),
      ai: this.aiProvider.isAvailable(),
      stt: this.sttProvider.isAvailable(),
      tts: this.ttsProvider.isAvailable(),
      mic: this.audioRecorder?.isAvailable() ?? false,
      state: this.stateMachine.getCurrentState(),
      voice: this.getVoiceState(),
    };
  }

  /** Verifica ativamente Ollama, Whisper, TTS e microfone. */
  async checkServices(): Promise<CelesteStatus> {
    await Promise.all([
      this.aiProvider.checkAvailability?.(),
      this.sttProvider.checkAvailability?.(),
      this.ttsProvider.checkAvailability?.(),
      this.audioRecorder?.checkAvailability?.(),
    ]);
    return this.getStatus();
  }

  /** Para o comando STATUS: reconsulta só a IA (rápido) e usa o último estado dos demais. */
  private async refreshStatus(): Promise<CelesteStatus> {
    await this.aiProvider.checkAvailability?.();
    return this.getStatus();
  }

  // ---- Mensagens recebidas -------------------------------------------------

  private async handleIncomingMessage(message: IncomingMessage): Promise<void> {
    await this.exclusive(async () => {
      await this.messageService.handleIncomingMessage(message);

      if (this.voicePipeline?.isBusy()) {
        // Não fala por cima do usuário nem da resposta atual.
        this.deferredAnnouncements.push(message);
      } else {
        await this.announce(message);
      }

      if (this.stateMachine.getCurrentState() === 'ANNOUNCING_MESSAGE') {
        this.stateMachine.transition('IDLE');
      }
    });
  }

  private async announce(message: IncomingMessage): Promise<void> {
    this.messageService.markAsRead(message.id);
    this.messageService.setFocusedMessage(message);
    // Mesmo sem TTS o anúncio aparece no terminal (evento ASSISTANT_SPEECH).
    await this.voiceService.announceMessage(message).catch((error) => {
      Logger.warn('Could not speak announcement', { error: String(error) });
    });
    this.commandProcessor.rememberSpoken(describeMessage(message));
  }

  private flushDeferredAnnouncements(state: VoicePipelineState): void {
    if ((state === 'IDLE' || state === 'WAITING_FOR_VOICE') && this.deferredAnnouncements.length) {
      const pending = this.deferredAnnouncements;
      this.deferredAnnouncements = [];
      void this.exclusive(async () => {
        for (const message of pending) {
          await this.announce(message);
        }
      });
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
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
