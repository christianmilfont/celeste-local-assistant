/*
 * Celeste — holograma facial 3D (Three.js / WebGL).
 *
 * Representação visual apenas: o estado vem do backend (SSE em /events), como na versão SVG.
 * Performance (alvo: GTX 1050 Ti):
 *  - toda a rede é BufferGeometry + Points/LineSegments nativos com ShaderMaterial próprio
 *    (nenhum objeto por partícula; ~3,4 mil pontos, ~5,8 mil ligações, 2 aglomerados de olhos);
 *  - pixelRatio limitado a 2; bloom do UnrealBloomPass (trabalha em mips de meia resolução);
 *  - aberração cromática + scanlines + vinheta + grão + conversão sRGB num ÚNICO ShaderPass final;
 *  - 30 fps em IDLE (sem mouse ativo), 60 fps nos demais estados; o navegador pausa em segundo plano;
 *  - ?lite=1 desliga o pós-processamento (render direto).
 * Sem WebGL, cai para a versão SVG (variants/pointcloud/).
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const params = new URLSearchParams(location.search);
const LITE = params.get('lite') === '1';
const body = document.body;
if (params.get('hud') === '0') body.classList.add('no-hud');
if (params.get('captions') === '0') body.classList.add('no-captions');
const msPerChar = Number(params.get('cps')) > 0 ? 1000 / Number(params.get('cps')) : 70;

// ---------------------------------------------------------------- renderer (com fallback)

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
} catch (error) {
  location.replace('variants/pointcloud/' + location.search);
  throw error;
}
const PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(PIXEL_RATIO);
renderer.setClearColor(0x000000, 1);
document.querySelector('.stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
camera.position.set(0, 0, 7.8);

const head = new THREE.Group();
head.position.y = -0.12;
scene.add(head);

// ---------------------------------------------------------------- estados visuais

const STATES = {
  IDLE:      { color: '#4fcfff', intensity: 0.85, eyes: 0.85, breath: 0.9 },
  LISTENING: { color: '#7fe8ff', intensity: 1.15, eyes: 1.25, breath: 1.6 },
  THINKING:  { color: '#7f9cff', intensity: 1.0,  eyes: 0.95, breath: 2.8 },
  SPEAKING:  { color: '#4fcfff', intensity: 1.05, eyes: 1.05, breath: 1.2 },
  ERROR:     { color: '#ff5468', intensity: 1.0,  eyes: 1.05, breath: 2.0 },
  OFFLINE:   { color: '#3d5566', intensity: 0.35, eyes: 0.15, breath: 0.5 },
};

const shared = {
  uTime: { value: 0 },
  uColor: { value: new THREE.Color(STATES.IDLE.color) },
  uIntensity: { value: STATES.IDLE.intensity },
  uBreath: { value: 1 },
  uPixelRatio: { value: PIXEL_RATIO },
};
const target = { color: new THREE.Color(STATES.IDLE.color), intensity: 0.85, eyes: 0.85, breathSpeed: 0.9 };
const OUTPUT_SRGB = LITE ? '#define OUTPUT_SRGB\n' : '';

const SRGB_GLSL = /* glsl */ `
  vec3 toSRGB(vec3 c) {
    c = max(c, 0.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
`;

// Brilho de cada ponto: recorte (bordas em relação à câmera) + luz principal + "respiração".
const SURFACE_GLSL = /* glsl */ `
  attribute float aShell;
  attribute float aPhase;
  uniform float uTime;
  uniform float uBreath;
  uniform float uIntensity;
  float surfaceBrightness(vec4 mv, vec3 objNormal, float yObj) {
    vec3 n = normalize(normalMatrix * objNormal);
    vec3 v = normalize(-mv.xyz);
    float facing = dot(n, v);
    float rim = pow(1.0 - clamp(abs(facing), 0.0, 1.0), 1.6);
    float key = pow(max(dot(n, normalize(vec3(-0.5, 0.55, 0.7))), 0.0), 1.5);
    float front = smoothstep(-0.25, 0.2, facing);            // o que está de costas fica tênue (holograma)
    float fade = smoothstep(1.46, 1.08, yObj) * smoothstep(-1.76, -1.48, yObj);
    float twinkle = 0.88 + 0.12 * sin(uTime * 1.7 + aPhase * 6.2831);
    return (0.06 + 0.62 * rim + 0.42 * key) * mix(0.22, 1.0, front) * aShell
         * (0.35 + 0.65 * fade) * twinkle * uBreath * uIntensity;
  }
`;

