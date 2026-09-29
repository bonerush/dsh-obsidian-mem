# Obsidian 关系图谱源码适配记录

## 实际参考来源

2026-09-28 读取本机安装的 Obsidian，从
`/Applications/Obsidian.app/Contents/Resources/obsidian.asar` 提取内置关系图谱。
实际来源是内置 `graph` 模块，当前 vault 未安装另一个同名社区插件。
提取和格式化发生在系统临时目录中，仓库不包含 Obsidian 的应用源码。

版本有两处互相矛盾的记录，都如实留在这里：应用窗口标题显示 **1.13.7**，而包内
`Info.plist` 的 `CFBundleShortVersionString` 是 **1.12.7**。下表是本次
（2026-09-28 再次复核）实测的当前提取文件。此前把格式化后的 `app.js`
（8195223 字节）误记为原始文件；重新读取 asar 后确认原始文件是 3728534
字节。下面分别列出原始文件和格式化文件，后者仍与此前记录的哈希相同。

| 文件形态 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `app.js` | 3728534 | `cc6d0c363cba3935207fb70e7d78736c9f0c2024545787871095288a1b185851` |
| `app.js`（Prettier 格式化后，非原始文件） | 8195223 | `30dbf34c6c548bc8a4402d5b8bb854b62f474d356ce283b8a321143f682b66fe` |
| `app.css` | 600413 | `6245db88b65b1728ef136cc79b3ce3ef85ab860944abbe5198e9d6bd9abe9bea` |
| `sim.js` | 17693 | `549be2f69710af360d521c92b80c83718f673594d3dc2255a65e251199eee25d` |
| `lib/pixi.min.js`（仅临时目录对照） | 487134 | `842814b22c348dcdab381ffb79da3763ff0672271f60f09dababa52656fd31b8` |

初次对照时运行的 Obsidian 主题是 **Wasp**；随后用户要求采用 **Obsidian 默认配色**。
现在实现不再自绘调色板，而是按原版方式解析颜色：`app.js` 的 `MQ` 把十一个槽位
映射到 `.graph-view.color-*` 类，`testCSS()` 用隐藏探针读它们的 `color` 与
`opacity`，取值由主题拥有。

2026-09-28 复核发现两处此前没有对齐，均已改正：

| 现象 | 原因 | 现在的做法 |
| --- | --- | --- |
| 深色 DSH 里图谱是浅色画布 | 原先用 `.dark` / `[data-theme=dark]` 判断深色，而本机 DSH 用的是 `body[data-ds-dark-theme]`，两个选择器都不命中 | 不再按类名分支，改为从主题令牌解析槽位 |
| 连线几乎看不见 | 连线槽位绑到了 `--dsw-alias-border-l2`，本机该令牌是半透明的（深色 `#ffffff1f`，约 12% 不透明度），再乘槽位自身透明度后只剩约十分之一对比度 | 连线改绑实色的 `--dsw-alias-label-dimmed` |

Obsidian 变量到本机 DSH 令牌的绑定（括号内是 Obsidian 默认值，作为回退）：

| Obsidian | 本机 DSH 令牌 | 默认浅色 | 默认深色 |
| --- | --- | --- | --- |
| `--graph-node` | `--dsw-alias-label-secondary` | `#5c5c5c` | `#b3b3b3` |
| `--graph-line` | `--dsw-alias-label-dimmed` | `#e1e5ee` | `#43454a` |
| `--graph-text` | `--dsw-alias-label-primary` | `#222222` | `#dadada` |
| `--graph-node-unresolved`（opacity 0.5） | `--dsw-alias-label-tertiary` | `#ababab` | `#666666` |
| `--graph-node-focused`、`--interactive-accent` | `--dsw-alias-link` | `hsl(257,88.88%,70.95%)` | `#8a5cf5` |
| `--graph-node-tag` | `--dsw-alias-state-success-primary` | `#08b94e` | `#44cf6e` |
| `--graph-node-attachment` | `--dsw-alias-state-warn-primary` | `#e0ac00` | `#e0de71` |
| 控件底色 `--menu-background` | `--dsw-alias-bg-layer-2` | `#f6f6f6` | `#262626` |

