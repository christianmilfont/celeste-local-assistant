import { AIProvider } from '../core/types/adapters';
import { ConversationContext, MessageIntent } from '../core/types';
import { Logger } from '../infrastructure/logging/Logger';
import { ConfirmationService } from './ConfirmationService';
import { fold, normalizeCommand, stripWakeWord, wordCount } from './nlu/text';

export interface ReplyCommand {
  /** Nome citado ("João"), ou undefined para usar a mensagem em foco. */
  target?: string;
  /** O que o usuário quer responder, como foi dito. Pode ser vazio. */
  content: string;
}

const REPLY_VERB =
  /^(?:por favor[\s,]+)?(?:(responde|responda|responder)|(diz|diga|dizer|fala|fale|falar|manda|mande|mandar|envia|envie|enviar|escreve|escreva|escrever))\b[\s,:]*/;
const TARGET_PREPOSITION = /^(?:para|pra|pro|pros|pras|ao|aos|a)\s+(?:(?:o|a|os|as)\s+)?/;
const CONTENT_SEPARATOR =
  /\s*[,:]?\s+(?:dizendo que|dizendo|falando que|falando|avisando que|que)\s+|\s*[:,]\s*/;
const CONTENT_LEAD = /^(?:dizendo que|dizendo|falando que|falando|avisando que|que)\b[\s,:]*/;
/** Palavras que não são nomes de contato: "responde para ele", "responde a mensagem". */
const GENERIC_TARGET =
  /\b(ele|ela|eles|elas|dele|dela|mensagem|ultima|pergunta|isso|essa|esse|pessoa|contato|todos|novo|nova|hoje|agora)\b/;

const STOP =
  /^(?:pode )?(?:desligar|desliga|desligue|encerrar|encerra|encerre|finalizar|finaliza|sair|stop|tchau|ate logo|ate mais|adeus)(?: (?:o sistema|a celeste|agora|por favor|tudo))*$/;
const HELP =
  /\b(ajuda|help|socorro|comandos)\b|o que (?:voce )?(?:consegue|pode|sabe) fazer|como (?:funciona|te uso|eu te uso|usar voce)|quais (?:sao )?(?:as )?(?:suas )?(?:funcoes|habilidades)/;
const READ_VERB = /\b(le|leia|ler|releia|reler)\b/;
const REPEAT_VERB = /\b(repete|repita|repetir)\b/;
const AGAIN = /\b(novamente|de novo|outra vez|mais uma vez)\b|^rel/;
const WHAT_SOMEONE_SAID = /\bo que (?:o |a )?(\w+) (?:disse|falou|mandou|escreveu|perguntou)\b/;
const MESSAGE_FROM = /\bmensagem d[aoe]s? (\w+)/;
const LAST_MESSAGE = /\bultima mensagem\b/;
const MESSAGES_PLURAL = /\bmensagens\b/;
const MESSAGE_WORD = /\bmensage(?:m|ns)\b/;
const LIST_HINT =
  /\b(quais|quantas|tenho|tem|recebi|chegou|chegaram|nova|novas|alguma|lista|listar|liste|ver|mostra|mostre)\b/;
const SOMEONE_WROTE = /\balguem (?:me )?(?:mandou|escreveu|chamou)\b/;
const REPEAT =
  /\b(repete|repita|repetir|repeat)\b|\b(de novo|novamente|outra vez)\b|\bnao (?:entendi|ouvi)\b|o que voce (?:disse|falou)|como e que e/;
const STATUS =
  /\bstatus\b|\bsituacao\b|\bcomo (?:voce )?(?:esta|estao|vai|anda|andam|ta|tao)\b|\b(?:esta|voce esta|ta) (?:online|funcionando|ai|ativa|ligada|me ouvindo)\b|\b(?:sistema|servicos|servico)\b.*\b(?:funcionando|online|ok|certo|bem)\b|\btudo (?:certo|bem|ok)\b/;

const MIN_AI_CONFIDENCE = 0.5;

/**
 * Converte texto livre (digitado ou transcrito) em intenção.
 * 1. Regras determinísticas (rápidas, sem LLM) para os comandos comuns.
 * 2. Fallback no LLM apenas quando nenhuma regra casa e a IA está disponível.
 */
export class IntentClassifier {
  constructor(
    private aiProvider?: AIProvider,
    private confirmationService: ConfirmationService = new ConfirmationService()
  ) {}

  async classify(text: string, context?: ConversationContext): Promise<MessageIntent> {
    const deterministic = this.classifyDeterministic(text);
    if (deterministic) {
      return deterministic;
    }

    if (!this.aiProvider?.isAvailable()) {
      return { intent: 'UNKNOWN', confidence: 0, source: 'rule' };
    }

    try {
      const parsed = await this.aiProvider.parseIntent(stripWakeWord(text), context);
      Logger.info('Intent resolved by AI', { intent: parsed?.intent, confidence: parsed?.confidence });
      // Palpites fracos do LLM (ex.: transcrição ruim) viram "não entendi".
      if (typeof parsed?.confidence === 'number' && parsed.confidence < MIN_AI_CONFIDENCE) {
        return { intent: 'UNKNOWN', confidence: parsed.confidence, source: 'ai' };
      }
      return {
        intent: parsed?.intent ?? 'UNKNOWN',
        target: parsed?.target,
        response: parsed?.response,
        confidence: parsed?.confidence ?? 0.5,
        source: 'ai',
      };
    } catch (error) {
      Logger.warn('AI intent parsing failed', { error: String(error) });
      return { intent: 'UNKNOWN', confidence: 0, source: 'ai' };
    }
  }