function faceMaterial(kind) {
  const isPoints = kind === 'points';
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uSize: { value: 0.042 }, uLineAlpha: { value: 0.13 } },
    vertexShader: OUTPUT_SRGB + SURFACE_GLSL + /* glsl */ `
      uniform float uSize;
      uniform float uPixelRatio;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vAlpha = surfaceBrightness(mv, normal, position.y);
        ${isPoints ? 'gl_PointSize = uSize * (0.6 + 0.6 * vAlpha) * uPixelRatio * (900.0 / -mv.z);' : ''}
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: OUTPUT_SRGB + SRGB_GLSL + /* glsl */ `
      uniform vec3 uColor;
      uniform float uLineAlpha;
      varying float vAlpha;
      void main() {
        ${isPoints ? `
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.08, d);
        float core = smoothstep(0.2, 0.0, d);
        vec3 col = mix(uColor, vec3(1.0), core * 0.4 * min(vAlpha, 1.0)) * vAlpha * a;` : `
        vec3 col = uColor * vAlpha * uLineAlpha;`}
        #ifdef OUTPUT_SRGB
          col = toSRGB(col);
        #endif
        gl_FragColor = vec4(col, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// Olhos: aglomerados densos de partículas (núcleo quase branco, bordas na cor do estado).
const eyeUniforms = { ...shared, uEyes: { value: 0.85 } };
const eyeMaterial = new THREE.ShaderMaterial({
  uniforms: eyeUniforms,
  vertexShader: OUTPUT_SRGB + /* glsl */ `
    attribute float aCore;
    attribute float aPhase;
    uniform float uTime;
    uniform float uEyes;
    uniform float uBreath;
    uniform float uPixelRatio;
    varying float vAlpha;
    varying float vCore;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float flicker = 0.9 + 0.1 * sin(uTime * 3.1 + aPhase * 6.2831);
      vAlpha = (0.12 + 0.55 * aCore) * uEyes * uBreath * flicker;
      vCore = aCore;
      gl_PointSize = (0.018 + 0.028 * aCore) * uPixelRatio * (900.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: OUTPUT_SRGB + SRGB_GLSL + /* glsl */ `
    uniform vec3 uColor;
    varying float vAlpha;
    varying float vCore;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.0, d);
      vec3 col = mix(uColor, vec3(1.0), vCore * 0.75) * vAlpha * a;
      #ifdef OUTPUT_SRGB
        col = toSRGB(col);
      #endif
      gl_FragColor = vec4(col, 1.0);
    }`,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

// Boca: linha pontilhada sutil (as posições mudam só durante a fala).
const MOUTH_DOTS = 23;
const mouthUniforms = { ...shared, uMouth: { value: 0.7 } };
const mouthMaterial = new THREE.ShaderMaterial({
  uniforms: mouthUniforms,
  vertexShader: OUTPUT_SRGB + /* glsl */ `
    attribute float aWeight;
    uniform float uMouth;
    uniform float uIntensity;
    uniform float uPixelRatio;
    varying float vAlpha;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vAlpha = (0.25 + 0.75 * aWeight) * uMouth * uIntensity;
      gl_PointSize = (0.026 + 0.026 * aWeight) * uPixelRatio * (900.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: OUTPUT_SRGB + SRGB_GLSL + /* glsl */ `
    uniform vec3 uColor;
    varying float vAlpha;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      vec3 col = mix(uColor, vec3(1.0), 0.25) * vAlpha * smoothstep(0.5, 0.1, d);
      #ifdef OUTPUT_SRGB
        col = toSRGB(col);
      #endif
      gl_FragColor = vec4(col, 1.0);
    }`,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

// ---------------------------------------------------------------- geometria

let mouthGeometry;
let mouthCenter = new THREE.Vector3();

function buildFace(mesh) {
  const count = mesh.points.length / 3;
  const phase = new Float32Array(count).map(() => Math.random());

  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute('position', new THREE.Float32BufferAttribute(mesh.points, 3));
  pointsGeo.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3));
  pointsGeo.setAttribute('aShell', new THREE.Float32BufferAttribute(mesh.shell, 1));
  pointsGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  head.add(new THREE.Points(pointsGeo, faceMaterial('points')));

  // Ligações: cada segmento repete os atributos dos dois pontos (um único draw call).
  const pairs = mesh.links.length / 2;
  const lp = new Float32Array(pairs * 6);
  const ln = new Float32Array(pairs * 6);
  const ls = new Float32Array(pairs * 2);
  const lph = new Float32Array(pairs * 2);
  for (let k = 0; k < pairs; k++) {
    for (let e = 0; e < 2; e++) {
      const i = mesh.links[k * 2 + e];
      for (let c = 0; c < 3; c++) {
        lp[k * 6 + e * 3 + c] = mesh.points[i * 3 + c];
        ln[k * 6 + e * 3 + c] = mesh.normals[i * 3 + c];
      }
      ls[k * 2 + e] = mesh.shell[i];
      lph[k * 2 + e] = phase[i];
    }
  }
  const linesGeo = new THREE.BufferGeometry();
  linesGeo.setAttribute('position', new THREE.BufferAttribute(lp, 3));
  linesGeo.setAttribute('normal', new THREE.BufferAttribute(ln, 3));
  linesGeo.setAttribute('aShell', new THREE.BufferAttribute(ls, 1));
  linesGeo.setAttribute('aPhase', new THREE.BufferAttribute(lph, 1));
  head.add(new THREE.LineSegments(linesGeo, faceMaterial('lines')));

  // Olhos: aglomerados gaussianos concentrados no centro.
  const EYE_PARTICLES = 420;
  const ep = [];
  const core = [];
  const eph = [];
  for (const [ex, ey, ez] of mesh.eyes) {
    for (let i = 0; i < EYE_PARTICLES; i++) {
      const r = Math.abs(gaussian()) * 0.05;
      const a = Math.random() * Math.PI * 2;
      ep.push(ex + Math.cos(a) * r * 1.15, ey + Math.sin(a) * r * 0.8, ez + gaussian() * 0.012);
      core.push(Math.exp(-(r * r) / (2 * 0.018 * 0.018)));
      eph.push(Math.random());
    }
  }
  const eyesGeo = new THREE.BufferGeometry();
  eyesGeo.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
  eyesGeo.setAttribute('aCore', new THREE.Float32BufferAttribute(core, 1));
  eyesGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(eph, 1));
  head.add(new THREE.Points(eyesGeo, eyeMaterial));

  // Boca
  mouthCenter.fromArray(mesh.mouth);
  mouthGeometry = new THREE.BufferGeometry();
  mouthGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MOUTH_DOTS * 2 * 3), 3));
  mouthGeometry.setAttribute('aWeight', new THREE.BufferAttribute(new Float32Array(MOUTH_DOTS * 2), 1));
  head.add(new THREE.Points(mouthGeometry, mouthMaterial));
  setMouth('IDLE', true);
}

