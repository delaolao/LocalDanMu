# 培训弹幕 · 实现文档（Tauri 版 v0.3.5）

> 覆盖范围：局域网模式 + **远程模式**（Cloudflare 隧道 + 端到端加密）。
> 远程模式的完整使用说明见 `docs/remote-tunnel.md`；本文讲**实现**与**为什么这么写**。

> 对应需求：**《线下培训弹幕互动平台（自建私密版）需求方案 v1.0》**
> 上一代实现：Electron 版 `v0.1.7`（同一仓库的 `LocalDanMu/`，只读参照，不再改动）
> 面向读者：接手本项目的系统架构师、Rust / 前端工程师、运维同学

---

## 0. 怎么读这份文档

| 你的目的 | 建议阅读顺序 |
| --- | --- |
| 5 分钟了解这是什么、怎么跑起来 | §1 → §2 → §8 |
| 要改需求、加功能 | §2 → §4 → §5 → 各模块函数名 |
| 要排查线上问题 | §5 → §10 → §9 |
| 想知道"为什么从 Electron 换成 Tauri、踩了什么坑" | §0.1 → §10 |

**v0.2.0 与 v0.1.7 的关系**：功能完全对齐，技术栈更换。渲染层（4 个窗口 + 观众端 H5）
几乎零改动复用，主进程从 Node 3000 行换成 Rust 约 3000 行。

### 0.1 为什么换技术栈

旧版的功能没有任何问题，唯一的问题是**发行体积**：Electron 安装包约 110MB、
解压后约 250MB，绿色版还得解压整个文件夹（里面是完整的 Chromium 与 node_modules）。

换到 Tauri 后的实测数字（同一台机器、同一套功能）：

| 产物 | Electron v0.1.7 | Tauri v0.2.0 | 变化 |
| --- | --- | --- | --- |
| 安装包 | ~110 MB | **1.83 MB** | 约 1/60 |
| 可执行文件 | — | **5.43 MB** | — |
| 绿色版 | 整个文件夹（~250MB 解压） | **一个 zip 2.28 MB**（exe + 一个标记文件） | |
| 运行时依赖 | 自带 Chromium + Node；`koffi` 原生模块需 `asarUnpack` | 系统 WebView2；无 npm 依赖、无原生模块 | |
| 冷启动 | 1~2s | 明显更快（无 Node 引导） | 待真机细测 |
| 远程模式（v0.3+） | 无 | 隧道客户端 cloudflared **不进安装包**，首次使用按需下载到 `%LOCALAPPDATA%\localdanmu\` | 见 §5.7 |

代价只有一个：**依赖系统 WebView2 运行时**。Windows 11 自带；Win10 装过 Edge 基本都有。
这是把 110MB 换成 5MB 必须付的账。

---

## 1. 需求与约束（与旧版一致，未变）

### 1.1 四条硬约束

| 约束 | 含义 | 对实现的直接影响 |
| --- | --- | --- |
| **不遮挡** | 弹幕叠在 PPT 放映之上，且不挡讲师鼠标 | 必须有一个透明、置顶、默认鼠标穿透的全屏窗口 |
| **不安装** | 观众扫码即用，跑在微信内置浏览器里 | 观众端只能是普通 H5，**不能依赖 HTTPS / Service Worker** |
| **私密** | 消息只在本机内存，不出局域网，默认不落盘 | 无云端、无第三方统计；配置落盘最小化 |
| **仅 Windows** | 只支持 Windows 10/11 x64 | 允许直接用 Win32 API，不必做跨平台抽象 |

### 1.2 数据流一句话

```
手机(浏览器) --WS--> Rust 服务 --> 内存历史 --> IPC --> 4 个 WebView 窗口
                                        └--> 广播回所有手机（图片只给占位）
```

---

## 2. 总体架构

### 2.1 进程与窗口拓扑

与旧版最大的结构差异：**没有"主进程 = Node"这一层**。服务端、窗口、系统集成全在同一个
Rust 进程里，靠 tokio 任务和 channel 通信，不存在跨进程 IPC 序列化。

```
                     ┌───────────────────────────────────────────┐
                     │        Rust 主线程（Tauri 事件循环）        │
                     │   窗口生命周期 / 命令分发 / 托盘 / 快捷键     │
                     └───────┬───────────────┬───────────────────┘
              事件 emit      │               │  30Hz 光标轮询线程
        ┌────────────────────┼───────────────┼────────────────────┐
        │                    │               │                    │
┌───────▼──────┐  ┌──────────▼───────┐  ┌────▼────────┐  ┌────────▼──────┐
│ 控制面板      │  │ 弹幕层（透明）    │  │ 词云页       │  │ 投屏引导页     │
│ control      │  │ danmaku          │  │ cloud       │  │ join          │
│ 常驻          │  │ 全屏/穿透/置顶    │  │ 全屏/穿透    │  │ 全屏/不透明    │
└──────────────┘  └────────▲─────────┘  └─────────────┘  └───────────────┘
                           │ dm:item-full
                           │
        ┌──────────────────┴──────────────────────┐
        │   tokio 运行时：axum HTTP + WebSocket    │
        │   监听 0.0.0.0:8080（占用则 8081…）      │
        └──────────────────▲──────────────────────┘
                           │ WebSocket（同一局域网）
        ┌──────────────────┴──────────────────────┐
        │   观众端 H5（用 rust-embed 打进 exe）     │
        └─────────────────────────────────────────┘
