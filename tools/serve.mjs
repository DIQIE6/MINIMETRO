/**
 * Zero-dependency static file server for the game.
 *
 *   node tools/serve.mjs [--port 8123]
 *
 * ES modules cannot be loaded over file://, so this is the simplest way to
 * play the development version. (dist/minimetro.html is a single file and
 * works straight from the filesystem.)
 */
import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openUrl } from './open-browser.mjs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argPort = (() => {
  const index = process.argv.indexOf('--port');
  if (index >= 0) return Number(process.argv[index + 1]);
  return Number(process.env.PORT || 8123);
})();
const port = Number.isFinite(argPort) && argPort > 0 ? argPort : 8123;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(`[server] request failed: ${error.message}`);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 Server Error');
  });
});

// The page streams progress reports; write them one at a time through a unique
// temp file so a reader never sees a partial report and two reports never race.
let reportQueue = Promise.resolve();
let reportSeq = 0;

async function handle(req, res) {
  // The browser self-check posts its report here, because this Edge build
  // writes nothing to stdout for --dump-dom.
  if (req.method === 'POST' && req.url === '/report') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    res.writeHead(204).end();
    reportQueue = reportQueue.then(async () => {
      const target = path.join(root, 'shots', 'browser-report.json');
      await mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.${reportSeq++}.tmp`;
      await writeFile(temp, body, 'utf8');
      await rename(temp, target);
    });
    await reportQueue.catch((error) => console.error(`[server] report write failed: ${error.message}`));
    return;
  }
  // TEMPORARY SCAFFOLDING (tools/RIVER-LAB.md): the two /ratings routes below
  // exist only for the river rating lab. Delete both when the lab goes away.
  // Ratings: appended one JSON object per line so nothing is ever lost
  // when a run is interrupted. tools/river-tune.mjs reads this file.
  if (req.method === 'POST' && req.url === '/ratings') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(204).end();
    reportQueue = reportQueue.then(async () => {
      let payload = null;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return;
      }
      const list = Array.isArray(payload) ? payload : payload?.ratings;
      if (!Array.isArray(list) || !list.length) return;
      const target = path.join(root, 'shots', 'river-ratings.jsonl');
      await mkdir(path.dirname(target), { recursive: true });
      const text = list.map((r) => JSON.stringify(r)).join('\n') + '\n';
      const existing = await readFile(target, 'utf8').catch(() => '');
      const temp = `${target}.${process.pid}.${reportSeq++}.tmp`;
      await writeFile(temp, existing + text, 'utf8');
      await rename(temp, target);
    });
    await reportQueue.catch((error) => console.error(`[server] rating write failed: ${error.message}`));
    return;
  }
  if (req.method === 'GET' && req.url === '/ratings') {
    const target = path.join(root, 'shots', 'river-ratings.jsonl');
    const text = await readFile(target, 'utf8').catch(() => '');
    const list = text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const body = JSON.stringify(list);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  if (req.method === 'POST' && req.url === '/shot-log') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    console.log(`[page] ${Buffer.concat(chunks).toString('utf8')}`);
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  let relative = decodeURIComponent(url.pathname);
  if (relative.endsWith('/')) relative += 'index.html';
  const filePath = path.join(root, path.normalize(relative));
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

process.on('unhandledRejection', (error) => {
  console.error(`[server] unhandled rejection: ${error && error.message}`);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Mini Metro clone running at http://127.0.0.1:${port}/`);
  // Bind every interface and say so: otherwise other machines on the network
  // cannot open the link you send them.
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  LAN: http://${net.address}:${port}/`);
      }
    }
  }
  console.log('Press Ctrl+C to stop.');
  if (!process.argv.includes('--no-open')) {
    void openUrl(`http://127.0.0.1:${port}/`);
  }
});