function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------- boca: formas

/** h = abertura (em px do desenho original); s = curvatura dos cantos. */
function mouthShape(h, s) {
  const pos = [];
  const weight = [];
  const halfWidth = 27 - h * 0.35;
  for (const lower of [false, true]) {
    for (let i = 0; i < MOUTH_DOTS; i++) {
      const t = i / (MOUTH_DOTS - 1);
      const x = -halfWidth + 2 * halfWidth * t;
      const bulge = Math.sin(Math.PI * t);
      const corner = (1 - bulge) * -s;
      const y = lower ? corner + h * 0.78 * bulge : corner - h * 0.22 * bulge;
      const lx = x / 100;
      pos.push(mouthCenter.x + lx, mouthCenter.y - y / 100, mouthCenter.z - lx * lx * 1.2);
      weight.push(lower && h === 0 ? 0 : bulge);
    }
  }
  return { pos, weight };
}

const MOUTH_SHAPES = {
  IDLE: [0, 0.3], MOUTH_CLOSED: [0, 0.3], MOUTH_SMALL: [4.5, 0.15],
  MOUTH_MEDIUM: [9, 0], MOUTH_OPEN: [14, -0.3], FROWN: [0, -1.6],
};
const MOUTH_OPENNESS = { MOUTH_SMALL: 0.35, MOUTH_MEDIUM: 0.65, MOUTH_OPEN: 1 };
let currentMouth = null;
let mouthOpen = 0;

function setMouth(name, force) {
  if (!mouthGeometry || (name === currentMouth && !force)) return;
  currentMouth = name;
  const [h, s] = MOUTH_SHAPES[name] || MOUTH_SHAPES.IDLE;
  const shape = mouthShape(h, s);
  mouthGeometry.attributes.position.array.set(shape.pos);
  mouthGeometry.attributes.aWeight.array.set(shape.weight);
  mouthGeometry.attributes.position.needsUpdate = true;
  mouthGeometry.attributes.aWeight.needsUpdate = true;
  mouthOpen = MOUTH_OPENNESS[name] || 0;
  body.dataset.mouth = name;
}

