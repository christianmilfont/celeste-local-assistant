import { SpeakHooks, TextToSpeechProvider } from '../../core/types/adapters';
import { Logger } from '../../infrastructure/logging/Logger';

/**
 * Usa a voz principal (neural) e, se ela falhar ou estiver indisponível, a voz reserva (sistema).
 * Assim a Celeste nunca fica muda por causa de um problema no modelo de voz.
 */
export class FallbackTTSProvider implements TextToSpeechProvider {
  readonly notifiesStart = true;
  private primaryHealthy = true;

  constructor(
    private primary: TextToSpeechProvider,
    private fallback: TextToSpeechProvider
  ) {}

  async speak(text: string, hooks: SpeakHooks = {}): Promise<void> {
    if (this.primaryHealthy) {
      let started = false;
      try {
        await this.primary.speak(text, {
          onStart: () => {
            started = true;
            hooks.onStart?.();
          },
        });
        return;
      } catch (error) {
        Logger.warn('Primary voice failed, using system voice', { error: String(error) });
        this.primaryHealthy = false;
        if (started) return; // já falou parte: não repete a frase com outra voz
      }
    }
    if (!this.fallback.notifiesStart) hooks.onStart?.();
    await this.fallback.speak(text, this.fallback.notifiesStart ? hooks : {});
  }

  stop(): void {
    this.primary.stop?.();
    this.fallback.stop?.();
  }

  isAvailable(): boolean {
    return this.primary.isAvailable() || this.fallback.isAvailable();
  }

  async checkAvailability(): Promise<boolean> {
    const [primary, fallback] = await Promise.all([
      this.primary.checkAvailability?.() ?? Promise.resolve(this.primary.isAvailable()),
      this.fallback.checkAvailability?.() ?? Promise.resolve(this.fallback.isAvailable()),
    ]);
    this.primaryHealthy = primary;
    if (!primary) Logger.warn('Neural voice unavailable, using system voice');
    return primary || fallback;
  }

  async warmUp(): Promise<void> {
    if (!this.primaryHealthy) return;
    await this.primary.warmUp?.().catch((error) => {
      Logger.warn('Neural voice failed to start, using system voice', { error: String(error) });
      this.primaryHealthy = false;
    });
  }

  dispose(): void {
    this.primary.dispose?.();
    this.fallback.dispose?.();
  }

  /** Nome da voz em uso (para o painel). */
  describe(): string {
    return this.primaryHealthy ? 'neural (Kokoro)' : 'sistema (Windows)';
  }
}