2026-09-28 用已发布的 `lib/client.js` 规则与真实渲染器在 Chrome 实测：深色下
`color-fill` = `rgb(179,179,179)`、`color-text` = `rgb(218,218,218)`、
`color-line` = `rgb(67,69,74)`，浅色下 `color-fill` = `rgb(92,92,92)`；
切换 `body[data-ds-dark-theme]` 后不重新注册即按新主题重绘。

悬停节点与相邻连线、调用流光使用强调色；未创建目标按原版降低透明度。
颜色组仍支持手动新增，但首次打开与复位均不按记忆类型预置彩色分组。

## 标签字号与缓存分辨率的有意适配

原版标签字号是 `14 + getSize() / 4`，其中 `getSize()` 就是节点半径
（本仓库的 `baseRadius` 复刻了它，含 `clamp(3 * sqrt(weight + 1), 8, 30)`）。
2026-09-28 用户要求“文字稍微小一点”：图谱位于窄侧栏，自适应后的图形很小，而
悬停标签按原版会锁定在基准字号，视觉上偏大。用户先选定 0.5，随后要求把默认值
改回 **0.85**；目前标签按原版公式的 **85%** 栅格化。位置、`√scale` 缩放、淡出阈值和
悬停锁定一律不变。

缩放对照表（`node scratch/label-scale-table.mjs`，数字是相对基准字号的倍率）：

| 缩放 scale | 非悬停标签（原版 = √scale） | 悬停标签（原版 scale<1 时锁定 1） |
| --- | --- | --- |
| 1.0000 | 1.000 | 1.000 |
| 0.6724 | 0.820 | 1.000 |
| 0.2992 | 不可见（透明度 0） | 1.000 |
| 0.0079（下限 1/128） | 不可见 | 1.000 |
| 7.9300（上限 8） | 2.816 | 2.816 |

滑块范围是 **0.4–1.6**（步长 0.05），默认 **0.85**，位于外观区块；改它会按新字号重新
栅格化缓存。原版没有这个滑块，这是本仓库的扩展。

用户随后反馈放大时文字边缘模糊。固定分辨率 2 的离屏位图在放大后会被拉伸，
尤其在高像素密度屏幕上。现在缓存分辨率为
`2 ** ceil(log2(max(2, devicePixelRatio * textScale)))`，其中普通标签的
`textScale = sqrt(scale)`，高亮标签在 `scale < 1` 时为 1。
字号、换行宽度和 CSS 显示尺寸保持原规则，仅在跨越分辨率档位时增加缓存像素；
缩小继续复用已有高分辨率缓存。每帧最多更新 50 个普通标签，等待更新的旧标签
仍可见，避免在升级缓存时消失。这个适配不再承诺放大档位的缓存与原版固定
分辨率 2 的像素完全一致。

## 调用记忆时的提示（本仓库扩展）

原版图谱没有“正在被调用”的概念。2026-09-29 用户审阅对照原型后选定了
轻量聚焦提示。时序和绘制在 `lib/graph-recall.js`，渲染器保持同一布局与视口，
提示只在会话内存在：

| 提示 | 行为 |
| --- | --- |
| 节点强调 | 180 ms 淡入强调色核心、固定细外环与柔和光晕；不反复扩散 |
| 关联线 | 从最近读取的端点向邻居扫过一次，扫过阶段 880 ms，随后只保留淡强调；邻居不会被标成已读取 |
| 文件名 | 提示期间保持可见，`scale<1` 时逐步锁定基准字号；最后 600 ms 同时淡出并恢复普通缩放；无障碍标题列出至多三个正在提示的文件名 |

整条提示持续 **2.6 s**，从浏览器收到事件时起算，用单调时钟推进，避免 700 ms
轮询消耗首次动效。同一活动事件不会在快照或显示设置更新时重新播放；新的读取
可以再次触发。外围节点只轻微降低对比度，不改变位置。系统开启
`prefers-reduced-motion: reduce` 时保留静态强调，停止连线运动。
销毁渲染器时取消偏好监听并清空提示状态。

