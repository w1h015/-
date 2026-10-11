#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从已生成的 spritesheet 重新提取「逐帧」命中掩膜，写回 meta.json。

修两个问题：

1. 旧掩膜是整条素材各帧 alpha 的并集 —— 对奔跑、扑抓、转身这类猫在画面里
   位移很大的分镜，并集会覆盖猫走过的整条轨迹，于是鼠标落在猫身后的空气里
   也算摸到猫（用户反馈的「互动范围不稳定、与图像大小不符」）。
   改成逐帧后，判定范围 = 当前这一帧猫的真实轮廓。

2. 旧掩膜在 meta.json 里是 32x32 nibble 打包（1024 字节），而 app.js 按
   HIT_RES=64 去索引 —— 直接越界读到 undefined，判定完全是乱的。
   现在统一 64x64、1 bit/像素、512 字节/帧，base64 存进 meta.json 的 hitFrames。

用法: venv python tools/remask.py
"""
import os
import json
import base64

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'assets_sprites')
HIT_RES = 64


def pack_bits(mask):
    """bool 掩膜 (64,64) -> 512 字节，1 bit/像素。"""
    return np.packbits(mask.astype(np.uint8).reshape(-1)).tobytes()


def main():
    meta_path = os.path.join(OUT_DIR, 'meta.json')
    with open(meta_path, 'r', encoding='utf-8') as fp:
        meta = json.load(fp)

    rows = []
    total_bytes = 0

    for key, m in meta.items():
        cell = m['cell']
        per = m['sheet'] * m['sheet']
        n = m['frames']

        frames_mask = []
        covs = []
        union = np.zeros((HIT_RES, HIT_RES), dtype=bool)

        for sf in m['sheets']:
            path = os.path.join(OUT_DIR, sf['file'])
            im = Image.open(path).convert('RGBA')
            arr = np.array(im)
            for k in range(per):
                if len(frames_mask) >= n:
                    break
                sx = (k % m['sheet']) * cell
                sy = (k // m['sheet']) * cell
                a = arr[sy:sy + cell, sx:sx + cell, 3]
                small = np.array(
                    Image.fromarray(a).resize((HIT_RES, HIT_RES), Image.BILINEAR)
                )
                msk = small > 110
                covs.append(float(msk.mean()))
                union |= msk
                frames_mask.append(pack_bits(msk))
            del arr
            im.close()

        blob = b''.join(frames_mask)
        m['hitFrames'] = base64.b64encode(blob).decode()
        m['hitFrameBytes'] = 512
        m.pop('hit', None)          # 并集掩膜作废
        total_bytes += len(blob)

        covs = np.array(covs)
        rows.append((key, n, float(union.mean()), float(covs.mean()),
                     float(covs.max()), float(covs.min())))

    with open(meta_path, 'w', encoding='utf-8') as fp:
        json.dump(meta, fp, ensure_ascii=False, indent=2)

    print('%-10s %5s %9s %10s %8s %8s %10s' %
          ('clip', 'frames', 'union%', 'frameAvg%', 'max%', 'min%', 'union/avg'))
    for key, n, uc, fa, mx, mn in rows:
        print('%-10s %5d %8.1f%% %9.1f%% %7.1f%% %7.1f%% %9.2fx' %
              (key, n, uc * 100, fa * 100, mx * 100, mn * 100, uc / max(fa, 1e-6)))
    print()
    print('逐帧掩膜总体积: %.1f KB（base64 后 %.1f KB）' %
          (total_bytes / 1024.0, total_bytes * 4 / 3 / 1024.0))
    print('meta.json: %.1f KB' % (os.path.getsize(meta_path) / 1024.0))


if __name__ == '__main__':
    main()
