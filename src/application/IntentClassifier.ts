import { AIProvider } from '../core/types/adapters';
import { ConversationContext, MessageIntent, TvCommand } from '../core/types';
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
  /^(?:por favor[\s,]+)?(?:(responde|responda|responder)|(diz|diga|dizer|fala|fale|falar|manda|mande|mandar|envia|envie|enviar|escreve|escreva|escrever|avisa|avise|avisar))\b[\s,:]*/;
/** "uma mensagem", "um recado", "um zap"... entre o verbo e o destinatário (ou no lugar do verbo). */
const MESSAGE_NOUN = /^(?:uma |um |a |o )?(?:mensagem|mensagenzinha|msg|recado|zap|whats|whatsapp)\b[\s,:]*/;
const TARGET_PREPOSITION = /^(?:para|pra|pro|pros|pras|ao|aos|a)\s+(?:(?:o|a|os|as)\s+)?/;
const CONTENT_SEPARATOR =
  /\s*[,:]?\s+(?:dizendo que|dizendo|falando que|falando|avisando que|contando que|que)\s+|\s*[:,]\s*/;
const CONTENT_LEAD = /^(?:dizendo que|dizendo|falando que|falando|avisando que|que)\b[\s,:]*/;
/** Palavras que não são nomes de contato: "responde para ele", "responde a mensagem". */
const GENERIC_TARGET =
  /\b(ele|ela|eles|elas|dele|dela|mensagem|ultima|pergunta|isso|essa|esse|pessoa|contato|todos|novo|nova|hoje|agora)\b/;

// ---- TV ------------------------------------------------------------------------
const TV_WORD = /\b(tv|tvs|televisao|televisoes|televisor)\b/;
const TV_TARGET = /\b(?:tv|televisao|televisor) (?:da|do|de) ([a-z0-9]+)/;
const TV_DISCOVER = /\b(procura|procurar|procure|encontra|encontrar|encontre|descobrir|descubra|busca|buscar|busque)\b.*\b(tvs?|televisao|televisoes)\b|\bquais (?:sao )?(?:as )?(tvs|televisoes)\b/;
const TV_PAIR = /\b(conecta|conectar|conecte|parear|pareia|emparelhar|autorizar)\b.*\b(tv|televisao)\b/;
const TV_OFF = /\b(desliga|desligar|desligue|apaga|apagar|apague)\b.*\b(tv|televisao|televisor)\b/;
const TV_ON = /\b(liga|ligar|ligue|acende|acender|acenda)\b.*\b(tv|televisao|televisor)\b/;
const VOLUME_UP = /\b(aumenta|aumentar|aumente|sobe|subir|suba)\b.*\b(volume|som)\b|\bvolume\b.*\bmais alto\b/;
const VOLUME_DOWN = /\b(abaixa|abaixar|abaixe|diminui|diminuir|diminua|baixa|baixar|baixe|reduz|reduzir|reduza)\b.*\b(volume|som)\b|\bvolume\b.*\bmais baixo\b/;
const TV_MUTE = /\b(muta|mutar|mute|silencia|silenciar|silencie|mudo)\b|\b(tira|tirar|corta|cortar) o som\b|\bsem som\b/;
const MEDIA = /\b(tv|televisao|video|filme|serie|musica|episodio)\b/;
const TV_PAUSE = /\b(pausa|pausar|pause|para o|pare o)\b/;
const TV_PLAY = /\b(continua|continuar|continue|despausa|retoma|retomar|play|solta)\b/;
const TV_HOME = /\b(tela inicial|menu inicial|home)\b/;
const TV_STATUS = /\b(status|estado) da (tv|televisao)\b|\bcomo (esta|ta) a (tv|televisao)\b|\b(a )?(tv|televisao) (esta|ta) (ligada|desligada)\b/;
const KNOWN_APPS =
  /\b(youtube|netflix|prime video|amazon prime|disney|globoplay|spotify|hbo max|max|twitch|plex|pluto tv|apple tv|paramount|star plus|crunchyroll|deezer)\b/;
const OPEN_VERB = /\b(abre|abrir|abra|coloca|colocar|coloque|poe|por|bota|botar|inicia|iniciar|liga|ligar|ligue|entra|entrar|entre)\b/;
const OPEN_ANY_APP = /\b(?:abre|abrir|abra|inicia|iniciar) (?:o |a )?(.+?) (?:na|no) (?:tv|televisao)\b/;
const NUMBER_WORDS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8,
  nove: 9, dez: 10, quinze: 15, vinte: 20,
};

