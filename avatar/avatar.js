/*
 * Celeste — controlador visual do avatar 2D (nuvem de pontos).
 * Recebe o estado do backend (Server-Sent Events em /events) e apenas desenha:
 * nenhuma regra de negócio aqui. Sem requestAnimationFrame e sem timers em repouso:
 * a única animação por script é a boca, e só enquanto a Celeste fala.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var body = document.body;
  if (params.get('bg') === 'transparent') body.classList.add('transparent');
  if (params.get('hud') === '0') body.classList.add('no-hud');
  if (params.get('captions') === '0') body.classList.add('no-captions');
  var msPerChar = Number(params.get('cps')) > 0 ? 1000 / Number(params.get('cps')) : 70;

  var $ = function (selector) { return document.querySelector(selector); };
  var el = {
    label: $('.status .label'),
    caption: $('.caption'),
    inner: $('.mouth-inner'),
    dots: $('.mouth-dots'),
  };

  // ---- Boca: linha de pontos que se abre em dois arcos -----------------------

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var DOTS = 15;
  var upperDots = [];
  var lowerDots = [];

  function createDots() {
    for (var i = 0; i < DOTS * 2; i++) {
      var dot = document.createElementNS(SVG_NS, 'circle');
      el.dots.appendChild(dot);
      (i < DOTS ? upperDots : lowerDots).push(dot);
    }
  }

  /**
   * h = abertura (0 = linha única); s = curvatura dos cantos (positivo = cantos levemente para cima).
   * Os pontos afinam nos cantos (menores e mais apagados) e o arco de baixo desce mais que o de cima,
   * como uma mandíbula. Com h = 0 os dois arcos coincidem numa só linha.
   */
  function mouthShape(h, s) {
    var halfWidth = 27 - h * 0.35;
    var upper = [];
    var lower = [];
    for (var i = 0; i < DOTS; i++) {
      var t = i / (DOTS - 1);
      var x = -halfWidth + 2 * halfWidth * t;
      var bulge = Math.sin(Math.PI * t);          // 0 nos cantos, 1 no centro
      var corner = (1 - bulge) * -s;              // cantos sobem/descem com a curvatura
      var r = 0.45 + 0.75 * bulge;
      var alpha = 0.3 + 0.7 * bulge;
      upper.push({ x: x, y: corner - h * 0.22 * bulge, r: r, a: alpha });
      lower.push({ x: x, y: corner + h * 0.78 * bulge, r: h > 0 ? r : 0, a: alpha });
    }
    return { upper: upper, lower: lower, rx: halfWidth * 0.75, ry: h * 0.6, cy: h * 0.28 };
  }

  var MOUTHS = {
    IDLE: mouthShape(0, 0.2),
    MOUTH_CLOSED: mouthShape(0, 0.2),
    MOUTH_SMALL: mouthShape(3.5, 0.1),
    MOUTH_MEDIUM: mouthShape(7, 0),
    MOUTH_OPEN: mouthShape(11, -0.2),
    FROWN: mouthShape(0, -1.2),
  };
  var currentMouth = null;

  function placeDots(nodes, points) {
    for (var i = 0; i < nodes.length; i++) {
      var p = points[i];
      nodes[i].setAttribute('cx', p.x.toFixed(2));
      nodes[i].setAttribute('cy', p.y.toFixed(2));
      nodes[i].setAttribute('r', p.r.toFixed(2));
      nodes[i].setAttribute('fill-opacity', p.a.toFixed(2));
      nodes[i].setAttribute('class', p.a > 0.85 ? 'bright' : '');
    }
  }

  function setMouth(name) {
    if (name === currentMouth) return;
    var shape = MOUTHS[name] || MOUTHS.IDLE;
    currentMouth = name;
    placeDots(upperDots, shape.upper);
    placeDots(lowerDots, shape.lower);
    el.inner.setAttribute('rx', shape.rx.toFixed(2));
    el.inner.setAttribute('ry', shape.ry.toFixed(2));
    el.inner.setAttribute('cy', shape.cy.toFixed(2));
    body.dataset.mouth = name;
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

  var captionTimer = null;

  function showCaption(text) {
    clearTimeout(captionTimer);
    if (text) {
      el.caption.textContent = text;
      body.classList.add('show-caption');
    } else {
      body.classList.remove('show-caption');
    }
  }

  // ---- Máquina de estados visual ------------------------------------------

  var STATES = ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING', 'ERROR'];
  var state = 'IDLE';

  function setState(next, details) {
    details = details || {};
    state = STATES.indexOf(next) >= 0 ? next : 'IDLE';
    body.dataset.state = state;
    body.dataset.alert = details.alert ? 'true' : 'false';
    el.label.textContent = details.reason === 'message' && state === 'LISTENING' ? 'MESSAGE' : state;
    stopSpeaking();

    switch (state) {
      case 'SPEAKING':
        showCaption(details.text);
        startSpeaking(details.text);
        break;
      case 'ERROR':
        setMouth('FROWN');
        showCaption(details.text);
        break;
      case 'IDLE':
        setMouth('IDLE');
        captionTimer = setTimeout(function () { showCaption(null); }, 2500);
        break;
      default:
        setMouth('MOUTH_CLOSED');
        showCaption(null);
    }
  }

  function getState() { return state; }

  // ---- Conexão com o backend ----------------------------------------------

  function setConnected(connected) {
    body.dataset.connected = connected ? 'true' : 'false';
    if (!connected) {
      stopSpeaking();
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

  window.celesteAvatar = { setState: setState, getState: getState, setMouth: setMouth };

  createDots();
  setMouth('IDLE');
  setState('IDLE');
  if (params.get('demo') === '1') {
    demo();
  } else if (params.get('state')) {
    // ?state=SPEAKING&mouth=MOUTH_OPEN — pré-visualização estática, sem backend.
    body.dataset.connected = 'true';
    var previewState = params.get('state').toUpperCase();
    setState(previewState, {
      text: params.get('text') || 'Estou online e todos os sistemas principais estão funcionando.',
      alert: previewState === 'ERROR',
    });
    if (params.get('mouth')) { stopSpeaking(); setMouth(params.get('mouth')); }
  } else {
    setConnected(false);
    connect();
  }
})();
