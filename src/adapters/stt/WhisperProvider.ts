import { ChildProcess, spawn, execFile } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import { SpeechToTextProvider } from '../../core/types/adapters';
import { CelesteError } from '../../core/errors';
import { Config } from '../../infrastructure/config/Config';
import { Logger } from '../../infrastructure/logging/Logger';

interface PendingTranscription {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Whisper local via faster-whisper (Python), executado como worker persistente:
 * o modelo é carregado uma única vez e reutilizado em todas as transcrições.
 * Ver scripts/stt/whisper_worker.py.
 */
export class WhisperProvider implements SpeechToTextProvider {
  private model: string;
  private language: string;
  private worker: ChildProcess | null = null;
  private workerReady: Promise<void> | null = null;
  private pending = new Map<number, PendingTranscription>();
  private nextId = 1;
  private available = false;
  private lastStderr = '';

  constructor(
    private pythonPath: string = Config.whisperPython,
    private scriptPath: string = path.resolve(__dirname, '../../../scripts/stt/whisper_worker.py')
  ) {
    this.model = Config.whisperModel;
    this.language = Config.whisperLanguage;
  }

  async transcribe(audioPath: string): Promise<string> {
    Logger.debug('Starting transcription with Whisper', { audioPath });

    await this.ensureWorker();

    const id = this.nextId++;
    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CelesteError('TIMEOUT', 'Whisper transcription timed out'));
        // O worker pode estar travado: reinicia na próxima transcrição.
        this.dispose();
      }, Config.whisperTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.stdin!.write(`${JSON.stringify({ id, path: path.resolve(audioPath) })}\n`);
    });

    Logger.debug('Transcription completed', { transcription: text });
    return text;
  }

  /** Inicia o worker e carrega o modelo em segundo plano. */
  async warmUp(): Promise<void> {
    await this.ensureWorker();
  }

  isAvailable(): boolean {
    return this.available;
  }

  async checkAvailability(): Promise<boolean> {
    if (this.worker && this.workerReady) {
      return this.available;
    }
    this.available = await new Promise<boolean>((resolve) => {
      execFile(
        this.pythonPath,
        ['-c', 'import faster_whisper'],
        { timeout: 30000, windowsHide: true },
        (error) => {
          if (error) {
            Logger.warn('Whisper unavailable (python/faster-whisper not found)', {
              python: this.pythonPath,
              error: error.message,
            });
          }
          resolve(!error);
        }
      );
    });
    return this.available;
  }

  dispose(): void {
    const worker = this.worker;
    this.resetWorker(new CelesteError('CANCELLED', 'Whisper worker disposed'));
    if (worker && worker.exitCode === null) {
      worker.kill();
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.workerReady) {
      return this.workerReady;
    }

    Logger.info('Starting Whisper worker', { model: this.model, python: this.pythonPath });

    const worker = spawn(this.pythonPath, [this.scriptPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        WHISPER_MODEL: this.model,
        WHISPER_LANGUAGE: this.language,
        WHISPER_DEVICE: Config.whisperDevice,
        WHISPER_COMPUTE_TYPE: Config.whisperComputeType,
        WHISPER_INITIAL_PROMPT: Config.whisperInitialPrompt,
      },
    });
    this.worker = worker;
    this.lastStderr = '';

    this.workerReady = new Promise<void>((resolve, reject) => {
      const startupTimer = setTimeout(() => {
        reject(new CelesteError('TIMEOUT', 'Whisper model load timed out'));
        this.dispose();
      }, Config.whisperStartupTimeoutMs);

      readline.createInterface({ input: worker.stdout! }).on('line', (line) => {
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          Logger.debug('Whisper worker output', { line });
          return;
        }

        if (message.ready) {
          clearTimeout(startupTimer);
          this.available = true;
          Logger.info('Whisper model loaded');
          resolve();
        } else if (message.fatal) {
          clearTimeout(startupTimer);
          this.available = false;
          reject(new CelesteError('STT_UNAVAILABLE', message.fatal));
        } else if (typeof message.id === 'number') {
          this.settle(message);
        }
      });

      worker.on('error', (error) => {
        clearTimeout(startupTimer);
        this.available = false;
        reject(new CelesteError('STT_UNAVAILABLE', error.message));
        this.resetWorker(new CelesteError('STT_UNAVAILABLE', error.message));
      });

      worker.on('exit', (code) => {
        clearTimeout(startupTimer);
        if (this.worker === worker) {
          const detail = `Whisper worker exited (${code}). ${this.lastStderr.slice(-500)}`;
          Logger.warn('Whisper worker exited', { code });
          reject(new CelesteError('STT_UNAVAILABLE', detail));
          this.resetWorker(new CelesteError('STT_UNAVAILABLE', detail));
        }
      });
    });

    worker.stderr!.on('data', (data) => {
      const text = data.toString();
      this.lastStderr = (this.lastStderr + text).slice(-2000);
      Logger.debug('Whisper stderr', { stderr: text });
    });

    this.workerReady.catch(() => undefined);
    return this.workerReady;
  }

  private settle(message: { id: number; text?: string; error?: string }): void {
    const request = this.pending.get(message.id);
    if (!request) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(request.timer);

    if (message.error) {
      request.reject(new CelesteError('STT_UNAVAILABLE', message.error));
    } else {
      request.resolve((message.text || '').trim());
    }
  }

  private resetWorker(error: Error): void {
    this.worker = null;
    this.workerReady = null;
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    pending.forEach((request) => {
      clearTimeout(request.timer);
      request.reject(error);
    });
  }
}
