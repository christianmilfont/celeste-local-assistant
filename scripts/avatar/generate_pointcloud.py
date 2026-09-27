"""
Gera o rosto da Celeste como uma nuvem de pontos conectados (estilo scanner 3D / holograma).

Um modelo 3D procedural da cabeça (elipsoide + relevos de nariz, órbitas, sobrancelhas,
maçãs do rosto, lábios e queixo) é amostrado em pontos; cada ponto recebe brilho pela
normal da superfície (bordas mais claras, como luz de recorte) e é ligado aos vizinhos
mais próximos. O resultado é uma imagem estática: custo zero em tempo de execução.

Saídas (viewBox "30 40 340 425", o mesmo das camadas de olhos e boca):
  avatar/assets/face-cloud.svg       pontos e ligações (branco com alpha = máscara colorida por CSS)
  avatar/assets/face-highlights.svg  pontos mais brilhantes (núcleo quase branco, sobreposto)

Uso: .venv/Scripts/python scripts/avatar/generate_pointcloud.py   (requer numpy)
"""
import math
import os

import numpy as np

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'avatar', 'assets')
VIEWBOX = '30 40 340 425'
rng = np.random.default_rng(2029)
YAW = math.radians(-14)   # cabeça levemente girada (quase três quartos): o relevo aparece na projeção
HTML = os.path.join(os.path.dirname(__file__), '..', '..', 'avatar', 'variants', 'pointcloud', 'index.html')

# ---------------------------------------------------------------- silhueta (meia-largura por altura)
# Mesma silhueta da cabeça usada antes: topo em y=50, queixo em y=358, olhos em y≈206.
Y_TOP, Y_CHIN, CX = 50.0, 358.0, 200.0


def half_width(y):
    """Meia-largura da cabeça na altura y (crânio arredondado, mandíbula afinando até o queixo)."""
    y = np.asarray(y, dtype=float)
    t = np.clip((y - Y_TOP) / (Y_CHIN - Y_TOP), 0, 1)
    cranium = 99 * np.sqrt(np.clip(1 - ((y - 165) / 115) ** 2, 0, 1))
    jaw_t = np.clip((y - 235) / (Y_CHIN - 235), 0, 1)
    jaw = 83 * np.clip(1 - jaw_t ** 2.6, 0, 1) ** 0.5   # queixo arredondado
    return np.where(y < 165, cranium, np.where(y < 235, 99 - 16 * ((y - 165) / 70) ** 2, jaw)) * (t >= 0)


