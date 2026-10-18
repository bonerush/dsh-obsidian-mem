# 图表源文件

本目录保存文档中的全部图。所有图都是 SVG，文字使用系统字体。

## 文件

| 图 | 源 | 生成方式 |
|---|---|---|
| `fig-overview.svg` | 本目录 `build.mjs` | `node build.mjs` |
| `fig-layers.svg` | 本目录 `build.mjs` | `node build.mjs` |
| `fig-write-path.svg` | 本目录 `build.mjs` | `node build.mjs` |
| `fig-troubleshoot.svg` | 本目录 `build.mjs` | `node build.mjs` |
| `fig-job-states.svg` | 本目录 `build.mjs` | `node build.mjs` |
| `fig-reading-path.svg` | 本目录 `build.mjs` | `node build.mjs` |
| `fig-session.svg` | `src/fig-session.mmd` | Mermaid CLI |

## 重新生成手绘图

```sh
cd docs/guide/figures
node build.mjs
```

生成器会先测量文字宽度。
文字放不下时，构建直接报错，不会画出重叠的标签。

## 重新生成时序图

```sh
cp src/puppeteer.example.json src/puppeteer.json
# 编辑 src/puppeteer.json，填入本机 Chrome 路径
npx -y @mermaid-js/mermaid-cli@12.0.0 \
  -p src/puppeteer.json \
  -c src/mermaid.json \
  -i src/fig-session.mmd \
  -o fig-session.svg
```

`src/puppeteer.json` 由示例文件复制，含本机绝对路径，不提交。
`src/mermaid.json` 固定字体、配色和时序图间距。

## 检查

1. 用浏览器打开 SVG。
2. 以 2 倍缩放截图。
3. 检查三点：文字不重叠、箭头不穿过文字、每个标签都能读完。
