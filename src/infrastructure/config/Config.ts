import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config({ quiet: true } as dotenv.DotenvConfigOptions);

function envInt(name: string, fallback: number): number {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

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

  /** Python usado pelo worker do Whisper. Por padrão usa o venv do projeto (.venv). */
  static get whisperPython(): string {
    if (process.env.WHISPER_PYTHON) {
      return process.env.WHISPER_PYTHON;
    }
    const venvPython =
      process.platform === 'win32'
        ? path.resolve('.venv', 'Scripts', 'python.exe')
        : path.resolve('.venv', 'bin', 'python');
    if (fs.existsSync(venvPython)) {
      return venvPython;
    }
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  static get whisperDevice(): string {
    return process.env.WHISPER_DEVICE || 'cpu';
  }

  static get whisperComputeType(): string {
    return process.env.WHISPER_COMPUTE_TYPE || 'int8';
  }

  /** Vocabulário que ajuda o Whisper a reconhecer o nome "Celeste" e os comandos. */
  static get whisperInitialPrompt(): string {
    return (
      process.env.WHISPER_INITIAL_PROMPT ??
      'Celeste, status. Leia a última mensagem. Responde para o João dizendo que já vou verificar. Pode enviar.'
    );
  }

  static get whisperTimeoutMs(): number {
    return envInt('WHISPER_TIMEOUT_MS', 60000);
  }

  /** Tempo máximo para carregar o modelo (inclui o download na primeira execução). */
  static get whisperStartupTimeoutMs(): number {
    return envInt('WHISPER_STARTUP_TIMEOUT_MS', 300000);
  }

  static get piperModel(): string {
    return process.env.PIPER_MODEL || 'pt_BR-glow_tts';
  }

  static get piperVoicePath(): string {
    return process.env.PIPER_VOICE_PATH || '';
  }

  /** Nome da voz do Windows (ex.: "Microsoft Maria Desktop"). Vazio = primeira voz pt-BR. */
  static get ttsVoice(): string {
    return process.env.TTS_VOICE || '';
  }

  /** Velocidade da voz no Windows, de -10 a 10. */
  static get ttsRate(): number {
    return envInt('TTS_RATE', 0);
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

  /** Nível dos logs exibidos no terminal. O restante vai apenas para LOG_FILE. */
  static get logConsoleLevel(): string {
    return process.env.LOG_CONSOLE_LEVEL || 'warn';
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

  /** Gravação push-to-talk é finalizada automaticamente após este tempo. */
  static get voiceMaxRecordingMs(): number {
    return envInt('VOICE_MAX_RECORDING_MS', 30000);
  }

  /** Gravações menores que isso são consideradas vazias. */
  static get voiceMinRecordingMs(): number {
    return envInt('VOICE_MIN_RECORDING_MS', 400);
  }

  /** Pico mínimo (0-32767) para considerar que houve som na gravação. */
  static get voiceSilenceThreshold(): number {
    return envInt('VOICE_SILENCE_THRESHOLD', 400);
  }

  /** Serve a página do avatar 2D (http://AVATAR_HOST:AVATAR_PORT). */
  static get avatarEnabled(): boolean {
    return process.env.AVATAR_ENABLED !== 'false';
  }

  /** 127.0.0.1 = só este computador. Use 0.0.0.0 para abrir o avatar em outro dispositivo da rede. */
  static get avatarHost(): string {
    return process.env.AVATAR_HOST || '127.0.0.1';
  }

  static get avatarPort(): number {
    return envInt('AVATAR_PORT', 7717);
  }

  /** app = janela própria (Edge/Chrome --app); browser = navegador padrão; none = não abre. */
  static get avatarWindow(): 'app' | 'browser' | 'none' {
    const value = process.env.AVATAR_WINDOW;
    return value === 'browser' || value === 'none' ? value : 'app';
  }

  static get avatarFullscreen(): boolean {
    return process.env.AVATAR_FULLSCREEN === 'true';
  }

  static get aiTemperature(): number {
    return parseFloat(process.env.AI_TEMPERATURE || '0.7');
  }

  static get aiMaxTokens(): number {
    return parseInt(process.env.AI_MAX_TOKENS || '500', 10);
  }

  static get aiTimeoutMs(): number {
    return envInt('AI_TIMEOUT_MS', 60000);
  }

  /** Tempo máximo para o carregamento inicial do modelo no Ollama. */
  static get aiWarmUpTimeoutMs(): number {
    return envInt('AI_WARMUP_TIMEOUT_MS', 300000);
  }

  /** Quanto tempo o Ollama mantém o modelo carregado entre comandos. */
  static get ollamaKeepAlive(): string {
    return process.env.OLLAMA_KEEP_ALIVE || '30m';
  }

  /** Usa o LLM para redigir a resposta a partir do que o usuário ditou. */
  static get aiRewriteReplies(): boolean {
    return process.env.AI_REWRITE_REPLIES !== 'false';
  }
}
