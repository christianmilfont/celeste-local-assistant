import { ConfirmationService } from '../../src/application/ConfirmationService';

describe('ConfirmationService', () => {
  const service = new ConfirmationService();

  it.each(['sim', 'pode', 'manda', 'Pode.', 'Pode enviar.', 'Sim, pode mandar!', 'Celeste, pode enviar', 'ok', 'Envia'])(
    '"%s" => CONFIRM',
    (text) => {
      expect(service.parse(text)).toBe('CONFIRM');
    }
  );

  it.each(['não', 'Não.', 'nao', 'não pode', 'Não envia', 'negativo'])('"%s" => DENY', (text) => {
    expect(service.parse(text)).toBe('DENY');
  });

  it.each(['cancela', 'Cancela isso.', 'deixa', 'deixa pra lá', 'esquece', 'espera', 'para'])(
    '"%s" => CANCEL',
    (text) => {
      expect(service.parse(text)).toBe('CANCEL');
    }
  );

  it('negation wins over confirmation words ("não pode mandar")', () => {
    expect(service.parse('não pode mandar')).toBe('DENY');
  });

  it.each([
    '',
    'hmm',
    'sim, mas muda para amanhã',
    'acho que pode',
    'pode ser que eu mande depois quando chegar em casa hoje',
    'qual é a previsão do tempo',
  ])('ambiguous "%s" => UNKNOWN (never sends)', (text) => {
    expect(service.parse(text)).toBe('UNKNOWN');
  });

  it('"pode enviar para ele" is a confirmation, not a cancellation', () => {
    expect(service.parse('pode enviar para ele')).toBe('CONFIRM');
  });
});
