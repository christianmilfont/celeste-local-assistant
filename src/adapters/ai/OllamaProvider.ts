import { AIProvider } from '../../core/types/adapters';
import { ConversationContext } from '../../core/types';
import { Config } from '../../infrastructure/config/Config';
import { Logger } from '../../infrastructure/logging/Logger';

export class OllamaProvider implements AIProvider {
  private baseUrl: string;
  private model: string;

  constructor() {
    this.baseUrl = Config.ollamaHost;
    this.model = Config.ollamaModel;
  }

  async generateResponse(
    prompt: string,
    context?: ConversationContext
  ): Promise<string> {
    try {
      const systemPrompt = this.buildSystemPrompt(context);
      const fullPrompt = `${systemPrompt}\n\nUser: ${prompt}`;

      Logger.debug('Sending request to Ollama', { model: this.model });

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          prompt: fullPrompt,
          stream: false,
          options: {
            temperature: Config.aiTemperature,
            num_predict: Config.aiMaxTokens,
          },
        }),
      });

      if (!response.ok) {
        Logger.error('Ollama API error', { status: response.status, statusText: response.statusText });
        throw new Error(`Ollama API error: ${response.statusText}`);
      }

      const data = await response.json() as any;
      const generatedText = data.response;

      Logger.debug('Received response from Ollama');

      return generatedText.trim();
    } catch (error) {
      Logger.error('Failed to generate response from Ollama', error);
      // Fallback to simple response
      return prompt;
    }
  }

  async parseIntent(
    transcription: string,
    context?: ConversationContext
  ): Promise<any> {
    try {
      const prompt = this.buildIntentPrompt(transcription, context);

      Logger.debug('Parsing intent with Ollama');

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: {
            temperature: 0.3,
            num_predict: 200,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.statusText}`);
      }

      const data = await response.json() as any;
      
      // Try to parse JSON response
      let parsed;
      try {
        parsed = JSON.parse(data.response);
      } catch {
        // If JSON parsing fails, use simple keyword matching
        parsed = this.parseIntentFromText(data.response, transcription);
      }

      Logger.debug('Intent parsed', { intent: parsed.intent });

      return parsed;
    } catch (error) {
      Logger.error('Failed to parse intent', error);
      // Fallback to simple keyword matching
      return this.parseIntentFromText('', transcription);
    }
  }

  private parseIntentFromText(aiResponse: string, transcription: string): any {
    const lowerTranscription = transcription.toLowerCase();
    
    // Simple keyword matching as fallback
    if (lowerTranscription.includes('responde') || lowerTranscription.includes('responder')) {
      // Extract the response part
      const responseMatch = transcription.match(/(?:responde|responder)(?: que)?\s+(.+)/i);
      const response = responseMatch ? responseMatch[1].trim() : 'Sim';
      
      return {
        intent: 'REPLY_TO_MESSAGE',
        response: response,
        confidence: 0.8,
      };
    }
    
    if (lowerTranscription.includes('cancelar') || lowerTranscription.includes('não') || lowerTranscription.includes('nao')) {
      return {
        intent: 'CANCEL',
        confidence: 0.9,
      };
    }
    
    if (lowerTranscription.includes('ajuda') || lowerTranscription.includes('help')) {
      return {
        intent: 'HELP',
        confidence: 0.9,
      };
    }
    
    if (lowerTranscription.includes('pode') || lowerTranscription.includes('sim') || lowerTranscription.includes('envia')) {
      return {
        intent: 'CONFIRM',
        confidence: 0.9,
      };
    }
    
    return {
      intent: 'UNKNOWN',
      confidence: 0,
    };
  }

  private buildSystemPrompt(context?: ConversationContext): string {
    let systemPrompt = `You are Celeste, a helpful local voice assistant. 
Your role is to help the user respond to WhatsApp messages.

When generating responses:
- Be concise and natural
- Use the same language as the incoming message
- Avoid unnecessary pleasantries
- Focus on the user's intent`;

    if (context?.currentMessage) {
      systemPrompt += `\n\nCurrent message context:
- From: ${context.currentMessage.senderName || 'Unknown'}
- Message: "${context.currentMessage.text}"
- Is group: ${context.currentMessage.isGroup}`;
    }

    return systemPrompt;
  }

  private buildIntentPrompt(
    transcription: string,
    context?: ConversationContext
  ): string {
    let prompt = `Analyze the following user voice command and extract the intent.
Return ONLY a JSON object with this exact structure:
{
  "intent": "REPLY_TO_MESSAGE" | "CANCEL" | "CONFIRM" | "DENY" | "REPEAT" | "HELP" | "UNKNOWN",
  "response": "the exact response text if REPLY_TO_MESSAGE",
  "confidence": 0.0 to 1.0
}

User said: "${transcription}"`;

    if (context?.currentMessage) {
      prompt += `\n\nMessage context: "${context.currentMessage.text}"`;
    }

    return prompt;
  }

  isAvailable(): boolean {
    return true;
  }
}
