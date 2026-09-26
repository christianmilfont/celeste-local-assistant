import { TextToSpeechProvider } from '../../core/types/adapters';
import { Config } from '../../infrastructure/config/Config';
import { Logger } from '../../infrastructure/logging/Logger';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

export class PiperTTSProvider implements TextToSpeechProvider {
  private model: string;
  private voicePath: string;
  private tempDir: string;

  constructor() {
    this.model = Config.piperModel;
    this.voicePath = Config.piperVoicePath;
    this.tempDir = Config.audioTempDir;

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async speak(text: string): Promise<void> {
    try {
      Logger.debug('Starting TTS', { textLength: text.length });

      const platform = process.platform;

      if (platform === 'win32') {
        await this.speakWindows(text);
      } else {
        await this.speakPiper(text);
      }

      Logger.info('TTS completed');
    } catch (error) {
      Logger.error('Failed to speak text', error);
      throw new Error(`TTS failed: ${error}`);
    }
  }

  private async speakWindows(text: string): Promise<void> {
    const escapedText = text.replace(/'/g, "''");
    const command = `powershell -Command "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${escapedText}')"`;
    await execAsync(command);
  }

  private async speakPiper(text: string): Promise<void> {
    const outputPath = path.join(this.tempDir, `output_${Date.now()}.wav`);
    const command = this.buildPiperCommand(text, outputPath);

    await execAsync(command);

    Logger.debug('Audio generated, playing...');

    await this.playAudio(outputPath);

    if (!Config.keepAudioFiles) {
      fs.unlinkSync(outputPath);
      Logger.debug('Temporary audio file deleted');
    }
  }

  private buildPiperCommand(text: string, outputPath: string): string {
    const voicePath = this.voicePath
      ? `--model ${this.voicePath}`
      : `--model ${this.model}`;

    return `echo "${text}" | piper ${voicePath} --output_file "${outputPath}"`;
  }

  private async playAudio(audioPath: string): Promise<void> {
    const command = this.getPlayCommand(audioPath);
    await execAsync(command);
  }

  private getPlayCommand(audioPath: string): string {
    const platform = process.platform;

    switch (platform) {
      case 'darwin':
        return `afplay "${audioPath}"`;
      case 'linux':
        return `aplay "${audioPath}" || paplay "${audioPath}"`;
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  isAvailable(): boolean {
    return true;
  }
}
