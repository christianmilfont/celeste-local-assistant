import { AIProvider } from '../../core/types/adapters';
import { ConversationContext, IntentType } from '../../core/types';
import { CelesteError } from '../../core/errors';
import { Config } from '../../infrastructure/config/Config';
import { Logger } from '../../infrastructure/logging/Logger';

const KNOWN_INTENTS: IntentType[] = [
  'STATUS',
  'HELP',
  'STOP',
  'READ_LAST_MESSAGE',
  'LIST_MESSAGES',
  'REPLY_TO_MESSAGE',
  'CANCEL',
  'CONFIRM',
  'DENY',
  'REPEAT',
  'UNKNOWN',
];

export class OllamaProvider implements AIProvider {
  private baseUrl: string;
  private model: string;
  private available = false;

  constructor() {
    this.baseUrl = Config.ollamaHost;
    this.model = Config.ollamaModel;
  }

  async generateResponse(
    prompt: string,
    context?: ConversationContext
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt(context);
    const fullPrompt = `${systemPrompt}\n\nInstrução do usuário: ${prompt}\n\nMensagem a enviar:`;

    Logger.debug('Sending request to Ollama', { model: this.model });

    const generatedText = await this.generate(fullPrompt, {
      temperature: Config.aiTemperature,
      num_predict: Config.aiMaxTokens,
    });

    Logger.debug('Received response from Ollama');

    return generatedText.trim();
  }

  async parseIntent(
    transcription: string,
    context?: ConversationContext
  ): Promise<any> {
    const prompt = this.buildIntentPrompt(transcription, context);

    Logger.debug('Parsing intent with Ollama');

    const raw = await this.generate(prompt, { temperature: 0.1, num_predict: 200 }, 'json');

    // Try to parse JSON response
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // If JSON parsing fails, use simple keyword matching
      parsed = this.parseIntentFromText(raw, transcription);
    }

    const intent = String(parsed?.intent || 'UNKNOWN').toUpperCase() as IntentType;
    const result = {
      intent: KNOWN_INTENTS.includes(intent) ? intent : 'UNKNOWN',
      target: typeof parsed?.target === 'string' && parsed.target.trim() ? parsed.target.trim() : undefined,
      response:
        typeof parsed?.response === 'string' && parsed.response.trim() ? parsed.response.trim() : undefined,
      confidence: typeof parsed?.confidence === 'number' ? parsed.confidence : 0.5,
    };

    Logger.debug('Intent parsed', { intent: result.intent });

