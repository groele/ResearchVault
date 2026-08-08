import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(ROOT, p);
  fs.readFile(fp, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(buf);
  });
});

server.on('error', (err) => {
  if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
    const nextPort = Number(PORT) + 1;
    console.log(`端口 ${PORT} 受限/占用，尝试端口 ${nextPort}...`);
    server.listen(nextPort, '127.0.0.1');
  } else {
    throw err;
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`serving ResearchVault-arch on http://127.0.0.1:${server.address().port}`));
