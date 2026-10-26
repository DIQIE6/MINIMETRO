/**
 * Balance smoke test.
 *
 *   node tools/balance.mjs [minutes] [runs]
 *
 * Plays the game with the greedy autopilot and reports how long it survives
 * and how much it delivers. If a competent bot cannot keep the network alive
 * for a few minutes, the spawn rates are wrong.
 */
import { Game, GameState } from '../src/game.js';
import { Autopilot } from '../src/autopilot.js';

const minutes = Number(process.argv[2] || 6);
const runs = Number(process.argv[3] || 5);

const step = 1 / 30;
const rows = [];
for (let run = 0; run < runs; run++) {
  const seed = 1000 + run * 7;
  const game = new Game({ mode: 'normal', seed });
  const bot = new Autopilot(game, { interval: 2.6 });
  let t = 0;
  while (t < minutes * 60) {
    bot.update(step);
    game.update(step);
    t += step;
    if (game.state === GameState.GAMEOVER) break;
  }
  rows.push({
    seed,
    survived: t,
    delivered: game.delivered,
    score: game.score,
    week: game.week,
    stations: game.stations.length,
    lines: game.activeLines().length,
    incidents: game.overcrowdIncidents,
    state: game.state,
  });
}

const fmt = (n, w = 8, d = 1) => String(n.toFixed(d)).padStart(w);
console.log(`autopilot, ${runs} runs up to ${minutes} min each (30 fps sim)\n`);
console.log('  seed  survived  week  stations  lines  delivered   score  incidents  state');
for (const r of rows) {
  console.log(
    `${String(r.seed).padStart(6)}${fmt(r.survived)}${fmt(r.week, 6, 0)}${fmt(r.stations, 10, 0)}${fmt(r.lines, 7, 0)}` +
      `${fmt(r.delivered, 11, 0)}${fmt(r.score, 8, 0)}${fmt(r.incidents, 11, 0)}  ${r.state}`,
  );
}

const survived = rows.map((r) => r.survived);
const avg = survived.reduce((a, b) => a + b, 0) / survived.length;
const worst = Math.min(...survived);
console.log(`\naverage survival: ${(avg / 60).toFixed(1)} min   worst: ${(worst / 60).toFixed(1)} min`);
const medianDelivered = rows.map((r) => r.delivered).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
console.log(`median passengers delivered: ${medianDelivered}`);