```

要点：

- 服务端与窗口共享内存状态（`Arc<AppCore>`），**图片不经磁盘、不经网络回传**；
- 弹幕层、词云页、引导页是**互斥的全屏窗口**：词云模式下弹幕层 `hide()`；
- 观众端 H5 **编译进可执行文件**（`rust-embed`），exe 拷到哪都能直接服务。

### 2.2 一条弹幕的完整旅程

```
手机输入
  │  ① ws.send({type:'message', contentType, payload, color, clientId, msgId})
  ▼
server.rs handle_message
  │  ② validate()      结构/长度/图片 dataURL 白名单（拒绝 SVG）
  │  ③ filter.check()  5 条正则 + 58 词；block 直接回 invalid，**不占额度**
  │  ④ 三道限流        单人间隔 → 单 IP 令牌桶 → 全局令牌桶
  │  ⑤ seq += 1
  ├──⑥ ack 回手机（seq / retryAfter）
  ├──⑦ 广播 {type:'item'} 给所有观众（图片只发占位）
  └──⑧ MessageSink::on_message(out)
        │  ⑨ core.handle_incoming：历史入内存（文本 ≤300、图片 ≤20）
        ├─⑩ emit("dm:item", brief)         → 控制面板 + 词云（无图片正文）
        ├─⑪ emit_to("overlay","dm:item-full", 完整消息) → 弹幕层
        └─⑫ schedule_push() 120ms 合并 → emit("state") → 三个窗口
