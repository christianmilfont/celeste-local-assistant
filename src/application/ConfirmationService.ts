import { normalizeCommand, wordCount } from './nlu/text';

export type ConfirmationDecision = 'CONFIRM' | 'DENY' | 'CANCEL' | 'UNKNOWN';

const DENY = /\b(nao|negativo|nunca|jamais|errado|nem)\b/;
const CANCEL =
  /\b(cancela|cancelar|cancele|cancelado|deixa|deixe|esquece|esqueca|desiste|desisto|pare|parar|espera|espere|aguarda|aguarde)\b|^para\b/;
/** Frases que indicam hesitação ou pedido de alteração nunca confirmam o envio. */
const HEDGE = /\b(mas|porem|muda|mude|mudar|troca|troque|trocar|altera|altere|corrige|corrija|talvez|acho|sei la)\b/;
const CONFIRM =
  /\b(sim|pode|manda|mande|mandar|envia|envie|enviar|confirmo|confirma|confirmar|confirmado|ok|okay|isso|claro|certo|beleza|positivo|perfeito|exato|bora|vai)\b/;

/** Respostas de confirmação costumam ser curtas; frases longas são tratadas como ambíguas. */
const MAX_CONFIRMATION_WORDS = 6;

/**
 * Interpreta respostas a "Posso enviar?".
 * Regra de segurança: só retorna CONFIRM quando a resposta é inequívoca.
 * Negação/cancelamento têm prioridade sobre confirmação ("não pode" => DENY).
 */
export class ConfirmationService {
  parse(text: string): ConfirmationDecision {
    const normalized = normalizeCommand(text);
    if (!normalized) {
      return 'UNKNOWN';
    }

    if (DENY.test(normalized)) {
      return 'DENY';
    }
    if (CANCEL.test(normalized)) {
      return 'CANCEL';
    }
    if (HEDGE.test(normalized) || wordCount(normalized) > MAX_CONFIRMATION_WORDS) {
      return 'UNKNOWN';
    }
    if (CONFIRM.test(normalized)) {
      return 'CONFIRM';
    }
    return 'UNKNOWN';
  }

  isConfirmation(text: string): boolean {
    return this.parse(text) === 'CONFIRM';
  }
}
