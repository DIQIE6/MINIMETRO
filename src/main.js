import { Game, GameState } from './game.js';
import { Renderer } from './render.js';
import { InputController } from './input.js';
import { Hud } from './hud.js';
import { Autopilot } from './autopilot.js';
import { Net, ranking } from './net.js';

const params = new URLSearchParams(window.location.search);
const canvas = document.getElementById('map');
const renderer = new Renderer(canvas);

let game = null;
let autopilot = null;
let speed = 1;
let lastSpeed = 1;
let paused = false;
let accumulator = 0;
let lastFrame = performance.now();
let menuPreview = true;
/** Online session state (M1 same-seed race). */
const net = new Net();
let multiplayer = false;
let raceOver = false;
/** Mode the menu's background demo is playing, so it can restart itself. */
let previewMode = 'normal';

net.onRoom = (room, { justStarted }) => {
  hud.renderLobby(room, net);
  if (net.connected) hud.renderBoard(room, net, ranking);
  if (justStarted) {
    raceOver = false;
    startGame('normal', { seed: room.seed, multiplayer: true });
  }
};

const hud = new Hud({
  onMode: (mode) => startGame(mode, { preview: false }),
  onRestart: () => startGame(game?.mode.id || 'normal', { preview: false }),
  onMenu: () => showMenu(),
  onSpeed: (value) => setSpeed(value),
  onReward: (kind) => game?.chooseReward(kind),
  onClearLine: (line) => game?.clearLine(line),
  onVehicleDrag: (kind, event) => input.beginVehicleDragFromPool(kind, event),
  // ------------------------------------------------------------------ online
  onOnline: () => {
    hud.hideStart();
    hud.showLobby();
  },
  onHost: () => {
    net
      .host(Net.defaultName(), params.has('seed') ? Number(params.get('seed')) : null)
      .then(() => {
        hud.setLobbyHint('房间建好了，把房间号发给其他人。');
        hud.renderLobby(net.room, net);
      })
      .catch((error) => hud.setLobbyHint('创建失败：' + error.message));
  },
  onJoin: (code) => {
    if (!code || String(code).trim().length < 4) {
      hud.setLobbyHint('请输入 4 位房间号');
      return;
    }
    net
      .join(code, Net.defaultName())
      .then(() => {
        hud.setLobbyHint('');
        hud.renderLobby(net.room, net);
      })
      .catch((error) => hud.setLobbyHint('加入失败：' + error.message));
  },
  onStart: () => {
    if (!net.isHost) return;
    net.start().catch((error) => hud.setLobbyHint('开始失败：' + error.message));
  },
  onLeave: () => {
    net.leave();
    hud.hideLobby();
    hud.hideBoard();
    hud.hideResults();
    showMenu();
  },
  onRaceAgain: () => {
    hud.hideResults();
    if (net.isHost) net.start();
    else hud.showLobby();
  },
});

const input = new InputController(canvas, null, renderer, {});
input.attach();
hud.setSpeed(1);

function setSpeed(value) {
  if (value === 0) {
    paused = true;
  } else {
    paused = false;
    speed = value;
    lastSpeed = value;
  }
  hud.setSpeed(paused ? 0 : speed);
}

/**
 * TEMPORARY SCAFFOLDING (tools/RIVER-LAB.md): ?river={"width":50,...} previews a
 * river parameter set in the real game. Delete this with the lab.
 */
function readRiverParams() {
  try {
    const raw = params.get('river');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function startGame(modeId, options = {}) {
  menuPreview = options.preview === true;
  if (menuPreview) previewMode = modeId;
  multiplayer = options.multiplayer === true;
  if (multiplayer) raceOver = false;
  game = new Game({
    mode: modeId,
    seed: Number.isFinite(options.seed)
      ? options.seed
      : params.has('seed')
        ? Number(params.get('seed'))
        : undefined,
    riverParams: readRiverParams(),
  });
  input.setGame(game);
  autopilot = menuPreview || params.get('demo') === '1' ? new Autopilot(game, { interval: menuPreview ? 2.4 : 3.2 }) : null;
  accumulator = 0;
  if (menuPreview) {
    hud.showStart();
    // let the preview map build itself up behind the menu
    fastForward(90);
  } else {
    hud.hideStart();
    setSpeed(speed);
    if (params.has('t')) fastForward(Number(params.get('t')));
  }
  window.__minimetro = {
    game,
    renderer,
    input,
    hud,
    get speed() {
      return paused ? 0 : speed;
    },
    /** Advance the whole game (sim + render + HUD) by `seconds` in one call.
     *  Used by the browser self-check, where headless rAF is unreliable. */
    tick(seconds = 1 / 60) {
      const steps = Math.max(1, Math.round(seconds / (1 / 60)));
      for (let i = 0; i < steps; i++) advance(1 / 60);
    },
    resize,
    startGame,
  };
}

function showMenu() {
  startGame('normal', { preview: true });
}

/** Advance the simulation without waiting, used by `?t=` and the menu preview. */
function fastForward(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const step = 1 / 60;
  let elapsed = 0;
  let guard = 0;
  while (elapsed < seconds && guard < 60 * 60 * 30) {
    guard++;
    autopilot?.update(step);
    game.update(step);
    elapsed += step;
    if (game.state === GameState.GAMEOVER) break;
  }
}

function resize() {
  renderer.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
// A ResizeObserver also catches layout changes that never fire a window
// resize event (embedded frames, dev tools docking, CSS-driven reflows).
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(resize).observe(document.getElementById('app'));
}

window.addEventListener('keydown', (event) => {
  if (event.key === ' ') {
    event.preventDefault();
    setSpeed(paused ? lastSpeed : 0);
  } else if (event.key === '1') setSpeed(1);
  else if (event.key === '2') setSpeed(2);
  else if (event.key === '3') setSpeed(3);
});

/** One simulation + presentation step. `frame` calls this, and so does the
 *  deterministic `tick` used by the browser self-check. */
function advance(dt) {
  if (!game) {
    renderer.clear();
    return;
  }
  // The menu's background demo must never show a game-over card - that would
  // be baffling to someone who is not playing. If the autopilot loses, quietly
  // deal a fresh game and carry on until the player picks a mode.
  if (menuPreview && game.state === GameState.GAMEOVER) {
    startGame(previewMode, { preview: true });
    return;
  }
  if (game.state === GameState.PLAYING && !paused) {
    accumulator += dt * speed;
    const step = 1 / 60;
    let guard = 0;
    while (accumulator >= step && guard < 12) {
      autopilot?.update(step);
      game.update(step);
      accumulator -= step;
      guard++;
    }
  } else {
    accumulator = 0;
    if (game.state === GameState.UPGRADE) autopilot?.update(dt);
  }
  // Online: tell the host how I am doing, and show the live board.
  if (net.connected) {
    net.report(game);
    if (multiplayer && game.state === GameState.GAMEOVER && !raceOver) {
      raceOver = true;
      net.report(game, true);
      const rows = ranking(net.room);
      const mine = rows.findIndex((p) => p.id === net.id);
      hud.showResults(rows, net, mine === 0 ? '你活得最久。' : '你存活了 ' + game.time.toFixed(0) + ' 秒。');
    }
  }
  renderer.draw(game, input, dt);
  hud.sync(game);
}

function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.25);
  lastFrame = now;
  advance(dt);
  requestAnimationFrame(frame);
}

resize();
const autostart = params.get('autostart') === '1' || params.get('demo') === '1' || params.has('t');
if (autostart) {
  startGame(params.get('mode') || 'normal', { preview: false });
} else {
  startGame('normal', { preview: true });
}
requestAnimationFrame(frame);
