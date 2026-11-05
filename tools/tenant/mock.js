'use strict';
/**
 * Cloudflare API 的本地假服务器，给自测和 UI 的"体验模式"用。
 * 只实现 TENANT 用到的那几个端点，行为尽量贴近真实返回。
 */

const http = require('node:http');

function startMock() {
  const state = {
    hits: [],
    tunnelDeleted: false,
    dnsDeleted: false,
    accountId: 'acct-test-1',
    zoneId: 'zone-test-1',
    tunnelId: '11111111-2222-3333-4444-555555555555',
    dnsId: 'dns-test-1',
    tunnelToken: 'fake-tunnel-token'
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits.push({
        method: req.method,
        url: req.url,
        body: body ? JSON.parse(body) : undefined
      });
      const send = (code, payload) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const ok = (result) => send(200, { success: true, result });
      const u = req.url.split('?')[0];

      // 令牌不对时真实 API 会 403，这里也照做，方便测错误分支
      if (req.headers.authorization !== 'Bearer fake-token') {
        return send(403, { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] });
      }

      if (u === '/accounts' && req.method === 'GET') return ok([]); // 模拟细粒度令牌
      if (u === '/zones' && req.method === 'GET') {
        return ok([{ id: state.zoneId, name: 'teachergeng.space', account: { id: state.accountId } }]);
      }
      if (u.endsWith('/cfd_tunnel') && req.method === 'POST') {
        return ok({ id: state.tunnelId, name: JSON.parse(body).name });
      }
      if (u.endsWith(`/cfd_tunnel/${state.tunnelId}/token`) && req.method === 'GET') {
        return ok(state.tunnelToken);
      }
      if (u.endsWith(`/cfd_tunnel/${state.tunnelId}/configurations`) && req.method === 'PUT') {
        state.ingress = JSON.parse(body).config.ingress;
        return ok({});
      }
      if (u.endsWith(`/cfd_tunnel/${state.tunnelId}/configurations`) && req.method === 'GET') {
        return ok({ config: { ingress: state.ingress || [] } });
      }
      if (u.endsWith('/cfd_tunnel') && req.method === 'GET') {
        return ok([{ id: state.tunnelId, name: 'ldm-user-mock', created_at: new Date().toISOString() }]);
      }
      if (u.endsWith('/dns_records') && req.method === 'POST') return ok({ id: state.dnsId });
      if (u.endsWith(`/dns_records/${state.dnsId}`) && req.method === 'DELETE') {
        state.dnsDeleted = true;
        return ok({ id: state.dnsId });
      }
      if (u.endsWith(`/cfd_tunnel/${state.tunnelId}`) && req.method === 'DELETE') {
        state.tunnelDeleted = true;
        return ok({ id: state.tunnelId });
      }
      return send(404, { success: false, errors: [{ message: `unexpected ${req.method} ${u}` }] });
    });
  });

  return {
    state,
    listen: () =>
      new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = { startMock };
