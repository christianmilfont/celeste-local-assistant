/*
 * Celeste — controlador visual do avatar 2D.
 * Recebe o estado do backend (Server-Sent Events em /events) e apenas desenha:
 * nenhuma regra de negócio aqui. Sem requestAnimationFrame: tudo é orientado a eventos
 * e timers esparsos (piscar, olhar, boca durante a fala).
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var body = document.body;
  if (params.get('bg') === 'transparent') body.classList.add('transparent');
  if (params.get('hud') === '0') body.classList.add('no-hud');
  if (params.get('captions') === '0') body.classList.add('no-captions');
  if (params.get('lite') === '1') body.classList.add('lite');
  var msPerChar = Number(params.get('cps')) > 0 ? 1000 / Number(params.get('cps')) : 70;

  var $ = function (selector) { return document.querySelector(selector); };
  var $$ = function (selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); };

  var el = {
    head: $('.head-motion'),
    gaze: $$('.gaze'),
    label: $('.status .label'),
    caption: $('.caption'),
    inner: $('.mouth-inner'),
    clip: $('.mouth-inner-clip'),
    upper: $('.lip-upper'),
    lower: $('.lip-lower'),
    gloss: $('.lip-gloss'),
    line: $('.lip-line'),
  };

  function random(min, max) { return min + Math.random() * (max - min); }

  // ---- Boca -----------------------------------------------------------------

  /** h = abertura; s = curvatura dos cantos (positivo = sorriso). */
  function mouthPaths(h, s) {
    var cy = 1 - s;
    var top = -h * 0.5;
    var bottom = 1 + h * 0.9;
    var inner = 'M-18 ' + cy + ' C-10 ' + top + ' 10 ' + top + ' 18 ' + cy +
      ' C10 ' + bottom + ' -10 ' + bottom + ' -18 ' + cy + ' Z';
    var upper = 'M-19 ' + cy + ' C-12 -5 -5 -7 0 -3.8 C5 -7 12 -5 19 ' + cy +
      ' C10 ' + (top + 1.5) + ' -10 ' + (top + 1.5) + ' -19 ' + cy + ' Z';
    var lower = 'M-19 ' + cy + ' C-10 ' + (bottom - 1) + ' 10 ' + (bottom - 1) + ' 19 ' + cy +
      ' C12 ' + (bottom + 8) + ' -12 ' + (bottom + 8) + ' -19 ' + cy + ' Z';
    var gloss = 'M-8 ' + (bottom + 2.5) + ' C-3 ' + (bottom + 4.5) + ' 3 ' + (bottom + 4.5) + ' 8 ' + (bottom + 2.5) +
      ' C3 ' + (bottom + 5.5) + ' -3 ' + (bottom + 5.5) + ' -8 ' + (bottom + 2.5) + ' Z';
    // Linha entre os lábios (visível com a boca fechada).
    var line = 'M-19 ' + cy + ' C-10 ' + (top + 1.2) + ' 10 ' + (top + 1.2) + ' 19 ' + cy;
    return { inner: inner, upper: upper, lower: lower, gloss: gloss, line: line };
  }

  var MOUTHS = {
    IDLE: mouthPaths(0, 0.3),
    MOUTH_CLOSED: mouthPaths(0, 0.2),
    MOUTH_SMALL: mouthPaths(3.5, 0.1),
    MOUTH_MEDIUM: mouthPaths(7, 0),
    MOUTH_OPEN: mouthPaths(11, -0.2),
    FROWN: mouthPaths(0, -1.1),
  };
  var currentMouth = null;

  function setMouth(name) {
    if (name === currentMouth) return;
    var shape = MOUTHS[name] || MOUTHS.IDLE;
    currentMouth = name;
    el.inner.setAttribute('d', shape.inner);
    el.clip.setAttribute('d', shape.inner);
    el.upper.setAttribute('d', shape.upper);
    el.lower.setAttribute('d', shape.lower);
    el.gloss.setAttribute('d', shape.gloss);
    el.line.setAttribute('d', shape.line);
    body.dataset.mouth = name;
  }

  // ---- Olhos ----------------------------------------------------------------

  var eyesMode = 'OPEN';
  var blinkTimer = null;

  function setEyes(mode) {
    eyesMode = mode;
    body.dataset.eyes = mode;
  }

  function blink() {
    if (eyesMode === 'CLOSED') return;
    body.classList.add('blink');
    setTimeout(function () { body.classList.remove('blink'); }, 120);
  }

  function scheduleBlink() {
    clearTimeout(blinkTimer);
    var wait = state === 'LISTENING' ? random(4000, 8000) : random(2600, 6500);
    blinkTimer = setTimeout(function () {
      blink();
      if (Math.random() < 0.15) setTimeout(blink, 260); // piscada dupla ocasional
      scheduleBlink();
    }, wait);
  }

  function look(x, y) {
    var transform = 'translate(' + x + 'px, ' + y + 'px)';
    el.gaze.forEach(function (node) { node.style.transform = transform; });
  }

  // ---- Movimento de cabeça (eventos esparsos, parado entre eles) ------------

  var motionTimer = null;

  function scheduleMotion() {
    clearTimeout(motionTimer);
    if (state === 'LISTENING') {
      el.head.style.transform = 'translateY(0.6%) rotate(0.4deg) scale(1.012)';
      return;
    }
    if (state === 'THINKING') {
      el.head.style.transform = 'rotate(-1.2deg) translateX(-0.4%)';
      return;
    }
    if (state === 'ERROR') {
      el.head.style.transform = 'rotate(0deg)';
      return;
    }
    var amplitude = state === 'SPEAKING' ? 1.2 : 0.8;
    el.head.style.transform =
      'translate(' + random(-0.5, 0.5).toFixed(2) + '%, ' + random(-0.4, 0.4).toFixed(2) + '%) ' +
      'rotate(' + random(-amplitude, amplitude).toFixed(2) + 'deg)';
    motionTimer = setTimeout(scheduleMotion, random(3500, 7000));
  }

  // ---- Olhar em IDLE e THINKING -------------------------------------------

  var gazeTimer = null;
  var THINKING_POINTS = [[5, -0.5], [-5, -0.5], [2, -1], [-3, 0]];

  function scheduleGaze() {
    clearTimeout(gazeTimer);
    if (state === 'THINKING') {
      var point = THINKING_POINTS[Math.floor(Math.random() * THINKING_POINTS.length)];
      look(point[0], point[1]);
      body.dataset.scan = String((Number(body.dataset.scan || 0) + 1) % 4);
      gazeTimer = setTimeout(scheduleGaze, random(700, 1200));
    } else if (state === 'IDLE') {
      if (Math.random() < 0.35) {
        look(random(-6, 6).toFixed(1), random(-0.6, 0.6).toFixed(1));
        gazeTimer = setTimeout(function () { look(0, 0); scheduleGaze(); }, random(900, 1800));
      } else {
        gazeTimer = setTimeout(scheduleGaze, random(4000, 9000));
      }
    } else {
      look(0, 0);
    }
    if (state !== 'THINKING') {
      body.dataset.scan = '0';
    }
  }

  // ---- Fala ------------------------------------------------------------------

  var speechTimer = null;

  function startSpeaking(text) {
    stopSpeaking();
    var sequence = window.LipSync.sequence(text || 'a e o a e', msPerChar);
    var index = 0;
    function step() {
      if (state !== 'SPEAKING') return;
      if (index >= sequence.length) index = 0; // fala mais longa que a estimativa: continua
      var segment = sequence[index++];
      setMouth(segment.shape);
      speechTimer = setTimeout(step, segment.ms);
    }
    step();
  }

  function stopSpeaking() {
    clearTimeout(speechTimer);
    speechTimer = null;
  }

  function showCaption(text) {
    if (text) {
      el.caption.textContent = text;
      body.classList.add('show-caption');
    } else {
      body.classList.remove('show-caption');
    }
  }

  // ---- Máquina de estados visual ------------------------------------------

  var LABELS = {
    IDLE: 'IDLE',
    LISTENING: 'LISTENING',
    THINKING: 'THINKING',
    SPEAKING: 'SPEAKING',
    ERROR: 'ERROR',
  };
  var state = 'IDLE';

  function setState(next, details) {
    details = details || {};
    state = LABELS[next] ? next : 'IDLE';
    body.dataset.state = state;
    body.dataset.alert = details.alert ? 'true' : 'false';
    el.label.textContent = details.reason === 'message' && state === 'LISTENING' ? 'MESSAGE' : LABELS[state];
    stopSpeaking();

    switch (state) {
      case 'LISTENING':
        setEyes('LISTENING');
        setMouth('MOUTH_CLOSED');
        showCaption(null);
        break;
      case 'THINKING':
        setEyes('THINKING');
        setMouth('MOUTH_CLOSED');
        break;
      case 'SPEAKING':
        setEyes('OPEN');
        showCaption(details.text);
        startSpeaking(details.text);
        break;
      case 'ERROR':
        setEyes('OPEN');
        setMouth('FROWN');
        showCaption(details.text);
        break;
      default:
        setEyes('OPEN');
        setMouth('IDLE');
        setTimeout(function () { if (state === 'IDLE') showCaption(null); }, 2500);
    }

    scheduleGaze();
    scheduleMotion();
    scheduleBlink();
  }

  function getState() { return state; }

  // ---- Conexão com o backend ----------------------------------------------

  function setConnected(connected) {
    body.dataset.connected = connected ? 'true' : 'false';
    if (!connected) {
      stopSpeaking();
      setEyes('CLOSED');
      setMouth('IDLE');
      el.label.textContent = 'OFFLINE';
    }
  }

  function connect() {
    var source = new EventSource('/events');
    source.addEventListener('state', function (event) {
      var data = JSON.parse(event.data);
      setConnected(true);
      setState(data.state, data);
    });
    source.onopen = function () { setConnected(true); };
    source.onerror = function () { setConnected(false); }; // o EventSource reconecta sozinho
  }

  // ?demo=1 percorre os estados sem backend (revisão visual / teste em hardware).
  function demo() {
    body.dataset.connected = 'true';
    var steps = [
      ['IDLE', {}, 4000],
      ['LISTENING', {}, 3000],
      ['THINKING', {}, 2500],
      ['SPEAKING', { text: 'Estou online. WhatsApp conectado, inteligência artificial disponível e sistema de voz funcionando.' }, 7000],
      ['IDLE', {}, 3000],
      ['LISTENING', { reason: 'message' }, 1200],
      ['SPEAKING', { text: 'Você recebeu uma mensagem de João: oi, você está disponível?' }, 5000],
      ['ERROR', { text: 'Não consegui entender o áudio. Pode repetir?', alert: true }, 3000],
    ];
    var i = 0;
    (function next() {
      var step = steps[i++ % steps.length];
      setState(step[0], step[1]);
      setTimeout(next, step[2]);
    })();
  }

  window.celesteAvatar = { setState: setState, getState: getState, setMouth: setMouth, setEyes: setEyes, blink: blink };

  setMouth('IDLE');
  setState('IDLE');
  if (params.get('demo') === '1') {
    demo();
  } else if (params.get('state')) {
    // ?state=SPEAKING&mouth=MOUTH_OPEN — pré-visualização estática, sem backend.
    body.dataset.connected = 'true';
    setState(params.get('state').toUpperCase(), {
      text: params.get('text') || 'Estou online e todos os sistemas principais estão funcionando.',
      alert: params.get('state').toUpperCase() === 'ERROR',
    });
    if (params.get('mouth')) { stopSpeaking(); setMouth(params.get('mouth')); }
  } else {
    setConnected(false);
    connect();
  }
})();
