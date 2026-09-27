import { SpeakHooks, TextToSpeechProvider } from '../../core/types/adapters';
import { Config } from '../../infrastructure/config/Config';
import { Logger } from '../../infrastructure/logging/Logger';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Windows: System.Speech (nativo). O texto chega em base64 por variável de ambiente,
 * evitando problemas de aspas/acentos na linha de comando. Prefere uma voz pt-BR.
 */
const WINDOWS_SPEAK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:CELESTE_TTS_TEXT))
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo }
$voice = $null
if ($env:CELESTE_TTS_VOICE) { $voice = $voices | Where-Object { $_.Name -eq $env:CELESTE_TTS_VOICE } | Select-Object -First 1 }
if (-not $voice) { $voice = $voices | Where-Object { $_.Culture.Name -eq 'pt-BR' } | Select-Object -First 1 }
if ($voice) { $synth.SelectVoice($voice.Name) }
$synth.Rate = [int]$env:CELESTE_TTS_RATE
[Console]::Out.WriteLine('SPEAKING'); [Console]::Out.Flush()
$synth.Speak($text)
$synth.Dispose()
`;

const WINDOWS_CHECK_SCRIPT = String.raw`
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
Write-Output ($synth.GetInstalledVoices().Count)
`;

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export class PiperTTSProvider implements TextToSpeechProvider {
  private model: string;
  private voicePath: string;
  private tempDir: string;
  private available = true;
  private current: ChildProcess | null = null;
  readonly notifiesStart = true;

  constructor() {
    this.model = Config.piperModel;
    this.voicePath = Config.piperVoicePath;
    this.tempDir = Config.audioTempDir;

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async speak(text: string, hooks: SpeakHooks = {}): Promise<void> {
    if (!text.trim()) {
      return;
    }
    try {
      Logger.debug('Starting TTS', { textLength: text.length });

      if (process.platform === 'win32') {
        await this.speakWindows(text, hooks);
      } else {
        await this.speakPiper(text, hooks);
      }

      this.available = true;
      Logger.info('TTS completed');
    } catch (error) {
      Logger.error('Failed to speak text', error);
      this.available = false;
      throw new Error(`TTS failed: ${error}`);
    }
  }

  /** Interrompe a fala atual (usado no Ctrl+C). */
  stop(): void {
    if (this.current && this.current.exitCode === null) {
      this.current.kill();
    }
    this.current = null;
  }

  private async speakWindows(text: string, hooks: SpeakHooks): Promise<void> {
    await this.run(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(WINDOWS_SPEAK_SCRIPT)],
      {
        CELESTE_TTS_TEXT: Buffer.from(text, 'utf8').toString('base64'),
        CELESTE_TTS_VOICE: Config.ttsVoice,
        CELESTE_TTS_RATE: String(Config.ttsRate),
      },
      undefined,
      (line) => {
        if (line === 'SPEAKING') {
          hooks.onStart?.();
        }
      }
    );
  }

  private async speakPiper(text: string, hooks: SpeakHooks): Promise<void> {
    const outputPath = path.join(this.tempDir, `output_${Date.now()}.wav`);
    const model = this.voicePath || this.model;

    try {
      await this.run('piper', ['--model', model, '--output_file', outputPath], {}, text);

      Logger.debug('Audio generated, playing...');

      hooks.onStart?.();
      await this.playAudio(outputPath);
    } finally {
      if (!Config.keepAudioFiles && fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
        Logger.debug('Temporary audio file deleted');
      }
    }
  }

  private async playAudio(audioPath: string): Promise<void> {
    switch (process.platform) {
      case 'darwin':
        return this.run('afplay', [audioPath]);
      case 'linux':
        return this.run('aplay', ['-q', audioPath]).catch(() => this.run('paplay', [audioPath]));
      default:
        throw new Error(`Unsupported platform: ${process.platform}`);
    }
  }

  private run(
    command: string,
    args: string[],
    env: Record<string, string> = {},
    stdin?: string,
    onLine?: (line: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        windowsHide: true,
        env: { ...process.env, ...env },
        stdio: [stdin !== undefined ? 'pipe' : 'ignore', onLine ? 'pipe' : 'ignore', 'pipe'],
      });
      this.current = child;

      if (onLine) {
        child.stdout!.on('data', (data) => {
          data
            .toString()
            .split(/\r?\n/)
            .forEach((line: string) => line.trim() && onLine(line.trim()));
        });
      }

      let stderr = '';
      child.stderr!.on('data', (data) => (stderr += data.toString()));
      child.on('error', (error) => reject(error));
      child.on('exit', (code, signal) => {
        if (this.current === child) {
          this.current = null;
        }
        // Encerrado por stop(): não é erro.
        if (code === 0 || signal || child.killed) {
          resolve();
        } else {
          reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
        }
      });

      if (stdin !== undefined) {
        child.stdin!.end(stdin);
      }
    });
  }

  isAvailable(): boolean {
    return this.available;
  }

  async checkAvailability(): Promise<boolean> {
    if (process.platform !== 'win32') {
      this.available = await this.run('piper', ['--help']).then(
        () => true,
        () => false
      );
      return this.available;
    }

    this.available = await new Promise<boolean>((resolve) => {
      const child = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(WINDOWS_CHECK_SCRIPT)],
        { windowsHide: true }
      );
      let stdout = '';
      child.stdout.on('data', (data) => (stdout += data.toString()));
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0 && parseInt(stdout.trim(), 10) > 0));
    });
    return this.available;
  }
}
