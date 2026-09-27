/**
 * Utilitários de normalização para interpretar comandos em português,
 * venham eles do teclado ou da transcrição de voz.
 */

/**
 * Minúsculas e sem acentos, preservando o comprimento (1 caractere -> 1 caractere).
 * Isso permite casar regex no texto "dobrado" e recortar o texto original pelos mesmos índices.
 */
export function fold(text: string): string {
  let result = '';
  for (const char of text) {
    const lower = char.toLowerCase();
    const base = lower.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const folded = base.length === 1 ? base : lower.length === 1 ? lower : ' ';
    // Caracteres fora do BMP (ex.: emoji) ocupam 2 unidades UTF-16: mantém o comprimento.
    result += folded.padEnd(char.length, ' ');
  }
  return result;
}

/** Remove "Celeste," / "Ei Celeste" do início (e "Celeste" do fim) de um comando. */
const WAKE_PREFIX = /^\s*(?:(?:ei|oi|ok|ola|hey|e ai)[\s,]+)?celest\w*\b[\s,.!:;-]*/;
const WAKE_SUFFIX = /[\s,]*\bcelest\w*[\s.!?]*$/;

export function stripWakeWord(original: string): string {
  const folded = fold(original);
  const prefix = folded.match(WAKE_PREFIX);
  let start = prefix ? prefix[0].length : 0;
  let end = original.length;
  const suffix = folded.slice(start).match(WAKE_SUFFIX);
  if (suffix && suffix.index !== undefined) {
    end = start + suffix.index;
  }
  return original.slice(start, end).trim();
}

/** Forma canônica para casar regras: sem acentos, sem pontuação, sem o nome "Celeste". */
export function normalizeCommand(text: string): string {
  return fold(stripWakeWord(text))
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function wordCount(normalized: string): number {
  return normalized ? normalized.split(' ').length : 0;
}

/** Comparação de nomes tolerante a acentos e caixa. */
export function sameName(a: string, b: string): boolean {
  return normalizeCommand(a) === normalizeCommand(b);
}

/** "João" casa com "João Silva" e com "joao". */
export function nameMatches(candidate: string | undefined, query: string): boolean {
  if (!candidate) {
    return false;
  }
  const name = normalizeCommand(candidate);
  const wanted = normalizeCommand(query);
  if (!name || !wanted) {
    return false;
  }
  return name === wanted || name.split(' ').includes(wanted) || name.startsWith(`${wanted} `);
}

export function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Deixa um texto ditado com cara de mensagem: maiúscula inicial e pontuação final. */
export function toSentence(text: string): string {
  const trimmed = text.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (!trimmed) {
    return '';
  }
  const capitalized = capitalizeFirst(trimmed);
  return /[.!?…]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

const SMALL_NUMBERS_FEM = ['zero', 'uma', 'duas', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez'];

/** 3 -> "três" (feminino, para "mensagens"). */
export function countInWords(count: number): string {
  return count >= 0 && count < SMALL_NUMBERS_FEM.length ? SMALL_NUMBERS_FEM[count] : String(count);
}

/** ["a", "b", "c"] -> "a, b e c" */
export function joinList(items: string[]): string {
  if (items.length <= 1) {
    return items.join('');
  }
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}
