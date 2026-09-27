import { CommandProcessor } from '../../src/application/CommandProcessor';
import { ConfirmationService } from '../../src/application/ConfirmationService';
import { IntentClassifier } from '../../src/application/IntentClassifier';
import { MessageService } from '../../src/application/MessageService';
import { ResponseService } from '../../src/application/ResponseService';
import { EventBus } from '../../src/core/EventBus';
import { StateMachine } from '../../src/core/StateMachine';
import { FakeAI, FakeMessaging, fakeDatabase, makeMessage } from '../helpers/fakes';

function setup() {
  const eventBus = new EventBus();
  const stateMachine = new StateMachine();
  const messaging = new FakeMessaging();
  const ai = new FakeAI();
  const confirmationService = new ConfirmationService();
  const messageService = new MessageService(messaging, eventBus, stateMachine, fakeDatabase());
  const responseService = new ResponseService(ai, eventBus, stateMachine, confirmationService);
  const processor = new CommandProcessor({
    messageService,
    responseService,
    stateMachine,
    eventBus,
    intentClassifier: new IntentClassifier(ai, confirmationService),
    confirmationService,
    aiProvider: ai,
    getStatus: async () => ({
      whatsapp: messaging.isConnected(),
      ai: ai.isAvailable(),
      stt: true,
      tts: true,
      mic: true,
      state: stateMachine.getCurrentState(),
    }),
  });

  /** Simula a chegada de uma mensagem já anunciada (como a Celeste faz). */
  const receive = async (overrides = {}) => {
    const message = makeMessage(overrides);
    await messageService.handleIncomingMessage(message);
    if (stateMachine.getCurrentState() === 'ANNOUNCING_MESSAGE') {
      stateMachine.transition('IDLE');
    }
    return message;
  };

  return { processor, stateMachine, messaging, ai, messageService, receive };
}

