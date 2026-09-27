"""
Gera os circuitos do avatar da Celeste (assets estáticos em avatar/assets/).

As trilhas são criadas num espaço "plano" e depois curvadas sobre a superfície da cabeça
(projeção esférica), para que as linhas se comprimam nas bordas como numa superfície 3D.
Semente fixa: o resultado é reproduzível.

Saídas (todas com viewBox "30 40 340 425", o mesmo das outras camadas):
  traces.svg         trilhas tênues + nós (camada estática, <img>)
  circuits.svg       trilhas/nós luminosos (máscara colorida por CSS; anima opacity)
  circuits-amber.svg nós âmbar (máscara; cintilam em passos)
  dataflow-N.svg     quadros do "fluxo de dados" (sprites; o CSS alterna a opacity)

Uso: python scripts/avatar/generate_circuits.py
"""
import math
import os
import random

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'avatar', 'assets')
VIEWBOX = '30 40 340 425'
random.seed(1984)

# ---------------------------------------------------------------- geometria


def cubic(p0, p1, p2, p3, steps=16):
    pts = []
    for i in range(1, steps + 1):
        t = i / steps
        a = (1 - t) ** 3
        b = 3 * (1 - t) ** 2 * t
        c = 3 * (1 - t) * t ** 2
        d = t ** 3
        pts.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return pts


def path_polygon(start, segments):
    poly = [start]
    cur = start
    for c1, c2, end in segments:
        poly += cubic(cur, c1, c2, end)
        cur = end
    return poly


# Mesmo contorno de celeste-base.svg (#head)
HEAD = path_polygon((200, 50), [
    ((138, 50), (102, 98), (101, 160)), ((100, 196), (107, 222), (117, 240)),
    ((120, 262), (128, 290), (144, 314)), ((160, 336), (182, 356), (200, 358)),
    ((218, 356), (240, 336), (256, 314)), ((272, 290), (280, 262), (283, 240)),
    ((293, 222), (300, 196), (299, 160)), ((298, 98), (262, 50), (200, 50)),
])
NECK = path_polygon((172, 322), [
    ((175, 366), (172, 408), (160, 448)), ((200, 448), (200, 448), (240, 448)),
    ((228, 408), (225, 366), (228, 322)), ((200, 322), (200, 322), (172, 322)),
])
SHOULDERS = path_polygon((0, 470), [
    ((14, 438), (66, 420), (140, 416)), ((150, 410), (160, 404), (166, 402)),
    ((200, 402), (200, 402), (234, 402)), ((240, 404), (250, 410), (260, 416)),
    ((334, 420), (386, 438), (400, 470)), ((200, 470), (200, 470), (0, 470)),
])


def inside(poly, x, y):
    hit = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-9) + xi:
            hit = not hit
        j = i
    return hit


def in_ellipse(x, y, cx, cy, rx, ry):
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1


EXCLUDE = [  # olhos, boca, narinas: sem trilhas
    (160, 206, 26, 12), (240, 206, 26, 12), (200, 301, 26, 12), (200, 268, 13, 6),
]


def allowed(region, x, y):
    if any(in_ellipse(x, y, *e) for e in EXCLUDE):
        return False
    if region == 'head':
        return inside(HEAD, x, y)
    if region == 'neck':
        return inside(NECK, x, y) and not inside(HEAD, x, y)
    return inside(SHOULDERS, x, y) and not inside(NECK, x, y)


# projeção: plano -> superfície curva da cabeça
RX, CX = 108.0, 200.0
RY, CY = 118.0, 165.0


def warp_head(x, y):
    wx = CX + RX * math.sin((x - CX) / RX)
    wy = y
    if y < CY:
        wy = CY - RY * math.sin((CY - y) / RY)
    return wx, wy


def flat_range_x():
    half = RX * math.asin(min(1, 100 / RX))
    return CX - half, CX + half


# ---------------------------------------------------------------- trilhas

DIRS = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]


