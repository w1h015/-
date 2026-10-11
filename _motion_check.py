"""验证「猫在运行时画面里到底动没动」。

素材 cell 里有位移 ≠ 屏幕上能看出位移：运行时是把每条分镜的 cell
居中+底边对齐贴进一张统一的大画布（CELL_MAX），还要按 cfg.size 缩放。
这个脚本完全复刻 app.js 的 drawRect() 几何，算出猫的重心在屏幕上的移动范围。
用法：python tools/_motion_check.py [cfg.size]
"""
import json, sys
import numpy as np
from PIL import Image

SIZE = float(sys.argv[1]) if len(sys.argv) > 1 else 150.0
meta = json.load(open('assets_sprites/meta.json', encoding='utf-8'))
CELL_MAX = max(m['cell'] for m in meta.values())

print('CELL_MAX=%d  cfg.size=%g  （下面所有 px 都已经换算成屏幕像素）' % (CELL_MAX, SIZE))
print('%-10s %-8s %-10s %-10s %s' % ('clip', 'cell', '重心X移动', '重心Y移动', '贴画布边'))
# 运行时真正播的区间（与 app.js DEFAULTS 一致），全片位移会混进没用上的铺垫帧
RANGES = {
    'turn':    [(43, 53), (72, 88)],   # 43-88 挖 54-71
    'run':     [(18, 26)],             # 一个步幅
    'pounce':  [(62, 84)],
    'ready':   [(24, 76)],
}
for key in list(RANGES) + [k for k in meta if k not in RANGES]:
    m = meta[key]
    want = RANGES.get(key)
    cell, per = m['cell'], m['sheet'] ** 2
    dx = (CELL_MAX - cell) // 2
    dy = CELL_MAX - cell
    cache = {}
    cxs, cys = [], []
    edge = 0
    frames = sorted({f for a, b in want for f in range(a, b + 1)}) if want else list(range(m['frames']))
    for f in frames:
        if f >= m['frames']:
            continue
        si = f // per
        if si not in cache:
            cache[si] = np.array(Image.open('assets_sprites/' + m['sheets'][si]['file']))
        im = cache[si]
        k = f % per
        a = im[k % m['sheet'] * cell:(k % m['sheet'] + 1) * cell,
               k // m['sheet'] * cell:(k // m['sheet'] + 1) * cell, 3]
        ys, xs = np.nonzero(a > 110)
        if len(xs) == 0:
            continue
        # 贴进大画布后的绝对位置
        cxs.append((xs.mean() + dx) * SIZE / CELL_MAX)
        cys.append((ys.mean() + dy) * SIZE / CELL_MAX)
        if xs.min() + dx <= 0 or xs.max() + dx >= CELL_MAX - 1 or \
           ys.min() + dy <= 0 or ys.max() + dy >= CELL_MAX - 1:
            edge += 1
    if not cxs:
        print('%-10s 无主体' % key)
        continue
    mx, my = max(cxs) - min(cxs), max(cys) - min(cys)
    tag = key + ('*' if want else '')
    print('%-10s %-8d %-10.1f %-10.1f %d 帧' % (tag, cell, mx, my, edge))
