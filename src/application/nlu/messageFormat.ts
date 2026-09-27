import { IncomingMessage } from '../../core/types';

export function senderLabel(message: IncomingMessage): string {
  return message.senderName || 'um contato desconhecido';
}

/** Como a Celeste se refere ao destinatário de uma resposta. */
export function recipientLabel(message: IncomingMessage): string {
  const sender = message.senderName || 'o contato';
  return message.isGroup && message.groupName ? `${sender}, no grupo ${message.groupName}` : sender;
}

/** Texto falado ao anunciar/ler uma mensagem recebida. */
export function describeMessage(message: IncomingMessage): string {
  if (message.isGroup) {
    return `Mensagem no grupo ${message.groupName || 'desconhecido'}, enviada por ${senderLabel(message)}: ${message.text}`;
  }
  return `Você recebeu uma mensagem de ${senderLabel(message)}: ${message.text}`;
}
