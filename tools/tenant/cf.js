'use strict';
/**
 * Cloudflare API 的最小封装（只覆盖 TENANT 用到的几个端点）。
 *
 * 需要的环境变量：
 *   CF_API_TOKEN   API Token，权限：Account → Cloudflare Tunnel: Edit
 *                                 Zone    → DNS: Edit、Zone: Read
 *   CF_ACCOUNT_ID  可选，只有一个账号时可以自动取
 *   CF_ZONE_NAME   可选，默认 teachergeng.space
 */

// 测试时可用 CF_API_BASE 指向本地 mock，生产环境不要设置
const API = process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4';

function token() {
  const t = (process.env.CF_API_TOKEN || '').trim();
  if (!t) {
    throw new Error(
      '缺少 CF_API_TOKEN。请到 Cloudflare 控制台 → 我的个人资料 → API 令牌 创建一个，' +
        '权限至少包含：Cloudflare Tunnel: Edit、DNS: Edit、Zone: Read'
    );
  }
  // 最常见的错：把隧道令牌（eyJ... JWT）当成 API 令牌
  if (t.startsWith('eyJ')) {
    throw new Error(
      'CF_API_TOKEN 填的是「隧道令牌」，不是 API 令牌。\n' +
        '  隧道令牌（eyJ...）用于程序连隧道；调用 API 需要另一种令牌：\n' +
        '  Cloudflare → 我的个人资料 → API 令牌 → 创建令牌（自定义），\n' +
        '  权限：Account → Cloudflare Tunnel: Edit；Zone → DNS: Edit、Zone: Read。'
    );
  }
  return t;
}

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Cloudflare 返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok || json.success === false) {
    const detail = (json.errors || [])
      .map((e) => `${e.code || ''} ${e.message || ''}`.trim())
      .join('; ');
    throw new Error(`Cloudflare API ${method} ${path} 失败（HTTP ${res.status}）：${detail || text.slice(0, 200)}`);
  }
  return json.result;
}

/**
 * 按域名取 zone。
 *
 * 返回值里带 accountId —— 这是拿到账号 ID 的**主要途径**：
 * 细粒度令牌（只给了 Zone:Read + DNS:Edit + Tunnel:Edit）调 `GET /accounts`
 * 会返回空数组，因为"列出账号"需要额外的账号级权限。而 zone 对象里的 account.id
 * 是随 zone 一起返回的，不需要那个权限。
 */
async function resolveZone(zoneName) {
  const zones = await call('GET', `/zones?name=${encodeURIComponent(zoneName)}`);
  if (!Array.isArray(zones) || zones.length === 0) {
    throw new Error(
      `找不到域名 ${zoneName}。确认：1) 域名在这个账号下 2) 令牌的"区域资源"包含它 3) 有 Zone:Read`
    );
  }
  const z = zones[0];
  return { id: z.id, accountId: z.account && z.account.id ? z.account.id : undefined };
}

async function resolveZoneId(zoneName) {
  const z = await resolveZone(zoneName);
  return z.id;
}

/** 取账号 ID：显式指定 > 从 zone 反查 > /accounts（可能为空） */
async function resolveAccountId(explicit, zoneAccountId) {
  if (explicit) return explicit;
  if (zoneAccountId) return zoneAccountId;
  const accounts = await call('GET', '/accounts');
  if (Array.isArray(accounts) && accounts.length > 0) return accounts[0].id;
  throw new Error(
    '拿不到账号 ID。可以设置环境变量 CF_ACCOUNT_ID（控制台地址栏里 dash.cloudflare.com/<账号ID>/... 那段）'
  );
}

/** 创建一条 remotely-managed 隧道，返回 { id, token } */
async function createTunnel(accountId, name) {
  const created = await call('POST', `/accounts/${accountId}/cfd_tunnel`, {
    name,
    config_src: 'cloudflare'
  });
  let tunnelToken = created.token;
  if (!tunnelToken) {
    // 部分账号创建响应不带 token，单独取一次
    tunnelToken = await call('GET', `/accounts/${accountId}/cfd_tunnel/${created.id}/token`);
  }
  if (!tunnelToken) {
    throw new Error('隧道创建成功，但拿不到令牌；请到控制台复制');
  }
  return { id: created.id, token: tunnelToken };
}

/** 配置公开主机名（入口规则） */
async function setIngress(accountId, tunnelId, hostname, service) {
  await call('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
    config: {
      ingress: [{ hostname, service }, { service: 'http_status:404' }]
    }
  });
}

/** 建 CNAME 记录指向隧道 */
async function createDnsRecord(zoneId, hostname, tunnelId) {
  const rec = await call('POST', `/zones/${zoneId}/dns_records`, {
    type: 'CNAME',
    name: hostname,
    content: `${tunnelId}.cfargotunnel.com`,
    proxied: true,
    comment: 'localdanmu tenant'
  });
  return rec.id;
}

async function deleteDnsRecord(zoneId, recordId) {
  await call('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
}

async function deleteTunnel(accountId, tunnelId) {
  await call('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}?force=true`);
}

module.exports = {
  call,
  resolveAccountId,
  resolveZone,
  resolveZoneId,
  createTunnel,
  setIngress,
  createDnsRecord,
  deleteDnsRecord,
  deleteTunnel
};
