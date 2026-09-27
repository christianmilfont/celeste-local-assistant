import { ContactService, Contact, ContactStore } from '../../src/application/ContactService';
import { CommandProcessor } from '../../src/application/CommandProcessor';
import { ConfirmationService } from '../../src/application/ConfirmationService';
import { IntentClassifier } from '../../src/application/IntentClassifier';
import { MessageService } from '../../src/application/MessageService';
import { ResponseService } from '../../src/application/ResponseService';
import { EventBus } from '../../src/core/EventBus';
import { StateMachine } from '../../src/core/StateMachine';
import { FakeAI, FakeMessaging, fakeDatabase, makeMessage } from '../helpers/fakes';

class MemoryStore implements ContactStore {
  saved = new Map<string, Contact>();
  loadAll() {
    return [...this.saved.values()];
  }
  saveMany(contacts: Contact[]) {
    contacts.forEach((c) => this.saved.set(c.id, c));
  }
}

const AGENDA = [
  { id: '5585911110001@s.whatsapp.net', name: 'Letícia Souza' },
  { id: '5585911110002@s.whatsapp.net', name: 'Letícia Lima' },
  { id: '5585911110003@s.whatsapp.net', name: 'João Pedro' },
  { id: '5585911110004@s.whatsapp.net', name: 'Mãe' },
  { id: '5585911110005@s.whatsapp.net', notify: 'Carla ✨' },
  { id: '123456@g.us', name: 'Grupo da família' },
];

describe('ContactService', () => {
  function directory(lookup?: (phone: string) => Promise<string | undefined>) {
    const store = new MemoryStore();
    const service = new ContactService(store, {
      isConnected: () => true,
      lookupPhone: lookup,
      syncContacts: async () => undefined,
    });
    service.upsert(AGENDA);
    return { service, store };
  }

  it('stores contacts (ignoring groups) and counts named ones', () => {
    const { service, store } = directory();
    expect(service.count()).toBe(5);
    expect(store.saved.has('123456@g.us')).toBe(false);
    expect(store.saved.get('5585911110001@s.whatsapp.net')).toMatchObject({ phone: '5585911110001' });
  });

  it('finds by name ignoring accents; ties are returned for disambiguation', () => {
    const { service } = directory();
    expect(service.search('Joao').map((m) => m.label)).toEqual(['João Pedro']);
    expect(service.search('leticia').map((m) => m.label)).toEqual(['Letícia Lima', 'Letícia Souza']);
    expect(service.search('Letícia Souza').map((m) => m.label)).toEqual(['Letícia Souza']);
    expect(service.search('minha mãe').map((m) => m.label)).toEqual(['Mãe']);
    expect(service.search('carla').map((m) => m.label)).toEqual(['Carla ✨']);
    expect(service.search('Zé')).toEqual([]);
  });

  it('prefers the phone JID when the contact arrives with a LID id', () => {
    const { service } = directory();
    service.upsert([{ id: '999@lid', name: 'Bruna', phoneNumber: '5511988887777@s.whatsapp.net' }]);
    expect(service.search('bruna')[0].contact.id).toBe('5511988887777@s.whatsapp.net');
  });

  it('keeps the address book name when only the profile name changes', () => {
    const { service } = directory();
    service.upsert([{ id: '5585911110003@s.whatsapp.net', notify: 'JP' }]);
    expect(service.search('joao')[0].label).toBe('João Pedro');
  });

  it('looks up unsaved phone numbers on WhatsApp (adds Brazil code)', async () => {
    const lookup = jest.fn(async (phone: string) => (phone === '5585999991234' ? `${phone}@s.whatsapp.net` : undefined));
    const { service } = directory(lookup);
    expect((await service.lookupPhone('85 99999-1234'))?.contact.id).toBe('5585999991234@s.whatsapp.net');
    expect(await service.lookupPhone('11 1234')).toBeUndefined();
  });
});

