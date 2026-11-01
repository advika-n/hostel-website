// Tiny static file server for static/ (used by the tests; GitHub Pages does this job online).
const http = require('http'), fs = require('fs'), path = require('path');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.sql': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
function serve(root, port) {
  root = path.resolve(root);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}
module.exports = { serve };
if (require.main === module) {
  // node tests/serve.js [folder] [port]   - both optional; a lone number is the port
  const args = process.argv.slice(2);
  const port = +(args.find(a => /^\d+$/.test(a)) || 8000);
  const root = args.find(a => !/^\d+$/.test(a)) || path.join(__dirname, '..', 'static');
  if (!fs.existsSync(path.join(root, 'index.html'))) { console.error('No index.html in ' + path.resolve(root)); process.exit(1); }
  serve(root, port).then(() => console.log('Serving ' + path.resolve(root) + ' on http://localhost:' + port + '   (Ctrl+C to stop)'));
}
