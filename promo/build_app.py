"""把真实渲染进程页面包装成演示页：注入虚拟时钟与示例数据接口。"""
import pathlib, re
root = pathlib.Path(__file__).resolve().parent
html = (root.parent / 'src/renderer/index.html').read_text(encoding='utf-8')
html = re.sub(r'<meta\s+http-equiv="Content-Security-Policy"[^>]*/>', '', html, flags=re.S)
html = html.replace('href="styles.css"', 'href="../src/renderer/styles.css"')
html = html.replace('<script src="app.js"></script>',
    '<style>.logs::-webkit-scrollbar{display:none}*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}</style>'
    '<script src="clock.js"></script><script src="mock-api.js"></script>'
    '<script src="../src/renderer/app.js"></script>')
html = html.replace('<head>', '<head><script src="clock.js"></script>', 1)
# clock.js 只需一次：保留 head 中的那份
html = html.replace('<script src="clock.js"></script><script src="mock-api.js">', '<script src="mock-api.js">')
(root / 'app.html').write_text(html, encoding='utf-8')
print('app.html ok')
