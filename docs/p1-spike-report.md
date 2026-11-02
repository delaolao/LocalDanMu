# P1 去风险验证报告（spike）

> 目的：在投入全量重写之前，先证明「透明 + 置顶 + 点击穿透 + 不抢焦点」这条**唯一的**高风险链路
> 在 Tauri 2 / WebView2 上真的能工作，并实测发行体积。
>
> 结论：**全部通过**。可以继续 P2。

- 日期：见 git 提交
- 环境：Windows 10.0.26200（x64）、WebView2 Runtime 156.0.4314.58、
  单显示器 3840×2160 @150% 缩放（正好覆盖高 DPI 场景）
- 工具链：rustc 1.99.1、tauri 2.12.5、tauri-cli 2.12.4、NSIS 3.13

---

## 1. 实测体积

| 产物 | 体积 | 说明 |
| --- | --- | --- |
| `localdanmu.exe`（release，含 LTO/strip/opt-level=s） | **3.24 MB** | 单文件，绿色版直接就是它 |
| `LocalDanMu_0.2.0_x64-setup.exe`（NSIS） | **1.16 MB** | 当前用户安装 |

对照旧版 Electron：安装包 ~110MB、解压后 ~250MB。**当前只是骨架**，P2 之后会加入
axum / tokio / regex / qrcode 等依赖，预计最终 exe 落在 6~10MB、安装包 3~5MB —— 仍然是一个数量级的差别。

## 2. 五项验证结果

由当時代的 `probe-overlay.ps1` 自动执行（debug 与 release 两种构建都跑过，均 PASS）。

| # | 验证项 | 方法 | 结果 |
| --- | --- | --- | --- |
| 1 | 逐像素透明 | 背后放一个品红全屏置顶窗口，在**标记区之外**采样 3 个点，必须看到品红 | PASS |
| 2 | 压住「激活的置顶全屏窗口」 | 在标记区内采样，必须看到弹幕层的纯色（说明渲染在我们之上） | PASS |
| 3 | 默认点击穿透 | 用 `mouse_event` 真实点击，事件必须落到下层 WinForms 窗口的计数器上 | PASS |
| 4 | 悬停接管鼠标 | 光标移入标记区后点击，必须被我们捕获，且下层计数为 0 | PASS |
| 5 | 不抢前台焦点 | 全程轮询 `GetForegroundWindow()`，从不得等于弹幕层 HWND | PASS |

截图证据：`scripts\out\spike-topmost.png`（品红「PPT」完整透出，弹幕清晰压在上面）。

> 该 spike 页面与探针在 P3 阶段已被**真实的弹幕层**取代，现在用
> `scripts\probe-app.ps1` 对完整应用做同样的五项检查（外加 HTTP/WS 协议）。
> 结论不变：**五项全通过**。

## 3. 踩到的三个 Windows 坑（这是本阶段最大产出）

### 坑 1：`WS_EX_NOACTIVATE` 会被 tao 覆盖掉

- **现象**：启动后明明设了不激活，**鼠标点一下图片之后前台焦点还是被抢走了**。
- **日志实录**：`ex_style 0x08040198 → 0x000c0138`（0x08000000 = NOACTIVATE 消失）。
- **原因**：tao 在 WebView2 初始化完成这个时机，把创建时缓存的 ex_style 整体写回去，
  我们在创建后追加的位就没了。
- **对策**：不做「设置一次就永久有效」的假设。`sys::apply_overlay_style()` 作为**唯一真相来源**，
  由 350ms 的置顶守护线程持续复核（幂等，只在真的被改坏时才写回）；
  页面 `ready` 时也立刻再钉一次，因为这个时机正好和 tao 的覆盖撞上。

### 坑 2：点击穿透必须 `WS_EX_LAYERED | WS_EX_TRANSPARENT` 同时在场

- **现象**：只切了 `WS_EX_TRANSPARENT` 之后，点击不再穿透（第二版探针就是这么挂的）。
- **原因**：我们改由 Rust 独占样式位后，tao 之前加的 `WS_EX_LAYERED` 被一起清掉了；
  Windows 的命中测试要这两个位配合才生效。
- **对策**：`LAYERED` 常开（WebView2 走 DirectComposition 渲染，分层样式不影响画面），
  只切换 `TRANSPARENT`。
- **附带确认**：透明窗口 + `WS_EX_LAYERED` 在 WebView2 上渲染正常，没有黑底，
  不需要退回 GDI 颜色键那套兜底方案。

### 坑 3：Tauri 没有 Electron 的 `setIgnoreMouseEvents(true, { forward: true })`

- 旧版靠 forward 收 `mousemove` 做悬停判定，本来就不太可靠，所以旧代码已经用
  30Hz 轮询 `GetCursorPos` 兜底了。
- 换到 Tauri 反而更简单：**直接用 Rust 轮询光标 + `GetAsyncKeyState` 判左键**，
  不需要 forward，也不需要「DOM click 收不到」那第二条备份路径。
- 结论：旧版 `§5.6 两条点击路径` 的复杂度在 Rust 里可以砍掉一半。

## 4. 工具链踩坑（国内网络）

| 问题 | 对策 |
| --- | --- |
| `static.rust-lang.org` 被限速到 ~5KB/s | 用 `rsproxy.cn` 镜像下载 `rustup-init.exe`，并设 `RUSTUP_DIST_SERVER` / `RUSTUP_UPDATE_ROOT`；toolchain 几十秒装完 |
| crates.io 慢 | `~/.cargo/config.toml` 配 `sparse+https://rsproxy.cn/index/` |
| `cargo tauri build` 卡在下载 NSIS（GitHub 超时） | 手工把 NSIS 3.13 与 `nsis_tauri_utils.dll v0.5.3`（SHA1 `75197FEE3C6A814FE035788D1C34EAD39349B860`）放进 `%LOCALAPPDATA%\tauri\NSIS\`，并保证 `Plugins\x86-unicode\additional\nsis_tauri_utils.dll` 存在——bundler 就是靠这个文件判断"本地 NSIS 可用"的，缺了它会删掉整个目录重下 |
| GitHub 直连不通 | `ghfast.top` 代理前缀可用 |

> 这些步骤会固化进 `scripts\build-win.ps1`，让新机器一条命令就能构建。

## 5. 另外两条脚本级踩坑（与产品无关但会咬人）

1. **`.ps1` 一律只写 ASCII**：Windows PowerShell 5.1 按 ANSI 解析 `.ps1`，
   文件里的中文会变成乱码，甚至会破坏引号导致语法错误。中文只放 README / docs。
2. **不要用 `Get-Content -Tail` 读取后直接塞进 JSON**：在这一版 PowerShell 里它返回的是
   带 `PSPath` / `PSDrive` / `ReadCount` 的包装对象而不是字符串，序列化后能膨胀到 30MB+。
   改用 `[System.IO.File]::ReadAllText` / `ReadAllLines`。
