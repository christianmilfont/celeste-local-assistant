/*
 * Lip-sync aproximado: converte o texto falado numa sequência de formas de boca.
 * Não é sincronização fonética real — só dá a impressão de fala coerente com o texto
 * (vogais abrem, "m/b/p" fecham, pontuação faz pausa). O fim real vem do evento TTS_FINISHED.
 * Funciona no navegador (window.LipSync) e no Node (testes).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LipSync = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SHAPES = ['MOUTH_CLOSED', 'MOUTH_SMALL', 'MOUTH_MEDIUM', 'MOUTH_OPEN'];
  /** Menor duração de uma forma: limita a ~12 atualizações por segundo. */
  var MIN_SEGMENT_MS = 80;

  function moreOpen(a, b) {
    return SHAPES.indexOf(a) >= SHAPES.indexOf(b) ? a : b;
  }

  function shapeFor(char) {
    if (/[aáàâã]/.test(char)) return 'MOUTH_OPEN';
    if (/[eéêoóôõ]/.test(char)) return 'MOUTH_MEDIUM';
    if (/[iíuúüy]/.test(char)) return 'MOUTH_SMALL';
    if (/[mbp]/.test(char)) return 'MOUTH_CLOSED';
    if (/[a-zç]/.test(char)) return 'MOUTH_SMALL';
    return null;
  }

  /**
   * @param {string} text
   * @param {number} [msPerChar=70] ~14 caracteres/s, ritmo da voz padrão do Windows
   * @returns {{shape: string, ms: number}[]}
   */
  function sequence(text, msPerChar) {
    var unit = msPerChar || 70;
    var raw = [];

    function push(shape, ms) {
      var last = raw[raw.length - 1];
      if (last && last.shape === shape) {
        last.ms += ms;
      } else {
        raw.push({ shape: shape, ms: ms });
      }
    }

    var chars = String(text || '').toLowerCase();
    for (var i = 0; i < chars.length; i++) {
      var char = chars[i];
      if (/[.!?;:…]/.test(char)) {
        push('MOUTH_CLOSED', unit * 4);
      } else if (char === ',') {
        push('MOUTH_CLOSED', unit * 2.5);
      } else if (/\s/.test(char)) {
        push('MOUTH_SMALL', unit * 0.6);
      } else if (/\d/.test(char)) {
        // Números viram palavras faladas ("três"): alterna aberturas.
        push('MOUTH_MEDIUM', unit * 1.5);
        push('MOUTH_SMALL', unit * 1.5);
      } else {
        var shape = shapeFor(char);
        if (shape) push(shape, unit);
      }
    }

    // Agrupa letras em janelas de ~MIN_SEGMENT_MS mantendo a forma mais aberta de cada janela:
    // menos repinturas, sem perder as vogais. Pausas (segmentos longos) ficam como estão.
    var merged = [];
    var bucket = null;
    function emit(segment) {
      var last = merged[merged.length - 1];
      if (last && last.shape === segment.shape) {
        last.ms += segment.ms;
      } else {
        merged.push({ shape: segment.shape, ms: segment.ms });
      }
    }
    function flush() {
      if (!bucket) return;
      var last = merged[merged.length - 1];
      if (bucket.ms < MIN_SEGMENT_MS / 2 && last) {
        last.ms += bucket.ms;
        last.shape = moreOpen(last.shape, bucket.shape);
      } else {
        emit(bucket);
      }
      bucket = null;
    }
    for (var j = 0; j < raw.length; j++) {
      var segment = raw[j];
      if (segment.ms >= MIN_SEGMENT_MS) {
        flush();
        emit(segment);
        continue;
      }
      if (!bucket) {
        bucket = { shape: segment.shape, ms: segment.ms };
      } else {
        bucket.ms += segment.ms;
        bucket.shape = moreOpen(bucket.shape, segment.shape);
      }
      if (bucket.ms >= MIN_SEGMENT_MS) {
        emit(bucket);
        bucket = null;
      }
    }
    flush();
    return merged;
  }

  return { sequence: sequence, shapeFor: shapeFor, SHAPES: SHAPES, MIN_SEGMENT_MS: MIN_SEGMENT_MS };
});
