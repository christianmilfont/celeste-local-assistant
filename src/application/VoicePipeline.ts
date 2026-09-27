import { CommandResult, InputSource, VoicePipelineState } from '../core/types';
import { EventBus } from '../core/EventBus';
import { CelesteError } from '../core/errors';
import { Config } from '../infrastructure/config/Config';
import { Logger } from '../infrastructure/logging/Logger';
import { SpeechInputService } from './SpeechInputService';
import { CommandStageListener } from './CommandProcessor';

/** O que o pipeline precisa da Celeste: o mesmo processamento usado pelo CLI + fala. */
export interface VoiceCommandHandler {
  processCommand(
    input: string,
    source: InputSource,
    onStage?: CommandStageListener
  ): Promise<CommandResult>;
  speak(text: string): Promise<void>;
  stopSpeaking(): void;
}

export interface VoiceTurnResult {
  transcription?: string;
  result?: CommandResult;
  error?: CelesteError;
  cancelled?: boolean;
}

type StateListener = (state: VoicePipelineState, previous: VoicePipelineState) => void;

/**
 * Fluxo de voz push-to-talk:
 * IDLE -> WAITING_FOR_VOICE -> RECORDING -> PROCESSING_AUDIO -> TRANSCRIBING
 *      -> COMMAND_PROCESSING -> ACTION -> TTS_RESPONSE -> IDLE
 * Em erro: ERROR -> (fala o problema) -> IDLE. cancel() volta para IDLE de qualquer estado.
 */
export class VoicePipeline {
  private state: VoicePipelineState = 'IDLE';
  private listeners = new Set<StateListener>();
  private turnListeners = new Set<(result: VoiceTurnResult) => void>();
  /** Incrementado a cada cancelamento: resultados de turnos antigos são descartados. */
  private turn = 0;
  private maxRecordingTimer?: NodeJS.Timeout;
  private activeTurn?: Promise<VoiceTurnResult>;

  constructor(
    private speechInput: SpeechInputService,
    private handler: VoiceCommandHandler,
    private eventBus: EventBus,
    private maxRecordingMs: number = Config.voiceMaxRecordingMs
  ) {}

  getState(): VoicePipelineState {
    return this.state;
  }

  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notificado ao fim de cada turno de voz (inclusive quando a gravação para sozinha). */
  onTurnComplete(listener: (result: VoiceTurnResult) => void): () => void {
    this.turnListeners.add(listener);
    return () => this.turnListeners.delete(listener);
  }

  /** true enquanto grava ou processa um comando de voz. */
  isBusy(): boolean {
    return this.state !== 'IDLE' && this.state !== 'WAITING_FOR_VOICE';
  }

  isRecording(): boolean {
    return this.state === 'RECORDING';
  }

  /** A interface está pronta para o push-to-talk. */
  waitForVoice(): void {
    if (this.state === 'IDLE') {
      this.setState('WAITING_FOR_VOICE');
    }
  }

  /**
   * Abre o microfone. Retorna false se não foi possível gravar
   * (o erro já foi comunicado ao usuário pelo fluxo de ERROR).
   */
  async startRecording(): Promise<boolean> {
    if (this.state === 'RECORDING') {
      throw new CelesteError('ALREADY_RECORDING');
    }
    if (this.isBusy()) {
      throw new CelesteError(
        'ALREADY_RECORDING',
        `Pipeline busy (${this.state})`,
        'Aguarde, ainda estou processando o comando anterior.'
      );
    }

    // Se a Celeste estiver falando (ex.: anunciando uma mensagem), para de falar para ouvir.
    this.handler.stopSpeaking();
    const turn = this.turn;
    this.setState('RECORDING');

    try {
      await this.speechInput.startRecording();
    } catch (error) {
      if (turn === this.turn) {
        await this.fail(error);
      }
      return false;
    }

    if (turn !== this.turn) {
      // Cancelado enquanto o microfone abria.
      await this.speechInput.cancel();
      return false;
    }

    this.maxRecordingTimer = setTimeout(() => {
      Logger.info('Max recording time reached, stopping automatically');
      void this.stopAndProcess();
    }, this.maxRecordingMs);
    return true;
  }

