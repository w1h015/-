#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
离线抠像：把洋红幕布素材转成自带 Alpha 的 WebM。

为什么不再在运行时逐帧抠像：
  1. H.264 压缩会让主体边缘的色度被背景渗透，单像素阈值法对这种伪影无解，
     这就是「洋红残留」一直抠不干净的来源；
  2. 每帧 getImageData + JS 逐像素循环 + putImageData 是卡顿主因；
  3. 背景残留像素带 alpha，会让鼠标落在猫身体外也算摸到猫 —— 互动范围虚大。

离线处理可以用运行时负担不起的重算法：形态学开闭运算去压缩噪点、填体内空洞、
丢背景孤岛、距离羽化、边缘 despill。成品是自带 alpha 的 VP9 WebM，
浏览器直接当透明图层画，运行时零抠像开销。

用法: venv python tools/matting.py [ffmpeg路径]
"""
import os
import sys
import json
import shutil
import subprocess
import numpy as np
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, 'assets')
OUT_DIR = os.path.join(ROOT, 'assets_alpha')

# 运行时显示约 260px，输出留一点余量。降分辨率是最有效的一档减负。
OUT_SIZE = 360
OUT_FPS = 20

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


def find_ffmpeg(cli_path=None):
    if cli_path and os.path.exists(cli_path):
        return cli_path
    try:
        import imageio_ffmpeg
        p = imageio_ffmpeg.get_ffmpeg_exe()
        if p and os.path.exists(p):
            return p
    except Exception:
        pass
    for c in (
        os.path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
        os.path.join(ROOT, 'ffmpeg.exe'),
    ):
        if os.path.exists(c):
            return c
    return shutil.which('ffmpeg')


def build_mask(frame):
    """由 RGB 帧算出初始不透明度掩膜。

    判定放在「洋红分量占整体色度的比例」上，与明暗无关 ——
    暗部洋红（例如 (80,10,80)）也能判出来，这正是运行时漏掉的那种像素。
    """
    f = frame.astype(np.int16)
    r, g, b = f[:, :, 0], f[:, :, 1], f[:, :, 2]

    mn = np.minimum(r, b)                       # 洋红：红蓝高、绿低
    mx = np.maximum(np.maximum(r, g), b)
    mnc = np.minimum(np.minimum(r, g), b)
    chroma = mx - mnc
    dg = mn - g

    rel = np.where(chroma > 0, dg.astype(np.float32) / np.maximum(chroma, 1), 0.0)

    # 灰白黑（chroma 低）不参与色度判定，黑毛白腹不会被误伤
    keyed = (chroma >= 16) & (rel >= 0.70) & (dg > 0)
    return np.where(keyed, 0, 255).astype(np.uint8)


def refine_mask(alpha):
    """形态学清理 —— 离线方案相对运行时逐像素判定的核心优势。"""
    h, w = alpha.shape
    m = alpha > 127

    # 开运算：抹掉背景里的孤立残留块（压缩伪影常见形态）
    m = ndimage.binary_opening(m, structure=np.ones((3, 3), bool), iterations=1)
    # 闭运算：补上猫身上的细小缺口
    m = ndimage.binary_closing(m, structure=np.ones((3, 3), bool), iterations=2)
    # 填充体内空洞（例如毛发围出的背景色区域）
    m = ndimage.binary_fill_holes(m)

    # 只保留最大连通团，丢掉背景里的孤岛
    lab, n = ndimage.label(m)
    if n > 1:
        sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
        biggest = int(sizes.max())
        # 保底：最大团小到离谱说明这帧抠崩了，宁可退回原掩膜也别让猫消失
        if biggest > 0.02 * h * w:
            m = (lab == int(sizes.argmax()) + 1)

    # 边缘羽化：硬边会有锯齿，模糊出 1px 过渡即可
    a = np.where(m, 255.0, 0.0)
    a = ndimage.uniform_filter(a, size=3)
    return np.clip(a, 0, 255).astype(np.uint8)


def despill(frame, alpha):
    """边缘去洋红：半透明像素里残留的洋红会把猫勾出一圈粉边。

    把绿通道拉回到「与红蓝中较低者相当」，痕迹就没了。
    只在半透明边缘做，实心底色不动，避免整体偏色。
    """
    f = frame.astype(np.int16)
    r, g, b = f[:, :, 0], f[:, :, 1], f[:, :, 2]
    mn = np.minimum(r, b)
    excess = np.maximum(0, mn - g)
    edge = (alpha > 0) & (alpha < 250)
    newg = np.minimum(g + (excess * 0.85).astype(np.int16), mn)
    g2 = np.where(edge, newg, g)
    return np.clip(np.stack([r, g2, b], axis=2), 0, 255).astype(np.uint8)


def bbox_of(alpha):
    ys, xs = np.nonzero(alpha > 110)
    if len(xs) == 0:
        return None
    return (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


def process(ff, src, out_name, log):
    # 1) 抽帧为 rawvideo，避开 PNG 编解码开销
    cmd = [
        ff, '-v', 'error', '-i', src,
        '-vf', f'scale={OUT_SIZE}:{OUT_SIZE}:flags=lanczos,fps={OUT_FPS}',
        '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'
    ]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    frame_n = OUT_SIZE * OUT_SIZE * 3

    frames, masks = [], []
    while True:
        buf = p.stdout.read(frame_n)
        if len(buf) < frame_n:
            break
        arr = np.frombuffer(buf, dtype=np.uint8).reshape(OUT_SIZE, OUT_SIZE, 3)
        a = refine_mask(build_mask(arr))
        frames.append(despill(arr, a))
        masks.append(a)
    p.stdout.close()
    p.wait()

    if not frames:
        log.append('  !! %s: 抽帧失败' % out_name)
        return None

    # 2) 整条素材统一的包围盒：取各帧面积中位数所在的那一帧。
    #    不用并集 —— 扑抓、转身位移大，并集会虚高，反而把猫算小。
    cand = []
    for i, m in enumerate(masks):
        bb = bbox_of(m)
        if bb:
            cand.append(((bb[2] - bb[0]) * (bb[3] - bb[1]), i, bb))
    if not cand:
        log.append('  !! %s: 没测到主体' % out_name)
        return None
    cand.sort()
    _, mi, bbox = cand[len(cand) // 2]
    log.append('  frames=%d bbox=%s' % (len(frames), bbox))

    # 3) 合成带 alpha 的 VP9 WebM
    dst = os.path.join(OUT_DIR, out_name + '.webm')
    enc = [
        ff, '-v', 'error', '-y',
        '-f', 'rawvideo', '-pix_fmt', 'rgba',
        '-s', '%dx%d' % (OUT_SIZE, OUT_SIZE), '-r', str(OUT_FPS), '-i', '-',
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
        '-b:v', '800k', '-auto-alt-ref', '0',
        '-deadline', 'good', '-cpu-used', '4',
        dst
    ]
    q = subprocess.Popen(enc, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    for f, a in zip(frames, masks):
        q.stdin.write(np.dstack([f, a]).astype(np.uint8).tobytes())
    q.stdin.close()
    q.wait()

    if not os.path.exists(dst):
        log.append('  !! %s: 编码失败' % out_name)
        return None
    return {
        'file': out_name + '.webm',
        'frames': len(frames),
        'fps': OUT_FPS,
        'size': OUT_SIZE,
        'bbox': list(bbox),
        'mb': round(os.path.getsize(dst) / 1048576, 2),
    }


def main():
    cli = sys.argv[1] if len(sys.argv) > 1 else None
    ff = find_ffmpeg(cli)
    if not ff:
        print('ERROR: 找不到 ffmpeg')
        sys.exit(1)
    print('ffmpeg:', ff, flush=True)

    os.makedirs(OUT_DIR, exist_ok=True)
    log, meta = [], {}
    for base, key in CLIPS:
        src = os.path.join(SRC_DIR, base + '.mp4')
        if not os.path.exists(src):
            log.append('  !! 缺素材 %s.mp4' % base)
            continue
        print('处理', base, flush=True)
        m = process(ff, src, key, log)
        if m:
            meta[key] = m
            print('   ->', m['frames'], 'frames', m['mb'], 'MB', flush=True)

    with open(os.path.join(OUT_DIR, 'meta.json'), 'w', encoding='utf-8') as fp:
        json.dump(meta, fp, ensure_ascii=False, indent=2)
    print('\n'.join(log))
    print('完成，输出目录:', OUT_DIR)
    print('素材数:', len(meta))


if __name__ == '__main__':
    main()