```

---

## 3. 目录结构

```
LocalDanMu-Tauri/
├─ src-tauri/                  Rust 侧（约 3000 行）
│  ├─ Cargo.toml               依赖与体积优化 profile
│  ├─ tauri.conf.json          产品名、版本、bundle 配置
│  ├─ capabilities/            窗口能力（只开 core:default）
│  ├─ icons/                   icon.ico + 各尺寸 png（make-icons.ps1 生成）
│  └─ src/
│     ├─ main.rs               生命周期、IPC 命令、托盘、快捷键、导出
│     ├─ core.rs               历史、会话、状态快照、与窗口的桥（AppCore）
│     ├─ server.rs             axum HTTP + WebSocket（协议/限流/校验）
│     ├─ windows.rs            四个窗口的创建与置顶守护
│     ├─ sys.rs                Win32 原生调用（零依赖手写 extern）
│     ├─ filter.rs             内容过滤（正则 + aho-corasick）
│     ├─ network.rs            网卡打分与网络位置
│     ├─ qr.rs                 二维码（qrcode + 自写 PNG 编码）
│     └─ settings.rs           设置项持久化（白名单 + 防抖 + 便携模式）
├─ src/
│  ├─ renderer/                四个窗口页面（**从旧版原样复用**）
│  │  ├─ control/              控制面板 + shim.js
│  │  ├─ danmaku/              弹幕层（Canvas + 轨道算法）
│  │  ├─ cloud/                词云 + 切词
│  │  └─ join/                 投屏引导页
│  └─ web/                     观众端 H5（内嵌进 exe）
├─ assets/                     图标母版、托盘图标
├─ scripts/
│  ├─ build-win.ps1            出安装包 + 绿色 zip
│  ├─ make-icons.ps1           图标管线
│  ├─ probe-app.ps1            端到端探针（HTTP/WS/穿透/置顶/焦点）
│  └─ setup-nsis.ps1           国内网络预置 NSIS 工具链
├─ docs/
│  ├─ architecture.md          本文档
│  └─ p1-spike-report.md       技术可行性验证记录
├─ README.md                   使用者视角：装、跑、排障
└─ LICENSE
```

---

## 4. 模块详解

### 4.1 `main.rs`：编排层

只做编排，不含业务。按职责分五块：

| 职责 | 关键项 | 说明 |
| --- | --- | --- |
| 生命周期 | `tauri::Builder::setup` | 设置目录 → 建 store/core → 建窗口 → 托盘/快捷键 → 后台起服务 |
| IPC | `invoke_handler` | 26 个命令，见 §6.3 |
| 托盘 | `create_tray` / `refresh_tray_labels` | 菜单项文字跟状态走（1 秒 tick 复核，变化才写） |
| 快捷键 | `register_shortcuts` / `run_shortcut_action` | 6 个全局快捷键 |
| 导出 | `write_csv` / `write_json` | CSV 带 BOM（否则 Excel 中文乱码） |

**两个容易忽略的设计**：

1. `refresh_tray_labels` 用 1 秒 tick 而不是事件驱动——托盘菜单只能从主线程改，
   而状态变化发生在任意线程；用"变化了才写"的 tick 最省事且不会抖动。
2. 退出时只**同步广播** `session_end` 然后 sleep 80ms，不 `await` 关服务：
   进程马上要退，await 反而可能卡在别的 runtime 上。

### 4.2 `server.rs`：会话服务

一个 `tokio::net::TcpListener` 同时服务静态页与 WS 升级，**一个端口**：
二维码里只有一个地址，防火墙也只涉及一条规则。

```
GET  /              → 「请扫码」提示页
GET  /j/<token>     → 观众端页面（口令错 → 403）
GET  /assets/*      → 内嵌静态资源
GET  /healthz       → 存活探测
WS   /ws?t=<token>  → 会话（口令错 → 401）
```

关键实现：

- **端口探测**（`port_usable` + `bind_port`）：先探测 `127.0.0.1:port` 可用再绑 `0.0.0.0`。
  为什么不能只试通配地址：Windows 上通配绑定**不会**和已存在的 `127.0.0.1:port` 冲突，
  两个进程都能 Listen 成功，但发往本机的流量会被具体的那个接走。实测在本机上就撞了一次（§10）。
- **口令校验**：`timing_safe_eq` 恒定时间比较，避免逐字符试探。
- **心跳**：20s ping，45s 没动静就关，防止手机切后台留下僵尸连接。
- **优雅关闭**：先广播 `session_end`，60ms 后触发 `with_graceful_shutdown`。
- **`MessageSink` trait**：把"服务端该产生的副作用"抽象出来，由主程序注入。
  好处是这套协议能在**不开 GUI** 的情况下完整跑集成测试（见 §9）。

### 4.3 `core.rs`：状态中枢

持有 `history`（仅内存）、`session`、`bridge`、暂停/在线/总数等原子量，并负责：

| 函数 | 作用 |
| --- | --- |
| `start_session` / `end_session` / `restart_session` | 会话生命周期 |
| `handle_incoming` | 入历史 + 推窗口（**两种载荷形状，两个事件名**，见 §10） |
| `handle_like_signal` / `maybe_replay_by_likes` | 点赞同步 + 高赞自动复现 |
| `refresh_network` / `refresh_qr` | 网卡重算与二维码刷新 |
| `build_state` | 与旧版 `buildState()` 字段一一对应的全量状态 |
| `schedule_push` | 120ms 合并刷新，避免连发消息时渲染层高频重排 |

### 4.4 `windows.rs`：窗口与置顶

弹幕层配方（P1 探针验过，别随手改）：

```rust
decorations(false) + transparent(true) + shadow(false) + always_on_top(true)
+ skip_taskbar(true) + focused(false) + visible(false)
```

创建后立刻（**在显示之前**）做三件事：

1. `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` —— 永不抢键盘焦点；
2. `apply_overlay_style(hwnd, false)` —— 带上 `LAYERED | TRANSPARENT`，点击穿透；
3. `show_no_activate(hwnd)` + `force_top(hwnd)` —— 显示但不激活、压到最上层。

之后由两个常驻线程维持：

- `spawn_style_guard`：每 350ms 复核窗口样式 + `SetWindowPos(HWND_TOPMOST)`。
  **必须周期性做**，因为 tao 会覆盖 `ex_style`（§10 坑 1）。
- `spawn_cursor_watch`：30Hz 读光标位置，把窗口相对坐标推给渲染层做命中测试。

### 4.5 `sys.rs`：Win32 原生

手写 `extern "system"` 声明，**零依赖**。7 个函数：`SetWindowPos` / `GetWindowLongPtrW` /
`SetWindowLongPtrW` / `ShowWindow` / `GetAsyncKeyState` / `GetCursorPos` / `GetForegroundWindow`。

为什么不用 `windows` crate 或 FFI 库：

1. 只需要 7 个函数，手写比引依赖轻；
2. 避开"我们的 windows crate 版本与 tauri 内部版本不一致导致 HWND 类型对不上"的坑；
3. 旧版用 `koffi` 正是因为 Electron 没有原生能力——现在这条依赖彻底消失了，
   连带 `asarUnpack` 那个打包坑一起没了。

### 4.6 `filter.rs` / `network.rs` / `qr.rs` / `settings.rs`

四者都与旧版逐条对齐，只换语言：

- **filter**：5 条正则 + 58 条通用脏话 + 自定义词表；`aho-corasick` 取最长命中。
  注意 **Rust regex 不支持 lookaround**，手机号规则从 `(?<!\d)1[3-9]\d{9}(?!\d)`
  改写成 `(?:^|[^0-9])1[3-9][0-9]{9}(?:[^0-9]|$)`（只判是否命中，边界字符被吃掉无影响）。
- **network**：仍用 UDP `connect(8.8.8.8)` 拿默认路由地址；打分表与原版同分同权重；
  公用网络检测仍走 PowerShell（`CREATE_NO_WINDOW` 避免每 15 秒跳黑框）。
- **qr**：`qrcode` 拿模块矩阵，自己按整数倍放大 + 4 模块静区，再用 `png` 编码。
  不用 `qrcode` 的 image 特性是为了避免拖进整套 `image` 编解码器。
- **settings**：同款白名单 SCHEMA、同款默认值、同款 camelCase 落盘格式——
  **旧版 `settings.json` 可以直接沿用**，讲师不用重填字号/速度/WiFi。

---

## 5. 关键机制专题

### 5.1 弹幕层为什么这么"脏"

这是整个项目最难的部分，也是换栈后**唯一必须重新验证**的部分。三个必须记住的事实：

| 事实 | 做法 |
| --- | --- |
| `WS_EX_NOACTIVATE` 会被 tao 覆盖 | 不假设"设置一次就永久有效"，350ms 复核自愈 |
| 点击穿透需要 `LAYERED \| TRANSPARENT` 同时在场 | `LAYERED` 常开，只切换 `TRANSPARENT` |
| Tauri 没有 `setIgnoreMouseEvents(forward)` | 悬停判定本来就走 Rust 轮询光标，反而更简单 |

### 5.2 置顶与穿透的样式位

| 状态 | `WS_EX_*` | 含义 |
| --- | --- | --- |
| 穿透（默认） | `NOACTIVATE \| TOOLWINDOW \| TOPMOST \| LAYERED \| TRANSPARENT` = `0x080c01b8` | 点击落到下层应用 |
| 接管（悬停图片/大图） | `0x080c0198`（去掉 `TRANSPARENT`） | 点击进我们的窗口 |

这两个值在探针里有断言，改动窗口配方时探针会立刻报错。

### 5.3 两条点击路径（旧版遗产，已简化）

旧版因为 Chromium 在"穿透 ↔ 接管"反复切换后不再派发 `click`，做了两条路径：
DOM `click` + 主进程 `GetAsyncKeyState` 轮询兜底。

Tauri 版里**只保留轮询这条**，它从"兜底"变成了"主路径"：

```
30Hz: GetCursorPos → 换算成窗口相对坐标 → emit("dm:cursor")
      GetAsyncKeyState(VK_LBUTTON) 边沿 → emit("dm:click")
渲染层: imageAt(x, y, 16) 命中 → invoke("dm_hover", true/false)
       主进程: apply_overlay_style(hwnd, 命中)
```

好处是不再依赖 Chromium 的事件派发行为，跨 WebView2 版本更稳。

### 5.4 事件路由：为什么用两个事件名

`dm:item`（精简副本，无图片正文）+ `dm:item-full`（完整消息，含图片正文）。

**不能**都叫 `dm:item` 再靠 `emit_to(label, ...)` 区分：实测 Tauri 的 `emit_to` 在这里会把
事件发给所有 webview，于是控制面板同时收到完整版和精简版——表现为"一条消息在最近弹幕里
出现三次、其中一条空白"（§10 坑 4）。

### 5.5 三道限流与幂等

| 级别 | 参数 | 目的 |
| --- | --- | --- |
| 单人 | 两次发送间隔 ≥ `intervalSec`（默认 5s） | 防一个人刷屏 |
| 单 IP | 令牌桶 0.8 条/秒，突发 8 | 防一台设备开多标签 |
| 全局 | 令牌桶 4 条/秒，突发 12 | 防全场同时爆发打爆大屏 |

顺序：**过滤 → 单人 → 单 IP → 全局**。被过滤的消息**不占任何额度**
（现场误伤后学员换个说法不该再等 5 秒）。幂等：`msgId` 在连接内缓存 40 个，
重连重发返回 `duplicate: true`，不重复上屏。

### 5.6 隐私与落盘

| 数据 | 存放位置 | 生命周期 |
| --- | --- | --- |
| 观众消息 | 进程内存 `history` | 结束培训即释放 |
| 图片 | 内存中的 dataURL（≤20 张） | 同上 |
| 设置项 | `%APPDATA%\local-danmu\settings.json`（便携模式在 exe 旁） | 持久 |
| WebView2 数据 | 系统默认位置（Tauri 未重定向） | — |

**没有任何外发请求**（除用户主动点的"打开网络设置""打开仓库"）。
诊断开关全部走环境变量，**默认关闭**，release 产物不带这些行为：

| 变量 | 作用 |
| --- | --- |
| `LDM_PROBE=1` | 把房间口令等信息写到 `%TEMP%\localdanmu-debug\`，供自动化探针读取 |
| `LDM_BIND=127.0.0.1` | 只监听回环。自动化测试必须用：非回环监听会触发 Windows 防火墙对话框，那个对话框会变暗桌面并独占输入（见 §10 坑 5） |
| `LDM_TOKEN=xxx` | 固定房间口令（仅 debug 构建生效），省得每次找 token |
| `LDM_TUNNEL=1` | 开机自动开一次隧道，用于不依赖 GUI 点击验证远程链路 |

---

### 5.7 远程模式：隧道 + 端到端加密 + cloudflared 获取

场地 WiFi 不可靠时，用一条 Cloudflare 隧道把本机会话服务暴露到公网，让学员用手机流量进来。
设计上有三个必须守住的点：**不扩大体积、不暴露明文、不留下孤儿进程**。

#### 5.7.1 为什么不内置 cloudflared

cloudflared 单个 exe 约 **53MB**，内置会让 5.5MB 的安装包直接膨胀十倍，违背换栈的初衷。
所以按需获取：`%LOCALAPPDATA%\localdanmu\cloudflared.exe`，一次下载长期缓存。

获取顺序（`tunnel.rs::ensure_binary`）：

```
① 设置里的 cloudflaredPath（用户手动指定的）
② 「下载 / 桌面 / exe 同级目录」里现成的 cloudflared*.exe（校验通过就复制进来，不搬走原文件）
③ 缓存文件（必须校验通过）
④ 依次尝试 4 个下载源：ghfast.top → gh-proxy.com → moeyy → GitHub 直连
```

第 ② 步是针对真实反馈加的：**自动下载失败时，人的第一反应就是用浏览器手动下载到「下载」文件夹**。
旧逻辑完全无视那个文件，非要自己再下一遍，于是用户只能手动改名、手动搬到缓存目录。现在不需要了。

#### 5.7.2 下载器必须做到的四件事

这四条都是踩出来的（见 §10 坑 17~22）：

| 要求 | 做法 |
| --- | --- |
| **多源回退** | 直连 GitHub release 在很多网络下超时；代理源排前面 |
| **真实进度** | 每 600ms 读 `.part` 体积，报`已下载 X / 约 53MB（P%）· 速度 · 来源` |
| **校验产物** | PE 头必须是 `MZ` 且 ≥10MB；无效缓存改名 `.bad` 留证，而不是一直当它好使 |
| **能停下** | 45 秒无新数据就换源（`curl --speed-limit` 在"连上但零字节"时不可靠）；curl 进 Job Object 防孤儿 |

#### 5.7.3 端到端加密

密钥一次性生成在 `crypto.rs`，只存在于 **URL 的 fragment**（`#k=…`）里：

```
https://xxx.trycloudflare.com/j/abcd2345#k=<base64url 密钥>
```

`#` 之后的内容**浏览器不会发给服务器**，所以 Cloudflare 只看到"有人在发消息"，看不到密钥，也解不开内容。
消息体用 AES-256-GCM；服务端对 `enc=1` 的连接要求必须密文，明文会被 `bad_enc` 拒绝。

#### 5.7.4 进程生命周期（防孤儿）

cloudflared 与下载用的 curl **都**放进同一个 Windows Job Object
（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）：应用无论正常退出、崩溃还是被任务管理器强杀，
系统都会连带收掉整棵子进程树。没有这一层，cloudflared 会留在后台占着端口，curl 会继续往 `.part` 写。

#### 5.7.5 隧道生命周期

```
start → 取 cloudflared → 生成密钥 → spawn cloudflared → 读 stderr 找公网地址 → running
   ↑                                                              │
   └──── schedule_restart（自动续连，可关） ←──── 进程异常退出 ←──┘
stop  → kill 子进程 + 清密钥 + 关 Job Object
```

`--no-autoupdate --loglevel info` 是必须的：前者防止 cloudflared 自我更新时把进程换掉，
后者保证能从 stderr 稳定解析出地址。

## 6. 契约速查

### 6.1 WebSocket（服务端 → 客户端）

| `type` | 何时 | 主要字段 |
| --- | --- | --- |
| `hello` | 连接建立 | `proto`、`intervalSec`、`paused`、`recent[]`、`signals`、`serverTs` |
| `ack` | 收到一条 message | `msgId`、`status`（ok/invalid/rate_limited）、`seq`、`retryAfter`、`reason`、`duplicate` |
| `item` | 有消息通过校验 | `seq`、`kind`、`text`、`color`、`clientId`、`ts` |
| `config` | 讲师改设置 | `intervalSec` |
| `paused` | 暂停/恢复 | `paused` |
| `session_end` | 结束培训 | `reason` |
| `like` / `like-reject` | 点赞 | `seq`、`likes` / `reason`（gone/own/duplicate/too_fast/too_many/busy） |
| `react` / `react-reject` | 快捷反应 | `kind`、`signals` / `reason` |

### 6.2 WebSocket（客户端 → 服务端）

| `type` | 字段 |
| --- | --- |
| `message` | `msgId`、`contentType`（text/image）、`payload`、`color`、`clientId`、`ts` |
| `like` | `seq`、`clientId` |
| `react` | `kind`（agree/confused/slow） |

### 6.3 IPC 命令（渲染层 → Rust）

| 命令 | 作用 |
| --- | --- |
| `state_get` | 全量状态（URL、二维码、在线数、模式、显示器…） |
| `session_toggle_pause` / `session_clear` / `session_end` / `session_restart` | 会话控制 |
| `session_replay` | 重播某条历史 |
| `history_get` | 取历史（已去图片正文） |
| `app_set_config` / `app_set_display` / `app_set_nic` | 改设置 / 投屏显示器 / 首选网卡 |
| `app_toggle_overlay` / `app_toggle_join` / `app_set_mode` | 显隐弹幕层 / 引导页 / 切词云 |
| `app_copy_link` / `app_export` / `app_import_words` | 复制链接 / 导出 / 导入词表 |
| `app_open_repo` / `app_open_network_settings` / `app_refresh_network` | 打开仓库 / 网络设置 / 刷新网卡 |
| `app_hide_panel` / `app_minimize` / `app_quit` / `join_close` | 窗口控制 |
| `dm_hover` / `dm_modal` / `dm_ready` | 接管鼠标 / 大图模式 / 渲染就绪 |
| `tunnel_start` / `tunnel_stop` / `tunnel_state` / `tunnel_set_auto` | 远程模式开关、查询、自动续连 |
| `app_pick_cloudflared` | 手动指定 cloudflared.exe（自动下载失败时的逃生口，选完先校验再存） |

**事件（Rust → 渲染层）**：`state`、`dm:item`、`dm:item-full`、`dm:cmd`、`dm:like`、
`dm:cursor`、`dm:click`。

> 渲染层看到的接口仍是旧版的 `window.api` / `window.dm` / `window.cloud` / `window.join`，
> 由 `src/renderer/*/shim.js` 把 `invoke`/`listen` 包装成同样的形状。**页面代码一行没改。**

**写新命令时的一条硬规则**：命令默认是**同步**的，同步命令在**主线程**执行。
只要它会创建窗口（`WebviewWindowBuilder::build`）或搬动窗口，就必须写成 `async fn`，
否则请求要投递给主线程、主线程又卡在命令里等它 —— 自我死锁，整个应用冻住。
见 §10 坑 12。

### 6.4 设置项

| 键 | 类型/范围 | 默认 | 说明 |
| --- | --- | --- | --- |
| `intervalSec` | 1–60 | 5 | 每人发送间隔 |
| `fontPx` | 20–72 | 38 | 弹幕字号 |
| `speed` | 4–30 | 8 | 每秒屏宽百分比 |
| `area` | full/top/middle/bottom | full | 弹幕可用区域 |
| `opacity` | 30–100 | 100 | 弹幕不透明度 |
| `displayId` | any | null | 投屏显示器（用显示器名标识） |
| `preferredIp` | any | null | 首选网卡地址 |
| `theme` | system/dark/light | system | 界面主题 |
| `wifiSsid` / `wifiPassword` | string | '' | 现场 WiFi（显示在引导页） |
| `mode` | scroll/cloud | scroll | 投影模式 |
| `filterLevel` | off/mark/block | block | 过滤强度 |
| `autoReplay` | bool | true | 高赞是否自动重新上屏 |
| `customWords` | string ≤6000 | '' | 自定义词表 |
| `tunnelToken` | string ≤4096 | '' | 固定隧道令牌；留空则用临时隧道 |
| `tunnelHost` | string ≤128 | '' | 固定域名（如 dm.example.com） |
| `cloudflaredPath` | string ≤260 | '' | 手动指定的 cloudflared.exe；空 = 自动获取 |

---

## 7. 启动时序

```
main()
 ├─ 注册插件（single-instance 必须最先）与 26 个命令
 ├─ setup():
 │   ├─ 1. settings::resolve_data_dir()   便携模式判定
 │   ├─ 2. Store::open(settings.json)     读配置（旧版文件可直接用）
 │   ├─ 3. create_control()               讲师先看到面板
 │   ├─ 4. create_overlay()               弹幕层（先钉样式再显示）
 │   ├─ 5. spawn_cursor_watch / spawn_style_guard
 │   ├─ 6. create_tray / register_shortcuts / 托盘 tick
 │   └─ 7. 后台任务：
 │         start_session()
 │           ├─ pickPort(8080…)  先探 127.0.0.1 再绑 0.0.0.0
 │           ├─ random_token(8)  房间口令
 │           ├─ network::pick()  选网卡
 │           ├─ Bridge::start()  起 HTTP + WS
 │           └─ refresh_qr()     生成 data URL
 │         refresh_network()     网络位置探测（慢，放后台）
 │         每 15 秒重算地址（IP 变了二维码跟着变）
 └─ run(): ExitRequested → 同步广播 session_end
