import { ContactRecord } from '../core/types';
import { MessagingAdapter } from '../core/types/adapters';
import { Logger } from '../infrastructure/logging/Logger';
import { normalizeCommand } from './nlu/text';

/** Contato pronto para receber mensagem. */
export interface Contact {
  /** JID usado para enviar (…@s.whatsapp.net de preferência). */
  id: string;
  /** Nome salvo na agenda do celular. */
  name?: string;
  /** Nome do perfil do WhatsApp. */
  pushName?: string;
  /** Telefone (só dígitos). */
  phone?: string;
}

export interface ContactMatch {
  contact: Contact;
  /** Como a Celeste fala o nome ("Letícia Souza"). */
  label: string;
  score: number;
}

export interface ContactStore {
  loadAll(): Contact[];
  saveMany(contacts: Contact[]): void;
}

const IGNORED = /@(g\.us|broadcast|newsletter)$|^status@/;
const MAX_CANDIDATES = 4;

function phoneFromJid(jid?: string): string | undefined {
  const match = jid?.match(/^(\d{8,15})@s\.whatsapp\.net$/);
  return match ? match[1] : undefined;
}

/**
 * Diretório de contatos do WhatsApp: guarda o que chega da sincronização (agenda do celular,
 * histórico, remetentes) e encontra contatos pelo nome falado, sem depender de acentos.
 */
export class ContactService {
  private contacts = new Map<string, Contact>();

  constructor(
    private store: ContactStore,
    private adapter?: Pick<MessagingAdapter, 'syncContacts' | 'lookupPhone' | 'isConnected'>
  ) {
    for (const contact of store.loadAll()) {
      this.contacts.set(contact.id, contact);
    }
  }

  /** Quantos contatos têm nome (agenda ou perfil). */
  count(): number {
    let named = 0;
    this.contacts.forEach((c) => (c.name || c.pushName ? named++ : 0));
    return named;
  }

  upsert(records: ContactRecord[]): void {
    const changed: Contact[] = [];
    for (const record of records) {
      // IDs em formato LID: usa o JID de telefone quando disponível (é por ele que se envia).
      const id = record.id.endsWith('@lid') && record.phoneNumber ? record.phoneNumber : record.id;
      if (IGNORED.test(id)) continue;
      const current = this.contacts.get(id) ?? { id };
      const next: Contact = {
        ...current,
        name: record.name?.trim() || current.name,
        pushName: record.notify?.trim() || current.pushName,
        phone: phoneFromJid(id) ?? phoneFromJid(record.phoneNumber) ?? current.phone,
      };
      if (JSON.stringify(next) !== JSON.stringify(current) || !this.contacts.has(id)) {
        this.contacts.set(id, next);
        changed.push(next);
      }
    }
    if (changed.length) {
      try {
        this.store.saveMany(changed);
      } catch (error) {
        Logger.warn('Could not save contacts', { error: String(error) });
      }
    }
  }

  /**
   * Busca por nome (ou telefone). Devolve só os melhores empatados: um resultado = certeza;
   * vários = a Celeste pergunta "qual deles?".
   */
  search(query: string): ContactMatch[] {
    const digits = query.replace(/\D/g, '');
    if (digits.length >= 8) {
      return [...this.contacts.values()]
        .filter((c) => c.phone?.endsWith(digits.slice(-8)))
        .slice(0, MAX_CANDIDATES)
        .map((contact) => ({ contact, label: this.label(contact), score: 100 }));
    }

    // "minha mãe", "meu chefe": o contato costuma estar salvo sem o possessivo.
    const wanted = normalizeCommand(query).replace(/^(?:minha|meu|minhas|meus|a|o)\s+/, '');
    if (!wanted) return [];
    const scored: ContactMatch[] = [];
    this.contacts.forEach((contact) => {
      const score = Math.max(this.score(contact.name, wanted), this.score(contact.pushName, wanted) - 5);
      if (score > 0) scored.push({ contact, label: this.label(contact), score });
    });
    if (!scored.length) return [];
    scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    const best = scored[0].score;
    return scored.filter((m) => m.score >= best).slice(0, MAX_CANDIDATES);
  }

  /** Telefone falado ("85 99999 1234") → contato, consultando o WhatsApp se não estiver salvo. */
  async lookupPhone(spoken: string): Promise<ContactMatch | undefined> {
    let digits = spoken.replace(/\D/g, '');
    if (digits.length < 8) return undefined;
    if (digits.length === 10 || digits.length === 11) digits = `55${digits}`; // DDD + número (Brasil)
    const jid = await this.adapter?.lookupPhone?.(digits);
    if (!jid) return undefined;
    const contact = this.contacts.get(jid) ?? { id: jid, phone: phoneFromJid(jid) };
    return { contact, label: this.label(contact), score: 100 };
  }

  /** Pede ao WhatsApp a agenda completa; devolve quantos contatos com nome a Celeste conhece. */
  async sync(waitMs = 6000): Promise<number> {
    if (!this.adapter?.syncContacts) return this.count();
    await this.adapter.syncContacts();
    await new Promise((resolve) => setTimeout(resolve, waitMs)); // eventos chegam logo após o sync
    return this.count();
  }

  label(contact: Contact): string {
    return contact.name || contact.pushName || (contact.phone ? `+${contact.phone}` : 'contato');
  }

  private score(label: string | undefined, wanted: string): number {
    if (!label) return 0;
    const name = normalizeCommand(label);
    if (!name) return 0;
    if (name === wanted) return 100;
    const tokens = name.split(' ');
    const wantedTokens = wanted.split(' ');
    if (tokens[0] === wanted) return 85;
    if (tokens.includes(wanted)) return 70;
    if (wantedTokens.length > 1 && wantedTokens.every((w) => tokens.some((t) => t.startsWith(w)))) return 65;
    if (name.startsWith(wanted) && wanted.length >= 3) return 55;
    if (tokens.some((t) => t.startsWith(wanted)) && wanted.length >= 3) return 45;
    return 0;
  }
}