// ---------------------------------------------------------------- pós-processamento

let composer = null;
let finalPass = null;
if (!LITE) {
  composer = new EffectComposer(renderer);
  composer.setPixelRatio(PIXEL_RATIO);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 0.22));

  // Aberração cromática (só nas bordas) + scanlines + vinheta + grão + sRGB, num único passe.
  finalPass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: shared.uTime,
      uResolution: { value: new THREE.Vector2(1, 1) },
      uAberration: { value: 0.012 },
      uScan: { value: 0.07 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: SRGB_GLSL + /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform vec2 uResolution;
      uniform float uAberration;
      uniform float uScan;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec2 c = vUv - 0.5;
        float r2 = dot(c, c);
        vec2 off = c * r2 * uAberration * 4.0;
        vec3 col = vec3(
          texture2D(tDiffuse, vUv + off).r,
          texture2D(tDiffuse, vUv).g,
          texture2D(tDiffuse, vUv - off).b);
        col += vec3(0.001, 0.004, 0.009) * smoothstep(0.75, 0.0, length(c));      // fundo: brilho frio central
        float scan = 0.5 + 0.5 * sin(vUv.y * uResolution.y * 2.0944 + uTime * 2.0); // linha a cada ~3 px
        col *= 1.0 - uScan * scan;
        col *= mix(0.4, 1.0, smoothstep(0.78, 0.22, length(c * vec2(1.0, 1.1))));  // vinheta
        col += (hash(vUv * uResolution + fract(uTime)) - 0.5) * 0.012;              // grão
        gl_FragColor = vec4(toSRGB(col), 1.0);
      }`,
  });
  composer.addPass(finalPass);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  // Em janelas largas, afasta a câmera para a cabeça continuar inteira.
  camera.position.z = w / h < 0.8 ? 7.8 / Math.max(w / h / 0.8, 0.72) : 7.8;
  camera.updateProjectionMatrix();
  if (composer) {
    composer.setSize(w, h);
    finalPass.uniforms.uResolution.value.set(w * PIXEL_RATIO, h * PIXEL_RATIO);
  }
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- interação: rotação pelo mouse

// ?yaw=20 fixa o ângulo de repouso em graus (ex.: display sem mouse).
const BASE_YAW = params.has('yaw') ? (Number(params.get('yaw')) * Math.PI) / 180 : -0.22;
const rotationTarget = { yaw: BASE_YAW, pitch: 0 };
let pointerActiveUntil = 0;

window.addEventListener('pointermove', (event) => {
  const nx = event.clientX / window.innerWidth - 0.5;
  const ny = event.clientY / window.innerHeight - 0.5;
  rotationTarget.yaw = BASE_YAW + nx * 0.9;
  rotationTarget.pitch = ny * 0.45;
  pointerActiveUntil = performance.now() + 1500;
});
document.addEventListener('pointerleave', () => {
  rotationTarget.yaw = BASE_YAW;
  rotationTarget.pitch = 0;
  pointerActiveUntil = performance.now() + 1500;
});
head.rotation.y = BASE_YAW;

// ---------------------------------------------------------------- loop

let lastFrame = 0;
let elapsed = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const idle = state === 'IDLE' && now > pointerActiveUntil;
  const minInterval = idle ? 1000 / 30 : 1000 / 61;
  if (now - lastFrame < minInterval) return;
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  elapsed += dt;

  // transições suaves de cor/intensidade entre estados
  const k = 1 - Math.exp(-dt * 4);
  shared.uColor.value.lerp(target.color, k);
  shared.uIntensity.value += (target.intensity - shared.uIntensity.value) * k;
  const eyeTarget = target.eyes * (1 + 0.15 * mouthOpen);
  eyeUniforms.uEyes.value += (eyeTarget - eyeUniforms.uEyes.value) * k;
  mouthUniforms.uMouth.value += ((state === 'SPEAKING' ? 0.95 : 0.6) - mouthUniforms.uMouth.value) * k;

  // "respiração" do sistema
  shared.uTime.value = elapsed;
  shared.uBreath.value = 0.9 + 0.1 * Math.sin(elapsed * target.breathSpeed);

  // rotação amortecida em direção ao mouse
  const r = 1 - Math.exp(-dt * 3);
  head.rotation.y += (rotationTarget.yaw - head.rotation.y) * r;
  head.rotation.x += (rotationTarget.pitch - head.rotation.x) * r;

  if (composer) {
    composer.render(dt);
  } else {
    renderer.render(scene, camera);
  }
}

// ---------------------------------------------------------------- estados, fala e legenda

const labelEl = document.querySelector('.status .label');
const captionEl = document.querySelector('.caption');
let state = 'IDLE';
let speechTimer = null;
let captionTimer = null;

function applyLook(name) {
  const look = STATES[name] || STATES.IDLE;
  target.color.set(look.color);
  target.intensity = look.intensity;
  target.eyes = look.eyes;
  target.breathSpeed = look.breath;
}

function showCaption(text) {
  clearTimeout(captionTimer);
  if (text) {
    captionEl.textContent = text;
    body.classList.add('show-caption');
  } else {
    body.classList.remove('show-caption');
  }
}

function stopSpeaking() {
  clearTimeout(speechTimer);
  speechTimer = null;
}

function startSpeaking(text) {
  stopSpeaking();
  const sequence = window.LipSync.sequence(text || 'a e o a e', msPerChar);
  let index = 0;
  const step = () => {
    if (state !== 'SPEAKING') return;
    if (index >= sequence.length) index = 0;
    const segment = sequence[index++];
    setMouth(segment.shape);
    speechTimer = setTimeout(step, segment.ms);
  };
  step();
}

function setState(next, details = {}) {
  state = STATES[next] && next !== 'OFFLINE' ? next : 'IDLE';
  body.dataset.state = state;
  applyLook(details.alert ? 'ERROR' : state);
  labelEl.textContent = details.reason === 'message' && state === 'LISTENING' ? 'MESSAGE' : state;
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
      captionTimer = setTimeout(() => showCaption(null), 2500);
      break;
    default:
      setMouth('MOUTH_CLOSED');
      showCaption(null);
  }
}

function setConnected(connected) {
  body.dataset.connected = connected ? 'true' : 'false';
  if (!connected) {
    stopSpeaking();
    setMouth('IDLE');
    applyLook('OFFLINE');
    labelEl.textContent = 'OFFLINE';
  }
}

function connect() {
  const source = new EventSource('/events');
  source.addEventListener('state', (event) => {
    const data = JSON.parse(event.data);
    setConnected(true);
    setState(data.state, data);
  });
  source.onopen = () => setConnected(true);
  source.onerror = () => setConnected(false); // o EventSource reconecta sozinho
}

function demo() {
  body.dataset.connected = 'true';
  const steps = [
    ['IDLE', {}, 4000],
    ['LISTENING', {}, 3000],
    ['THINKING', {}, 2500],
    ['SPEAKING', { text: 'Estou online. WhatsApp conectado, inteligência artificial disponível e sistema de voz funcionando.' }, 7000],
    ['IDLE', {}, 3000],
    ['LISTENING', { reason: 'message' }, 1200],
    ['SPEAKING', { text: 'Você recebeu uma mensagem de João: oi, você está disponível?' }, 5000],
    ['ERROR', { text: 'Não consegui entender o áudio. Pode repetir?', alert: true }, 3000],
  ];
  let i = 0;
  const next = () => {
    const [name, details, ms] = steps[i++ % steps.length];
    setState(name, details);
    setTimeout(next, ms);
  };
  next();
}

window.celesteAvatar = { setState, getState: () => state, setMouth };

// ---------------------------------------------------------------- início

fetch('assets/face-mesh.json')
  .then((response) => response.json())
  .then((mesh) => {
    buildFace(mesh);
    if (params.get('demo') === '1') {
      demo();
    } else if (params.get('state')) {
      body.dataset.connected = 'true';
      const preview = params.get('state').toUpperCase();
      setState(preview, {
        text: params.get('text') || 'Estou online e todos os sistemas principais estão funcionando.',
        alert: preview === 'ERROR',
      });
      if (params.get('mouth')) { stopSpeaking(); setMouth(params.get('mouth')); }
    } else {
      setConnected(false);
      connect();
    }
    requestAnimationFrame(frame);
  })
  .catch((error) => {
    console.error('Falha ao carregar o holograma; usando a versão SVG.', error);
    location.replace('variants/pointcloud/' + location.search);
  });