describe('Sending messages to contacts', () => {
  function setup() {
    const eventBus = new EventBus();
    const stateMachine = new StateMachine();
    const messaging = new FakeMessaging();
    const ai = new FakeAI();
    ai.available = false; // texto ditado literal: resultados previsíveis
    const confirmationService = new ConfirmationService();
    const messageService = new MessageService(messaging, eventBus, stateMachine, fakeDatabase());
    const contacts = new ContactService(new MemoryStore(), { isConnected: () => true, syncContacts: async () => undefined });
    contacts.upsert(AGENDA);
    const processor = new CommandProcessor({
      messageService,
      responseService: new ResponseService(ai, eventBus, stateMachine, confirmationService),
      stateMachine,
      eventBus,
      intentClassifier: new IntentClassifier(ai, confirmationService),
      confirmationService,
      aiProvider: ai,
      contacts,
      getStatus: async () => ({ whatsapp: true, ai: false, stt: true, tts: true, state: 'IDLE' }),
    });
    return { processor, messaging, messageService, stateMachine };
  }

  it('"envie uma mensagem para Joao dizendo que sairei para o treino" → confirmation → sent', async () => {
    const { processor, messaging } = setup();
    const draft = await processor.processCommand('Celeste, envie uma mensagem para Joao dizendo que sairei para o treino');
    expect(draft.reply).toBe('Preparei esta mensagem para João Pedro: "Sairei para o treino.". Posso enviar?');
    expect(messaging.sent).toHaveLength(0);

    const sent = await processor.processCommand('pode enviar');
    expect(sent.reply).toBe('Mensagem enviada para João Pedro.');
    expect(messaging.sent).toEqual([{ chatId: '5585911110003@s.whatsapp.net', text: 'Sairei para o treino.' }]);
  });

  it('asks which one when several contacts match, then continues', async () => {
    const { processor, messaging } = setup();
    const question = await processor.processCommand('envie uma mensagem para Letícia dizendo que sairei para o treino');
    expect(question.reply).toBe('Encontrei dois contatos com esse nome: Letícia Lima e Letícia Souza. Para qual deles?');

    const draft = await processor.processCommand('Souza');
    expect(draft.reply).toContain('Preparei esta mensagem para Letícia Souza');
    await processor.processCommand('sim');
    expect(messaging.sent[0].chatId).toBe('5585911110001@s.whatsapp.net');
  });

  it('accepts ordinals ("a primeira") when choosing', async () => {
    const { processor } = setup();
    await processor.processCommand('manda um recado pra Leticia que já estou saindo');
    expect((await processor.processCommand('a primeira')).reply).toContain('Letícia Lima');
  });

  it('asks for the content when it is missing', async () => {
    const { processor, messaging } = setup();
    expect((await processor.processCommand('envia uma mensagem para a minha mãe')).reply).toBe('O que você quer dizer para Mãe?');
    const draft = await processor.processCommand('que vou chegar mais tarde');
    expect(draft.reply).toBe('Preparei esta mensagem para Mãe: "Vou chegar mais tarde.". Posso enviar?');
    await processor.processCommand('pode');
    expect(messaging.sent).toHaveLength(1);
  });

  it('the dictated content can even start with "não" (it is the message, not a denial)', async () => {
    const { processor } = setup();
    await processor.processCommand('envia uma mensagem para o João');
    const draft = await processor.processCommand('não vou poder ir hoje');
    expect(draft.reply).toContain('"Não vou poder ir hoje."');
  });

  it('"cancela" while choosing aborts; other commands are still answered', async () => {
    const { processor, messaging } = setup();
    await processor.processCommand('envie uma mensagem para Letícia dizendo oi');
    expect((await processor.processCommand('cancela')).reply).toBe('Tudo bem, cancelei a mensagem.');
    await processor.processCommand('envia uma mensagem para o João');
    expect((await processor.processCommand('status')).intent).toBe('STATUS');
    expect(messaging.sent).toHaveLength(0);
  });

  it('prefers the conversation of someone who wrote during the session', async () => {
    const { processor, messageService, stateMachine } = setup();
    await messageService.handleIncomingMessage(makeMessage({ senderName: 'João', chatId: 'joao-chat@s.whatsapp.net' }));
    stateMachine.transition('IDLE');
    const draft = await processor.processCommand('responde para o João que chego já');
    expect(draft.reply).toBe('Preparei esta resposta para João: "Chego já.". Posso enviar?');
  });

  it('says when the contact does not exist', async () => {
    const { processor } = setup();
    expect((await processor.processCommand('manda uma mensagem para o Zé que oi')).reply).toBe('Não encontrei Zé nos seus contatos.');
  });

  it('"atualizar contatos" syncs the address book', async () => {
    const { processor } = setup();
    jest.useFakeTimers();
    const pending = processor.processCommand('Celeste, atualizar contatos');
    await jest.advanceTimersByTimeAsync(7000);
    jest.useRealTimers();
    expect((await pending).reply).toBe('Sincronizei sua agenda: conheço 5 contatos.');
  });
});
