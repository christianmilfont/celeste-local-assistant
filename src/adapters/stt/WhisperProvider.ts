import { SpeechToTextProvider } from '../../core/types/adapters';
import { Config } from '../../infrastructure/config/Config';
import { Logger } from '../../infrastructure/logging/Logger';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class WhisperProvider implements SpeechToTextProvider {
  private model: string;
  private language: string;

  constructor() {
    this.model = Config.whisperModel;
    this.language = Config.whisperLanguage;
  }

  async transcribe(audioPath: string): Promise<string> {
    try {
      Logger.debug('Starting transcription with Whisper', { audioPath });

      const command = this.buildWhisperCommand(audioPath);
      const { stdout, stderr } = await execAsync(command);

      if (stderr) {
        Logger.warn('Whisper stderr output', { stderr });
      }

      const transcription = stdout.trim();
      Logger.debug('Transcription completed', { transcription });

      return transcription;
    } catch (error) {
      Logger.error('Failed to transcribe audio', error);
      throw new Error(`Transcription failed: ${error}`);
    }
  }

  private buildWhisperCommand(audioPath: string): string {
    return `whisper "${audioPath}" --model ${this.model} --language ${this.language} --output_format txt`;
  }

  isAvailable(): boolean {
    return true;
  }
}
