# 演示视频工程

用 HTML/CSS + 无头 WebKit 逐帧渲染出的 60 秒演示视频，画面与软件真实界面同一套样式。

## 文件

| 文件 | 说明 |
| --- | --- |
| `stage.html` | 视频主场景：1920×1080 时间线动画，结尾 GitHub 地址在 `REPO` 常量 |
| `app.html` | 由 `build_app.py` 从 `src/renderer` 生成，`stage.html` 内嵌的演示界面 |
| `clock.js` / `mock-api.js` | 虚拟时钟与示例数据接口（不连真实邮箱） |
| `narration.tsv` | 9 段旁白文稿与起始时间 |
| `vo/1.aiff` … `vo/9.aiff` | 逐段配音，`vo/plan.txt` 为时间点 |
| `render.swift` | 逐帧渲染为 MP4 或导出 PNG 截图 |
| `grab.swift` | 从视频里按时点截取 JPEG，用于检查 |
| `mix.swift` | 把分段配音按时间点合成到视频 |
| `build_app.py` / `make_srt.py` | 生成演示页、字幕与旁白稿 |

编译出的 `render` / `grab` / `mix` 可执行文件、`app.html`、`stills/`、`check/` 都不入库，按下面步骤本地生成。

## 重新渲染

需要 macOS（WebKit + AVFoundation）、Xcode 命令行工具、Python 3。

```bash
# 1. 生成演示页
python3 promo/build_app.py

# 2. 起一个本地静态服务（file:// 下 iframe 与跨目录资源会被 WebKit 拦截）
python3 -m http.server 8123

# 3. 编译渲染器
swiftc -O promo/render.swift -o promo/render
swiftc -O promo/grab.swift   -o promo/grab
swiftc -O promo/mix.swift    -o promo/mix

# 4. 渲染 60.5 秒 1080p30 无声画面
./promo/render "http://127.0.0.1:8123/promo/stage.html" "画面_无声.mp4" 30 60.5

# 5. 合成配音（可选）
./promo/mix "画面_无声.mp4" . promo/vo
```

截图检查某一帧：

```bash
./promo/render "http://127.0.0.1:8123/promo/stage.html" --stills /tmp/stills 58.5
./promo/grab "画面_无声.mp4" 56,58.5
```

## 修改结尾地址

`stage.html` 里：

```js
const REPO = P.get('repo') || 'github.com/yu024/invoice-catcher';
```

也可以在 URL 上传 `?repo=github.com/xxx/yyy` 临时覆盖，不用改文件。
