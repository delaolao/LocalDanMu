# 培训弹幕 v0.5.6（本地版 · Tauri）

线下培训用的弹幕系统：讲师在自己电脑上开一个窗口，观众扫码进入网页发文字/图片，内容实时飘在 PPT 上方；需要看整体意见分布时，一键切到「词云」大屏。

- **不遮挡**：弹幕层透明、置顶、鼠标点击穿透，讲师照常操作 PPT。
- **不安装**：观众零安装、零注册，手机扫码即用（纯 H5）。
- **私密**：所有消息只在讲师电脑内存里，默认不落盘；默认不经过任何第三方服务器。
  需要时开启「远程模式」，内容端到端加密，中继只看得到"有人在发消息"，看不到内容。
- **不怕网络差**：场地 WiFi 靠不住时，开启远程模式，学员用手机流量也能进（见下文「现场排障 · 9」）。
- **两种看法**：滚动弹幕看单条，词云看比例；错过的可以回看、可以重播。
- **有护栏**：手机号/广告/脏话默认拦截，可自定义词表或导入。
- **可分发给别人**：每个讲师一条独立固定隧道（各自域名、各自令牌），互不影响；
  详见 [第三点五节](#三点五给别人用多讲师开通tenant)。

只支持 Windows 10/11 x64。

> **v0.2.0 是技术栈更换版**：功能与 v0.1.7 完全一致，主进程从 Electron 换成了 Tauri（Rust）。
> 换栈的唯一动机是体积——安装包从约 110MB 降到 **1.8MB**，可执行文件 **5.4MB**，
> 绿色版就是一个 zip（解压即用）。
>
> **v0.3.0 新增「远程模式」**：场地网络不可靠时，一条 Cloudflare 隧道让学员用手机流量进入；
> 消息端到端加密，讲师侧不改任何流程。体积几乎没变（exe +0.09MB）。详见
> **[docs/remote-tunnel.md](docs/remote-tunnel.md)**。
>
> 想了解代码结构、模块关系和各处"为什么这么写"，看 **[docs/architecture.md](docs/architecture.md)**；
> 技术可行性验证记录在 **[docs/p1-spike-report.md](docs/p1-spike-report.md)**。

---

## 一、快速开始

### 1. 讲师直接用（推荐）

**绿色版**：把 `LocalDanMu-0.5.6-green.zip` 解压到任意文件夹，双击 `LocalDanMu.exe`。
不写注册表、不装服务、不需要管理员权限；设置存在 exe 旁边，换电脑把整个文件夹拷走即可。

**安装版**：双击 `LocalDanMu-Setup-0.5.6.exe`，装到当前用户目录，开始菜单有快捷方式。

> 两种形态功能完全一样，只是配置存放位置不同（见下）。
> 未做代码签名，首次运行 Windows SmartScreen 可能提示"未知发布者"，点「更多信息 → 仍要运行」。

**首次运行会弹 Windows 防火墙询问**（程序需要被手机访问），**必须勾选"专用网络"并允许**。
如果误点了取消：控制面板 → 设置与网络 → 「打开网络设置」→ 允许应用通过防火墙 → 找到本程序勾上。

> 绿色版如果只有 `LocalDanMu.exe`（没有 `portable.txt`），配置会存到 `%APPDATA%\local-danmu`。
> 想让配置跟着 U 盘走，就在 exe 旁边放一个空的 `portable.txt`。

### 2. 从源码构建

前置：Rust（stable, MSVC）+ VS 2022 C++ 生成工具 + Windows SDK。

```powershell
# 1) Rust 工具链（国内走镜像，几十秒）
#    下载 https://rsproxy.cn/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe
$env:RUSTUP_DIST_SERVER='https://rsproxy.cn'
$env:RUSTUP_UPDATE_ROOT='https://rsproxy.cn/rustup'
.\rustup-init.exe -y --default-toolchain stable-x86_64-pc-windows-msvc --profile minimal

# 2) crates.io 镜像（否则拉 tauri 依赖会非常慢）
#    ~/.cargo/config.toml 写入：
#      [source.crates-io]
#      replace-with = 'rsproxy-sparse'
#      [source.rsproxy-sparse]
#      registry = "sparse+https://rsproxy.cn/index/"

# 3) Tauri CLI 与 NSIS 打包工具链（只需一次）
cargo install tauri-cli --locked
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-nsis.ps1

# 4) 开发运行
cd src-tauri; cargo run

# 5) 打包（产物在 dist\）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-win.ps1
```

> **前端零构建**：没有 npm、没有 bundler。`src/renderer` 与 `src/web` 都是原样
> HTML/CSS/JS，编译时直接内嵌进 exe。改完 CSS 重新 `cargo run` 就行。

---

## 二、现场使用流程

1. 打开程序，主面板会显示二维码和链接（`http://192.168.x.x:18080/j/<房间号>`）。
2. 在「设置与网络」里填上现场 WiFi 的名称和密码（只需要填一次，之后会记住）。
3. 开场点「投屏引导页」（或 `Ctrl+Alt+J`）：投影上会出现一个大二维码 + 链接 + WiFi 名称和密码的页面。
4. 弹幕会出现在**选中的显示器**上，压在 PPT 之上，鼠标可以正常点 PPT。
5. **点一下弹幕里的图片**：指针停在图片上会让滚动暂停，点一下居中放大；再点任意位置关闭。
6. **需要看整体意见时**切到「词云弹幕」（面板按钮或 `Ctrl+Alt+K`）。
7. 控制面板的「最近弹幕」保留最近 200 条，点每行右边的 `↻` 可以把这条重新推上屏。
8. 讲完点「结束培训」：断开所有手机连接，清空内存里的消息，然后可以「开始新一场」。

### 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+Alt+空格` | 暂停 / 恢复弹幕（暂停时新消息会攒着） |
| `Ctrl+Alt+X` | 清屏（不删数据） |
| `Ctrl+Alt+J` | 打开 / 关闭投屏引导页（二维码 + WiFi） |
| `Ctrl+Alt+K` | 在「滚动弹幕 / 词云」之间切换 |
| `Ctrl+Alt+G` | 关闭图片大图，恢复滚动（兜底） |
| `Ctrl+Alt+M` | 显示 / 隐藏控制面板 |

弹幕层是点击穿透的，点不到；托盘图标和控制面板都藏起来时，用快捷键找回来。

---

## 三、现场排障（重要）

这类系统在现场 90% 的问题都是网络，程序本身没问题。按顺序检查：

### 1. 手机和电脑是不是同一个 WiFi？

不是同一个网段一定连不上。电脑开了 VPN / 分身网卡时，注意选对网卡。

### 2. 是不是选错了网卡？

装了 Hyper-V、WSL、VMware、Tailscale、VPN 的机器可能有 5、6 个网卡。
**症状**：二维码里的 IP 是 `192.168.50.1`、`172.x`、`100.64.x.x` 之类，手机打不开。
**处理**：控制面板 → 设置与网络 → 「网卡」下拉，换成 `Wi-Fi` 或 `以太网` 那个。

### 3. Windows 网络是不是「公用」？

公用网络下 Windows 防火墙默认拦截入站连接，手机就会一直"打不开"。
**处理**：设置 → 网络和 Internet → 属性 → 网络配置文件改为「专用」。程序检测到公用网络会显示黄色提示。

### 4. 首次运行时防火墙弹窗被点了取消

控制面板 → 设置与网络 → 「打开网络设置」→ 防火墙 → 允许应用通过防火墙 → 找到 `LocalDanMu` 勾上。

### 5. 场地 WiFi 开了「设备隔离」

酒店、会议中心的访客 WiFi 经常开启 AP isolation，同一 WiFi 下的设备互相看不见。
**处理**：用电脑开移动热点（设置 → 网络和 Internet → 移动热点），让手机连电脑的热点，再点「重新检测」。

### 6. 微信里打不开 / 发不出去

微信内置浏览器一般没问题，首次打开可能提示"非官方网页"，点继续访问即可。一直白屏就改用手机自带浏览器扫码。

### 7. 手机提示"WiFi 无法上网"

电脑没连外网时，手机系统会认为这个 WiFi 有问题。选择"保持连接"/"继续使用此 WiFi"，**不要让它切到移动数据**。

### 8. 端口被占用

服务端口**固定 18080**，没有手动改的选项——因为隧道入口在 Cloudflare 侧是常量，
本机端口一旦变化，二维码、投屏材料、隧道入口就会全部对不上。

18080 被占用时：

1. 如果是**本程序**上一次没退干净（任务管理器里还有 LocalDanMu），程序会自动结束它再重试；
2. 如果是**别的程序**占着，程序不会擅自杀别人，而是提示占用者名字和 PID，让你处理完再点「重新检测」。

> 为什么选 18080：Windows 的保留端口区间经常覆盖 7000–9000（`netsh int ipv4 show excludedportrange protocol=tcp` 可查），18080 基本不受影响。

### 9. 场地网络实在不行：开启「远程模式」

如果 WiFi 挤爆、被隔离、或者压根连不上，不必换场地——开远程模式，让学员用手机流量进来。

**操作**：控制面板 → 「远程模式」→ **开启** → 第一次会下载 cloudflared（约 53MB，仅一次）→
等状态变成「隧道已就绪」→ 学员扫**下面那个二维码**。

投屏引导页会自动变成**两个二维码并排**：左边局域网、右边手机流量。

**代价**（实测，见 [docs/remote-tunnel.md](docs/remote-tunnel.md)）：

| 项 | 局域网 | 远程模式 |
| --- | --- | --- |
| 打开页面 | 立刻 | 1～3 秒 |
| 消息延迟（单程） | 几毫秒 | 约 250ms |
| 图片上传 | 快 | 明显慢，建议回 WiFi 再发 |
| 学员流量 | 0 | 图片按张计（300KB 左右） |

**隐私**：内容走 AES-256-GCM 端到端加密，密钥放在二维码的 `#k=` 里（浏览器不会把它发给服务器），
所以 Cloudflare 只做转发，看不到消息正文；它能看到的是连接时间、条数和长度这些元数据。

**注意**：

- 讲师机自己也必须能上网（最稳的组合是：讲师机插 5G 网卡 / 手机 USB 共享 + 学员用流量）
- 隧道地址每次开启都会变，对应"每场一个二维码"的用法没问题
- 开启期间有人拿到二维码就能进，和局域网是同一个信任模型（房间号就是门票）
- 关掉程序或点「关闭」，隧道进程会被一并回收（Job Object 保证，强杀也不留残留）
- **自动续连**：勾上后隧道掉了会在 3 秒后自动重开；临时隧道重开会变地址，固定隧道不变
- **固定域名**（可选，推荐）：设置里填 Cloudflare 隧道令牌 + 域名（如 `dm.teachergeng.space`），
  地址就固定下来，重连也不用学员重新扫码；配法见 [docs/remote-tunnel.md](docs/remote-tunnel.md#固定域名named-tunnel推荐)

---


## 三点五、给别人用：多讲师开通（TENANT）

> 这一节是给**分发者**看的。普通讲师只用上一节就够了。

固定域名需要「Cloudflare 账号 + 域名」，绝大多数讲师不会自己折腾。
如果你要把软件发给别人，**不要把你自己那条隧道的令牌发出去**——那等于把你的账号凭证分发给所有人，
而且同一条隧道挂多个连接器时，Cloudflare 会把学员轮询分到别人的电脑上。

正确做法是**每人一条独立隧道**：

```
你的 Cloudflare 账号
├─ localdanmu     → dm.teachergeng.space        你自己
├─ ldm-user-a1b2  → zhangsan.teachergeng.space  张三
└─ ldm-user-c3d4  → lisi.teachergeng.space      李四
```

### 一次性准备

到 Cloudflare → 我的个人资料 → **API 令牌** → 创建自定义令牌：

| 类型 | 权限 |
| --- | --- |
| 账户 | Cloudflare Tunnel → **编辑** |
| 区域 | DNS → **编辑**、区域 → **读取** |

区域资源限定到你的域名（如 `teachergeng.space`）即可。

> 别把**隧道令牌**（`eyJhIjoi...`）当成 API 令牌。API 令牌是 40 位随机串，只在开通/吊销时用。

### 开通（网页版，推荐）

```powershell
cd D:\teachergeng\LocalDanMu
node tools/tenant/ui.js
```

浏览器会打开一个本地页面：粘贴 API 令牌 → 填标签 →域名标识自动生成（可改）→ 点「开通」。
结果区直接给「公开域名」和「隧道令牌」，各带复制按钮；下方列出已开通的人，每人一个「吊销」按钮。

想先看效果可以加 `--mock`（假 API，不会真的建东西）。

### 开通（命令行，适合脚本化）

```powershell
$env:CF_API_TOKEN = "你的 API 令牌"
node tools/tenant/provision.js --label x --check          # 先验证令牌，不建东西
node tools/tenant/provision.js --label "张三-2026春季" --host zhangsan
```

会打印两行，**私聊发给对方**：

```
公开域名 : zhangsan.teachergeng.space
隧道令牌 : eyJhIjoi...
```

对方填进「设置与网络 → 固定隧道」，点开启即可。

### 改端口（隧道不重建、令牌不变）

Windows 有时会把 8000 段端口保留起来（`netsh int ipv4 show excludedportrange protocol=tcp` 能看到），
程序端口和隧道入口对不上时，表现为 502 / 「入口尚未生效」。

改入口（不用重新开通，对方令牌继续有效）：

```powershell
node tools/tenant/port.js --host syklong.teachergeng.space --port 18080
```

程序端口是固定的 18080，不用改；改完入口重启程序即可。

### 查看与吊销

```powershell
node tools/tenant/revoke.js --list                      # 看都开了谁
node tools/tenant/revoke.js --label "张三-2026春季"      # 吊销（删 DNS + 删隧道）
```

吊销只影响那一个人，**他手里的令牌立即失效**，不影响其他人。

### 三个必须知道的约束

1. **子域只能一级**：Cloudflare 免费版证书只覆盖 `*.teachergeng.space`，
   `xx.dm.teachergeng.space` 这种二级域名会 TLS 握手失败。想要 `dm.` 前缀得买
   Advanced Certificate Manager（约 $10/月），或者用 `dm-zhangsan.teachergeng.space` 这种一级命名。
2. **令牌不落盘**：`tools/tenant/tenants.json` 只记 label/hostname/tunnelId，**不存令牌**；
   令牌只在开通时打印一次，补发要去控制台那条隧道详情页复制。该文件已 gitignore。
3. **隐私边界**：流量走你的 Cloudflare 账号，你能看到元数据（时间、条数、长度），
   **看不到内容**（程序强制端到端加密）。宣传时可以把它当卖点讲清楚。

操作细节见 [tools/tenant/README.md](tools/tenant/README.md)，长期规划见
[docs/topic-tenant.md](docs/topic-tenant.md)。

## 三点六、演练与验收（建议先做）

正式发给同事前，按 [docs/field-trial/README.md](docs/field-trial/README.md) 走一遍：
课前清单、现场记录表、事先定死的判据（首次进入率 / 远程启用率 / 阻塞时长）。

目的是用真实数据决定"远程模式该不该继续投入"，而不是靠印象。

---

## 四、实现要点（简版，详见架构文档）

- **单端口**：HTTP 与 WebSocket 共用一个端口，二维码里只有一个地址。
- **房间口令**：每场随机 8 位，链接 `/j/<房间号>`；口令不对页面 403、WS 401。
- **三道限流**：单人间隔（默认 5 秒）→ 单 IP 令牌桶 → 全局令牌桶；被过滤的消息不占额度。
- **消息校验**：文字上限 100 字（按码点计）；图片只接受 png/jpeg/webp/gif 的 data URL，
  **拒绝 SVG**；WS 单帧上限 2MB。
- **弹幕轨道**：判断条件是"上一条的尾巴完全进入屏幕"，不是等它飞出去，吞吐高很多。
- **滚动速度**：默认每秒走过屏宽的 8%，可调 4%～30%。
- **词云**：短句整条当一个词，长句按标点切段；纯 Canvas 螺旋布局，无第三方库。
- **关键词过滤**：5 条规则 + 58 条通用脏话 + 自定义/导入；匹配前做全角转半角、去零宽字符。
- **不落盘**：消息只在内存（文本 ≤300 条、图片 ≤20 张）；只有「导出本次记录」会写盘。

---

## 五、目录结构

> 分发者用的开通脚本在 `tools/tenant/`（见第三点五节），不影响程序本身。

```
src-tauri/src/     Rust 侧：main / core / server / windows / sys / filter / network / qr / settings
src/renderer/      四个窗口页面（control / danmaku / cloud / join）+ shim.js 兼容层
src/web/           观众端 H5（编译时内嵌进 exe）
scripts/           build-win.ps1 / setup-nsis.ps1 / make-icons.ps1 / probe-app.ps1
docs/              architecture.md（实现文档）/ p1-spike-report.md（可行性验证）
assets/            图标母版与托盘图标
dist/              构建产物（安装包、绿色 zip）
```

---

## 六、开发命令

```powershell
cd src-tauri
cargo test          # 59 个测试：单元 + 协议集成（真 HTTP/WS，不开 GUI）
cargo run           # 开发运行

# 端到端探针：真进程验证 HTTP/WS/口令门/弹幕层透明·置顶·穿透·不抢焦点
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\probe-app.ps1 -Exe "src-tauri\target\release\localdanmu.exe"
```

探针会把结果写到 `scripts\out\probe-app-result.json` 和 `app-main.png`。
它内置一个"品红全屏置顶已激活窗口"来模拟放映中的 PPT——这也是验证"弹幕压得住 PPT"的
唯一可靠办法（单元测试做不到这件事）。

---

## 七、已知限制

- 只支持 Windows；只支持单实例（第二次启动会把已有窗口调出来）。
- **依赖系统 WebView2 运行时**。Windows 11 自带；Win10 装过 Edge 一般都有。
  从不上网的老机器需要先离线装一次 WebView2 运行时（系统级，装一次即可）。
- 消息**不经过人工审核**，只有关键词过滤 + 撤回手段（暂停、清屏、结束）。
- 词云不做同义词合并，「太难了」和「太难」算两个词。
- 单条文字上限 100 字；超长内容在屏幕上按屏幕宽度截断加省略号。
- 图片统一转成 JPEG 发送，GIF 只保留首帧。
- 鼠标停留在图片上时会临时接管点击，那一小块区域点不到 PPT；移开即恢复。
- 投屏引导页会把 WiFi 密码显示在大屏上——这是本意，请确认现场允许公开该密码。
- 传输是明文 HTTP/WS，仅限可信局域网。不要开公网隧道直接暴露。
- 结束培训前没导出，数据就没了（这是设计目标，不是 bug）。