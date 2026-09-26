import dotenv from 'dotenv';

dotenv.config();

export class Config {
  static get ollamaHost(): string {
    return process.env.OLLAMA_HOST || 'http://localhost:11434';
  }

  static get ollamaModel(): string {
    return process.env.OLLAMA_MODEL || 'llama3.2';
  }

  static get whisperModel(): string {
    return process.env.WHISPER_MODEL || 'base';
  }

  static get whisperLanguage(): string {
    return process.env.WHISPER_LANGUAGE || 'pt';
  }

  static get piperModel(): string {
    return process.env.PIPER_MODEL || 'pt_BR-glow_tts';
  }

  static get piperVoicePath(): string {
    return process.env.PIPER_VOICE_PATH || '';
  }

  static get whatsappSessionPath(): string {
    return process.env.WHATSAPP_SESSION_PATH || './sessions';
  }

  static get whatsappAuthTimeout(): number {
    return parseInt(process.env.WHATSAPP_AUTH_TIMEOUT || '60000', 10);
  }

  static get databasePath(): string {
    return process.env.DATABASE_PATH || './celeste.db';
  }

  static get logLevel(): string {
    return process.env.LOG_LEVEL || 'info';
  }

  static get logFile(): string {
    return process.env.LOG_FILE || './logs/celeste.log';
  }

  static get audioTempDir(): string {
    return process.env.AUDIO_TEMP_DIR || './tmp/audio';
  }

  static get keepAudioFiles(): boolean {
    return process.env.KEEP_AUDIO_FILES === 'true';
  }

  static get aiTemperature(): number {
    return parseFloat(process.env.AI_TEMPERATURE || '0.7');
  }

  static get aiMaxTokens(): number {
    return parseInt(process.env.AI_MAX_TOKENS || '500', 10);
  }
}
