#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
离线抠像 + 打包 spritesheet。

为什么放弃「运行时逐帧抠像」：
  1. 素材背景不统一 —— 有的条满屏洋红，有的条两侧带黑边（AI 生成不守规矩），
     固定阈值的洋红判定天然顾此失彼；
  2. 背景有渐变，暗部洋红 rel 只有 0.49，达到 0.70 阈值就残留；
  3. 运行时逐像素 JS 循环是卡顿主因；
  4. 本机 ffmpeg 构建写不出带 alpha 的 WebM（实测 VP8/VP9 均丢弃 alpha）。

所以：全部在离线阶段处理完，产出「自带 alpha 的 WebP spritesheet」，
运行时 Canvas 按帧号 drawImage 一次贴图 —— 零抠像、零解码、零形态学运算。

抠像算法（离线才能负担得起的重处理）：
  a. 逐条自适应裁掉黑边（AI 生成素材常见的 letterbox）；
  b. HSV 判定洋红背景 —— 色相判定与明暗无关，暗部渐变也能判住；
  c. 连通域分析：只把「与画面边框连通」的洋红团判为背景，
     猫身上不与边框接触的粉色涂鸦毛发不会被误抠；
  d. 填洞 + 最大连通团保底 + 3x3 均值羽化；
  e. 边缘 despill 去洋红勾边；
  f. 取景：**保留源片里猫的全部位移**，cell 按这条片段的「全帧并集」自适应放大。
     （曾用过「每帧对齐」把位移抹掉换小画面，结果扑抓的跨步、转身的走位全变成
       原地动作，看着没劲 —— 位移是动作的一部分，不能抹。）
     缩放仍按中位身形定，所以各分镜的猫一样大；cell 放大只影响"猫能跑多远"。
     运行时按 meta.cell 设画布、并把 #pet 的 CSS 尺寸同比放大，
     猫在屏幕上的实际大小不受 cell 影响；
  g. 打包成 WebP sheet，附带逐帧 64x64 命中掩膜（bit-packed，供鼠标判定用）。