def walk(region, start, prefer_vertical=False):
    """Caminhada estilo PCB: segmentos retos com curvas de 45°."""
    x, y = start
    d = random.choice([2, 6] if prefer_vertical else range(8))
    pts = [(x, y)]
    turns = []
    for _ in range(random.randint(3, 8)):
        length = random.uniform(5, 16)
        if random.random() < 0.45:
            d = (d + random.choice([-1, 1])) % 8
            turns.append(len(pts) - 1)
        dx, dy = DIRS[d]
        norm = math.hypot(dx, dy)
        nx, ny = x + dx / norm * length, y + dy / norm * length
        ok = True
        # checa o segmento em pontos intermediários (depois da projeção)
        for k in range(1, 5):
            px = x + (nx - x) * k / 4
            py = y + (ny - y) * k / 4
            wx, wy = warp_head(px, py) if region == 'head' else (px, py)
            if not allowed(region, wx, wy):
                ok = False
                break
        if not ok:
            break
        x, y = nx, ny
        pts.append((x, y))
    return pts if len(pts) >= 3 else None


def densify(pts, step=3.0):
    out = [pts[0]]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
        for i in range(1, n + 1):
            out.append((x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n))
    return out


def to_path(pts):
    return 'M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in pts)


def random_start(region):
    for _ in range(500):
        if region == 'head':
            lo, hi = flat_range_x()
            x, y = random.uniform(lo, hi), random.uniform(28, 350)
            wx, wy = warp_head(x, y)
        elif region == 'neck':
            x, y = random.uniform(168, 232), random.uniform(330, 446)
            wx, wy = x, y
        else:
            x, y = random.uniform(10, 390), random.uniform(412, 468)
            wx, wy = x, y
        if not allowed(region, wx, wy):
            continue
        if region == 'head':
            # centro do rosto (olhos/nariz/boca) bem mais esparso que crânio e bordas
            d = math.hypot((wx - 200) / 70, (wy - 255) / 85)
            if d < 1 and random.random() > 0.18 + 0.6 * d:
                continue
        return x, y
    return None


traces = []  # (region, flat_pts)
for region, count, vertical in (('head', 120, False), ('neck', 26, True), ('shoulders', 18, False)):
    made = 0
    while made < count:
        start = random_start(region)
        if not start:
            break
        pts = walk(region, start, vertical)
        if pts:
            traces.append((region, pts))
            made += 1


def project(region, pts):
    dense = densify(pts)
    return [warp_head(x, y) for x, y in dense] if region == 'head' else dense