设计参考为 [force-graph 的按事件触发粒子示例](https://github.com/vasturiano/force-graph/blob/master/example/emit-particles/index.html)
与 [Sigma.js 的邻域强调示例](https://github.com/jacomyal/sigma.js/blob/main/packages/storybook/stories/1-core-features/4-use-reducers/index.ts)，
结合本地 `motion-ui` 技能的有限状态反馈、空间连续性与减少动态效果原则。
代码按已有 Canvas 2D 渲染器独立实现，没有增加运行时依赖或复制上述库的实现。

## 资产按请求读取

`/obsidian-mem/graph-renderer.js` 与 `/obsidian-mem/graph-worker.js` 原先在
注册时用 `readFileSync` 读一次并长期返回那个缓冲区，于是 `lib/` 的改动在宿主
重启前不会进入浏览器——这正是“改完没效果”的来源。现在所有浏览器模块与 Worker 每次请求重新读取
（`cache-control: no-cache` 不变），`test/graph-route.test.js` 用“两个请求之间
改写临时资产”的用例钉住它。

## 从源码采用的合同

下面的符号来自格式化后的提取文件；符号名属于该版本的编译产物。

| 原版位置 | 采用的规则 | 本仓库适配 |
| --- | --- | --- |
| `app.js` `xJ.render`（GraphEngine） | 从 Markdown 文件及元数据链接构造图；历史状态不影响拓扑；默认保留未创建目标与孤立文件 | `lib/graph-data.js`；全部范围补充 `_meta` 管理文件的只读关系，管理文件仍不进入召回索引 |
| 元数据缓存 `getLinkpathDest`、`xT`、`ET` | 文件名大小写不敏感；显式相对路径；同目录优先再按路径长短排序；文件名查找失败再补 `.md`；链接来源包含正文、嵌入和 YAML；去掉标题片段 | `lib/graph-links.js`；保留文件名中的反引号、转义别名分隔符及别名里的方括号 |
| `sim.js` 的消息处理器 | `nodes` 为 ID 到坐标的映射；已有节点保留速度；`links` 为 ID 对；`forceNode` 固定/释放节点；修改设置重新加热 | `client/graph-worker.js` |
| `sim.js` 的 D3 回退分支 | forceX/Y 强度 0.1；连线长度 250；连线强度为较小端点度数的倒数；charge -1000、distanceMin 30、theta 0.9；collision 半径 60、强度 0.5 | 同上，直接使用官方 D3 3.0.0 实现这些力 |
| `sim.js` 的帧循环 | 60Hz；速度乘 0.6；alpha 每步按 `1 - 0.001^(1/300)` 衰减，到 0.001 停止；坐标以 Float32Array 传输 | 同上 |
| `app.js` `xQ.getSize` | 半径为 `nodeSizeMultiplier * clamp(3 * sqrt(degree + 1), 8, 30)` | `lib/graph-renderer.js` 的 Canvas 渲染 |
| `xQ.getTextStyle/render`、渲染器 `setScale` | 节点与普通标签的屏幕尺寸乘 `sqrt(scale)`；标签位于节点下方；透明度为 `clamp(log2(scale) + 1 - textFadeMultiplier, 0, 1)`；悬停强制显示标签，其他分支淡到 0.2 | 同上 |
| 渲染器 `getHighlightNode`、节点 `xQ.render` | 高亮只取拖拽或悬停节点；当 `scale < 1` 时高亮文字保持基础尺寸；点击后离开节点即恢复普通缩放 | 同上；删除了原先错误的持续点击选中状态 |
| `xQ.getDisplayText/initGraphics` 和 `lib/pixi.min.js` 的 `TextMetrics/Text` | 显示文件名并去掉 `.md`；完整字体回退链；文字缓存分辨率 2；300px 基础换行宽度，保留完整长单词；使用未取整的墨迹宽度居中，字形不压缩 | 同上；放大时按屏幕像素需求分档增加缓存分辨率 |
| 图谱渲染器 `changed/queueRender/renderCallback` 和节点/连线 `render` | 有变化时唤醒，60 个空闲帧后停止；裁剪屏幕外的节点、连线和标签；标签缓存只在文字/字体/颜色变化时更新 | 同上；同样每帧最多创建 50 个普通标签缓存；增加分辨率档位更新，等待期间保留原标签 |
| 图谱渲染器 `onWheel/updateZoom` | `deltaMode` 换算为像素；缩放因子 `1.5^(-delta/120)`；缩小时围绕视图中心，放大时围绕指针；插值在 1% 比例差异内停止 | 同上 |
| `app.js` `MJ/SJ`、`OJ` | 向心力/吸引力滑块做指数映射；排斥力为滑块值的三次方；各滑块区间与默认值保持原版 | `lib/client.js` |
| `app.js` `xJ/TJ/DJ/AJ/LJ/OJ` 和 `app.css` `.graph-controls` | 右上角距边 12px、宽 240px；收起时为 settings/wand-2；关闭与复位按钮定位；筛选、颜色组、外观、力度四个折叠区；颜色查询、色块、删除、排序和新增组 | 同上 |

原版使用 Pixi/WebGL 和可选 WASM。本适配用浏览器 Canvas 2D 绘制同样的
圆点、连线和标签，模拟器采用原版提供的 D3 回退模型；没有打包 Obsidian
的 Pixi 应用或 WASM。图谱显示 Markdown 文件关系与未创建目标，附件
筛选项禁用；“仅显示已创建的笔记”可隐藏未创建目标；新增范围选项切换
全部记忆/当前绑定项目。全部范围包含历史笔记与根 `_meta` 管理文件，
避免把召回的可见性限制误用到关系图。管理文件只输出节点与连线元数据，
仍不可通过记忆工具召回或读取。最多展示 500 个节点，优先保留有链接的
中心节点和分支。
对一次成功的记忆读取、命中笔记的搜索、写入，以及实际注入的相关记忆索引，
增加短暂的节点环与连线流光。读与注入用强调色，写入用标签色（成功语义），
搜索命中是同样强调色下的较低权重——找到一篇与打开一篇不是同一件事。
读取的来源包括 `mem_read` 与宿主的 `read`/`grep`，写入包括 `mem_write`、
`mem_log` 与宿主的 `edit`/`write`；宿主调用只有在参数点名了 vault 内某一个
`.md` 时才算触碰，`bash`/`run_code`/`glob` 有意排除（参数是命令文本、程序
文本或搜索根）。事件形状与排除理由见 `docs/p0-compatibility.md` §12。

一次写入提示的是刚刚被创建的笔记，而承载它的节点要等下一次快照（最多 15 s）才进
投影；活动事件本身在 3.6 s 后不再重放，所以「节点还没到」的提示会被暂存（同一路径
只留最新一条，上限 80 条，60 s 后过期），在节点出现的那一帧才开始计时。没有这一步，
一个回合里**新建**的笔记写多少条都不会亮。

## 侧栏调整尺寸闪烁与大节点缩放复核（2026-09-28）

重新提取本机原版后，核对了 `xQ.getSize/render`、渲染器
`setScale/updateZoom/onResize/renderCallback`。原版圆点的屏幕缩放由
`nodeScale = sqrt(1 / scale)` 与场景容器的 `scale` 相乘得到 `sqrt(scale)`；
30 的上限约束基础半径，不能用来限制缩放后的屏幕半径。本适配已使用这条
规则，本次保留公式并新增大节点回归。

闪烁来自 Canvas 2D 的适配时序：`ResizeObserver` 在动画帧回调后触发；此前
在监听回调里直接赋值 `canvas.width/height`，会清空刚画好的位图，包括值
没有变化的重复赋值。随后排队的重绘要等到下一帧，空白位图因此可能被显示。
现在监听只唤醒渲染，宽高在下一次 `draw()` 中按实际变化更新，并在同一个
回调中画出节点和连线。空闲图谱调整尺寸也会唤醒，窗口尺寸变化和像素比
变化继续由同一绘制路径处理。

验证通过 `scratch/graph-resize-fixture/server.mjs` 的隔离页面完成（排查脚本
不随包发布）。页面使用真实 `lib/client.js`、渲染器和发布 Worker；API
只提供 240 个生成节点和 239 条连线，不读取任何真实 vault。修复前后分别
加载保存的旧渲染器和当前文件，在 Codex 内置浏览器中执行 48 次连续宽度
变化，记录 Canvas 尺寸赋值以及 resize 回调后的位图状态：

| 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| resize 回调数 | 48 | 48 |
| 回调后画布被清空的次数 | 48 | 0 |
| 位图宽高赋值次数 | 96 | 48 |
| 大节点缩小后半径 / 初始半径 | 0.66703 | 0.66696 |
| 大节点放大后半径 / 初始半径 | 1.48726 | 1.48711 |

小节点在各档位的半径倍率与大节点一致，页面错误数均为 0。缩小输入为
`deltaY = 240`，随后放大输入为 `deltaY = -480`；源码公式预期相对最初
倍率为 2/3 和 1.5，误差在源码的 1% 插值停止容差内。本页面未复现“大节点
大小不变”；这个结果不解释用户原页面中的现象，也不等于原页面已验证。
两条尺寸回归在修复前失败、修复后通过；大节点回归覆盖基础半径 30，
实际缩小到约 20、放大到约 45 的绘制调用。
命令为 `node --test test/graph-renderer.test.js`，修复前 11 通过 / 2 失败，
修复后 13 通过 / 0 失败。详细数据在
`research/graph-resize-verification-2026-09-28.json`。
本次完整 `npm run check` 退出码为 0：727 项测试通过，lint、格式和类型检查
通过，`verify-pack` 与真实 tarball 校验通过（51 个条目 / 41 个 lib 模块）。
`git diff --check` 也通过。宿主返回的渲染器文件与本地修复文件 SHA-256 相同；
已有页面仍需刷新，才能加载本次修改后的 ES 模块。

## 黑屏修复与放大文字清晰度复核（2026-09-28）

用户随后报告黑屏。实际 Chrome 页面里 `graph-palette.js` 请求返回 404，
Canvas 仍为默认的 300×150 位图，未进入渲染初始化。`graph-renderer.js` 引入了
该模块，但 `registerGraphRoute()` 的默认资产清单只有渲染器和 Worker。
现在补齐 palette 路由。递归获取渲染器静态 imports 的路由回归，在修复前因
palette 404 失败，修复后通过；每个模块仍校验同源限制。

前一轮隔离页面手动提供了 palette，所以只能证明绘制行为，没有覆盖宿主
资产路由缺失。现在 fixture 的生成图 API 和当前浏览器模块都通过真实
`registerGraphRoute()` 注册的 handlers 提供。新一轮 240 个生成节点测试中，
48 次宽度变化的回调后空白数仍为 0，页面错误数为 0。原始前后数据保留在
上节的 JSON；本次路由与字体证据单独记录，避免混淆两轮测试边界。

两页都使用当前 0.85 默认值，分别加载固定分辨率 2 的旧渲染器和当前渲染器，
将图谱放大到上限 8。在 1 倍像素比的内置浏览器里，旧缓存最小像素覆盖率
为 0.7102，当前为 1.4212；覆盖率是缓存像素数除以标签显示的设备像素数，
小于 1 表示位图被拉伸。两页错误数均为 0，截图显示当前放大的中文字边缘
更清晰。这里没有把覆盖率当作对所有字体的主观清晰度评分。

命令 `node --test test/graph-client.test.js test/graph-renderer.test.js` 在修改前
为 11 通过 / 4 失败，分别暴露两处默认值与缩放、屏幕像素密度缓存问题。
加入分批替换标签保持可见的回归后，再连同路由测试共 19 项全部通过；
还覆盖 2 倍像素比下的放大、切换到 3 倍屏幕时 CSS 尺寸不变，以及悬停、
调用文字和原版平方根缩放规则。

重新加载本机 DSH web 宿主后，palette 请求返回 200，响应 SHA-256 与本地文件
一致；实际 Chrome 侧栏绘制 **495 个节点**，外观区块默认值为 **0.85**。
这里只观察用户现有页面与静态资产；自动化测试数据仍为生成图，没有把真实
vault 用作测试空间。

证据文件为 `research/graph-loading-label-verification-2026-09-28.json`。
最终 `npm run check` 退出码 0，**730 项测试通过 / 0 失败**，lint、格式、类型、
包契约和真实 tarball 校验通过（51 个条目 / 41 个 lib 模块）。

## 可复现资产与验证

- `d3-force` 是精确固定的开发依赖，插件运行时仍只有两个依赖。浏览器
  Worker 已内置 `d3-force`、`d3-quadtree`、`d3-dispatch`、`d3-timer`，不请求 CDN。
- `node scripts/build-graph-worker.mjs` 是显式维护命令。`--check` 只读比较
  已生成资产与锁定依赖/适配源码；测试运行这个检查，`prepack` 不执行构建。
- `lib/graph-worker.LICENSE` 保留四个 D3 分发包的完整 ISC 声明。
- `node --test test/graph-worker.test.js` 验证真实发布 Worker 的星形簇、
  冷却停止、固定/释放节点、删除过滤节点及力参数实际改变几何形状。
- `node --test test/graph.test.js test/graph-route.test.js test/graph-client.test.js`
  验证两种索引的关系与标签、同源路由、Worker 资产及宿主模块加载注册。
- `node --test test/graph-renderer.test.js` 通过真实 Canvas 渲染器入口验证
  文件名、字体链、自然字宽与居中、换行、缩放缓存复用、视口裁剪、空闲停止
  与交互唤醒。新增模块和资产路由测试先失败后通过；分数字宽居中的回归
  曾得到 `0.45999999999997954` 的多余偏移，修复后为原版的 `0`。

### 浏览器实测（2026-09-28）

- 已安装的 DSH web profile 在 Chrome 中显示 461 个节点，中心与分支形成
  星形簇；四个设置区与源码默认值一致。输入 `[type:decision]` 后为 109
  个节点；节点大小滑块能改变值，复位恢复 461 个节点与原值。
- `node /tmp/dsh-graph-browser-fixture.mjs` 创建临时 vault、数据目录和项目，
  在独立的本地端口加载真实客户端与发布 Worker；React 18.2.0 的 UMD
  来自 npm 官方包。fixture 不连接真实 vault 或 DSH 数据目录。
- 七条临时笔记显示后，通过真实 `registerTools` 注册的 `mem_read.execute`
  读取 `Decision.md`。服务记录活动，客户端轮询真实图谱路由，浏览器显示
  `记忆关系图谱，正在调用 1 条记忆`，截图可见节点扩散环和相连分支流光。
  3.6 秒后恢复 `可缩放的记忆关系图谱，7 个节点`。
- 该实测覆盖工具执行到浏览器动效；尚未实测真实 LLM 自主选择工具，
  或实际 agent 回合里的自动召回动效。fixture 结束后删除临时 vault。

### 字体与缩放修复的实测

修复前把 `fillText` 的第四个参数误当成换行宽度，长标签会横向压缩；
同时显示 frontmatter 标题，缺少原版字体回退链。修复后显示文件名，
采用原版文字缓存、自然字宽与换行规则，使用 `willReadFrequently: true`
的离屏 Canvas，与 Pixi 文字缓存的创建方式一致。

- `/tmp/dsh-font-reference.html` 在浏览器里直接实例化本机 Obsidian 自带的
  `PIXI.Text`，与真实 `createGraphRenderer` 生成的缓存做 RGBA 对照。
  中文长文件名与英文多词标签，各测 16、17.43693177121688、21.5 三个字号。
  六个样例的尺寸、字形、颜色和全部像素均一致，差异通道数为 `0`。
- `node /tmp/dsh-graph-performance-fixture.mjs` 使用 500 条临时笔记，
  800×760 CSS px 画布、2 倍像素比；每 25ms 输入一次滚轮，前 80 次为
  `deltaY=-12`，后 80 次为 `+12`，再记录 300ms 的收尾帧。
  单帧计时包含 JavaScript 绘制回调，不等同于 GPU 耗时或全应用帧率。
  修复还恢复了原版滚轮缩放映射，因此相同输入后的可见范围也有变化，
  这些数字不作为严格的同视野帧率倍数比较。
- 修复前平均 2.36ms、95% 分位 4.20ms，重复调用主画布 `fillText`
  56,500 次；最终版本的结果保存在
  `research/graph-ui-verification-2026-09-28.json`。空闲停绘与缓存复用
  另有自动化行为测试，缩放时绘制主画布已改用缓存图像。

上述 fixture 仅使用临时 vault；Obsidian 的 Pixi 文件仅作为本地验证参照，
未进入发布包。测试样例的逐像素一致不代表所有系统字体或所有浏览器都已测过。

### 连线与实际显示尺寸的再次核对

此前文字缓存的像素对照没有覆盖点击后持续高亮导致的显示尺寸问题。
本次按原版 `getHighlightNode` 删除了持续点击状态，并通过真实渲染入口
测试“点击、移出、缩小、放大”：缩小时文字宽度与节点半径同比变化，
放大后宽度增长，三个阶段复用同一张文字缓存。回归测试修复前失败，
修复后通过。

同时通过两个应用的开发者工具读取当前图谱数据，未在真实 vault 上运行
测试、写文件或重建索引探针。测试本身使用临时 vault。

| 当前 Markdown 图谱，含孤立文件、不含标签和附件 | 修复前 DSH | Obsidian 元数据参考 | 修复后 DSH |
| --- | ---: | ---: | ---: |
| 节点 | 461 | 478 | 478 |
| 有向连线（同一来源/目标去重） | 456 | 503 | 503 |
| 最大连通分支 | 308 | 471 | 471 |
| 次大连通分支 | 139 | 1 | 1 |
| 孤立节点 | 14 | 7 | 7 |

主要缺失来自 `_meta/registry.md` 的跨项目桥梁、10 条历史笔记，以及链接
解析差异。原版元数据还记录了行内代码里的 Markdown 目标；适配遵循这个
实际缓存结果。新的解析版本会重新提取旧缓存的链接，不要求修改笔记文件。
回归覆盖扫描与 SQLite 两种后端，包含代码/注释排除、相对路径、YAML、
转义表格别名、别名方括号、反引号文件名、重复扩展名与旧缓存迁移。

两边把连线转为 `[来源路径, 目标路径]`，逐条 JSON 编码、排序后再次 JSON
编码，计算 SHA-256；结果均为
`9c07ea0dfa6288859506da55291867f28444123e355e173b43539b0e41e2abee`。
原版运行时也确认 `showOrphans: true`、`hideUnresolved: false`、标签和附件
关闭，渲染器实际为 478 个节点。因此当前记忆库的连线集合一致。力模拟初始位置随机，坐标与布局不保证逐点
重合；这个结果也不表示附件、所有 Obsidian 搜索语法或任意 vault 已验证。

在已安装 DSH 的 Chrome 主画布中临时测量 `drawImage` 的实际文字尺寸，
随后恢复原方法。滚轮缩小 120 后显示比例为 `0.8166188179952919`（原版
目标 `sqrt(2/3)`）；接着放大 360，相对最初比例为 `1.4871329564847546`
（目标 `1.5`）。误差来自源码一致的 1% 缩放插值停止阈值。普通文字实际
变小、变大，并非仅更新了缓存。UI 勾选“仅显示已创建的笔记”后，节点
从 478 变为 474，取消后恢复 478。

最终执行 `npm run check`，退出码为 0：lint、格式与类型检查通过，
714 项测试通过、0 失败；`verify-pack` 与实际 tarball 校验通过，
归档含 50 个条目、40 个 lib 模块。`git diff --check` 也通过。
之后仅修改默认配色，执行
`node --test test/graph-renderer.test.js test/graph-client.test.js test/graph-route.test.js`，
8 项测试通过、0 失败；这次配色修改没有重新运行完整 714 项套件。
配色修改后的 lint、格式检查与 `git diff --check` 通过。Chrome 中直接读取
计算样式并记录 Canvas 的填充/描边，确认浅色节点 `#5c5c5c`、连线 `#d4d4d4`，
深色节点 `#b3b3b3`、连线 `#3f3f3f`；颜色组为 0，图谱仍显示 478 个节点。
深色核验只临时改变图谱容器的类，完成后恢复，没有修改用户的主题设置。

官方 D3 参考：[力模拟器](https://d3js.org/d3-force/simulation)、
[ISC 许可](https://github.com/d3/d3-force/blob/main/LICENSE)。