describe('CommandProcessor', () => {
  describe('STATUS', () => {
    it.each(['status', 'Celeste, status', 'como está o sistema?'])('"%s" => STATUS', async (input) => {
      const { processor } = setup();
      const result = await processor.processCommand(input);
      expect(result.intent).toBe('STATUS');
      expect(result.reply).toBe(
        'Estou online. WhatsApp conectado, inteligência artificial disponível e sistema de voz funcionando.'
      );
    });

    it('CLI and voice inputs produce the same result', async () => {
      const { processor } = setup();
      const cli = await processor.processCommand('status', 'cli');
      const voice = await processor.processCommand('Celeste, status.', 'voice');
      expect(voice).toEqual(cli);
    });

    it('reports services that are down', async () => {
      const { processor, messaging, ai } = setup();
      messaging.connected = false;
      ai.available = false;
      const result = await processor.processCommand('status');
      expect(result.reply).toContain('WhatsApp desconectado');
      expect(result.reply).toContain('inteligência artificial indisponível');
    });
  });

  it('HELP explains what Celeste can do', async () => {
    const { processor } = setup();
    const result = await processor.processCommand('Celeste, o que você consegue fazer?');
    expect(result.intent).toBe('HELP');
    expect(result.reply).toContain('responder mensagens do WhatsApp');
  });

  it('STOP asks the interface to shut down', async () => {
    const { processor } = setup();
    expect(await processor.processCommand('Celeste, desligar')).toMatchObject({ intent: 'STOP', shouldStop: true });
  });

  describe('messages', () => {
    it('lists unread messages', async () => {
      const { processor, receive } = setup();
      await receive({ senderName: 'João' });
      await receive({ senderName: 'João', text: 'Oi?' });
      await receive({ senderName: 'Maria', chatId: 'maria@s.whatsapp.net', text: 'Bom dia' });

      const result = await processor.processCommand('Celeste, quais mensagens eu recebi?');
      expect(result.intent).toBe('LIST_MESSAGES');
      expect(result.reply).toContain('Você recebeu três mensagens novas: duas de João e uma de Maria.');
    });

    it('reads the last message and marks it as read', async () => {
      const { processor, receive, messageService } = setup();
      await receive({ senderName: 'João', text: 'Você conseguiu terminar o projeto?' });

      const result = await processor.processCommand('Leia minha última mensagem.');
      expect(result.intent).toBe('READ_LAST_MESSAGE');
      expect(result.reply).toBe('Você recebeu uma mensagem de João: Você conseguiu terminar o projeto?');
      expect(messageService.getUnreadMessages()).toHaveLength(0);
    });

    it('handles "no messages" gracefully', async () => {
      const { processor } = setup();
      expect((await processor.processCommand('leia a última mensagem')).reply).toBe(
        'Você ainda não recebeu nenhuma mensagem.'
      );
    });

    it('REPEAT repeats the last thing Celeste said', async () => {
      const { processor } = setup();
      const status = await processor.processCommand('status');
      const repeat = await processor.processCommand('repete');
      expect(repeat).toEqual({ intent: 'REPEAT', reply: status.reply });
    });
  });

  describe('reply + confirmation', () => {
    it('uses conversation context: no need to say who the reply is for', async () => {
      const { processor, receive, stateMachine, messaging, ai } = setup();
      const message = await receive({ senderName: 'João' });
      ai.replyText = 'Ainda estou terminando, te aviso quando acabar.';

      const draft = await processor.processCommand('Responde que ainda estou terminando.');
      expect(draft.intent).toBe('REPLY_TO_MESSAGE');
      expect(draft.reply).toBe(
        'Preparei esta resposta para João: "Ainda estou terminando, te aviso quando acabar.". Posso enviar?'
      );
      expect(stateMachine.getCurrentState()).toBe('WAITING_CONFIRMATION');
      expect(messaging.sent).toHaveLength(0);

      const sent = await processor.processCommand('Pode.');
      expect(sent.reply).toBe('Mensagem enviada para João.');
      expect(messaging.sent).toEqual([
        { chatId: message.chatId, text: 'Ainda estou terminando, te aviso quando acabar.' },
      ]);
      expect(stateMachine.getCurrentState()).toBe('IDLE');
    });

    it('replies to the contact named in the command', async () => {
      const { processor, receive, messaging } = setup();
      const joao = await receive({ senderName: 'João', chatId: 'joao@s.whatsapp.net' });
      await receive({ senderName: 'Maria', chatId: 'maria@s.whatsapp.net' });

      await processor.processCommand('Responde para o João dizendo que já vou verificar.');
      await processor.processCommand('sim');
      expect(messaging.sent[0].chatId).toBe(joao.chatId);
    });

    it.each(['não', 'cancela', 'deixa'])('"%s" does not send', async (answer) => {
      const { processor, receive, messaging, stateMachine } = setup();
      await receive();
      await processor.processCommand('responde que já estou chegando');

      const result = await processor.processCommand(answer);
      expect(result.reply).toBe('Tudo bem, não vou enviar a mensagem.');
      expect(messaging.sent).toHaveLength(0);
      expect(stateMachine.getCurrentState()).toBe('IDLE');
    });

    it('an ambiguous answer never sends and asks again', async () => {
      const { processor, receive, messaging, stateMachine, ai } = setup();
      await receive();
      await processor.processCommand('responde que já estou chegando');
      ai.intentResult = { intent: 'CONFIRM', confidence: 1 }; // mesmo que o LLM "ache" que é sim

      const result = await processor.processCommand('sim, mas muda o horário');
      expect(result.intent).toBe('UNKNOWN');
      expect(result.reply).toContain('Posso enviar a resposta para João?');
      expect(messaging.sent).toHaveLength(0);
      expect(stateMachine.getCurrentState()).toBe('WAITING_CONFIRMATION');
      expect(ai.intentCalls).toHaveLength(0);
    });

    it('falls back to the dictated text when the AI is offline', async () => {
      const { processor, receive, ai } = setup();
      await receive();
      ai.available = false;
      const result = await processor.processCommand('Responde para o João que já estou chegando');
      expect(result.reply).toBe('Preparei esta resposta para João: "Já estou chegando.". Posso enviar?');
    });

    it('does not guess the recipient when the named contact is unknown', async () => {
      const { processor, receive, stateMachine } = setup();
      await receive({ senderName: 'João' });
      const result = await processor.processCommand('Responde para a Carla que já vou');
      expect(result.reply).toContain('Ainda não conheço seus contatos');
      expect(stateMachine.getCurrentState()).toBe('IDLE');
    });

    it('refuses to reply when WhatsApp is disconnected', async () => {
      const { processor, receive, messaging } = setup();
      await receive();
      messaging.connected = false;
      const result = await processor.processCommand('responde que ok');
      expect(result.reply).toBe('O WhatsApp está desconectado, então não consigo enviar mensagens agora.');
    });

    it('keeps the draft when sending fails, so the user can retry', async () => {
      const { processor, receive, messaging, stateMachine } = setup();
      await receive();
      await processor.processCommand('responde que ok');
      messaging.sendError = new Error('socket closed');

      const failed = await processor.processCommand('pode enviar');
      expect(failed.reply).toBe('Não consegui enviar a mensagem. Quer que eu tente de novo?');
      expect(stateMachine.getCurrentState()).toBe('WAITING_CONFIRMATION');

      messaging.sendError = undefined;
      const retried = await processor.processCommand('sim');
      expect(retried.reply).toBe('Mensagem enviada para João.');
      expect(messaging.sent).toHaveLength(1);
    });

    it('answers other commands while waiting for confirmation', async () => {
      const { processor, receive, stateMachine } = setup();
      await receive();
      await processor.processCommand('responde que ok');
      const result = await processor.processCommand('status');
      expect(result.intent).toBe('STATUS');
      expect(result.reply).toContain('Ainda aguardo sua confirmação');
      expect(stateMachine.getCurrentState()).toBe('WAITING_CONFIRMATION');
    });

    it('CONFIRM/CANCEL without a pending reply are harmless', async () => {
      const { processor, messaging } = setup();
      expect((await processor.processCommand('pode mandar')).reply).toBe(
        'Não há nenhuma resposta aguardando confirmação.'
      );
      expect((await processor.processCommand('cancela')).reply).toBe('Não há nada para cancelar.');
      expect(messaging.sent).toHaveLength(0);
    });
  });

  describe('unrecognized commands', () => {
    it('explains that the AI is offline', async () => {
      const { processor, ai } = setup();
      ai.available = false;
      const result = await processor.processCommand('qual a capital da França?');
      expect(result.intent).toBe('UNKNOWN');
      expect(result.reply).toContain('A inteligência artificial está indisponível no momento');
    });

    it('asks to repeat when the AI does not understand either', async () => {
      const { processor } = setup();
      const result = await processor.processCommand('blá blá blá');
      expect(result.reply).toContain('Não entendi');
    });

    it('does not shut down on an AI guess', async () => {
      const { processor, ai } = setup();
      ai.intentResult = { intent: 'STOP', confidence: 0.6 };
      const result = await processor.processCommand('acho que já deu por hoje');
      expect(result.shouldStop).toBeUndefined();
    });
  });
});