```

---

## 8. 开发与构建

```powershell
# 首次：装 Rust（国内建议走 rsproxy 镜像，见 README）+ 预置 NSIS（scripts\setup-nsis.ps1）
cargo install tauri-cli --locked

# 开发运行
cd src-tauri; cargo run

# 打包（安装包 + 绿色 zip，产物在 dist\）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-win.ps1

# 单元 + 协议集成测试（52 个）
cd src-tauri; cargo test

# 端到端探针（HTTP/WS/穿透/置顶/焦点），对 release 也能跑
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\probe-app.ps1 -Exe "src-tauri\target\release\localdanmu.exe"
```

> **零构建链**：前端没有任何打包步骤。`src/renderer` 与 `src/web` 都是原样 HTML/CSS/JS，
> Tauri 编译时直接内嵌。改一行 CSS 重新 `cargo run` 即可，没有 npm、没有 bundler。

---

## 9. 测试与验证

| 层次 | 手段 | 覆盖 |
| --- | --- | --- |
| 单元测试 | `cargo test`（settings/filter/network/qr/core） | 白名单校验、旧配置兼容、过滤 13 例、网卡打分、二维码 PNG、历史裁剪 |
| 协议集成测试 | `server.rs` 内 11 个 `#[tokio::test]` | 起真监听、真 WS 客户端：hello/ack/item、幂等、过滤不占额度、单人间隔、点赞、快捷反应、广播、最近历史、401/403 |
| 端到端探针 | `scripts\probe-app.ps1` | 真进程：HTTP 服务、口令门、内嵌资源、WS 协议、弹幕层透明/置顶/穿透/不抢焦点 |
| 真实层叠验证 | 探针内置"品红全屏置顶已激活窗口" | 模拟 PPT 放映，验证弹幕层仍在其上 |
| 远程链路 | `tools/probe-e2e.js` / `probe-tunnel.js` / `probe-lan.js` | 隧道可达性、端到端加密握手、局域网对照 |
| 交互诊断 | `scripts/diag-*.js`（CDP） | 直接问运行中的页面：IPC 是否可用、事件计数、坐标单位、对话框是否卡死 |

