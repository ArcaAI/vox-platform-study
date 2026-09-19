// usage: node sse.js <method> <path> <authHeaderName> <authValue> <bodyFile|-> <timeoutMs> <outFile> [tenantId]
const http = require('http');
const fs = require('fs');
const [,, method, path, authName, authValue, bodyFile, timeoutMsRaw, outFile, tenantId] = process.argv;
const timeoutMs = Number(timeoutMsRaw);
const body = bodyFile && bodyFile !== '-' ? fs.readFileSync(bodyFile) : null;
const headers = { Accept: 'text/event-stream', [authName]: authValue };
if (tenantId) headers['X-Tenant-Id'] = tenantId;
if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
const out = fs.createWriteStream(outFile);
const req = http.request({ host: '127.0.0.1', port: 8868, path, method, headers }, (res) => {
  console.log('HTTP', res.statusCode, res.headers['content-type']);
  out.write(`# HTTP ${res.statusCode} ${res.headers['content-type']}\n`);
  res.setEncoding('utf8');
  let seen = '';
  res.on('data', (c) => { out.write(c); seen += c;
    if (/"status"\s*:\s*"(SUCCEEDED|FAILED|CANCELLED|TIMED_OUT|COMPLETED)"/.test(seen) || /event:\s*(done|end|terminal)/.test(seen)) {
      setTimeout(() => { req.destroy(); out.end(); process.exit(0); }, 1500);
    }
  });
  res.on('end', () => { out.end(); console.log('stream ended'); process.exit(0); });
});
req.on('error', (e) => { console.log('ERR', e.code, e.message); out.end(); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT after', timeoutMs, 'ms'); req.destroy(); out.end(); process.exit(2); }, timeoutMs);
if (body) req.write(body);
req.end();
