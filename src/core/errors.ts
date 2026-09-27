export type CelesteErrorCode =
  | 'MIC_UNAVAILABLE'
  | 'MIC_PERMISSION_DENIED'
  | 'EMPTY_AUDIO'
  | 'SILENT_AUDIO'
  | 'STT_UNAVAILABLE'
  | 'EMPTY_TRANSCRIPTION'
  | 'AI_UNAVAILABLE'
  | 'TTS_UNAVAILABLE'
  | 'WHATSAPP_DISCONNECTED'
  | 'TIMEOUT'
  | 'NOT_RECORDING'
  | 'ALREADY_RECORDING'
  | 'CANCELLED'
  | 'UNKNOWN';

const USER_MESSAGES: Record<CelesteErrorCode, string> = {
  MIC_UNAVAILABLE:
    'Não consegui acessar o microfone. Verifique se ele está conectado.',
  MIC_PERMISSION_DENIED:
    'O acesso ao microfone foi negado. Libere o microfone nas configurações de privacidade do sistema.',
  EMPTY_AUDIO: 'A gravação ficou muito curta. Segure um pouco mais e fale de novo.',
  SILENT_AUDIO:
    'Não captei nenhum som. Verifique se o microfone não está mudo e se o acesso ao microfone está permitido.',
  STT_UNAVAILABLE: 'O reconhecimento de voz está indisponível no momento.',
  EMPTY_TRANSCRIPTION: 'Não consegui entender o áudio. Pode repetir?',
  AI_UNAVAILABLE: 'A inteligência artificial está indisponível no momento.',
  TTS_UNAVAILABLE: 'A síntese de voz está indisponível no momento.',
  WHATSAPP_DISCONNECTED: 'O WhatsApp está desconectado no momento.',
  TIMEOUT: 'A operação demorou demais e foi interrompida. Tente novamente.',
  NOT_RECORDING: 'Não há gravação em andamento.',
  ALREADY_RECORDING: 'Já estou gravando.',
  CANCELLED: 'Cancelado.',
  UNKNOWN: 'Ocorreu um erro. Tente novamente.',
};

/**
 * Erro de domínio com código estável e mensagem amigável (pt-BR) para o usuário.
 * A mensagem técnica fica em `message`/`detail` para os logs.
 */
export class CelesteError extends Error {
  readonly userMessage: string;

  constructor(
    readonly code: CelesteErrorCode,
    readonly detail?: string,
    userMessage?: string
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'CelesteError';
    this.userMessage = userMessage ?? USER_MESSAGES[code];
  }

  static from(error: unknown): CelesteError {
    if (error instanceof CelesteError) {
      return error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new CelesteError('UNKNOWN', detail);
  }
}
