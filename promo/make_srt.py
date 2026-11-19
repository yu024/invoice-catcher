import re, subprocess, pathlib
out = pathlib.Path.home() / 'Desktop/发票捕手演示视频'
def dur(p):
    o = subprocess.check_output(['afinfo', p]).decode()
    return float(re.search(r'estimated duration: ([\d.]+)', o).group(1))
def ts(x):
    ms = int(round(x * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f'{h:02}:{m:02}:{s:02},{ms:03}'
cues = []; plan = []
for i, line in enumerate(pathlib.Path('narration.tsv').read_text().strip().split('\n'), 1):
    a, b, text = line.split('\t'); a = float(a); d = dur(f'vo/{i}.aiff'); plan.append((i, a))
    parts = [p for p in re.split(r'(?<=[，。？：、；！])', text) if p.strip()]
    chunks, cur = [], ''
    for p in parts:
        if cur and len(cur) + len(p) > 18: chunks.append(cur); cur = p
        else: cur += p
    chunks.append(cur)
    total = sum(len(c) for c in chunks); t = a
    for c in chunks:
        e = t + d * len(c) / total
        cues.append((t, e, c.rstrip('，、；：。')))
        t = e
srt = '\n'.join(f'{n}\n{ts(s)} --> {ts(e)}\n{c}\n' for n, (s, e, c) in enumerate(cues, 1))
(out / '字幕.srt').write_text(srt, encoding='utf-8')
pathlib.Path('vo/plan.txt').write_text('\n'.join(f'{i} {a}' for i, a in plan))
script = '\n'.join(f'[{a:05.1f}s] {line.split(chr(9))[2]}' for line, (i, a) in zip(pathlib.Path('narration.tsv').read_text().strip().split('\n'), plan))
(out / '旁白稿.txt').write_text('发票捕手 · 60 秒演示旁白（[开始时间] 文案）\n\n' + script + '\n', encoding='utf-8')
print(srt[:400]); print(len(cues), 'cues')