  classifyDeterministic(text: string): MessageIntent | null {
    const normalized = normalizeCommand(text);
    if (!normalized) {
      return null;
    }

    const reply = this.parseReplyCommand(text);
    if (reply) {
      return {
        intent: 'REPLY_TO_MESSAGE',
        target: reply.target,
        response: reply.content,
        confidence: 0.95,
        source: 'rule',
      };
    }

    if (STOP.test(normalized)) {
      return this.rule('STOP');
    }
    if (HELP.test(normalized)) {
      return this.rule('HELP');
    }

    const read = this.parseReadCommand(normalized);
    if (read) {
      return read;
    }

    if (
      (MESSAGE_WORD.test(normalized) && LIST_HINT.test(normalized)) ||
      SOMEONE_WROTE.test(normalized)
    ) {
      return this.rule('LIST_MESSAGES');
    }
    if (REPEAT.test(normalized)) {
      return this.rule('REPEAT');
    }
    if (STATUS.test(normalized)) {
      return this.rule('STATUS');
    }

    // Respostas curtas soltas: "sim", "pode", "cancela", "não".
    if (wordCount(normalized) <= 4) {
      const decision = this.confirmationService.parse(text);
      if (decision !== 'UNKNOWN') {
        return this.rule(decision);
      }
    }

    return null;
  }

  /**
   * "Responde para o João dizendo que já vou verificar" -> { target: "João", content: "já vou verificar" }
   * "Responde que ainda estou terminando"               -> { content: "ainda estou terminando" }
   * Trabalha no texto "dobrado" (sem acentos, mesmo comprimento) e recorta o original.
   */
  parseReplyCommand(original: string): ReplyCommand | null {
    const text = stripWakeWord(original);
    const folded = fold(text);

    const verb = folded.match(REPLY_VERB);
    if (!verb) {
      return null;
    }
    const isRespondVerb = Boolean(verb[1]);
    const afterVerb = verb[0].length;
    const rest = folded.slice(afterVerb);

    let target: string | undefined;
    let content: string;

    const preposition = rest.match(TARGET_PREPOSITION);
    if (preposition) {
      const start = afterVerb + preposition[0].length;
      const tail = folded.slice(start);
      const separator = tail.match(CONTENT_SEPARATOR);

      if (separator && separator.index !== undefined && separator.index > 0) {
        target = text.slice(start, start + separator.index);
        content = text.slice(start + separator.index + separator[0].length);
      } else {
        // Sem separador ("responde pro João ok"): a primeira palavra é o destinatário.
        const firstWord = tail.match(/^\S+/);
        const end = start + (firstWord ? firstWord[0].length : 0);
        target = text.slice(start, end);
        content = text.slice(end);
      }
    } else {
      const lead = rest.match(CONTENT_LEAD);
      // "manda", "envia" sozinhos são confirmações, não respostas.
      if (!isRespondVerb && !lead) {
        return null;
      }
      content = text.slice(afterVerb + (lead ? lead[0].length : 0));
    }

    return {
      target: this.cleanTarget(target),
      content: this.cleanContent(content),
    };
  }

  private parseReadCommand(normalized: string): MessageIntent | null {
    const readVerb = READ_VERB.test(normalized);
    const repeatMessage = REPEAT_VERB.test(normalized) && MESSAGE_WORD.test(normalized);
    const whatSaid = normalized.match(WHAT_SOMEONE_SAID);

    if (readVerb && MESSAGES_PLURAL.test(normalized)) {
      return this.rule('LIST_MESSAGES');
    }

    if (readVerb || repeatMessage || whatSaid || LAST_MESSAGE.test(normalized)) {
      const again = AGAIN.test(normalized) || repeatMessage;
      const from = normalized.match(MESSAGE_FROM)?.[1] ?? whatSaid?.[1];
      return {
        ...this.rule('READ_LAST_MESSAGE'),
        again,
        target: this.cleanTarget(from),
      };
    }

    return null;
  }

  private cleanTarget(target?: string): string | undefined {
    if (!target) {
      return undefined;
    }
    const cleaned = target.replace(/[.,:;!?"']/g, '').trim();
    const normalized = normalizeCommand(cleaned);
    if (!normalized || GENERIC_TARGET.test(normalized) || wordCount(normalized) > 3) {
      return undefined;
    }
    return cleaned;
  }

  private cleanContent(content: string): string {
    return content
      .replace(/[\s,]*\bpor favor[\s.!]*$/i, '')
      .trim()
      .replace(/^["'“]+|["'”]+$/g, '')
      .trim();
  }

  private rule(intent: MessageIntent['intent']): MessageIntent {
    return { intent, confidence: 0.9, source: 'rule' };
  }
}
