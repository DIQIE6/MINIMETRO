/**
 * Mini Metro - LAN multiplayer host.
 *
 *   node tools/net-server.mjs [--port 8123]
 *
 * One command on the host machine, and everyone on the same network opens the
 * printed address. It serves the game files *and* the room API, so there is
 * nothing to install on the other machines.
 *
 * Zero dependencies: plain HTTP plus Server-Sent Events for the push channel.
 *
 * How a race works (M1 "same seed"):
 *   the host picks a seed, everybody builds their own network on the same map,
 *   and the winner is whoever survives longest. Nothing about the simulation is
 *   synchronised - only liveness and score, a few small messages per second.
 */
import http from 'node:http';
import { readFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openUrl } from './open-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argPort = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : Number(process.env.PORT || 8123);
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

// ---------------------------------------------------------------- rooms
/**
 * @type {Map<string, {
 *   code: string, seed: number, started: boolean, hostId: string,
 *   createdAt: number,
 *   players: Map<string, {id:string,name:string,alive:boolean,delivered:number,time:number,lastSeen:number,finished:boolean}>
 * }>}
 */
const rooms = new Map();
const streams = new Map(); // roomCode -> Set<{id, res}>

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return randomUUID().slice(0, 6).toUpperCase();
}

const STALE_MS = 15000;
const EMPTY_ROOM_MS = 10 * 60 * 1000;

function publicRoom(room) {
  return {
    code: room.code,
    seed: room.seed,
    started: room.started,
    hostId: room.hostId,
    players: [...room.players.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        delivered: p.delivered,
        time: Math.round(p.time * 10) / 10,
        finished: p.finished,
      }))
      // Longest survival first: that is the whole ranking rule for M1.
      .sort((a, b) => (b.finished ? b.time : Infinity) - (a.finished ? a.time : Infinity) || b.delivered - a.delivered),
  };
}

function broadcast(code) {
  const room = rooms.get(code);
  const set = streams.get(code);
  if (!room || !set) return;
  const payload = `data: ${JSON.stringify({ type: 'room', room: publicRoom(room) })}\n\n`;
  for (const client of set) {
    try {
      client.res.write(payload);
    } catch {
      set.delete(client);
    }
  }
}

function sweep() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    for (const [id, p] of room.players) {
      // A player whose tab closed stops posting; drop them so the room does not
      // fill up with ghosts.
      if (now - p.lastSeen > STALE_MS) room.players.delete(id);
    }
    if (!room.players.size && now - room.createdAt > EMPTY_ROOM_MS) rooms.delete(code);
  }
}
setInterval(sweep, 5000).unref?.();

// ---------------------------------------------------------------- helpers
const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

async function serveStatic(req, res, url) {
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

// ---------------------------------------------------------------- API
async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const p = url.pathname;

  if (p === '/api/host' && req.method === 'POST') {
    const body = await readBody(req);
    const code = makeCode();
    const id = randomUUID();
    const room = {
      code,
      seed: Number.isFinite(body.seed) ? Number(body.seed) : Math.floor(Math.random() * 1e6),
      started: false,
      hostId: id,
      createdAt: Date.now(),
      players: new Map(),
    };
    room.players.set(id, {
      id,
      name: String(body.name || '房主').slice(0, 12),
      alive: true,
      delivered: 0,
      time: 0,
      lastSeen: Date.now(),
      finished: false,
    });
    rooms.set(code, room);
    json(res, 200, { code, id, seed: room.seed, hostId: id });
    return;
  }

  if (p === '/api/join' && req.method === 'POST') {
    const body = await readBody(req);
    const code = String(body.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) {
      json(res, 404, { error: '没有这个房间' });
      return;
    }
    if (room.players.size >= 8) {
      json(res, 409, { error: '房间满了' });
      return;
    }
    const id = randomUUID();
    room.players.set(id, {
      id,
      name: String(body.name || '玩家').slice(0, 12),
      alive: true,
      delivered: 0,
      time: 0,
      lastSeen: Date.now(),
      finished: false,
    });
    json(res, 200, { code, id, seed: room.seed, hostId: room.hostId, started: room.started });
    broadcast(code);
    return;
  }

  if (p === '/api/start' && req.method === 'POST') {
    const body = await readBody(req);
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (!room) return json(res, 404, { error: '没有这个房间' });
    if (body.id !== room.hostId) return json(res, 403, { error: '只有房主能开始' });
    room.started = true;
    // Everyone races the identical map, so the seed is fixed at start time.
    if (Number.isFinite(body.seed)) room.seed = Number(body.seed);
    for (const player of room.players.values()) {
      player.alive = true;
      player.delivered = 0;
      player.time = 0;
      player.finished = false;
    }
    broadcast(room.code);
    json(res, 200, { ok: true, seed: room.seed });
    return;
  }

  if (p === '/api/state' && req.method === 'POST') {
    const body = await readBody(req);
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (!room) return json(res, 404, { error: '没有这个房间' });
    const player = room.players.get(body.id);
    if (!player) return json(res, 404, { error: '不在房间里' });
    player.lastSeen = Date.now();
    player.alive = body.alive !== false;
    player.delivered = Number(body.delivered) || 0;
    player.time = Number(body.time) || 0;
    if (body.finished) player.finished = true;
    broadcast(room.code);
    json(res, 200, { ok: true });
    return;
  }

  if (p === '/api/events') {
    const code = String(url.searchParams.get('code') || '').toUpperCase();
    const id = url.searchParams.get('id');
    const room = rooms.get(code);
    if (!room) return json(res, 404, { error: '没有这个房间' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'room', room: publicRoom(room) })}\n\n`);
    const set = streams.get(code) || new Set();
    streams.set(code, set);
    const client = { id, res };
    set.add(client);
    // Keep-alive comment so proxies and browsers do not drop the stream.
    const beat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(beat);
      }
    }, 20000);
    req.on('close', () => {
      clearInterval(beat);
      set.delete(client);
      if (!set.size) streams.delete(code);
    });
    return;
  }

  if (p === '/api/rooms') {
    json(res, 200, {
      rooms: [...rooms.values()].map((r) => ({ code: r.code, players: r.players.size, started: r.started })),
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method Not Allowed');
    return;
  }
  await serveStatic(req, res, url);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(`[net] request failed: ${error.message}`);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 Server Error');
  });
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(port, '0.0.0.0', () => {
  console.log(`Mini Metro 联机主机  http://127.0.0.1:${port}/`);
  for (const ip of lanAddresses()) {
    console.log(`  局域网内其他人打开:  http://${ip}:${port}/`);
  }
  console.log('');
  console.log('进入游戏后选「联机模式」→ 房主「创建房间」，其他人输入房间号加入。');
  console.log('按 Ctrl+C 停止。');
  // A browser page cannot start a local server, so the host opens the browser
  // instead: double-clicking the launcher is then the whole setup. Works on
  // Windows, macOS and Linux alike.
  if (!process.argv.includes('--no-open')) {
    void openUrl(`http://127.0.0.1:${port}/`);
  }
});