用法: venv python tools/make_sprites.py [--probe]
"""
import os
import sys
import json
import math
import shutil
import subprocess
import numpy as np
from scipy import ndimage
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, 'assets')
OUT_DIR = os.path.join(ROOT, 'assets_sprites')

CELL_BASE = 256     # 取景基准边长：缩放按它算，保证各分镜的猫一样大
SHEET = 8           # sheet 每边帧数 → 8x8=64 帧/张
FPS = 15            # 桌宠逐格动画，15fps 足够流畅且省一半体积
OUT_H_RATIO = 0.82  # 中位身形的高缩放到基准 cell 的 82%
OUT_W_RATIO = 0.92  # 宽度兜底（奔跑这类宽体）
ANCHOR_Y = 0.96     # 全帧并集的底边固定在 cell 底部 96% 处
HIT_RES = 64        # 命中掩膜分辨率

CLIPS = [
    ('01A-idle', 'idleA'),
    ('01B-idle', 'idleB'),
    ('02-run', 'run'),
    ('03-turn', 'turn'),
    ('04-sleep', 'sleep'),
    ('05-stretch', 'stretch'),
    ('06-liedown', 'liedown'),
    ('07-pounce', 'pounce'),
    ('08-recover', 'recover'),
    ('09-coquetry', 'coquetry'),
    ('10-ready', 'ready'),
]


def find_ffmpeg():
    try:
        import imageio_ffmpeg
        p = imageio_ffmpeg.get_ffmpeg_exe()
        if p and os.path.exists(p):
            return p
    except Exception:
        pass
    return shutil.which('ffmpeg')


def read_frames(ff, src):
    """抽帧为原始 RGB，直接在 ffmpeg 里完成缩放与降帧。"""
    cmd = [ff, '-v', 'error', '-i', src,
           '-vf', 'scale=360:360:flags=lanczos,fps=%d' % FPS,
           '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    n = 360 * 360 * 3
    out = []
    while True:
        b = p.stdout.read(n)
        if len(b) < n:
            break
        out.append(np.frombuffer(b, dtype=np.uint8).reshape(360, 360, 3))
    p.stdout.close()
    p.wait()
    return out


def to_hsv(rgb):
    """numpy 向量化 RGB -> HSV（h: 0-360, s/v: 0-1）"""
    f = rgb.astype(np.float32) / 255.0
    r, g, b = f[:, :, 0], f[:, :, 1], f[:, :, 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    diff = mx - mn
    diff_safe = np.maximum(diff, 1e-6)
    h = np.zeros_like(mx)
    nz = diff > 1e-6
    idx = (mx == r) & nz
    h[idx] = (60 * ((g - b) / diff_safe) % 360)[idx]
    idx = (mx == g) & nz
    h[idx] = (60 * ((b - r) / diff_safe) + 120)[idx]
    idx = (mx == b) & nz
    h[idx] = (60 * ((r - g) / diff_safe) + 240)[idx]
    s = np.where(mx > 1e-6, diff / np.maximum(mx, 1e-6), 0)
    return h, s, mx


def detect_black_bars(frame):
    """检测四边黑边（letterbox）。返回 (l, t, r, b) 裁切量。"""
    v = frame.max(axis=2).astype(np.float32) / 255.0
    dark = v < 0.10                      # 近黑像素
    H, W = dark.shape
    col_dark = dark.mean(axis=0)         # 每列暗像素占比
    row_dark = dark.mean(axis=1)
    l = 0
    while l < W // 3 and col_dark[l] > 0.95:
        l += 1
    r = W
    while r > 2 * W // 3 and col_dark[r - 1] > 0.95:
        r -= 1
    t = 0
    while t < H // 3 and row_dark[t] > 0.95:
        t += 1
    b = H
    while b > 2 * H // 3 and row_dark[b - 1] > 0.95:
        b -= 1
    # 保护：如果裁完剩不到一半，认为检测错了，不裁
    if (r - l) < W * 0.5 or (b - t) < H * 0.5:
        return 0, 0, W, H
    return l, t, r, b


def magenta_bg_mask(rgb):
    """疑似洋红背景的掩膜（HSV 色相判定，与明暗无关）。"""
    h, s, v = to_hsv(rgb)
    return (h >= 265) & (h <= 350) & (s >= 0.22) & (v >= 0.12)


def refine(rgb):
    """完整抠像：判定 → 边框连通 → 填洞 → 保底 → 羽化。返回 alpha (0-255)。"""
    H, W = rgb.shape[:2]
    suspect = magenta_bg_mask(rgb)

    # 关键一步：疑似背景里，只有「与画面边框接触」的连通团才算真背景。
    # 猫身上的亮粉涂鸦毛发色相与洋红背景同区间，但不接触边框 —— 这里保住了它。
    lab, n = ndimage.label(suspect)
    if n:
        border_labels = set(np.unique(np.concatenate([
            lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]
        ])))
        border_labels.discard(0)
        bg = np.isin(lab, list(border_labels)) if border_labels else np.zeros_like(suspect)
    else:
        bg = suspect

    fg = ~bg
    # 填洞：被猫轮廓包住的背景色区域（如毛发缝隙）归入前景
    fg = ndimage.binary_fill_holes(fg)

    # 开运算去孤立噪点
    fg = ndimage.binary_opening(fg, structure=np.ones((3, 3), bool))

    # 只保留最大连通团；若最大团异常小（说明该帧抠崩了），退回保底
    lab, n = ndimage.label(fg)
    if n > 1:
        sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
        biggest = int(sizes.max())
        if biggest > 0.02 * H * W:
            fg = (lab == int(sizes.argmax()) + 1)

    a = np.where(fg, 255.0, 0.0)
    a = ndimage.uniform_filter(a, size=3)   # 1px 羽化抗锯齿
    return a.astype(np.uint8)


def despill(rgb, alpha):
    """边缘去洋红勾边：半透明像素的绿通道拉回红蓝较低者。"""
    f = rgb.astype(np.int16)
    r, g, b = f[:, :, 0], f[:, :, 1], f[:, :, 2]
    mn = np.minimum(r, b)
    excess = np.maximum(0, mn - g)
    edge = (alpha > 0) & (alpha < 250)
    newg = np.minimum(g + (excess * 0.85).astype(np.int16), mn)
    g2 = np.where(edge, newg, g)
    return np.clip(np.stack([r, g2, b], axis=2), 0, 255).astype(np.uint8)


def bbox_of(alpha, th=110):
    ys, xs = np.nonzero(alpha > th)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def plan_framing(bbs):
    """决定这条片段的缩放、cell 边长与锚点。

    两条约束要同时满足：
      1. 猫不能被切 —— 缩放必须让「最大的那一帧」也塞得进画面；
      2. 位移要留 —— 扑抓跨步、转身走位是动作的一部分，
         不能靠每帧对齐把猫钉在原地（那样画面是小了，动作也没了）。
    所以：缩放按【中位身形】定（各分镜的猫一样大），
    画面边长按【全帧并集】定（连猫跑过的整条轨迹都装得下）。
    cell 因此每条片段不同（256~368），运行时按 meta.cell 自适应即可。
    """
    valid = [i for i, bb in enumerate(bbs) if bb]
    if not valid:
        return None
    medW = float(np.median([bbs[i][2] - bbs[i][0] for i in valid]))
    medH = float(np.median([bbs[i][3] - bbs[i][1] for i in valid]))
    scale = min(CELL_BASE * OUT_H_RATIO / max(medH, 1.0),
                CELL_BASE * OUT_W_RATIO / max(medW, 1.0))
    scale = min(scale, 4.0)

    # 全帧并集：含位移轨迹，cell 必须装得下它
    ux0 = min(bbs[i][0] for i in valid)
    uy0 = min(bbs[i][1] for i in valid)
    ux1 = max(bbs[i][2] for i in valid)
    uy1 = max(bbs[i][3] for i in valid)
    uw, uh = ux1 - ux0, uy1 - uy0

    need = max(uw * scale / OUT_W_RATIO, uh * scale / OUT_H_RATIO)
    cell = int(math.ceil(need / 8.0) * 8)
    cell = max(CELL_BASE, cell)
    # 锚点：并集底边中心 → cell 底部 ANCHOR_Y、水平居中
    ox = cell / 2.0 - (ux0 + ux1) / 2.0 * scale
    oy = cell * ANCHOR_Y - uy1 * scale
    return dict(scale=scale, cell=cell, ox=ox, oy=oy, uw=uw, uh=uh, medW=medW, medH=medH)


def process(ff, src, key, log):
    frames = read_frames(ff, src)
    if not frames:
        log.append('  !! %s: 抽帧失败' % key)
        return None

    # 1) 黑边裁切：用第一帧算 crop，整条沿用（避免帧间抖动）
    l, t, r, b = detect_black_bars(frames[0])
    if (l, t, r, b) != (0, 0, 360, 360):
        frames = [f[t:b, l:r] for f in frames]
        log.append('  裁黑边 l=%d t=%d r=%d b=%d -> %dx%d' % (l, t, r, b, r - l, b - t))

    # 2) 逐帧抠像
    alphas = []
    for f in frames:
        a = refine(f)
        alphas.append(a)
    frames = [despill(f, a) for f, a in zip(frames, alphas)]

    # 3) 帧率已在 ffmpeg 抽帧时降到 FPS，直接用

    # 4) 逐帧 bbox → 定缩放、cell 边长与锚点（保留位移的并集取景，见 plan_framing）
    bbs = [bbox_of(a) for a in alphas]
    plan = plan_framing(bbs)
    if plan is None:
        log.append('  !! %s: 没测到主体' % key)
        return None
    scale = plan['scale']
    cell = plan['cell']
    ox, oy = plan['ox'], plan['oy']
    log.append('  中位身形 %dx%d（缩放 %.3f）→ 含位移并集 %dx%d → cell %d'
               % (plan['medW'], plan['medH'], scale, plan['uw'], plan['uh'], cell))

    # 5) 绘制到 cell
    sheets = []
    per = SHEET * SHEET
    nsheets = int(math.ceil(len(frames) / per))
    hitBits = []          # 逐帧 64x64 命中掩膜，bit-packed
    hit = np.zeros((HIT_RES, HIT_RES), dtype=np.uint8)
    clipped = []          # 顶到 cell 边框的帧号，正常应为空

    for si in range(nsheets):
        sheet = Image.new('RGBA', (cell * SHEET, cell * SHEET), (0, 0, 0, 0))
        for k in range(per):
            fi = si * per + k
            if fi >= len(frames):
                break
            img = Image.fromarray(np.dstack([frames[fi], alphas[fi]]), 'RGBA')
            # 整条片段统一 transform：位移完整保留，猫在 cell 内该跑多远跑多远
            img = img.transform(
                (cell, cell), Image.AFFINE,
                (1.0 / scale, 0, -ox / scale, 0, 1.0 / scale, -oy / scale),
                resample=Image.BILINEAR,
            )
            # 取景自检：cell 四条边上还有不透明像素 = 这一帧被切掉了，必须为零
            a_cell = np.array(img)[:, :, 3]
            if (a_cell[0] > 110).any() or (a_cell[-1] > 110).any() \
                    or (a_cell[:, 0] > 110).any() or (a_cell[:, -1] > 110).any():
                clipped.append(fi)

            x = (k % SHEET) * cell
            y = (k // SHEET) * cell
            sheet.paste(img, (x, y))
            # 命中掩膜：逐帧存（并集会把跑动轨迹全算进去，互动范围会虚大 1~2.4 倍）
            a_small = np.array(img.resize((HIT_RES, HIT_RES), Image.BILINEAR))[:, :, 3]
            bits = (a_small > 90)
            hitBits.append(np.packbits(bits.ravel(), bitorder='big').tobytes())
            hit = np.maximum(hit, bits.astype(np.uint8) * 255)

        dst = os.path.join(OUT_DIR, '%s_%d.webp' % (key, si))
        sheet.save(dst, 'WEBP', quality=88, method=4)
        sheets.append({
            'file': os.path.basename(dst),
            'mb': round(os.path.getsize(dst) / 1048576, 2),
        })

    if clipped:
        log.append('  !! %s: %d 帧仍顶边 %s' % (key, len(clipped), clipped[:12]))
    else:
        log.append('  取景自检：0 帧顶边')

    b64 = __import__('base64')
    # 命中掩膜：逐帧 64x64，1bit/像素 → 512 字节/帧，base64 直存
    # （运行时按当前帧查表；另一份并集只留着做人工比对，代码里不再用）
    hit_frames_b64 = b64.b64encode(b''.join(hitBits)).decode()
    hit_b64 = b64.b64encode(hit.astype(np.uint8).tobytes()).decode()

    return {
        'frames': len(frames),
        'fps': FPS,
        'cell': cell,
        'sheet': SHEET,
        'sheets': sheets,
        'scale': round(scale, 4),
        'hitFrames': hit_frames_b64,
        'hitFrameBytes': HIT_RES * HIT_RES // 8,
        'hit': hit_b64,
    }


def main():
    probe = '--probe' in sys.argv
    ff = find_ffmpeg()
    if not ff:
        print('ERROR: 找不到 ffmpeg')
        sys.exit(1)
    print('ffmpeg:', ff, flush=True)

    os.makedirs(OUT_DIR, exist_ok=True)
    clip_list = CLIPS[:2] if probe else CLIPS
    log, meta = [], {}
    for base, key in clip_list:
        src = os.path.join(SRC_DIR, base + '.mp4')
        if not os.path.exists(src):
            log.append('  !! 缺素材 %s.mp4' % base)
            continue
        print('处理', base, flush=True)
        m = process(ff, src, key, log)
        if m:
            meta[key] = m
            tot = sum(s['mb'] for s in m['sheets'])
            print('   -> %d 帧 %d 张sheet 共%.1fMB' % (m['frames'], len(m['sheets']), tot), flush=True)

    with open(os.path.join(OUT_DIR, 'meta.json'), 'w', encoding='utf-8') as fp:
        json.dump(meta, fp, ensure_ascii=False, indent=2)
    print('\n'.join(log))
    print('完成:', OUT_DIR, '素材数:', len(meta))


if __name__ == '__main__':
    main()
