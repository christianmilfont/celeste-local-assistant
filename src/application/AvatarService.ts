import { EventBus } from '../core/EventBus';
import {
  AssistantEvent,
  AvatarController,
  AvatarState,
  AvatarStateDetails,
} from '../core/types';
import { Logger } from '../infrastructure/logging/Logger';

/** Quanto tempo o ERROR fica visível depois que a Celeste termina de falar o problema. */
const ERROR_HOLD_MS = 2500;

/**
 * Máquina de estados visual do avatar. Traduz os eventos do core (voz, TTS, WhatsApp, erros)
 * em estados e publica AVATAR_STATE_CHANGED. Não conhece HTML/SVG: quem desenha é o frontend.
 *
 *   LISTENING_STARTED -> LISTENING
 *   THINKING_STARTED  -> THINKING
 *   TTS_STARTED       -> SPEAKING
 *   TTS_FINISHED      -> IDLE (ou ERROR por alguns segundos, se a fala era um erro)
 *   ERROR (com code)  -> ERROR
 *   MESSAGE_RECEIVED  -> LISTENING (atenção), antes do anúncio falado
 */
export class AvatarService implements AvatarController {
  private state: AvatarState = 'IDLE';
  private errorPending = false;
  private errorTimer?: NodeJS.Timeout;

  constructor(
    private eventBus: EventBus,
    private errorHoldMs: number = ERROR_HOLD_MS
  ) {
    this.subscribe();
  }

  getState(): AvatarState {
    return this.state;
  }

  setState(state: AvatarState, details: AvatarStateDetails = {}): void {
    this.clearErrorTimer();
    const previous = this.state;
    if (previous === state && state !== 'SPEAKING') {
      return;
    }
    this.state = state;
    Logger.debug('Avatar state', { from: previous, to: state, reason: details.reason });
    void this.eventBus.emit('AVATAR_STATE_CHANGED', { state, previous, ...details });
  }

  dispose(): void {
    this.clearErrorTimer();
  }

  private subscribe(): void {
    const on = (type: Parameters<EventBus['on']>[0], handler: (event: AssistantEvent) => void) =>
      this.eventBus.on(type, handler);

    on('LISTENING_STARTED', () => {
      this.errorPending = false;
      this.setState('LISTENING', { reason: 'voice' });
    });

    on('LISTENING_FINISHED', (event) => {
      // Gravação cancelada: sem processamento a seguir.
      if (event.data?.next === 'IDLE' && this.state === 'LISTENING') {
        this.setState('IDLE', { reason: 'cancelled' });
      }
    });

    on('THINKING_STARTED', () => {
      this.errorPending = false;
      this.setState('THINKING');
    });

    on('TTS_STARTED', (event) => {
      this.setState('SPEAKING', { text: event.data?.text, alert: this.errorPending });
    });

    on('TTS_FINISHED', () => {
      // Uma fala interrompida pelo usuário (ENTER para falar) não pode tirar o avatar de LISTENING.
      if (this.state !== 'SPEAKING') {
        return;
      }
      if (this.errorPending) {
        this.showErrorThenIdle();
      } else {
        this.setState('IDLE');
      }
    });

    on('ERROR', (event) => {
      // Só erros comunicados ao usuário (com code) mudam o avatar.
      if (!event.data?.code) {
        return;
      }
      this.errorPending = true;
      this.showErrorThenIdle(event.data.message);
    });

    on('MESSAGE_RECEIVED', () => {
      if (this.state === 'IDLE') {
        this.setState('LISTENING', { reason: 'message' });
      }
    });

    on('VOICE_STATE_CHANGED', (event) => {
      // Ctrl+C durante gravação/processamento: volta ao repouso.
      if (event.data?.to === 'IDLE' && (this.state === 'LISTENING' || this.state === 'THINKING')) {
        this.setState('IDLE', { reason: 'cancelled' });
      }
    });
  }

  private showErrorThenIdle(message?: string): void {
    this.setState('ERROR', { text: message, alert: true });
    this.errorTimer = setTimeout(() => {
      this.errorTimer = undefined;
      this.errorPending = false;
      if (this.state === 'ERROR') {
        this.setState('IDLE');
      }
    }, this.errorHoldMs);
    this.errorTimer.unref?.();
  }

  private clearErrorTimer(): void {
    if (this.errorTimer) {
      clearTimeout(this.errorTimer);
      this.errorTimer = undefined;
    }
  }
}