**两套工具的分工，别重复造轮子**：

| 工具 | 位置 | 管什么 | 依赖 |
| --- | --- | --- | --- |
| 端到端探针 | `scripts/probe-app.ps1`、`probe-features.ps1` | **本机几何与系统行为**：透明 / 置顶 / 点击穿透 / 不抢焦点 / 快捷键 / 窗口出现 | 真实进程 + Win32 + 屏幕取色 |
| 远程链路探针 | `tools/*.js` | **网络链路**：隧道可达、加密握手、局域网对照 | 需要真实隧道地址与房间号 |
| CDP 诊断 | `scripts/diag-*.js`、`tools/cdp.js` | **页面内部状态**：逐条调用 IPC 看原始报错、数事件、量坐标 | 需 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` |
| 离线自检 | `tools/ipv6-check/` | 现场 IPv6 入站是否可用（独立小工具，不参与主构建） | 无 |

**经验**：涉及"鼠标能不能点到""能不能压住 PPT"的，必须用真实输入与真实窗口验证。
探针里那套 `mouse_event` + `GetForegroundWindow` + `GetWindow(GW_HWNDNEXT)` 就是为此存在，
它们抓到过两个真实缺陷（§10 坑 3、坑 4）。

---

## 10. 踩坑记录（本代新增，都是实测）

| # | 现象 | 根因 | 处理 |
| --- | --- | --- | --- |
| 1 | 设了不抢焦点，点一下图片还是把前台焦点抢走 | tao 在 WebView2 初始化完成时把创建时缓存的 `ex_style` 整体写回，追加的 `WS_EX_NOACTIVATE` 被抹掉（实测 `0x08040198 → 0x000c0138`） | `apply_overlay_style` 作为唯一真相来源，350ms 复核自愈 |
| 2 | 只切 `WS_EX_TRANSPARENT` 后点击不再穿透 | 点击穿透需要 `LAYERED \| TRANSPARENT` 同时在场；改由自己管样式后 `LAYERED` 被清掉 | `LAYERED` 常开，只切 `TRANSPARENT` |
| 3 | 二维码能扫，但本机 `127.0.0.1:8080` 打不开 | Windows 上 `0.0.0.0:8080` 与别人已占用的 `127.0.0.1:8080` **可以同时 Listen**，本机流量被具体的那个接走 | 端口探测先试 `127.0.0.1:port`，可用再绑通配地址 |
| 4 | 一条消息在"最近弹幕"里出现三次、其中一条空白 | `emit_to(label, ...)` 实测会发给所有 webview，而完整消息与精简副本字段形状不同 | 拆成 `dm:item` 与 `dm:item-full` 两个事件名 |
| 5 | release 版探针"透明/穿透"假失败 | 程序在非回环地址监听触发 Windows 防火墙对话框，**整个桌面被变暗且输入被独占** | 探针用 `LDM_BIND=127.0.0.1`；真实用户首次运行需在防火墙弹窗点"允许" |
| 6 | `cargo tauri build` 卡在下载 NSIS | GitHub 直连超时 | `scripts\setup-nsis.ps1` 预置 NSIS 3.13 + `nsis_tauri_utils.dll v0.5.3`（bundler 靠这个 dll 判断本地工具链可用，缺了会删目录重下） |
| 7 | `.ps1` 里的中文变乱码甚至语法错误 | Windows PowerShell 5.1 按 ANSI 解析 `.ps1` | 所有脚本**只写 ASCII**；中文只放 README/docs |
| 8 | 探针结果 JSON 膨胀到 30MB+ | 这一版 PowerShell 的 `Get-Content -Tail` 返回带 `PSPath`/`PSDrive` 的对象而非字符串 | 改用 `[System.IO.File]::ReadAllText` |
| 9 | 探针 HTTP 全 404、WS 连不上 | .NET 的 `HttpWebRequest` / `ClientWebSocket` 默认走系统代理 | 显式 `$req.Proxy = $null` |
| 10 | 6 个全局快捷键都注册成功，但按下去什么都不发生 | `Shortcut::to_string()` 产出 `control+alt+KeyK`，动作分派里取最后一段得到 `"keyk"`，与 `"k"` 永远匹配不上 | 先剥掉 `key` 前缀再比较；探针日志里加了 `shortcut fired: name=… key=…` 便于定位 |
| 11 | 命令行为什么"能跑但没输出" | PowerShell 里 `native command` 往 stderr 写进度，`$LASTEXITCODE` 常为 1，看起来像失败 | 判断成功看产物而不是退出码；或用 `cmd /c "… 2>&1"` 包一层 |
| 12 | **点「投屏引导页」之后整个 app 冻住：按钮全失灵、下拉框自动收起、点复制没反应、退出也退不掉** | `app_toggle_join` 当时写成了**同步命令**。同步命令跑在主线程上，而 `WebviewWindowBuilder::build()` 要把创建请求投递给主线程再等它完成——主线程正卡在命令里，于是自我死锁。CDP 实测 `Runtime.evaluate` 20 秒超时，坐实了这一点 | **凡是会创建窗口的命令必须 `async`**（`app_toggle_join` / `app_toggle_overlay`）。教训：六个表面上互不相关的症状，其实是同一个死锁的连带 |
| 13 | 切到词云时**滚动弹幕层迟迟不消失**，两层同时可见 2 秒 | 弹幕层当初用裸 `ShowWindow(SW_SHOWNOACTIVATE)` 显示，导致 tao 内部的"可见性"状态与真实状态不一致，之后 `win.hide()` 变成空操作（`toggleOverlay` 返回 `overlayVisible:false`，窗口却还在） | 显示/隐藏一律走 Tauri 的 `win.show()` / `win.hide()`；不抢焦点交给 `WS_EX_NOACTIVATE` 保证（探针的 never-steals-focus 断言守着）。`apply_mode` 固定"先藏弹幕层再建词云"的顺序 |
| 14 | 「设置与网络」下**所有下拉框点开就收回** | 置顶守护每 350ms 对控制面板 `SetWindowPos(HWND_TOPMOST)` 重排 z 序；Chromium 的原生 `<select>` 弹出列表属于该窗口，属主一被重排就立刻关闭。焦点没被抢（实测 5s 内前台只变 1 次） | 守护加判断：**控制面板已是前台窗口时不要动它**，只有被别的置顶窗口盖住时才抢回来 |
| 15 | **图片弹幕鼠标滑过毫无反应**（悬停不暂停、点不开大图） | `GetCursorPos()` 与 `outer_position()` 都是**物理像素**，而 canvas/弹幕条是 **CSS 像素**；本机 150% 缩放 → 坐标整体偏 1.5 倍，命中测试永远打不中。旧版 Electron 里 `getCursorScreenPoint()` 与 `getBounds()` 都是 DIP，天然一致，所以当年没暴露 | 推送前除以 `scale_factor()`。实测：物理 (600,450) → CSS (400,300) |
| 16 | 想给 WebView2 传 Chromium 开关关掉渲染节流，结果**启动即崩** |'@ '坑16 占位'
Apply '| 放弃该方案，改用坑 13 的显示/隐藏修正来保证切换不迟钝，不再传自定义 args |' @'
| 放弃该方案，改用坑 13 的显示/隐藏修正来保证切换不迟钝，不再传自定义 args |
| 17 | 首次开远程模式，**下载 cloudflared 屡次失败且界面毫无反馈** | 只有单一源（GitHub releases 直连），且用 `curl .status()` 静默等待 53MB | 4 源顺序回退 + 边下边报进度（已下载量 / 百分比 / 速度 / 来源 / 已等待秒数） |
| 18 | 下载"成功"了，但启动云隧道报一个看不懂的 spawn 错误，重试多少次都一样 | **只看文件在不在，从不校验内容**。一次失败会留下半截文件或被代理改写成 HTML 的"exe"，而 `is_file()` 把它当成好文件一直用下去 | 校验 PE 头 `MZ` + 体积下限；无效缓存改名 `.bad` 留证后重新获取 |
| 19 | 目录里躺着一个完整 52.82MB 的 `cloudflared.part`，但 exe 始终没出现 | Windows 上 `rename` 到**已存在**的目标会直接失败；杀软短暂占用句柄也会失败 | `install_binary`：先删目标 → `rename` → 失败退化为 `copy` + 删源 |
| 20 | 进度跑到 99% 后报 `保存失败：系统找不到指定的文件 (os error 2)` | 给每次尝试加了唯一 `.part` 名，但安装时用的仍是旧的固定名，两者不是同一个文件 | `download_one` 返回**实际写入的路径**，安装用它而不是调用方猜的路径 |
| 21 | 强杀应用后，一个 **孤儿 curl** 一直在往 `.part` 写，下次启动删不掉、内容还被写花 | cloudflared 早就进了 Job Object，但**下载用的 curl 没有** | curl 同样纳入 Job Object；每次尝试用独立 `.part` 名；过期分片自动清理 |
| 22 | 某个代理源**连上后一个字节都不来**，`--speed-limit` 也没能中止，白等 200+ 秒 | curl 的低速中止在"连接建立但零字节"场景下不可靠 | 自己按秒盯进度：45 秒无新数据就 kill 并换下一个源 | `background_throttling()` 文档写明 Windows 不支持；改用 `additional_browser_args()` 后，即使传 wry 自己的默认串也 `failed to create webview: WebView2 error HRESULT(0x8007139F)` | 放弃该方案，改用坑 13 的显示/隐藏修正来保证切换不迟钝，不再传自定义 args |

其它已知限制（沿用旧版）：

- 词云不做同义词合并（"难"与"太难"算两个词）。
- 过滤不内置政治敏感词，需要更大词表请自行导入。
- 图片悬停时那一小块区域点不到下层 PPT。
- 投屏引导页会公开 WiFi 密码（设计如此）。
- 观众端现场流里的图片只有占位，没有缩略图。
- 传输是明文 HTTP/WS，仅限可信局域网。

---

## 11. 与 Electron 版的差异对照

| 关注点 | v0.1.7（Electron） | v0.2.0（Tauri） |
| --- | --- | --- |
| 主进程语言 | Node（`main.js` ~2000 行） | Rust（约 3000 行，含测试） |
| 窗口 | `BrowserWindow` × 4 | `WebviewWindow` × 4（每个一个 WebView2） |
| 窗口通信 | preload + `contextBridge` + `ipcMain`/`ipcRenderer` | `shim.js` + `invoke` + `emit`/`listen` |
| 原生调用 | koffi（FFI 库，需 `asarUnpack`） | 手写 `extern "system"`，零依赖 |
| HTTP/WS | `node:http` + `ws` | axum + tokio（同一 listener） |
| 观众端资源 | `src/web` 散文件，打包进 asar | `rust-embed` 编进 exe |
| 二维码 | npm `qrcode` | `qrcode` crate + 自写 PNG（省掉 `image`） |
| 托盘/快捷键/单实例 | Electron 内置 | Tauri 内置 + 官方插件 |
| 渲染层 | — | **原样复用**（仅新增 shim.js、改 drm 区属性与 CSP） |
| 体积 | ~110MB 安装包 | **1.83MB 安装包 / 5.43MB exe** |

渲染层唯一的三处必要改动：

1. 每个 `index.html` 加一行 `<script src="shim.js"></script>`；
2. `meta CSP` 补 `connect-src 'self' ipc: http://ipc.localhost`；
3. 控制面板标题栏加 `data-tauri-drag-region`（Tauri 不认 `-webkit-app-region`）。

---

*文档随代码演进；改动窗口配方、事件名、协议字段时请同步更新本文档。*
