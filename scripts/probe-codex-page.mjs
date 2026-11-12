// 开发者用探针：连上正在运行的 Codex 页面，读取补丁实际看到的状态。
// 只读，不修改任何东西。用法：
//   node probe-codex-page.mjs                # 基本状态
//   node probe-codex-page.mjs --family       # 再挖内部 quota family
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATE_PORTS = [9239, 9240, 9241, 9222];
const markerFile = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Gaoge Free', 'codex-plugins-enabled');

function jsonGet(port, urlPath) {
  return new Promise(resolve => {
    const req = net.connect({ host: '127.0.0.1', port }, () => {
      req.write(`GET ${urlPath} HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let raw = Buffer.alloc(0);
    req.on('data', c => { raw = Buffer.concat([raw, c]); });
    req.on('end', () => {
      const split = raw.indexOf('\r\n\r\n');
      if (split < 0) return resolve(null);
      const head = raw.subarray(0, split).toString('latin1');
      if (!/ 200 /.test(head)) return resolve(null);
      try { resolve(JSON.parse(raw.subarray(split + 4).toString('utf8'))); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

// 与 Rust 侧 cdp_page_target_priority 一致的排序
function pageRank(target) {
  const url = String(target?.url || '');
  if (url === 'app://-/index.html') return 0;
  if (url.startsWith('app://-/index.html')) return 1;
  const aux = /overlay/i.test(String(target?.title || '')) && /avatar/i.test(url);
  if (!aux && /codex|localhost|file:\/\//i.test(url)) return 2;
  return 3;
}

function readFrame(buf) {
  if (buf.length < 2) return null;
  const b1 = buf[1];
  let len = b1 & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  if (buf.length < off + len) return null;
  return { opcode: buf[0] & 0x0f, payload: buf.subarray(off, off + len), used: off + len };
}

async function evaluate(wsUrl, port, expression, id) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect({ host: '127.0.0.1', port: Number(u.port) }, () => {
      sock.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: 127.0.0.1:${u.port}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        `Origin: http://127.0.0.1:${port}\r\n\r\n`);
    });
    let handshake = false, buf = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 15000);
    const send = payload => {
      const data = Buffer.from(payload, 'utf8');
      const mask = crypto.randomBytes(4);
      let header;
      if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
      else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0xfe; header.writeUInt16BE(data.length, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0xff; header.writeBigUInt64BE(BigInt(data.length), 2); }
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, mask, masked]));
    };
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshake) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        handshake = true;
        buf = buf.subarray(end + 4);
        send(JSON.stringify({ id, method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true } }));
      }
      for (;;) {
        const frame = readFrame(buf);
        if (!frame) return;
        buf = buf.subarray(frame.used);
        if (frame.opcode === 0x8) { clearTimeout(timer); sock.destroy(); reject(new Error('closed by peer')); return; }
        if (frame.opcode !== 0x1) continue;
        let text = frame.payload.toString('utf8');
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        let msg; try { msg = JSON.parse(text); } catch { continue; }
        if (msg.id !== id) continue;
        clearTimeout(timer); sock.destroy();
        if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
        const r = msg.result?.result;
        if (msg.result?.exceptionDetails) return reject(new Error(msg.result.exceptionDetails.text + ' :: ' + (r?.description || '')));
        return resolve(r?.value);
      }
    });
    sock.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