# Linhas de contorno feitas à mão (seguem a anatomia; sempre luminosas)
def arc(cx, cy, rx, ry, a0, a1, n=24):
    return [(cx + rx * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + ry * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


CONTOURS = [
    arc(160, 206, 34, 21, 200, 340), arc(240, 206, 34, 21, 200, 340),     # sobre as órbitas
    arc(160, 208, 33, 22, 20, 160), arc(240, 208, 33, 22, 20, 160),       # sob as órbitas
    [(200, 58), (200, 90), (200, 120), (200, 150), (200, 176)],           # linha central da testa
    [(126, 250), (140, 262), (156, 272), (170, 278)],                     # maçã esquerda
    [(274, 250), (260, 262), (244, 272), (230, 278)],                     # maçã direita
    [(130, 286), (142, 308), (158, 326), (176, 342)],                     # mandíbula esquerda
    [(270, 286), (258, 308), (242, 326), (224, 342)],                     # mandíbula direita
    [(200, 322), (200, 340), (200, 354)],                                 # queixo
    [(188, 362), (186, 400), (182, 440)], [(212, 362), (214, 400), (218, 440)],  # pescoço
]

# ---------------------------------------------------------------- saída

projected = [(r, project(r, p), p) for r, p in traces]
bright_idx = set(random.sample(range(len(projected)), int(len(projected) * 0.24)))

nodes = []  # (x, y, r)
for region, proj, flat in projected:
    ends = [flat[0], flat[-1]] + ([flat[len(flat) // 2]] if random.random() < 0.4 else [])
    for x, y in ends:
        wx, wy = warp_head(x, y) if region == 'head' else (x, y)
        nodes.append((wx, wy, random.uniform(0.55, 1.3)))
# poeira de pontos isolados (como na referência)
for _ in range(45):
    region = random.choice(['head', 'head', 'head', 'neck'])
    s = random_start(region)
    if s:
        wx, wy = warp_head(*s) if region == 'head' else s
        nodes.append((wx, wy, random.uniform(0.4, 0.9)))

amber = random.sample(nodes, int(len(nodes) * 0.09))


def svg(body, comment):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{VIEWBOX}" width="680" height="850">\n'
            f'  <!-- {comment} Gerado por scripts/avatar/generate_circuits.py -->\n{body}</svg>\n')


def circles(items, fill):
    return ''.join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.2f}"/>' for x, y, r in items).join(
        [f'<g fill="{fill}">', '</g>'])


all_paths = [to_path(p) for _, p, _ in projected]
contour_paths = [to_path(densify(c, 2)) for c in CONTOURS]
bright_paths = [to_path(projected[i][1]) for i in sorted(bright_idx)] + contour_paths

# 1) traces.svg — trilhas tênues (material), estática
dim = ''.join(f'<path d="{d}"/>' for d in all_paths)
traces_svg = svg(
    f'  <g fill="none" stroke="#2f4c63" stroke-width=".4" stroke-linecap="round" stroke-linejoin="round" opacity=".55">{dim}</g>\n'
    f'  {circles(nodes, "#4d7390")}\n',
    'Trilhas tênues da superfície.')

# 2) circuits.svg — máscara luminosa (branco), com brilho assado
bright = ''.join(f'<path d="{d}"/>' for d in bright_paths)
glow_nodes = [(x, y, r * 1.2) for x, y, r in nodes if random.random() < 0.45]
circuits_svg = svg(
    '  <defs><filter id="g" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.6"/></filter></defs>\n'
    f'  <g filter="url(#g)" opacity=".55"><g fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round">{bright}</g>{circles(glow_nodes, "#fff")}</g>\n'
    f'  <g fill="none" stroke="#fff" stroke-width=".4" stroke-linecap="round" stroke-linejoin="round" opacity=".8">{bright}</g>\n'
    f'  {circles(glow_nodes, "#fff")}\n',
    'Máscara: trilhas e nós luminosos (cor via CSS).')

# 3) circuits-amber.svg — nós âmbar
amber_big = [(x, y, r * 1.35) for x, y, r in amber]
amber_svg = svg(
    '  <defs><filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.4"/></filter></defs>\n'
    f'  <g filter="url(#g)">{circles([(x, y, r * 2.2) for x, y, r in amber], "#fff")}</g>\n'
    f'  {circles(amber_big, "#fff")}\n',
    'Máscara: nós âmbar.')

# 4) dataflow-N.svg — quadros pré-renderizados do fluxo de dados (sprites).
#    Cada quadro tem pulsos de luz numa posição diferente das trilhas; o CSS só alterna a
#    opacity entre os quadros: nenhuma repintura em tempo de execução.
FRAMES = 8
longest = sorted(projected, key=lambda t: -len(t[1]))[:18]
flow_paths = [p for _, p, _ in longest] + [densify(c, 2) for c in CONTOURS]
offsets = [random.random() for _ in flow_paths]


def sub_path(pts, t0, t1):
    """Trecho da polilinha entre as frações t0..t1 do comprimento."""
    seg = [math.hypot(x1 - x0, y1 - y0) for (x0, y0), (x1, y1) in zip(pts, pts[1:])]
    total = sum(seg) or 1
    out, acc = [], 0.0
    for (a, b), length in zip(zip(pts, pts[1:]), seg):
        f0, f1 = acc / total, (acc + length) / total
        if f1 >= t0 and f0 <= t1:
            out.append(a)
            out.append(b)
        acc += length
    return out


frames = {}
for k in range(FRAMES):
    pulses = []
    for pts, off in zip(flow_paths, offsets):
        t = (k / FRAMES + off) % 1.0
        piece = sub_path(pts, max(0, t - 0.05), min(1, t + 0.05))
        if len(piece) >= 2:
            pulses.append(f'<path d="{to_path(piece)}"/>')
    body = ''.join(pulses)
    frames[f'dataflow-{k}.svg'] = svg(
        '  <defs><filter id="g" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.8"/></filter></defs>\n'
        f'  <g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">'
        f'<g filter="url(#g)" stroke-width="2.6" opacity=".7">{body}</g><g stroke-width=".9">{body}</g></g>\n',
        f'Fluxo de dados, quadro {k + 1}/{FRAMES}.')

outputs = [('traces.svg', traces_svg), ('circuits.svg', circuits_svg),
           ('circuits-amber.svg', amber_svg)] + sorted(frames.items())
for name, content in outputs:
    path = os.path.join(OUT, name)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)
    print(f'{name}: {len(content) / 1024:.1f} KB')
print(f'{len(traces)} trilhas, {len(nodes)} nós ({len(amber)} âmbar), {len(flow_paths)} fluxos x {FRAMES} quadros')