const SYNC_CONTACTS =
  /\b(atualiza|atualizar|atualize|sincroniza|sincronizar|sincronize|carrega|carregar|importa|importar)\b.*\bcontatos\b/;

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
        tv: parsed?.tv,
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

    if (SYNC_CONTACTS.test(normalized)) {
      return this.rule('SYNC_CONTACTS');
    }

    // Depois das respostas ditadas ("responde que já vou ligar a TV" é uma resposta, não um comando).
    const tv = this.parseTvCommand(normalized);
    if (tv) {
      return { intent: 'TV_CONTROL', tv, confidence: 0.9, source: 'rule' };
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
    // Sem verbo: "mensagem para a Letícia: saindo para o treino".
    const nounFirst = !verb ? folded.match(MESSAGE_NOUN) : null;
    if (!verb && !(nounFirst && TARGET_PREPOSITION.test(folded.slice(nounFirst[0].length)))) {
      return null;
    }
    const isRespondVerb = Boolean(verb?.[1]);
    let afterVerb = verb ? verb[0].length : 0;
    // "envie uma mensagem para…", "manda um recado pro…": pula o substantivo.
    const noun = folded.slice(afterVerb).match(MESSAGE_NOUN);
    const hasMessageNoun = Boolean(noun);
    if (noun) {
      afterVerb += noun[0].length;
    }
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
        // Sem separador. "envia uma mensagem para a minha mãe": tudo é o destinatário (sem conteúdo).
        // "responde pro João ok": a primeira palavra (ou "minha mãe", "meu chefe") é o destinatário.
        const firstWord = hasMessageNoun && tail.trim().split(/\s+/).length <= 4
          ? tail.match(/^.+$/)
          : tail.match(/^(?:(?:minha|meu|minhas|meus)\s+)?\S+/);
        const end = start + (firstWord ? firstWord[0].length : 0);
        target = text.slice(start, end);
        content = text.slice(end);
      }
    } else {
      const lead = rest.match(CONTENT_LEAD);
      // "manda", "envia" sozinhos são confirmações, não respostas.
      if (!isRespondVerb && !lead && !hasMessageNoun) {
        return null;
      }
      content = text.slice(afterVerb + (lead ? lead[0].length : 0));
    }

    return {
      target: this.cleanTarget(target),
      content: this.cleanContent(content),
    };
  }

  /**
   * Comandos de TV: "desliga a TV", "liga a TV da sala", "aumenta o volume em 5",
   * "abre o YouTube", "pausa o filme", "procurar TVs", "conectar na TV".
   */
  parseTvCommand(normalized: string): TvCommand | null {
    const target = normalized.match(TV_TARGET)?.[1];
    const withTarget = (command: TvCommand): TvCommand => (target ? { ...command, target } : command);
    const mentionsTv = TV_WORD.test(normalized);

    if (TV_DISCOVER.test(normalized)) return { action: 'DISCOVER' };
    if (TV_PAIR.test(normalized)) return withTarget({ action: 'PAIR' });
    if (TV_OFF.test(normalized)) return withTarget({ action: 'POWER_OFF' });

    const app = normalized.match(KNOWN_APPS)?.[1];
    if (app && (OPEN_VERB.test(normalized) || mentionsTv)) {
      return withTarget({ action: 'OPEN_APP', app });
    }
    const anyApp = normalized.match(OPEN_ANY_APP)?.[1];
    if (anyApp) return withTarget({ action: 'OPEN_APP', app: anyApp });

    if (TV_ON.test(normalized)) return withTarget({ action: 'POWER_ON' });
    if (TV_STATUS.test(normalized)) return withTarget({ action: 'STATUS' });

    // Volume e mudo: só a TV tem volume, então não é preciso citar "TV".
    if (VOLUME_UP.test(normalized)) return withTarget({ action: 'VOLUME_UP', amount: this.amount(normalized) });
    if (VOLUME_DOWN.test(normalized)) return withTarget({ action: 'VOLUME_DOWN', amount: this.amount(normalized) });
    if (TV_MUTE.test(normalized) && (mentionsTv || normalized.split(' ').length <= 4)) {
      return withTarget({ action: 'MUTE' });
    }

    if (MEDIA.test(normalized)) {
      if (TV_PAUSE.test(normalized)) return withTarget({ action: 'PAUSE' });
      if (TV_PLAY.test(normalized)) return withTarget({ action: 'PLAY' });
    }
    if (mentionsTv && TV_HOME.test(normalized)) return withTarget({ action: 'HOME' });
    return null;
  }

  private amount(normalized: string): number | undefined {
    const digits = normalized.match(/\b(?:em|de|mais) (\d{1,2})\b/) || normalized.match(/\b(\d{1,2})\b/);
    if (digits) return Number(digits[1]);
    const word = normalized.match(/\b(?:em|de|mais) (um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|quinze|vinte)\b/);
    return word ? NUMBER_WORDS[word[1]] : undefined;
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
