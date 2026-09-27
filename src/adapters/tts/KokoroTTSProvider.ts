import { ChildProcess, spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { SpeakHooks, TextToSpeechProvider } from '../../core/types/adapters';
import { Config } from '../../infrastructure/config/Config';
import { Logger } from '../../infrastructure/logging/Logger';

interface PendingSpeech {
  resolve: () => void;
  reject: (error: Error) => void;
  onStart?: () => void;
}

/**
 * Voz neural local (Kokoro-82M, voz feminina pt-BR "pf_dora") via worker Python persistente.
 * O worker sintetiza frase por frase e toca o áudio enquanto gera a próxima (ver
 * scripts/tts/kokoro_worker.py). Emite o início real do áudio para o avatar sincronizar a boca.
 */
export class KokoroTTSProvider implements TextToSpeechProvider {
  readonly notifiesStart = true;
  private worker: ChildProcess | null = null;
  private workerReady: Promise<void> | null = null;
  private pending = new Map<number, PendingSpeech>();
  private nextId = 1;
  private available = false;
  private lastStderr = '';

  constructor(
    private pythonPath: string = Config.whisperPython,
    private scriptPath: string = path.resolve(__dirname, '../../../scripts/tts/kokoro_worker.py')
  ) {}

  /** Os arquivos do modelo existem? (sem eles, usa-se a voz do sistema) */
  static modelFilesPresent(): boolean {
    return fs.existsSync(Config.kokoroModel) && fs.existsSync(Config.kokoroVoices);
  }

  async speak(text: string, hooks: SpeakHooks = {}): Promise<void> {
    if (!text.trim()) {
      return;
    }
    await this.ensureWorker();
    const id = this.nextId++;
    await new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onStart: hooks.onStart });
      this.worker!.stdin!.write(
        `${JSON.stringify({ type: 'speak', id, text, voice: Config.kokoroVoice, speed: Config.kokoroSpeed })}\n`
      );
    });
  }

  /** Interrompe na hora: a Celeste é liberada sem esperar o worker confirmar. */
  stop(): void {
    if (this.worker && this.worker.exitCode === null) {
      this.worker.stdin?.write(`${JSON.stringify({ type: 'stop' })}\n`);
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    pending.forEach((speech) => {
      speech.onStart?.();
      speech.resolve();
    });
  }

  async warmUp(): Promise<void> {
    await this.ensureWorker();
  }

  isAvailable(): boolean {
    return this.available;
  }

  async checkAvailability(): Promise<boolean> {
    if (this.workerReady) {
      return this.available;
    }
    if (!KokoroTTSProvider.modelFilesPresent()) {
      this.available = false;
      return false;
    }
    this.available = await new Promise<boolean>((resolve) => {
      execFile(this.pythonPath, ['-c', 'import kokoro_onnx, sounddevice'], { timeout: 30000, windowsHide: true }, (error) =>
        resolve(!error)
      );
    });
    return this.available;
  }

  dispose(): void {
    const worker = this.worker;
    this.reset(new Error('TTS worker disposed'));
    if (worker && worker.exitCode === null) {
      worker.kill();
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.workerReady) {
      return this.workerReady;
    }
    Logger.info('Starting Kokoro TTS worker', { voice: Config.kokoroVoice });

    const worker = spawn(this.pythonPath, [this.scriptPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        KOKORO_MODEL: path.resolve(Config.kokoroModel),
        KOKORO_VOICES: path.resolve(Config.kokoroVoices),
        KOKORO_VOICE: Config.kokoroVoice,
        KOKORO_SPEED: String(Config.kokoroSpeed),
        KOKORO_LANG: 'pt-br',
      },
    });
    this.worker = worker;
    this.lastStderr = '';

    this.workerReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Kokoro worker startup timed out'));
        this.dispose();
      }, 120000);

      readline.createInterface({ input: worker.stdout! }).on('line', (line) => {
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.ready) {
          clearTimeout(timer);
          this.available = true;
          Logger.info('Kokoro TTS ready');
          resolve();
        } else if (message.fatal) {
          clearTimeout(timer);
          this.available = false;
          reject(new Error(`Kokoro: ${message.fatal}`));
        } else if (typeof message.id === 'number') {
          this.handleEvent(message);
        }
      });

      worker.on('error', (error) => {
        clearTimeout(timer);
        this.available = false;
        reject(error);
        this.reset(error);
      });
      worker.on('exit', (code) => {
        clearTimeout(timer);
        if (this.worker === worker) {
          const error = new Error(`Kokoro worker exited (${code}). ${this.lastStderr.slice(-400)}`);
          reject(error);
          this.reset(error);
        }
      });
    });

    worker.stderr!.on('data', (data) => {
      this.lastStderr = (this.lastStderr + data.toString()).slice(-2000);
    });
    this.workerReady.catch(() => undefined);
    return this.workerReady;
  }

  private handleEvent(message: { id: number; event: string; error?: string }): void {
    const speech = this.pending.get(message.id);
    if (!speech) return;
    if (message.event === 'started') {
      speech.onStart?.();
    } else if (message.event === 'done') {
      this.pending.delete(message.id);
      speech.resolve();
    } else if (message.event === 'error') {
      this.pending.delete(message.id);
      speech.reject(new Error(message.error || 'Kokoro error'));
    }
  }

  private reset(error: Error): void {
    this.worker = null;
    this.workerReady = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    pending.forEach((speech) => speech.reject(error));
  }
}
