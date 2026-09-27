import { IntentClassifier } from '../../src/application/IntentClassifier';
import { FakeAI } from '../helpers/fakes';

describe('IntentClassifier', () => {
  const classifier = new IntentClassifier();

  const cases: Array<[string, string]> = [
    ['status', 'STATUS'],
    ['Celeste, status', 'STATUS'],
    ['Celeste, status.', 'STATUS'],
    ['como está o sistema?', 'STATUS'],
    ['Celeste, qual é o status do sistema?', 'STATUS'],
    ['Celeste, me fala como está o sistema.', 'STATUS'],
    ['Como estão os serviços?', 'STATUS'],
    ['Celeste, como você está?', 'STATUS'],
    ['Celeste, ajuda.', 'HELP'],
    ['Celeste, o que você consegue fazer?', 'HELP'],
    ['desligar', 'STOP'],
    ['Celeste, pode desligar.', 'STOP'],
    ['Leia minha última mensagem.', 'READ_LAST_MESSAGE'],
    ['Celeste, leia a última mensagem.', 'READ_LAST_MESSAGE'],
    ['Leia novamente.', 'READ_LAST_MESSAGE'],
    ['o que o João disse?', 'READ_LAST_MESSAGE'],
    ['Celeste, quais mensagens eu recebi?', 'LIST_MESSAGES'],
    ['Tenho mensagens novas?', 'LIST_MESSAGES'],
    ['Responde para o João dizendo que já vou verificar.', 'REPLY_TO_MESSAGE'],
    ['Responde que ainda estou terminando.', 'REPLY_TO_MESSAGE'],
    ['Cancela isso.', 'CANCEL'],
    ['Pode mandar.', 'CONFIRM'],
    ['Não', 'DENY'],
    ['Repete', 'REPEAT'],
    ['Não entendi, fala de novo', 'REPEAT'],
  ];

  it.each(cases)('"%s" => %s', (text, intent) => {
    expect(classifier.classifyDeterministic(text)?.intent).toBe(intent);
  });

  it('"leia novamente" re-reads the focused message', () => {
    expect(classifier.classifyDeterministic('Leia novamente.')).toMatchObject({ again: true });
  });

  it('extracts reading target ("leia a mensagem da Maria")', () => {
    expect(classifier.classifyDeterministic('leia a mensagem da Maria')).toMatchObject({
      intent: 'READ_LAST_MESSAGE',
      target: 'maria',
    });
  });

  describe('parseReplyCommand', () => {
    it.each([
      ['Responde para o João dizendo que já vou verificar.', 'João', 'já vou verificar.'],
      ['Celeste, responde pro João que já estou chegando', 'João', 'já estou chegando'],
      ['Responde para João Silva: estou a caminho', 'João Silva', 'estou a caminho'],
      ['Responde que ainda estou terminando.', undefined, 'ainda estou terminando.'],
      ['Responde dizendo que já vou verificar.', undefined, 'já vou verificar.'],
      ['responde pra ele que ok', undefined, 'ok'],
      ['Manda para a Maria dizendo que chego às 8', 'Maria', 'chego às 8'],
      ['responde a mensagem dizendo que sim', undefined, 'sim'],
    ])('"%s" => target=%s content=%s', (text, target, content) => {
      expect(classifier.parseReplyCommand(text)).toEqual({ target, content });
    });

    it('bare "responde" is a reply without content', () => {
      expect(classifier.parseReplyCommand('Responde')).toEqual({ target: undefined, content: '' });
    });

    it.each(['manda', 'Envia', 'pode mandar', 'status'])('"%s" is not a reply command', (text) => {
      expect(classifier.parseReplyCommand(text)).toBeNull();
    });
  });

  describe('LLM fallback', () => {
    it('does not call the LLM for deterministic commands', async () => {
      const ai = new FakeAI();
      const withAI = new IntentClassifier(ai);
      const intent = await withAI.classify('Celeste, status');
      expect(intent.intent).toBe('STATUS');
      expect(ai.intentCalls).toHaveLength(0);
    });

    it('uses the LLM for free-form sentences', async () => {
      const ai = new FakeAI();
      ai.intentResult = { intent: 'STATUS', confidence: 0.8 };
      const withAI = new IntentClassifier(ai);
      const intent = await withAI.classify('Celeste, está tudo em ordem por aí com as coisas?');
      expect(intent).toMatchObject({ intent: 'STATUS', source: 'ai' });
      expect(ai.intentCalls).toHaveLength(1);
    });

    it('ignores low-confidence LLM guesses', async () => {
      const ai = new FakeAI();
      ai.intentResult = { intent: 'HELP', confidence: 0.2 };
      const withAI = new IntentClassifier(ai);
      expect((await withAI.classify('e aí')).intent).toBe('UNKNOWN');
    });

    it('returns UNKNOWN without calling the LLM when AI is offline', async () => {
      const ai = new FakeAI();
      ai.available = false;
      const withAI = new IntentClassifier(ai);
      const intent = await withAI.classify('qual a capital da França');
      expect(intent.intent).toBe('UNKNOWN');
      expect(ai.intentCalls).toHaveLength(0);
    });

    it('returns UNKNOWN when the LLM call fails', async () => {
      const ai = new FakeAI();
      ai.parseIntent = async () => {
        throw new Error('boom');
      };
      const withAI = new IntentClassifier(ai);
      expect((await withAI.classify('frase qualquer sem regra')).intent).toBe('UNKNOWN');
    });
  });
});