    return result;
  }

  private async generate(
    prompt: string,
    options: Record<string, number>,
    format?: 'json'
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          ...(format ? { format } : {}),
          keep_alive: Config.ollamaKeepAlive,
          options,
        }),
        signal: AbortSignal.timeout(Config.aiTimeoutMs),
      });
    } catch (error) {
      this.available = false;
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      Logger.error('Failed to reach Ollama', error);
      throw new CelesteError(isTimeout ? 'TIMEOUT' : 'AI_UNAVAILABLE', String(error));
    }

    if (!response.ok) {
      Logger.error('Ollama API error', { status: response.status, statusText: response.statusText });
      if (response.status === 404) {
        this.available = false;
      }
      throw new CelesteError('AI_UNAVAILABLE', `Ollama API error: ${response.status} ${response.statusText}`);
    }

    this.available = true;
    const data = (await response.json()) as any;
    return String(data.response ?? '');
  }

  private parseIntentFromText(aiResponse: string, transcription: string): any {
    const lowerTranscription = transcription.toLowerCase();

    // Simple keyword matching as fallback
    if (lowerTranscription.includes('responde') || lowerTranscription.includes('responder')) {
      // Extract the response part
      const responseMatch = transcription.match(/(?:responde|responder)(?: que)?\s+(.+)/i);
      const response = responseMatch ? responseMatch[1].trim() : undefined;

      return {
        intent: 'REPLY_TO_MESSAGE',
        response: response,
        confidence: 0.8,
      };
    }

    if (lowerTranscription.includes('ajuda') || lowerTranscription.includes('help')) {
      return {
        intent: 'HELP',
        confidence: 0.9,
      };
    }

    return {
      intent: 'UNKNOWN',
      confidence: 0,
    };
  }

  private buildSystemPrompt(context?: ConversationContext): string {
    let systemPrompt = `Você é a Celeste, uma assistente local que ajuda o usuário a responder mensagens do WhatsApp.
Escreva a mensagem que o usuário quer enviar, seguindo a instrução dele.

Regras:
- Escreva em português do Brasil, em primeira pessoa, como se fosse o próprio usuário.
- Seja curta e natural, mantendo exatamente o sentido da instrução.
- Não invente informações, não adicione saudações nem assinaturas.
- Responda APENAS com o texto da mensagem, sem aspas e sem explicações.`;

    if (context?.currentMessage) {
      systemPrompt += `\n\nMensagem recebida que está sendo respondida:
- De: ${context.currentMessage.senderName || 'Desconhecido'}
- Texto: "${context.currentMessage.text}"
- Grupo: ${context.currentMessage.isGroup ? 'sim' : 'não'}`;
    }

    return systemPrompt;
  }

  private buildIntentPrompt(
    transcription: string,
    context?: ConversationContext
  ): string {
    let prompt = `Você interpreta comandos falados em português para a assistente Celeste.
Classifique o comando em UMA intenção:
- STATUS: perguntar como a Celeste/sistema/serviços estão
- HELP: perguntar o que a Celeste sabe fazer
- STOP: pedir para desligar/encerrar a Celeste
- LIST_MESSAGES: perguntar quais/quantas mensagens recebeu
- READ_LAST_MESSAGE: pedir para ler uma mensagem recebida
- REPLY_TO_MESSAGE: pedir para responder/enviar uma mensagem a alguém
- CANCEL: cancelar a ação atual
- CONFIRM: confirmar ("sim", "pode mandar")
- DENY: negar ("não")
- REPEAT: pedir para repetir o que a Celeste disse
- UNKNOWN: nenhuma das anteriores

Retorne SOMENTE um JSON com esta estrutura:
{"intent": "<INTENÇÃO>", "target": "<nome do contato citado ou null>", "response": "<texto que o usuário quer enviar, em primeira pessoa, ou null>", "confidence": <0.0 a 1.0>}

Comando do usuário: "${transcription}"`;

    if (context?.currentMessage) {
      prompt += `\n\nÚltima mensagem recebida (de ${context.currentMessage.senderName || 'desconhecido'}): "${context.currentMessage.text}"`;
    }

    return prompt;
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Carrega o modelo na memória em segundo plano. O primeiro carregamento de um
   * modelo 8B pode levar mais de um minuto; sem isso o primeiro comando estouraria o timeout.
   */
  async warmUp(): Promise<void> {
    if (!this.available) {
      return;
    }
    const started = Date.now();
    try {
      await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: '', keep_alive: Config.ollamaKeepAlive }),
        signal: AbortSignal.timeout(Config.aiWarmUpTimeoutMs),
      });
      Logger.info('Ollama model loaded', { model: this.model, ms: Date.now() - started });
    } catch (error) {
      Logger.warn('Ollama warm-up failed', { error: String(error) });
    }
  }

  /** Verifica se o Ollama responde e se o modelo configurado está instalado. */
  async checkAvailability(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as { models?: Array<{ name: string }> };
      const installed = (data.models || []).map((m) => m.name);
      const resolved = this.resolveModel(installed);

      if (!resolved) {
        Logger.warn(`Ollama model "${this.model}" is not installed`, { installed });
        this.available = false;
      } else {
        if (resolved !== this.model) {
          Logger.info('Using installed Ollama model', { configured: this.model, resolved });
          this.model = resolved;
        }
        this.available = true;
      }
    } catch (error) {
      Logger.warn('Ollama unavailable', { host: this.baseUrl, error: String(error) });
      this.available = false;
    }
    return this.available;
  }

  /** "llama3.1" também aceita "llama3.1:latest" ou uma única tag instalada (ex.: "llama3.1:8b"). */
  private resolveModel(installed: string[]): string | undefined {
    if (installed.includes(this.model)) {
      return this.model;
    }
    if (this.model.includes(':')) {
      return undefined;
    }
    if (installed.includes(`${this.model}:latest`)) {
      return `${this.model}:latest`;
    }
    const sameBase = installed.filter((name) => name.split(':')[0] === this.model);
    return sameBase.length === 1 ? sameBase[0] : undefined;
  }
}