const EXPRESSIONS = {
  runtime: `(() => {
    const rt = window.__gaogeCodexFuelRuntime;
    if (!rt) return { present: false };
    return {
      present: true, version: rt.version, enabled: rt.enabled, ready: rt.ready,
      reason: rt.reason, adapterMode: rt.adapterMode, hasAdapter: rt.hasAdapter,
      discoveryError: rt.discoveryError, routeError: rt.routeError,
      error: rt.error, submitScopeBound: rt.submitScopeBound,
      speedInstalled: rt.speedInstalled,
      decisions: (rt.decisions || []).slice(-24)
    };
  })()`,
  sendButton: `(() => {
    const out = [];
    for (const b of document.querySelectorAll('button')) {
      const label = (b.getAttribute('aria-label') || '') + '|' + (b.title || '') + '|' + (b.textContent || '').slice(0, 40);
      if (label.trim() === '||') continue;
      const testid = b.getAttribute('data-testid') || '';
      const looksSend = /send|submit|发送/i.test(label + testid);
      if (!looksSend) continue;
      out.push({ testid, label: label.slice(0, 80), disabled: b.disabled,
        ariaDisabled: b.getAttribute('aria-disabled'), dataState: b.getAttribute('data-state') });
    }
    return out;
  })()`,
  composer: `(() => {
    const ed = document.querySelector("[contenteditable='true']");
    if (!ed) return { present: false };
    const form = ed.closest('form');
    const buttons = form ? Array.from(form.querySelectorAll('button')).map(b => ({
      testid: b.getAttribute('data-testid') || null,
      aria: b.getAttribute('aria-label') || null,
      text: (b.textContent || '').trim().slice(0, 30) || null,
      disabled: b.disabled,
      ariaDisabled: b.getAttribute('aria-disabled')
    })) : [];
    return { present: true, text: (ed.textContent || '').slice(0, 60), formButtons: buttons };
  })()`,
  families: `(() => {
    const rt = window.__gaogeCodexFuelRuntime;
    const seen = [];
    const walk = (fiber, depth) => {
      if (!fiber || depth > 60) return;
      for (const cur of [fiber, fiber.alternate]) {
        if (!cur) continue;
        const chain = cur.memoizedProps?.value;
        const map = chain instanceof Map ? chain : chain?.chain;
        if (map instanceof Map) {
          for (const node of map.values()) {
            if (node?.familyBindings instanceof Map) {
              const sym = Object.getOwnPropertySymbols(node.familyBindings)
                .filter(k => typeof k.description === 'string' && k.description.includes('resolveFamilyMember'))
                .map(k => k.description);
              seen.push({ token: String(node.token?.id ?? node.token ?? '?'), symbols: sym });
            }
          }
        }
      }
      walk(fiber.return, depth + 1);
    };
    const el = document.querySelector("[contenteditable='true']") || document.body;
    let start = null;
    for (let c = el, d = 0; c && d < 6; c = c.parentElement, d++) {
      const k = Object.keys(c).find(n => n.startsWith('__reactFiber$') || n.startsWith('__reactInternalInstance$'));
      if (k) { start = c[k]; break; }
    }
    walk(start, 0);
    const uniq = [];
    for (const s of seen) if (!uniq.some(u => u.token === s.token)) uniq.push(s);
    return { runtimePresent: !!rt, scopeBound: rt?.submitScopeBound ?? null, contexts: uniq.slice(0, 8) };
  })()`
};

const wantFamily = process.argv.includes('--family');

const marker = fs.existsSync(markerFile) ? fs.readFileSync(markerFile, 'utf8').trim() : null;
const ports = [];
if (marker && /^\d+$/.test(marker)) ports.push(Number(marker));
for (const p of CANDIDATE_PORTS) if (!ports.includes(p)) ports.push(p);

let chosen = null;
for (const port of ports) {
  const list = await jsonGet(port, '/json/list');
  if (!list || !list.length) continue;
  const pages = list.filter(t => t.webSocketDebuggerUrl);
  pages.sort((a, b) => pageRank(a) - pageRank(b));
  if (pages.length) { chosen = { port, page: pages[0] }; break; }
}

if (!chosen) {
  console.log('没能连上 Codex 调试端口。确认高歌 Free 和 Codex 窗口都开着。');
  process.exit(1);
}

console.log(`端口 ${chosen.port}  页面 ${chosen.page.url}\n`);
const names = wantFamily ? ['runtime', 'composer', 'sendButton', 'families'] : ['runtime', 'composer', 'sendButton'];
let id = 1;
for (const name of names) {
  try {
    const value = await evaluate(chosen.page.webSocketDebuggerUrl, chosen.port, EXPRESSIONS[name], id++);
    console.log(`--- ${name} ---`);
    let parsed = value;
    if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { /* 保持原样 */ } }
    console.log(JSON.stringify(parsed, null, 2));
    console.log('');
  } catch (e) {
    console.log(`--- ${name} --- 失败: ${e.message}\n`);
  }
}
