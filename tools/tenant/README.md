# TENANT：给多个讲师开通固定隧道

对应议题 [docs/topic-tenant.md](../../docs/topic-tenant.md)。
核心思路：**不是共享一条隧道，而是每人一条**。作者的 Cloudflare 账号下为每个用户建独立隧道，
发给他专属令牌；吊销时只删那一条，不影响别人。

## 一次性准备

1. 到 Cloudflare → 我的个人资料 → **API 令牌** → 创建自定义令牌，权限：

   | 类型 | 权限 |
   | --- | --- |
   | Account | **Cloudflare Tunnel: Edit** |
   | Zone | **DNS: Edit**、**Zone: Read** |

   资源范围：包含你的账号和 `teachergeng.space`（或你的域名）。

> **别把隧道令牌当 API 令牌。** 隧道令牌长得像 `eyJhIjoi...`，那是给程序连隧道用的；
> API 令牌是 40 位随机串。填错时脚本会直接提示。

> **账号 ID 从哪来？** 细粒度令牌调 `/accounts` 会返回空（列出账号需要额外的账号级权限），
> 所以脚本改成从 `GET /zones` 的返回里读 `account.id`。万一还是取不到，
> 可以显式设置 `CF_ACCOUNT_ID`（控制台地址栏 `dash.cloudflare.com/<账号ID>/...` 那段）。

2. 设置环境变量（当前 PowerShell 会话有效）：

   ```powershell
   $env:CF_API_TOKEN = "你的 API 令牌"
   $env:CF_ZONE_NAME = "teachergeng.space"   # 可选，默认就是这个
   ```

> 注意：这是 **API 令牌**，和程序里填的**隧道令牌**不是一回事。
> API 令牌只在开通/吊销时用，不进程序、不分发给用户。

## 开通一个用户

**在仓库根目录**执行（或在 `tools/tenant` 目录里写 `node provision.js`）：

```powershell
node tools/tenant/provision.js --label "张三-2026春季" --host u7f3k2
```

- `--label`：内部标识，写进 `tenants.json`
- `--host`：可选，省略时自动生成 `u<随机6位>`；子域最终是 `u7f3k2.teachergeng.space`

> **只支持一级子域。** Cloudflare 免费版 Universal SSL 只覆盖 `*.teachergeng.space`，
> 像 `xxx.dm.teachergeng.space` 这种二级域名没有证书，TLS 会直接握手失败。
> 想用 `dm.` 分组前缀，需要 Advanced Certificate Manager（约 $10/月）签发 `*.dm.teachergeng.space`。
- `--dry-run`：只打印将要做的事，不调 API
- `--check`：只验证 API 令牌与账号/zone 解析，不建任何东西

执行完会打印：

```
公开域名 : u7f3k2.dm.teachergeng.space
隧道令牌 : eyJhIjoi...
```

把这两行私聊发给对方，让他填进「设置与网络 → 固定隧道」。

## 吊销

```powershell
node tools/tenant/revoke.js --label "张三-2026春季"
node tools/tenant/revoke.js --host u7f3k2.dm.teachergeng.space
node tools/tenant/revoke.js --list
```

删 DNS → 删隧道（force，会断开对方正在跑的连接器）→ 从记录里移除。
对方手里的令牌立即失效。

## 数据文件

`tools/tenant/tenants.json`（**已在 .gitignore 里，不要提交**）：

```json
{
  "tenants": [
    {
      "label": "张三-2026春季",
      "hostname": "u7f3k2.dm.teachergeng.space",
      "tunnelId": "...",
      "dnsRecordId": "...",
      "zoneId": "...",
      "accountId": "...",
      "createdAt": "..."
    }
  ]
}
```

**这个文件里不含令牌**（令牌只在开通时打印一次）。真要补发，去控制台该隧道详情页复制。

## 边界

- 你只承担 Cloudflare 账号的管理责任；流量走你的账号，**元数据可见，内容看不到**（程序强制端到端加密）
- 建议每人每年轮换一次令牌（控制台「轮换令牌」）
- 发现滥用：`revoke.js` 一条命令停掉，不影响其他人
- 子域用随机串而不是姓名拼音，避免在 URL 里暴露用户身份