  /** Finaliza a gravação e executa o restante do fluxo até a resposta falada. */
  stopAndProcess(): Promise<VoiceTurnResult> {
    if (this.state !== 'RECORDING') {
      return Promise.resolve(this.activeTurn ? this.activeTurn : { error: new CelesteError('NOT_RECORDING') });
    }
    this.clearTimer();
    this.activeTurn = this.runTurn(this.turn)
      .then((result) => {
        this.turnListeners.forEach((listener) => listener(result));
        return result;
      })
      .finally(() => {
        this.activeTurn = undefined;
      });
    return this.activeTurn;
  }

  /** Ctrl+C: interrompe gravação/processamento/fala e volta para IDLE. */
  async cancel(): Promise<void> {
    this.handler.stopSpeaking();
    if (!this.isBusy()) {
      return;
    }

    Logger.info('Voice interaction cancelled', { state: this.state });
    this.turn++;
    this.clearTimer();
    const wasRecording = this.state === 'RECORDING';
    this.setState('IDLE');

    if (wasRecording || this.speechInput.isRecording()) {
      await this.speechInput.cancel().catch((error) => {
        Logger.warn('Error cancelling recording', { error: String(error) });
      });
    }
  }

  private async runTurn(turn: number): Promise<VoiceTurnResult> {
    const cancelled = () => turn !== this.turn;
    let transcription: string | undefined;

    try {
      this.setState('PROCESSING_AUDIO');
      const audio = await this.speechInput.stopRecording();
      if (cancelled()) {
        this.speechInput.discard(audio.path);
        return { cancelled: true };
      }

      this.setState('TRANSCRIBING');
      transcription = await this.speechInput.transcribe(audio);
      if (cancelled()) {
        return { transcription, cancelled: true };
      }

      this.setState('COMMAND_PROCESSING');
      const result = await this.handler.processCommand(transcription, 'voice', () => {
        if (!cancelled()) {
          this.setState('ACTION');
        }
      });
      if (cancelled()) {
        return { transcription, result, cancelled: true };
      }

      this.setState('TTS_RESPONSE');
      await this.handler.speak(result.reply);
      if (!cancelled()) {
        this.setState('IDLE');
      }
      return { transcription, result };
    } catch (error) {
      if (cancelled()) {
        return { transcription, cancelled: true };
      }
      return { transcription, error: await this.fail(error) };
    }
  }

  private async fail(error: unknown): Promise<CelesteError> {
    const celesteError = CelesteError.from(error);
    // Áudio vazio/incompreensível é esperado: o usuário já é avisado por voz.
    const expected = ['EMPTY_AUDIO', 'SILENT_AUDIO', 'EMPTY_TRANSCRIPTION'].includes(celesteError.code);
    const log = expected ? Logger.info : Logger.warn;
    log('Voice interaction failed', { code: celesteError.code, detail: celesteError.detail });

    this.clearTimer();
    this.setState('ERROR');
    await this.eventBus.emit('ERROR', {
      code: celesteError.code,
      message: celesteError.userMessage,
    });
    try {
      await this.handler.speak(celesteError.userMessage);
    } catch {
      // Sem TTS o terminal ainda exibe a mensagem (evento ASSISTANT_SPEECH).
    }
    this.setState('IDLE');
    return celesteError;
  }

  private setState(state: VoicePipelineState): void {
    const previous = this.state;
    if (previous === state) {
      return;
    }
    this.state = state;
    Logger.debug('Voice state', { from: previous, to: state });
    void this.eventBus.emit('VOICE_STATE_CHANGED', { from: previous, to: state });

    if (state === 'RECORDING') {
      void this.eventBus.emit('LISTENING_STARTED');
    } else if (previous === 'RECORDING') {
      void this.eventBus.emit('LISTENING_FINISHED', { next: state });
    }
    if (state === 'PROCESSING_AUDIO') {
      void this.eventBus.emit('THINKING_STARTED', { source: 'voice' });
    }
    this.listeners.forEach((listener) => listener(state, previous));
  }

  private clearTimer(): void {
    if (this.maxRecordingTimer) {
      clearTimeout(this.maxRecordingTimer);
      this.maxRecordingTimer = undefined;
    }
  }
}