def gauss(x, y, cx, cy, sx, sy):
    return np.exp(-(((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2))


def depth(x, y):
    """Altura da superfície em direção ao observador (z), com os relevos do rosto."""
    w = np.maximum(half_width(y), 1e-3)
    u = np.clip((x - CX) / w, -1, 1)
    base = 78 * np.sqrt(np.clip(1 - u ** 2, 0, 1))
    # topo do crânio: a profundidade também cai a zero (casca elipsoidal, sem aresta ao girar)
    base = base * np.where(y < 165, np.sqrt(np.clip(1 - ((165 - y) / 118) ** 2, 0, 1)), 1)
    z = base
    # nariz: dorso crescendo até a ponta + asas
    ridge = np.clip((y - 200) / 64, 0, 1)
    z = z + 26 * ridge ** 1.3 * gauss(x, y, CX, 262, 6 + 4 * ridge, 40) * (y < 272)
    z = z + 6 * gauss(x, y, CX - 11, 266, 5, 4) + 6 * gauss(x, y, CX + 11, 266, 5, 4)
    # órbitas (afundadas) e arco das sobrancelhas
    for ex in (160, 240):
        z = z - 14 * gauss(x, y, ex, 207, 17, 9)
        z = z + 5 * gauss(x, y, ex, 186, 20, 5)
        z = z + 6 * gauss(x, y, ex - 12 if ex < CX else ex + 12, 246, 14, 8)   # maçãs do rosto
        z = z - 4 * gauss(x, y, ex, 288, 14, 12)                              # bochechas
    # lábios e queixo
    z = z + 6 * gauss(x, y, CX, 296, 18, 5) + 7 * gauss(x, y, CX, 306, 16, 5)
    z = z - 2.5 * gauss(x, y, CX, 301, 20, 1.3)
    z = z + 6 * gauss(x, y, CX, 340, 13, 9)
    return z


def normal(x, y, h=0.6):
    dzdx = (depth(x + h, y) - depth(x - h, y)) / (2 * h)
    dzdy = (depth(x, y + h) - depth(x, y - h)) / (2 * h)
    n = np.stack([-dzdx, -dzdy, np.ones_like(x)], axis=-1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


# ---------------------------------------------------------------- amostragem
# Candidatos em grade com ruído; aceitação ∝ área real da superfície (1/nz) → mais pontos nas bordas.
SPACING = 4.7
gx, gy = np.meshgrid(np.arange(96, 305, SPACING), np.arange(46, 362, SPACING))
x = (gx + rng.uniform(-SPACING / 2, SPACING / 2, gx.shape)).ravel()
y = (gy + rng.uniform(-SPACING / 2, SPACING / 2, gy.shape)).ravel()
inside = np.abs(x - CX) < half_width(y) * 0.995
x, y = x[inside], y[inside]

EXCLUDE = [(160, 206, 23, 8.5), (240, 206, 23, 8.5), (200, 301, 21, 8)]  # olhos e boca (camadas próprias)
for ex, ey, rx, ry in EXCLUDE:
    keep = ((x - ex) / rx) ** 2 + ((y - ey) / ry) ** 2 > 1
    x, y = x[keep], y[keep]

n = normal(x, y)
area = 1 / np.clip(n[:, 2], 0.25, 1)
accept = rng.uniform(0, 1, x.shape) < np.clip(0.42 * area, 0, 1)
x, y, n = x[accept], y[accept], n[accept]

# Pontos extras ao longo das feições (contornos ficam mais definidos)
extra = []
for ex in (160, 240):
    a = np.linspace(0, 2 * np.pi, 34, endpoint=False)
    extra += list(zip(ex + 25 * np.cos(a), 207 + 11 * np.sin(a)))            # contorno das órbitas
    extra += list(zip(np.linspace(ex - 22, ex + 22, 12), 186 - 3 * np.sin(np.linspace(0, np.pi, 12))))
t = np.linspace(0, 1, 16)
extra += list(zip(CX + 0 * t, 212 + 50 * t))                                  # dorso do nariz
extra += list(zip(CX - 14 + 28 * t, 268 + 4 * np.sin(np.pi * t)))             # base do nariz
for side in (-1, 1):
    extra += list(zip(CX + side * (60 - 58 * t) , 300 + 56 * t ** 1.2))      # mandíbula
extra += list(zip(CX + 30 * np.cos(np.linspace(np.pi, 2 * np.pi, 14)), 344 + 10 * np.sin(np.linspace(np.pi, 2 * np.pi, 14)) * -1))
ex_pts = np.array(extra) + rng.normal(0, 0.6, (len(extra), 2))
ok = np.abs(ex_pts[:, 0] - CX) < half_width(ex_pts[:, 1])
ex_pts = ex_pts[ok]
x = np.concatenate([x, ex_pts[:, 0]])
y = np.concatenate([y, ex_pts[:, 1]])
n = normal(x, y)

# ---------------------------------------------------------------- rotação (yaw) e projeção
C, S = math.cos(YAW), math.sin(YAW)


def rotate_x(px, py):
    return CX + (px - CX) * C + depth(px, py) * S


z = depth(x, y)
xr = CX + (x - CX) * C + z * S
nr = np.stack([n[:, 0] * C + n[:, 2] * S, n[:, 1], -n[:, 0] * S + n[:, 2] * C], axis=1)
visible = nr[:, 2] > 0.04
SHIFT = CX - float(np.mean(xr[visible]))   # recentra a cabeça depois de girar
x, y, n = xr[visible] + SHIFT, y[visible], nr[visible]

# ---------------------------------------------------------------- iluminação
light = np.array([-0.5, -0.5, 0.71])
light /= np.linalg.norm(light)
rim = (1 - np.clip(n[:, 2], 0, 1)) ** 1.6
key = np.clip(n @ light, 0, 1)
brightness = np.clip(0.12 + 0.62 * rim + 0.6 * key ** 1.5, 0, 1)
# o topo do crânio e o queixo somem suavemente (cabeça "flutuando")
fade = np.clip((y - 48) / 30, 0, 1) * np.clip((366 - y) / 26, 0, 1)
brightness *= 0.35 + 0.65 * fade

# ---------------------------------------------------------------- ligações (vizinhos mais próximos)
pts = np.stack([x, y], axis=1)
d2 = ((pts[:, None, :] - pts[None, :, :]) ** 2).sum(-1)
np.fill_diagonal(d2, np.inf)
links = set()
K, MAX_D = 3, 10.5
for i in range(len(pts)):
    for j in np.argsort(d2[i])[:K]:
        if d2[i, j] <= MAX_D ** 2:
            links.add((min(i, j), max(i, j)))

# ---------------------------------------------------------------- saída


def f(v):
    return f'{v:.1f}'


def svg(body, comment):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{VIEWBOX}" width="680" height="850">\n'
            f'  <!-- {comment} Gerado por scripts/avatar/generate_pointcloud.py -->\n{body}</svg>\n')


# ligações agrupadas por faixa de opacidade (poucos elementos, arquivo menor)
bands = {}
for i, j in links:
    a = round(float(min(brightness[i], brightness[j])) * 4) / 4
    if a > 0:
        bands.setdefault(a, []).append(f'M{f(x[i])} {f(y[i])}L{f(x[j])} {f(y[j])}')
link_svg = ''.join(
    f'<path d="{"".join(segs)}" stroke-opacity="{0.1 + 0.26 * a:.2f}"/>' for a, segs in sorted(bands.items()))

dots = ''.join(
    f'<circle cx="{f(x[i])}" cy="{f(y[i])}" r="{0.45 + 0.75 * brightness[i]:.2f}" fill-opacity="{0.25 + 0.75 * brightness[i]:.2f}"/>'
    for i in range(len(pts)))

cloud = svg(
    '  <defs><filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.6"/></filter></defs>\n'
    f'  <g fill="none" stroke="#fff" stroke-width=".35" stroke-linecap="round">{link_svg}</g>\n'
    f'  <g fill="#fff" filter="url(#glow)" opacity=".55">{dots}</g>\n'
    f'  <g fill="#fff">{dots}</g>\n',
    'Nuvem de pontos do rosto (máscara: a cor vem do CSS).')

hot = brightness > np.quantile(brightness, 0.82)
highlights = svg(
    '  <g fill="#eaffff">' + ''.join(
        f'<circle cx="{f(x[i])}" cy="{f(y[i])}" r="{0.35 + 0.5 * brightness[i]:.2f}" fill-opacity="{0.5 * brightness[i]:.2f}"/>'
        for i in np.where(hot)[0]) + '</g>\n',
    'Pontos mais brilhantes (núcleo quase branco).')

# ---------------------------------------------------------------- olhos (orbes) e boca (projetados)


def projected(px, py):
    """Posição projetada e escala horizontal local (encurtamento pela rotação)."""
    h = 0.5
    sx = (rotate_x(px + h, py) - rotate_x(px - h, py)) / (2 * h)
    return float(rotate_x(px, py)) + SHIFT, float(sx)


ORB_DEFS = (
    '<defs>'
    '<radialGradient id="orbBody" cx="42%" cy="38%" r="62%">'
    '<stop offset="0" class="orb-core"/><stop offset=".5" class="orb-mid"/><stop offset="1" class="orb-edge"/>'
    '</radialGradient>'
    '<radialGradient id="orbHalo" cx="50%" cy="50%" r="50%">'
    '<stop offset="0" class="orb-halo" stop-opacity=".55"/><stop offset=".45" class="orb-halo" stop-opacity=".16"/>'
    '<stop offset="1" class="orb-halo" stop-opacity="0"/>'
    '</radialGradient>'
    '</defs>'
)


def eye_orb(ex):
    """Olho como um orbe de luz na cor do estado (núcleo claro + halo), levemente encurtado pelo giro."""
    cx, sx = projected(ex, 206)
    return (f'<ellipse class="orb-halo-shape" cx="{cx:.1f}" cy="206" rx="{19 * sx:.1f}" ry="19" fill="url(#orbHalo)"/>'
            f'<ellipse class="orb" cx="{cx:.1f}" cy="206" rx="{7.2 * sx:.1f}" ry="7.2" fill="url(#orbBody)"/>'
            f'<circle class="orb-glint" cx="{cx - 2.2 * sx:.1f}" cy="203.6" r="1.3"/>'), cx


left_dots, left_x = eye_orb(160)
right_dots, right_x = eye_orb(240)
left_dots = ORB_DEFS + left_dots
mouth_x, mouth_sx = projected(200, 301)

html = open(HTML, encoding='utf-8').read()
start, end = html.index('<g class="eye-dots">'), html.index('</g>', html.index('<g class="eye-dots">'))
html = html[:start] + f'<g class="eye-dots">{left_dots}{right_dots}' + html[end:]
import re
html = re.sub(r'<g class="mouth" transform="[^"]*">',
              f'<g class="mouth" transform="translate({mouth_x:.1f} 301) scale({mouth_sx:.3f} 1)">', html)
with open(HTML, 'w', encoding='utf-8', newline='\n') as fh:
    fh.write(html)
# posição do brilho dos olhos (em % do enquadramento 30..370 x 40..465)
print(f'eye-glow left: {(left_x - 30) / 340 * 100:.1f}%  right: {(right_x - 30) / 340 * 100:.1f}%')

for name, content in (('face-cloud.svg', cloud), ('face-highlights.svg', highlights)):
    with open(os.path.join(OUT, name), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(content)
    print(f'{name}: {len(content) / 1024:.1f} KB')
print(f'{len(pts)} pontos, {len(links)} ligações')


# ================================================================ malha 3D (versão WebGL)
# Para o holograma em Three.js a cabeça gira ao vivo, então exportamos o modelo em 3D:
# posições, normais (o shader calcula o brilho de recorte conforme a rotação) e ligações.
import json


def sample_front(spacing, density):
    gx3, gy3 = np.meshgrid(np.arange(96, 305, spacing), np.arange(46, 362, spacing))
    px = (gx3 + rng.uniform(-spacing / 2, spacing / 2, gx3.shape)).ravel()
    py = (gy3 + rng.uniform(-spacing / 2, spacing / 2, gy3.shape)).ravel()
    ok = np.abs(px - CX) < half_width(py) * 0.995
    px, py = px[ok], py[ok]
    for ex, ey, rx, ry in EXCLUDE:
        keep = ((px - ex) / rx) ** 2 + ((py - ey) / ry) ** 2 > 1
        px, py = px[keep], py[keep]
    nn = normal(px, py)
    acc = rng.uniform(0, 1, px.shape) < np.clip(density / np.clip(nn[:, 2], 0.25, 1), 0, 1)
    px, py = px[acc], py[acc]
    return px, py, depth(px, py), normal(px, py)


fx, fy, fz, fn = sample_front(3.3, 0.40)
# pontos extras das feições (mesmos do SVG), agora com profundidade
fx = np.concatenate([fx, ex_pts[:, 0]])
fy = np.concatenate([fy, ex_pts[:, 1]])
fz = np.concatenate([fz, depth(ex_pts[:, 0], ex_pts[:, 1])])
fn = np.concatenate([fn, normal(ex_pts[:, 0], ex_pts[:, 1])])

# casca traseira esparsa (crânio), só para dar volume quando a cabeça gira
bx = rng.uniform(96, 304, 2600)
by = rng.uniform(52, 300, 2600)
w_b = half_width(by)
okb = np.abs(bx - CX) < w_b * 0.98
bx, by, w_b = bx[okb], by[okb], w_b[okb]
ub = (bx - CX) / w_b
bz = (-88 * np.sqrt(np.clip(1 - ub ** 2, 0, 1)) * np.clip((330 - by) / 60, 0.2, 1)
      * np.where(by < 165, np.sqrt(np.clip(1 - ((165 - by) / 118) ** 2, 0, 1)), 1))
bn = np.stack([ub, np.zeros_like(ub), -np.sqrt(np.clip(1 - ub ** 2, 0, 1))], axis=1)
bn /= np.linalg.norm(bn, axis=1, keepdims=True)
keep_b = rng.uniform(0, 1, bx.shape) < 0.45
bx, by, bz, bn = bx[keep_b], by[keep_b], bz[keep_b], bn[keep_b]

P = np.concatenate([np.stack([fx, fy, fz], 1), np.stack([bx, by, bz], 1)])
N = np.concatenate([fn, bn])
shell = np.concatenate([np.ones(len(fx)), np.full(len(bx), 0.35)])

# ligações: 3 vizinhos mais próximos em 3D (em blocos para não estourar memória)
links3 = set()
for s0 in range(0, len(P), 400):
    block = P[s0:s0 + 400]
    d = ((block[:, None, :] - P[None, :, :]) ** 2).sum(-1)
    for k in range(len(block)):
        i = s0 + k
        d[k, i] = np.inf
        for j in np.argpartition(d[k], 3)[:3]:
            if d[k, j] <= 9.0 ** 2:
                links3.add((min(i, int(j)), max(i, int(j))))


def to_scene(px, py, pz):
    """Coordenadas do desenho → unidades da cena (y para cima, centro entre os olhos)."""
    return (px - CX) / 100, (205 - py) / 100, pz / 100


sx_, sy_, sz_ = to_scene(P[:, 0], P[:, 1], P[:, 2])
mesh = {
    'points': [round(v, 4) for v in np.stack([sx_, sy_, sz_], 1).ravel().tolist()],
    'normals': [round(v, 3) for v in N.ravel().tolist()],
    'shell': [round(v, 2) for v in shell.tolist()],
    'links': [i for pair in sorted(links3) for i in pair],
    'eyes': [list(map(lambda v: round(float(v), 4), to_scene(ex, 206.0, depth(np.array(ex), np.array(206.0)) + 3)))
             for ex in (160.0, 240.0)],
    'mouth': list(map(lambda v: round(float(v), 4), to_scene(200.0, 301.0, depth(np.array(200.0), np.array(301.0)) + 1))),
}
mesh_path = os.path.join(OUT, 'face-mesh.json')
with open(mesh_path, 'w', encoding='utf-8') as fh:
    json.dump(mesh, fh, separators=(',', ':'))
print(f'face-mesh.json: {os.path.getsize(mesh_path) / 1024:.1f} KB — {len(P)} pontos 3D, {len(links3)} ligações')
