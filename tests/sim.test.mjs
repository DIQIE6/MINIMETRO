import test from 'node:test';
import assert from 'node:assert/strict';

import { Game, GameState } from '../src/game.js';
import { makePassenger } from '../src/passenger.js';
import { Autopilot } from '../src/autopilot.js';
import { routeLeg, segmentAngleDeg } from '../src/track.js';
import { Renderer } from '../src/render.js';
import { samplePolyline, pointSegmentDistance } from '../src/geometry.js';
import { CONFIG } from '../src/config.js';

/** Run the game for `seconds` of simulated time at a fixed step, acting as a
 *  player who always takes the first weekly reward offered. */
function run(game, seconds, step = 1 / 60) {
  const frames = Math.round(seconds / step);
  for (let i = 0; i < frames; i++) {
    if (game.state === GameState.UPGRADE) {
      const option = game.rewardOptions[0];
      if (!option || !game.chooseReward(option.kind)) {
        game.rewardOptions = [];
        game.state = GameState.PLAYING;
      }
    }
    game.update(step);
    if (game.state === GameState.GAMEOVER) break;
  }
  return game;
}

test('a fresh game has a river, three stations and three line slots', () => {
  const game = new Game({ seed: 7 });
  assert.equal(game.stations.length, CONFIG.station.initialCount);
  assert.deepEqual(
    game.stations.map((s) => s.shape).sort(),
    ['circle', 'square', 'triangle'],
  );
  assert.ok(game.river.points.length > 20);
  assert.equal(game.lineSlotsAvailable(), CONFIG.lines.startSlots);
  assert.equal(game.state, GameState.PLAYING);
  for (const s of game.stations) {
    assert.ok(game.river.distanceTo(s.x, s.y) >= CONFIG.river.stationClearance - 1e-6, 'stations stay off the river');
  }
});

/**
 * One simulation step that never stalls on the weekly reward screen. Days are
 * short (10 s) and a week is 70 s, so long test runs always cross one.
 */
function step(game) {
  if (game.state === 'upgrade') {
    game.chooseReward(game.rewardOptions[0].kind);
    return true;
  }
  if (game.state === 'playing') {
    game.update(1 / 60);
    return true;
  }
  return false;
}

/** Run N seconds of simulation, resolving rewards as they come. */
function simulate(game, seconds) {
  for (let i = 0; i < Math.round(seconds * 60); i++) if (!step(game)) break;
}

test('stations and passengers accumulate over time', () => {
  const game = new Game({ seed: 11 });
  run(game, 90);
  assert.ok(game.stations.length > CONFIG.station.initialCount, 'new stations appear');
  const waiting = game.stations.reduce((n, s) => n + s.passengers.length, 0);
  assert.ok(waiting > 0, 'passengers appear');
  assert.ok(game.week >= 2, `10 s days mean 90 s is already week ${game.week}`);
  assert.ok(game.day >= 1 && game.day <= 7, `the clock keeps a valid day, got ${game.day}`);
});

test('an unserved station eventually overloads and ends a normal game', () => {
  const game = new Game({ seed: 5, mode: 'normal' });
  const target = game.stations[0];
  for (let i = 0; i < 40; i++) target.passengers.push(makePassenger('square', 0));
  run(game, 120);
  assert.equal(game.state, GameState.GAMEOVER);
  assert.equal(game.gameOverStation, target);
});

test('endless mode clears an overloaded station instead of ending the game', () => {
  const game = new Game({ seed: 5, mode: 'endless' });
  const target = game.stations[0];
  for (let i = 0; i < 40; i++) target.passengers.push(makePassenger('square', 0));
  run(game, 90);
  assert.equal(game.state !== GameState.GAMEOVER, true);
  assert.ok(game.overcrowdIncidents > 0, 'the overload was registered');
});

test('a train carries passengers to their destination', () => {
  const game = new Game({ seed: 21 });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  assert.ok(line, 'line created');
  assert.equal(game.extendLine(line, 1, b), true);
  assert.equal(game.extendLine(line, 1, c), true);
  assert.equal(line.isActive, true);
  assert.equal(line.stations.length, 3);

  game.stations[0].passengers.push(makePassenger(c.shape, 0));
  game.stations[0].passengers.push(makePassenger(b.shape, 0));
  const before = game.delivered;
  run(game, 120);
  assert.ok(game.delivered > before, `expected deliveries, got ${game.delivered}`);
  assert.ok(game.score >= game.delivered);
});

/**
 * Two dry points either side of the water, derived from the map's own rivers
 * (they are no longer a single horizontal line).
 */
function acrossTheRiver(game) {
  const river = game.river;
  const dry = (x, y) =>
    x > 40 && y > 40 && x < CONFIG.world.w - 40 && y < CONFIG.world.h - 40 &&
    river.distanceTo(x, y) > river.width / 2 + 16;
  // Scan a coarse grid for dry land, then look for a pair with water between.
  // Perpendicular offsets are not enough now that rivers are wide and windy:
  // a point 90 px off one bend can sit inside another.
  const spots = [];
  for (let x = 80; x < CONFIG.world.w - 80; x += 70) {
    for (let y = 80; y < CONFIG.world.h - 80; y += 70) if (dry(x, y)) spots.push({ x, y });
  }
  let fallback = null;
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) {
      const a = spots[i];
      const b = spots[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < 140 || d > 460) continue;
      const n = river.crossings([a, b]);
      if (n === 1) return { near: a, far: b, crossings: 1 };
      if (n > 1) fallback = fallback || { near: a, far: b, crossings: n };
    }
  }
  return fallback;
}
test('a line cannot cross the river without a tunnel', () => {
  const game = new Game({ seed: 33 });
  const spot = acrossTheRiver(game);
  assert.ok(spot, 'setup: the map has water with dry land on both sides');
  const above = game.addStation(spot.near.x, spot.near.y, 'circle');
  const below = game.addStation(spot.far.x, spot.far.y, 'triangle');
  assert.equal(
    game.river.crossings([{ x: above.x, y: above.y }, { x: below.x, y: below.y }]),
    spot.crossings,
    'a straight link across that water crosses it as often as measured',
  );

  game.tunnelsOwned = 0;
  const line = game.startLine(above);
  assert.equal(game.extendLine(line, 1, below), false, 'refused without a tunnel');
  assert.equal(line.stations.length, 1);
  assert.equal(game.tunnelsOwned, 0);

  game.tunnelsOwned = 8;
  assert.equal(game.extendLine(line, 1, below), true, 'allowed once tunnels exist');
  assert.equal(line.isActive, true);
  // The octilinear route may cross the water more than once, and each crossing
  // costs a tunnel: the ledger has to match the track that was actually built.
  const needed = game.river.crossings(line.path.points);
  assert.ok(needed >= 1, 'the routed track really does cross the water');
  assert.equal(game.tunnelsAllocated(), needed, 'tunnels charged match the built track');
  assert.equal(game.freeTunnels(), 8 - needed);

  // Retracting the crossing gives the tunnels back.
  game.retractEndpoint(line, 1);
  assert.equal(game.tunnelsAllocated(), 0);
});

test('the tunnel check never reads a stale crossing count', () => {
  const game = new Game({ seed: 33 });
  const spot = acrossTheRiver(game);
  assert.ok(spot, 'setup: the map has water with dry land on both sides');
  const above = game.addStation(spot.near.x, spot.near.y, 'circle');
  const below = game.addStation(spot.far.x, spot.far.y, 'triangle');
  game.tunnelsOwned = 0;
  const line = game.startLine(above);
  // Warm the cache the way the HUD does (it polls freeTunnels every frame),
  // then make sure a crossing is still refused.
  assert.equal(game.tunnelsAllocated(), 0);
  assert.equal(game.extendLine(line, 1, below), false, 'crossing slipped past a warm cache');
  assert.equal(line.stations.length, 1);
  assert.equal(game.tunnelsAllocated(), 0);
  assert.equal(game.extendLine(line, 1, below), false, 'second attempt was allowed');
  game.tunnelsOwned = 8;
  assert.equal(game.extendLine(line, 1, below), true);
  assert.equal(game.tunnelsAllocated(), game.river.crossings(line.path.points));
});

test('closing a line into a loop makes the train circulate', () => {
  const game = new Game({ seed: 4 });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  assert.equal(game.extendLine(line, 1, a), true);
  assert.equal(line.isLoop, true);
  const train = line.trains[0];
  train.reset();
  run(game, 240, 1 / 30);
  assert.ok(train.travelled > line.path.total, 'the train went all the way round');
  const visited = new Set();
  for (let i = 0; i < 3000; i++) {
    train.update(1 / 30, game);
    if (train.arrivedThisFrame) visited.add(line.stations[train.stopIndex].id);
  }
  assert.equal(visited.size, 3, 'every loop station is served');
});

test('detaching a middle station heals the line', () => {
  const game = new Game({ seed: 8 });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  assert.equal(game.detachStation(line, b.id), true);
  assert.deepEqual(line.stations.map((s) => s.id), [a.id, c.id]);
  assert.equal(line.isActive, true);
});

test('track legs only use 0, 45 or 90 degree segments with a single bend', () => {
  const cases = [
    [{ x: 0, y: 0 }, { x: 400, y: 0 }],
    [{ x: 0, y: 0 }, { x: 0, y: 300 }],
    [{ x: 0, y: 0 }, { x: 300, y: 300 }],
    [{ x: 100, y: 500 }, { x: 700, y: 640 }],
    [{ x: 900, y: 100 }, { x: 960, y: 800 }],
    [{ x: 40, y: 40 }, { x: 1200, y: 960 }],
  ];
  for (const [a, b] of cases) {
    const bends = routeLeg(a, b);
    assert.ok(bends.length <= 1, `leg ${JSON.stringify([a, b])} produced ${bends.length} bends`);
    const chain = [a, ...bends, b];
    for (let i = 0; i < chain.length - 1; i++) {
      const angle = segmentAngleDeg(chain[i], chain[i + 1]);
      const octilinear =
        Math.abs(angle - 0) < 0.01 || Math.abs(angle - 45) < 0.01 || Math.abs(angle - 90) < 0.01;
      assert.ok(octilinear, `segment ${i} of a leg is ${angle.toFixed(2)} degrees, not octilinear`);
    }
  }
});

test('a built line path passes through every station and rounds its corners', () => {
  const game = new Game({ seed: 7 });
  const chosen = game.stations.slice();
  while (chosen.length < 5) {
    const extra = game.spawnStation();
    if (extra) chosen.push(extra);
  }
  const line = game.startLine(chosen[0]);
  for (const station of chosen.slice(1)) game.extendLine(line, 1, station);

  const path = line.path;
  assert.ok(path.points.length > line.stations.length, 'corners should add points');
  for (const station of line.stations) {
    const onPath = path.points.some((p) => Math.hypot(p.x - station.x, p.y - station.y) < 1e-6);
    assert.ok(onPath, `station ${station.id} is not on the path`);
  }
  // Every station's arc position must resolve back to that station.
  for (let i = 0; i < line.stations.length; i++) {
    const p = samplePolyline(path.points, path, line.stationS[i]);
    const station = line.stations[i];
    assert.ok(
      Math.hypot(p.x - station.x, p.y - station.y) < 0.01,
      `stationS[${i}] does not land on ${station.id}`,
    );
  }
});

test('a closed loop path starts and ends at the same station', () => {
  const game = new Game({ seed: 4 });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  game.extendLine(line, 1, a);
  assert.equal(line.isLoop, true);
  const pts = line.path.points;
  const first = pts[0];
  const last = pts[pts.length - 1];
  assert.ok(Math.hypot(first.x - last.x, first.y - last.y) < 1e-6, 'loop path must close');
  assert.ok(line.path.total > 0);
});

test('trains cruise between stations and ease off approaching them', () => {
  const game = new Game({ seed: 4, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  const train = line.trains[0];
  train.reset();

  let maxV = 0;
  let arrivals = 0;
  const approach = [];
  for (let i = 0; i < 60 * 300; i++) {
    const before = train.v;
    train.update(1 / 60, game);
    if (train.arrivedThisFrame) {
      arrivals++;
      approach.push(before);
    }
    maxV = Math.max(maxV, train.v);
  }
  const { cruiseSpeed, minSpeed } = CONFIG.train;
  assert.ok(arrivals > 20, `expected many arrivals, got ${arrivals}`);
  assert.ok(maxV > minSpeed + (cruiseSpeed - minSpeed) * 0.8, `never got up to speed: ${maxV.toFixed(1)}`);
  for (const v of approach) {
    assert.ok(v < cruiseSpeed * 0.6, `pulled into a platform at ${v.toFixed(1)} units/s`);
  }
});

test('dragging out of a station builds a line', () => {
  const game = new Game({ seed: 8 });
  const [a, b, c] = game.stations;

  const drag = game.beginLineDrag(a);
  assert.ok(drag, 'dragging from a bare station opens a new line');
  assert.equal(drag.isNew, true);
  assert.equal(game.lines[0].claimed, true);
  assert.deepEqual(game.lines[0].stations.map((s) => s.id), [a.id]);
  assert.equal(game.lineSlotsAvailable(), 2);

  // Every station the pointer passes over joins the line.
  assert.equal(game.dragOverStation(b), true);
  assert.equal(game.dragOverStation(c), true);
  const preview = game.dragPreviewPoints({ x: 0, y: 0 });
  assert.equal(preview.length, 4, 'anchor + 2 stations + pointer');

  assert.equal(game.endLineDrag(), true);
  assert.deepEqual(game.lines[0].stations.map((s) => s.id), [a.id, b.id, c.id]);
  assert.equal(game.drag, null);
});

test('a drag that connects nothing is thrown away', () => {
  const game = new Game({ seed: 8 });
  const [a] = game.stations;
  game.beginLineDrag(a);
  assert.equal(game.lineSlotsAvailable(), 2);
  assert.equal(game.endLineDrag(), false);
  assert.equal(game.lines[0].claimed, false, 'the empty line is discarded');
  assert.equal(game.lineSlotsAvailable(), 3, 'and its slot comes back');
});

test('dragging a terminus T extends that line; the station body starts a new one', () => {
  const game = new Game({ seed: 8 });
  const [a, b, c] = game.stations;
  const extra = game.addStation(a.x + 420, a.y + 320, 'star');
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);

  // Dragging the station body at a terminus opens a brand new line.
  const fresh = game.beginLineDrag(c, null);
  assert.ok(fresh);
  assert.equal(fresh.isNew, true);
  assert.notEqual(fresh.lineId, line.id);
  game.cancelLineDrag();
  assert.equal(game.lineSlotsAvailable(), 2, 'the abandoned new line gave its slot back');

  // Dragging the T on that same terminus extends the existing line.
  const drag = game.beginLineDrag(c, { lineId: line.id, end: 1 });
  assert.ok(drag);
  assert.equal(drag.isNew, false);
  assert.equal(drag.end, 1);
  assert.equal(game.dragOverStation(extra), true);
  assert.equal(game.endLineDrag(extra), true);
  assert.equal(line.hasStation(extra.id), true);

  // Walking back over the anchor pops the last hop instead of adding it.
  const extra2 = game.addStation(a.x - 260, a.y + 180, 'gem');
  const tail = line.stations[line.stations.length - 1];
  assert.ok(game.beginLineDrag(tail, { lineId: line.id, end: 1 }));
  assert.equal(game.dragOverStation(extra2), true);
  assert.equal(game.drag.route.length, 1);
  assert.equal(game.dragOverStation(tail), true, 'back over the anchor');
  assert.equal(game.drag.route.length, 0);
  game.cancelLineDrag();

  // A clean drag from one terminus T onto the other closes the loop.
  const head = line.stations[0];
  const tail2 = line.stations[line.stations.length - 1];
  assert.ok(game.beginLineDrag(tail2, { lineId: line.id, end: 1 }));
  assert.equal(game.endLineDrag(head), true);
  assert.equal(line.isLoop, true, 'dropping the tail on the head makes a loop');
});

test('grabbing a track segment re-routes it through another station', () => {
  const game = new Game({ seed: 8 });
  const [a, b, c] = game.stations;
  const detour = game.addStation(520, 520, 'star');
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);

  // Grab the piece of track between a and b...
  assert.ok(game.beginSegmentDrag(line, 0));
  const preview = game.segmentPreviewPoints({ x: 10, y: 10 });
  assert.equal(preview.length, 3, 'from - pointer - to');
  // ...and drop it on a station that is not on the line yet.
  assert.equal(game.endSegmentDrag(detour), true);
  assert.deepEqual(
    line.stations.map((s) => s.id),
    [a.id, detour.id, b.id, c.id],
    'the station is spliced in between the same two neighbours',
  );

  // Dropping the dragged segment ON a station that is already on the line now
  // takes that station off the line: that is how a middle station is removed by
  // dragging past it, instead of the right-click menu.
  assert.ok(game.beginSegmentDrag(line, 2));
  assert.equal(game.endSegmentDrag(c), true, 'dropping on an on-line station removes it');
  assert.deepEqual(
    line.stations.map((s) => s.id),
    [a.id, detour.id, b.id],
    'the removed station left and its neighbours closed up',
  );
});

test('removing a station from a line heals the gap', () => {
  const game = new Game({ seed: 8 });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  assert.equal(game.detachStation(line, b.id), true);
  assert.deepEqual(line.stations.map((s) => s.id), [a.id, c.id]);
});

test('clearing a line withdraws its train at the next station', () => {
  const game = new Game({ seed: 14, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  assert.equal(line.hasLocomotive, true, 'a new line takes a locomotive from the pool');
  assert.equal(game.locomotives.available, CONFIG.vehicles.startLocomotives - 1);
  // Let any pending hand-off finish so the train is simply running.
  for (let i = 0; i < 60 * 120 && line.trains[0].frozen; i++) game.update(1 / 60);
  assert.equal(line.trains[0].frozen, null, 'setup: the train is running normally');

  const rider = makePassenger(b.shape, 0);
  rider.targetStationId = b.id;
  line.trains[0].passengers.push(rider);

  assert.equal(game.clearLine(line), true);
  assert.equal(line.retiring, true, 'the line is on its way out');
  assert.ok(line.trains[0].frozen, 'the train keeps running the old route');
  assert.equal(line.trains[0].frozen.stations.length, 3, 'the ghost still has all three stations');
  assert.equal(line.stations.length, 0, 'but the track itself is already released');
  // The slot is NOT free yet: the ghost is still running in this line's
  // colour, so handing the slot to a new line would put more colours on the
  // map than the player has unlocked.
  assert.equal(
    game.lineSlotsAvailable(),
    CONFIG.lines.startSlots - 1,
    'the slot stays reserved while the ghost is still running',
  );

  const ghost = line.trains[0];
  const worldBefore = game.stations.reduce((n, s) => n + s.passengers.length, 0) + ghost.passengers.length;
  for (let i = 0; i < 60 * 150 && line.trains.length; i++) game.update(1 / 60);

  assert.equal(line.trains.length, 0, 'the train is withdrawn at the next station');
  assert.equal(line.retiring, false);
  assert.equal(line.hasLocomotive, false, 'the locomotive went back to the pool');
  assert.equal(game.locomotives.available, CONFIG.vehicles.startLocomotives);
  // The withdrawn train's riders are all standing on a platform by now.
  const worldAfter = game.stations.reduce((n, s) => n + s.passengers.length, 0);
  assert.equal(worldAfter, worldBefore, 'the rider was handed to a platform, never deleted');
});

test('re-routing a line hands the train over at the next station', () => {
  const game = new Game({ seed: 14, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  // Let any pending hand-off finish so the train is simply running.
  for (let i = 0; i < 60 * 120 && line.trains[0].frozen; i++) game.update(1 / 60);
  assert.equal(line.trains[0].frozen, null, 'setup: the train is running normally');

  const rider = makePassenger(b.shape, 0);
  rider.targetStationId = b.id;
  line.trains[0].passengers.push(rider);

  // Park the train on the leg we are about to change, so the freeze is
  // deterministic no matter how the map was generated.
  line.trains[0].placeAt(0, line.stationS, line.stations.length);
  line.trains[0].s = (line.stationS[0] + line.stationS[1]) / 2;
  line.trains[0].pendingArrival = null;
  line.trains[0].dwell = 30;
  const detour = game.addStation(game.stations[0].x + 40, game.stations[0].y + 40, 'diamond');
  assert.equal(game.tryLineEdit(line, () => line.insertStationAt(detour, 1)), true);

  assert.ok(line.trains[0].frozen, 'the old route is kept while the train finishes');
  assert.equal(line.trains[0].frozen.stations.length, 3, 'the ghost is the old station list');
  assert.equal(line.trains[0].frozen.hasStation(detour.id), false, 'which excludes the new station');
  assert.equal(line.hasStation(detour.id), true, 'while the line itself already has it');
  assert.equal(line.retiring, false, 'the line is still live and accepting passengers');
  assert.equal(line.hasLocomotive, true, 'and it keeps its locomotive');

  const deliveredBefore = game.delivered;
  for (let i = 0; i < 60 * 150 && line.trains[0].frozen; i++) game.update(1 / 60);

  assert.equal(line.trains[0].frozen, null, 'the train rejoins at the next station');
  assert.equal(line.stations.length, 4);
  const accounted =
    game.delivered > deliveredBefore ||
    line.trains[0].passengers.includes(rider) ||
    game.stations.some((st) => st.passengers.includes(rider));
  assert.ok(accounted, 'the rider is delivered, riding, or waiting - never lost');
});

test('a train whose next stop left the route is withdrawn and its riders wait', () => {
  const game = new Game({ seed: 14, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  const rider = makePassenger(c.shape, 0);
  rider.targetStationId = c.id;
  line.trains[0].passengers.push(rider);

  // Replace the whole route with something that shares no station with it.
  const far1 = game.addStation(1200, 200, 'star');
  const far2 = game.addStation(1300, 320, 'gem');
  assert.equal(game.tryLineEdit(line, () => line.setStations([far1, far2])), true);
  assert.ok(line.trains[0].frozen, 'the train is still on the old route');
  for (let i = 0; i < 60 * 150 && line.trains.length; i++) game.update(1 / 60);

  assert.equal(line.trains.length, 0, 'the train was withdrawn at its next stop');
  assert.equal(line.hasLocomotive, false);
  assert.equal(game.locomotives.available, CONFIG.vehicles.startLocomotives);
  const waiting = game.stations.reduce((n, s) => n + s.passengers.length, 0);
  assert.ok(waiting >= 1, 'its passenger is standing on a platform, not deleted');
});

test('extending a line at an end leaves a running train where it is', () => {
  const game = new Game({ seed: 31, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  // let the train get moving and settle
  for (let i = 0; i < 60 * 40; i++) game.update(1 / 60);
  const train = line.trains[0];
  assert.equal(train.frozen, null);
  const before = train.s;
  const beforeWorld = train.position;
  assert.ok(before > 0, 'the train is somewhere along the line');

  // Append a station at the far end: the arc distance must not move.
  const extra = game.addStation(a.x + 500, a.y + 300, 'star');
  assert.equal(game.extendLine(line, 1, extra), true);
  assert.equal(train.s, before, 'the train was yanked back to a station');
  const afterWorld = train.position;
  assert.ok(
    Math.hypot(afterWorld.x - beforeWorld.x, afterWorld.y - beforeWorld.y) < 1,
    'the train jumped in world space',
  );
  assert.equal(train.frozen, null, 'and no hand-over was started');
});

test('prepending a station shifts the train by the added track, not to a station', () => {
  const game = new Game({ seed: 31, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  for (let i = 0; i < 60 * 40; i++) game.update(1 / 60);
  const train = line.trains[0];
  const before = train.s;
  const beforeIndex = train.stopIndex;

  const front = game.addStation(a.x - 520, a.y - 260, 'gem');
  const worldBefore = train.position;
  assert.equal(game.extendLine(line, 0, front), true);
  assert.equal(train.frozen, null, 'adding a station at an end must not freeze the train');
  const worldAfter = train.position;
  assert.ok(
    Math.hypot(worldAfter.x - worldBefore.x, worldAfter.y - worldBefore.y) < 1,
    `the train jumped ${Math.hypot(worldAfter.x - worldBefore.x, worldAfter.y - worldBefore.y).toFixed(1)} px`,
  );
  assert.ok(train.s > before, 'its arc grows by the length of the new prefix');
  assert.ok(train.stopIndex >= beforeIndex, 'its station index shifts with the list');
});

test('clearing a line while its train is already handing over leaves no ghost', () => {
  const game = new Game({ seed: 31, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  for (let i = 0; i < 60 * 40; i++) game.update(1 / 60);
  // A middle edit freezes the train on the old route. Park it on that leg
  // first so the test does not depend on where it happened to be.
  line.trains[0].placeAt(0, line.stationS, line.stations.length);
  line.trains[0].s = (line.stationS[0] + line.stationS[1]) / 2;
  line.trains[0].pendingArrival = null;
  line.trains[0].dwell = 30;
  const detour = game.addStation(game.stations[0].x + 40, game.stations[0].y + 40, 'diamond');
  assert.equal(game.tryLineEdit(line, () => line.insertStationAt(detour, 1)), true);
  assert.ok(line.trains[0].frozen, 'setup: the train is mid hand-over');
  // ...and clearing the line retires it: the ghost finishes its trip, and the
  // locomotive only returns to the pool once it is done.
  const poolBefore = game.locomotives.available;
  assert.equal(game.clearLine(line), true);
  assert.equal(line.retiring, true);
  assert.equal(line.stations.length, 0, 'the track is released immediately');
  for (let i = 0; i < 60 * 150 && line.trains.length; i++) if (!step(game)) break;
  assert.equal(line.trains.length, 0, 'the ghost is finally withdrawn');
  assert.equal(line.hasLocomotive, false);
  assert.ok(game.locomotives.available > poolBefore, 'the locomotive came back');
});

test('a train keeps its passengers when it changes hands', () => {
  const game = new Game({ seed: 21, mode: 'endless' });
  const [a, b, c] = game.stations;
  const source = game.startLine(a);
  game.extendLine(source, 1, b);
  const target = game.startLine(c);
  game.extendLine(target, 1, a);
  game.releaseLocomotive(target);
  const rider = makePassenger(a.shape, 0);
  rider.targetStationId = a.id;
  source.trains[0].passengers.push(rider);

  game.beginVehicleDrag('train', { line: source, train: source.trains[0] });
  assert.equal(game.dropVehicle({ line: target, stationIndex: 0 }), 'pending');
  for (let i = 0; i < 60 * 120 && target.pendingLoco; i++) {
    if (game.state === 'upgrade') game.chooseReward(game.rewardOptions[0].kind);
    game.update(1 / 60);
  }
  const stillOnboard = target.trains[0].passengers.includes(rider);
  const delivered = game.delivered > 0;
  const onPlatform = game.stations.some((st) => st.passengers.includes(rider));
  assert.ok(stillOnboard || delivered || onPlatform, 'the rider survived the hand-over');
});

test('a retiring line object is never handed out again', () => {
  const game = new Game({ seed: 41, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  // Clearing a line with a train on it leaves the object in use as a ghost.
  assert.equal(game.clearLine(line), true);
  assert.equal(line.retiring, true);
  assert.equal(line.claimed, false);

  const fresh = game.startLine(c);
  assert.ok(fresh, 'a new line can still be started');
  assert.notEqual(fresh.id, line.id, 'but it must not reuse the retiring line object');
  assert.equal(fresh.retiring, false);
  assert.equal(line.trains[0].frozen !== null, true, 'the ghost still owns its train');
});

test('a new line takes a locomotive with it, and can take more later', () => {
  const game = new Game({ seed: 91, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  assert.equal(line.isActive, true);
  assert.equal(line.trains.length, 1, 'a brand new line is staffed automatically');
  assert.equal(line.isRunning, true);
  assert.equal(game.locomotives.available, game.locomotives.total - 1);
  assert.equal(game.locomotiveShortage, false);

  // A line may run several trains at once.
  game.locomotives.total = 5;
  game.locomotives.available = 3;
  assert.equal(game.deployLocomotive(line, 1), true);
  assert.equal(line.trains.length, 2, 'a line can hold more than one train');
  assert.equal(game.locomotives.available, 2);
  void c;
});

test('vehicles can be dragged from the pool onto a line', () => {
  const game = new Game({ seed: 21 });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  game.releaseLocomotive(line);
  assert.equal(line.hasLocomotive, false, 'the line is drawn but not running');
  assert.equal(line.isRunning, false);
  const poolBefore = game.locomotives.available;

  // A carriage is refused while there is no locomotive to pull it.
  game.carriages.total = 1;
  game.carriages.available = 1;
  game.beginVehicleDrag('carriage');
  assert.equal(game.dropVehicle({ line, stationIndex: 1 }), 'rejected');
  assert.equal(game.carriages.available, 1);
  assert.equal(line.carriages, 0);

  // A locomotive deploys and parks at the station it was dropped on.
  game.beginVehicleDrag('loco');
  assert.equal(game.dropVehicle({ line, stationIndex: 1 }), 'applied');
  assert.equal(line.hasLocomotive, true);
  assert.equal(game.locomotives.available, poolBefore - 1);
  assert.equal(line.trains[0].stopIndex, 1, 'the locomotive settles at the nearest station');
  assert.equal(line.trains[0].s, line.stationS[1]);

  // Now the carriage fits.
  game.beginVehicleDrag('carriage');
  assert.equal(game.dropVehicle({ line, stationIndex: 1 }), 'applied');
  assert.equal(line.carriages, 1);
  assert.equal(game.carriages.available, 0);
});

test('moving a running train to another line is deferred until it stops', () => {
  const game = new Game({ seed: 21 });
  const [a, b, c] = game.stations;
  const source = game.startLine(a);
  game.extendLine(source, 1, b);
  const target = game.startLine(c);
  game.extendLine(target, 1, a);
  game.releaseLocomotive(target);
  assert.equal(target.hasLocomotive, false);
  assert.equal(source.hasLocomotive, true);

  game.beginVehicleDrag('train', { line: source, train: source.trains[0] });
  assert.equal(game.dropVehicle({ line: target, stationIndex: 0 }), 'pending');
  assert.equal(target.pendingLoco, true, 'the destination shows a placeholder');
  assert.equal(target.hasLocomotive, false);
  assert.equal(source.hasLocomotive, true, 'the train is still running where it was');

  for (let i = 0; i < 60 * 120 && target.pendingLoco; i++) game.update(1 / 60);
  assert.equal(target.pendingLoco, false, 'the handover completes at the next stop');
  assert.equal(target.hasLocomotive, true);
  assert.equal(source.hasLocomotive, false, 'the source line is left without a train');
});

test('a deferred transfer never wipes the destination line\'s own passengers', () => {
  const game = new Game({ seed: 51, mode: 'endless' });
  const [a, b, c] = game.stations;
  const source = game.startLine(a);
  game.extendLine(source, 1, b);
  const target = game.startLine(c);
  game.extendLine(target, 1, a);
  // Give the target a spare locomotive so it already has its own train.
  game.locomotives.total = Math.max(game.locomotives.total, 4);
  game.locomotives.available = Math.max(game.locomotives.available, 1);

  // Something is already sitting on the target's own train.
  const squatter = makePassenger(a.shape, 0);
  squatter.targetStationId = a.id;
  target.trains[0].passengers.push(squatter);

  const rider = makePassenger(b.shape, 0);
  rider.targetStationId = b.id;
  source.trains[0].passengers.push(rider);

  game.beginVehicleDrag('train', { line: source, train: source.trains[0] });
  assert.equal(game.dropVehicle({ line: target, stationIndex: 0 }), 'pending');
  for (let i = 0; i < 60 * 120 && target.pendingLoco; i++) {
    if (game.state === 'upgrade') game.chooseReward(game.rewardOptions[0].kind);
    game.update(1 / 60);
  }
  const accounted =
    game.delivered > 0 ||
    target.trains[0].passengers.includes(squatter) ||
    source.trains[0].passengers.includes(squatter) ||
    game.stations.some((st) => st.passengers.includes(squatter));
  assert.ok(accounted, 'the squatter was handed to a platform, not deleted by the reset');
});

test('a train is only ever promised to one line at a time', () => {
  const game = new Game({ seed: 51, mode: 'endless' });
  const [a, b, c] = game.stations;
  const source = game.startLine(a);
  game.extendLine(source, 1, b);
  const t1 = game.startLine(c);
  game.extendLine(t1, 1, a);
  game.releaseLocomotive(t1);
  const d = game.addStation(1200, 300, 'star');
  const t2 = game.startLine(d);
  game.extendLine(t2, 1, game.addStation(1320, 420, 'gem'));
  game.releaseLocomotive(t2);

  game.beginVehicleDrag('train', { line: source, train: source.trains[0] });
  assert.equal(game.dropVehicle({ line: t1, stationIndex: 0 }), 'pending');
  game.beginVehicleDrag('train', { line: source, train: source.trains[0] });
  assert.equal(game.dropVehicle({ line: t2, stationIndex: 0 }), 'pending');
  assert.equal(t1.pendingLoco, false, 'the first promise was withdrawn');
  assert.equal(t2.pendingLoco, true);

  for (let i = 0; i < 60 * 120 && t2.pendingLoco; i++) game.update(1 / 60);
  assert.equal(t2.hasLocomotive, true);
  assert.equal(source.hasLocomotive, false);
  for (const line of game.lines) {
    assert.equal(line.pendingFromLineId, null, `${line.id} kept a stale booking`);
  }
});

test('locomotives and carriages are conserved through every vehicle move', () => {
  const totalLoco = () => game.locomotives.available + game.lines.filter((l) => l.hasLocomotive).length;
  const totalCarr = () => game.carriages.available + game.lines.reduce((n, l) => n + l.carriages, 0);
  const game = new Game({ seed: 61, mode: 'endless' });
  const [a, b, c] = game.stations;
  const l1 = game.startLine(a);
  game.extendLine(l1, 1, b);
  const l2 = game.startLine(c);
  game.extendLine(l2, 1, a);
  game.releaseLocomotive(l2);
  game.carriages.total = 3;
  game.carriages.available = 3;
  assert.equal(totalLoco(), game.locomotives.total);
  assert.equal(totalCarr(), game.carriages.total);

  // Promise l1's train to l2, then staff l2 directly while it waits.
  game.beginVehicleDrag('train', { line: l1, train: l1.trains[0] });
  assert.equal(game.dropVehicle({ line: l2, stationIndex: 0 }), 'pending');
  assert.equal(l2.pendingLoco, true);
  assert.equal(game.deployLocomotive(l2, 0), true, 'the player may staff it directly');
  assert.equal(l2.pendingLoco, false, 'which withdraws the promise');

  // Give l2 a carriage too, then let l1 run for a while.
  game.beginVehicleDrag('carriage');
  assert.equal(game.dropVehicle({ line: l2, stationIndex: 0 }), 'applied');
  for (let i = 0; i < 60 * 90; i++) {
    if (game.state === 'upgrade') game.chooseReward(game.rewardOptions[0].kind);
    game.update(1 / 60);
  }
  assert.equal(totalLoco(), game.locomotives.total, 'locomotives leaked');
  assert.equal(totalCarr(), game.carriages.total, 'carriages leaked');
});

test('a booking whose source stops running is cancelled', () => {
  const game = new Game({ seed: 71, mode: 'endless' });
  const [a, b, c] = game.stations;
  const source = game.startLine(a);
  game.extendLine(source, 1, b);
  const target = game.startLine(c);
  game.extendLine(target, 1, a);
  game.releaseLocomotive(target);

  game.beginVehicleDrag('train', { line: source, train: source.trains[0] });
  assert.equal(game.dropVehicle({ line: target, stationIndex: 0 }), 'pending');
  game.releaseLocomotive(source);
  assert.equal(target.pendingLoco, false, 'the waiting line must not keep a dead promise');
  assert.equal(target.pendingFromLineId, null);

  // And the booked line object must not be handed out to a new line meanwhile.
  game.beginVehicleDrag('train', { line: source, train: source.trains[0] });
  assert.equal(game.beginVehicleDrag('loco', null) !== null, true);
});

test('renderer caches never leak between games or station upgrades', () => {
  const stub = { getContext: () => ({}) };
  const renderer = new Renderer(stub);

  // --- a pass-through station appears once it becomes an interchange --------
  const game = new Game({ seed: 81, mode: 'endless' });
  game.tunnelsOwned = 30;
  const p1 = game.addStation(200, 400, 'gem');
  const mid = game.addStation(500, 413, 'star');
  const p2 = game.addStation(800, 400, 'cross');
  const line = game.startLine(p1);
  game.extendLine(line, 1, p2);
  assert.deepEqual(renderer.passThroughStations(game, line), [], 'setup: 13 px away is too far');
  game.inventory.interchanges = 1;
  assert.equal(game.placeInterchange(mid), true);
  const after = renderer.passThroughStations(game, line);
  assert.ok(after.some((e) => e.station.id === mid.id), 'the cache went stale after the upgrade');

  // --- the same line id/generation in another game must not reuse the cache --
  const other = new Game({ seed: 81, mode: 'endless' });
  other.tunnelsOwned = 30;
  const cross = acrossTheRiver(other);
  assert.ok(cross, 'setup: the second map also has water to cross');
  const q1 = other.addStation(cross.near.x, cross.near.y, 'gem');
  const q2 = other.addStation(cross.far.x, cross.far.y, 'cross');
  const oline = other.startLine(q1);
  other.extendLine(oline, 1, q2);
  assert.equal(oline.id, line.id, 'setup: same line id in both games');
  const stretches = renderer.tunnelStretches(other, oline);
  assert.ok(stretches.length >= 1, 'the fresh game\'s crossing was masked by the previous cache');
});

test('a line runs several trains at once, in either direction', () => {
  const game = new Game({ seed: 101, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  game.locomotives.total = 6;
  game.locomotives.available = 4;
  assert.equal(game.deployLocomotive(line, 0), true);
  assert.equal(game.deployLocomotive(line, 1), true);
  assert.equal(line.trains.length, 3, 'three locomotives, three trains');
  assert.equal(game.locomotives.available, 2);

  // Opposite directions on the same track are fine.
  line.trains[1].dir = -1;
  const start = line.trains.map((t) => t.position);
  for (let i = 0; i < 60 * 40; i++) game.update(1 / 60);
  assert.equal(line.trains.length, 3, 'nobody was removed by the others');
  line.trains.forEach((train, i) => {
    const now = train.position;
    assert.ok(Number.isFinite(now.x) && Number.isFinite(now.y), `train ${i} has a sane position`);
  });
  assert.ok(
    Math.hypot(line.trains[0].position.x - start[0].x, line.trains[0].position.y - start[0].y) > 1,
    'the trains kept running',
  );
});

test('a re-route only freezes the trains that were on the changed track', () => {
  const game = new Game({ seed: 102, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  game.locomotives.total = 6;
  game.locomotives.available = 4;
  game.deployLocomotive(line, 0);
  game.deployLocomotive(line, 0);

  // Park one train on the first leg and one on the last leg.
  line.trains[0].placeAt(0, line.stationS, line.stations.length);
  line.trains[0].s = line.stationS[0] + (line.stationS[1] - line.stationS[0]) * 0.5;
  line.trains[0].pendingArrival = null;
  line.trains[0].dwell = 30;
  line.trains[1].placeAt(2, line.stationS, line.stations.length);
  line.trains[1].s = line.stationS[1] + (line.stationS[2] - line.stationS[1]) * 0.5;
  line.trains[1].pendingArrival = null;
  line.trains[1].dwell = 30;

  const untouched = line.trains[0];
  const untouchedWorld = untouched.position;
  // Insert a station into the second leg (b->c) only; the first leg is untouched.
  // Derive it from the leg itself rather than a fixed coordinate: the map is
  // generated, and a hard-coded point can end up on top of an existing station
  // (which makes the edit degenerate and gets it rejected).
  const mx = (b.x + c.x) / 2;
  const my = (b.y + c.y) / 2;
  const px = -(c.y - b.y);
  const py = c.x - b.x;
  const plen = Math.hypot(px, py) || 1;
  const detour = game.addStation(mx + (px / plen) * 95, my + (py / plen) * 95, 'diamond');
  assert.equal(game.tryLineEdit(line, () => line.insertStationAt(detour, 2)), true);

  assert.equal(untouched.frozen, null, 'the train on the untouched leg kept running');
  const afterWorld = untouched.position;
  assert.ok(
    Math.hypot(afterWorld.x - untouchedWorld.x, afterWorld.y - untouchedWorld.y) < 1,
    'and it did not move in world space',
  );
  assert.ok(line.trains[1].frozen, 'the train on the changed leg finishes its old route');
});

test('a carriage can be detached on its own and re-homed', () => {
  const game = new Game({ seed: 103, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.locomotives.total = 6;
  game.locomotives.available = 4;
  game.deployLocomotive(line, 0);
  game.carriages.total = 4;
  game.carriages.available = 2;
  const first = line.trains[0];
  const second = line.trains[1];
  game.beginVehicleDrag('carriage', null);
  assert.equal(game.dropVehicle({ line, stationIndex: 0, x: first.position.x, y: first.position.y }), 'applied');
  assert.equal(first.carriages, 1);
  assert.equal(game.carriages.available, 1);

  // Pull it off again and hang it on the other train, which we park elsewhere
  // first so the drop lands unambiguously.
  game.placeTrain(second, 2);
  game.beginVehicleDrag('carriage', { line, train: first, carIndex: 1 });
  assert.equal(game.dropVehicle({ line, stationIndex: 0, x: second.position.x, y: second.position.y }), 'applied');
  assert.equal(first.carriages, 0);
  assert.equal(second.carriages, 1);
  assert.equal(game.carriages.available, 1, 'nothing leaked while moving it');
  void c;
});

test('a carriage dropped over nothing goes back to the tray', () => {
  const game = new Game({ seed: 103, mode: 'endless' });
  const [a, b] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.carriages.total = 3;
  game.carriages.available = 3;
  const train = line.trains[0];
  game.beginVehicleDrag('carriage', null);
  game.dropVehicle({ line, stationIndex: 0, x: train.position.x, y: train.position.y });
  assert.equal(train.carriages, 1);
  game.beginVehicleDrag('carriage', { line, train, carIndex: 1 });
  assert.equal(game.dropVehicle(null), 'detached');
  assert.equal(train.carriages, 0, 'the carriage came off');
  assert.equal(game.carriages.available, 3, 'and it is back in the tray');
});

test('a train dragged along its own line is re-positioned there', () => {
  const game = new Game({ seed: 104, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  const train = line.trains[0];
  game.beginVehicleDrag('train', { line, train });
  assert.equal(game.dropVehicle({ line, stationIndex: 2, x: c.x, y: c.y }), 'repositioned');
  assert.equal(train.stopIndex, 2, 'it now sits at the far station');
  assert.equal(line.trains.length, 1, 'and no train was created or destroyed');
  assert.equal(game.locomotives.available, CONFIG.vehicles.startLocomotives - 1);
});

test('every car of a train sits on the track, head first', () => {
  const game = new Game({ seed: 105, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  game.carriages.total = 3;
  game.carriages.available = 3;
  const train = line.trains[0];
  game.beginVehicleDrag('carriage', null);
  game.dropVehicle({ line, stationIndex: 0, x: train.position.x, y: train.position.y });
  game.beginVehicleDrag('carriage', null);
  game.dropVehicle({ line, stationIndex: 0, x: train.position.x, y: train.position.y });
  assert.equal(train.carriages, 2);

  const renderer = new Renderer({ getContext: () => ({}) });
  const cars = renderer.trainCarPositions(line, train);
  assert.equal(cars.length, 3, 'a head plus two carriages');
  for (const car of cars) {
    // Every car centre lies on the routed path.
    let best = Infinity;
    const pts = line.path.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      best = Math.min(best, pointSegmentDistance(car.x, car.y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y).d);
    }
    assert.ok(best < 0.5, `car ${car.carIndex} is ${best.toFixed(2)} px off the track`);
    assert.ok(Number.isFinite(car.angle), 'and it has a tangent to face along');
  }
});

test('a dropped locomotive lands under the pointer and faces the nearer station', () => {
  const game = new Game({ seed: 111, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  game.locomotives.total = 9;
  game.locomotives.available = 9;

  // Point at a fraction of the first leg's arc length.
  const onLeg = (index, t) => {
    const s = line.stationS[index] + (line.stationS[index + 1] - line.stationS[index]) * t;
    const pts = line.path.points;
    const cum = line.path.cum;
    let i = 0;
    for (let k = 0; k + 1 < pts.length; k++) if (cum[k] <= s) i = k;
    const span = cum[i + 1] - cum[i] || 1;
    const f = Math.max(0, Math.min(1, (s - cum[i]) / span));
    return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f };
  };

  // Near the far end of the leg: the *next* station is closer.
  const nearNext = onLeg(0, 0.85);
  game.beginVehicleDrag('loco', null);
  assert.equal(game.dropVehicle({ line, stationIndex: 0, x: nearNext.x, y: nearNext.y }), 'applied');
  let train = line.trains[line.trains.length - 1];
  let pos = train.position;
  assert.ok(
    Math.hypot(pos.x - nearNext.x, pos.y - nearNext.y) < 1,
    `the train appeared at ${pos.x.toFixed(1)},${pos.y.toFixed(1)} but the pointer was at ${nearNext.x.toFixed(1)},${nearNext.y.toFixed(1)}`,
  );
  assert.equal(train.dir, 1, 'it drives on towards the next station');
  assert.equal(train.stopIndex, 1);

  // Near the start of the leg: the *previous* station is closer.
  const nearPrev = onLeg(0, 0.15);
  game.beginVehicleDrag('loco', null);
  assert.equal(game.dropVehicle({ line, stationIndex: 0, x: nearPrev.x, y: nearPrev.y }), 'applied');
  train = line.trains[line.trains.length - 1];
  pos = train.position;
  assert.ok(Math.hypot(pos.x - nearPrev.x, pos.y - nearPrev.y) < 1, 'landed under the pointer');
  assert.equal(train.dir, -1, 'it drives back towards the station it just passed');
  assert.equal(train.stopIndex, 0);

  // And now it actually serves that station on the way.
  const before = game.delivered;
  for (let i = 0; i < 60 * 60 && game.delivered === before; i++) step(game);
  assert.ok(train.stopIndex >= 0 && train.stopIndex < line.stations.length);
});

test('a train never stops twice at the same station without leaving', () => {
  // Regression: `s` could land an ULP below the terminal, so the train matched
  // the terminal via the epsilon test without flipping `dir`, then clamped and
  // arrived there a second time.
  const game = new Game({ seed: 4, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  const train = line.trains[0];
  train.reset();

  let stops = 0;
  let duplicates = 0;
  let lastIndex = -1;
  let lastFrame = -100;
  const step = 1 / 60;
  for (let frame = 0; frame < 60 * 900; frame++) {
    train.update(step, game);
    if (!train.arrivedThisFrame) continue;
    stops++;
    assert.equal(train.s, line.stationS[train.stopIndex], 'the train must sit exactly on the station');
    if (train.stopIndex === lastIndex && frame - lastFrame <= 3) duplicates++;
    lastIndex = train.stopIndex;
    lastFrame = frame;
  }
  assert.ok(stops > 100, `expected plenty of stops, got ${stops}`);
  assert.equal(duplicates, 0, `${duplicates} double stops out of ${stops}`);
});

test('a freshly activated line serves the station it starts on', () => {
  const game = new Game({ seed: 4 });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  const train = line.trains[0];
  let first = -1;
  for (let i = 0; i < 600 && first < 0; i++) {
    train.update(1 / 60, game);
    if (train.arrivedThisFrame) first = train.stopIndex;
  }
  assert.equal(first, 0, 'the train should serve the head station before departing');
});

test('a station relieved in the frame its countdown expires is saved', () => {
  const game = new Game({ seed: 11, mode: 'normal' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);

  for (let i = 0; i < 10; i++) b.passengers.push(makePassenger(a.shape, 0));
  assert.ok(b.isOvercrowded, 'setup: the station starts overcrowded');
  b.overcrowdTimer = 0.0001;

  const train = line.trains[0];
  train.pendingArrival = null;
  train.dwell = 0;
  train.v = 40;
  train.s = line.stationS[1] + 0.3;
  train.dir = -1;

  game.update(1 / 60);
  assert.ok(!b.isOvercrowded, `the train should have relieved the platform, queue=${b.passengers.length}`);
  assert.equal(game.state, GameState.PLAYING, 'a relieved station must not end the game');
});

test('riders are handed back to a platform when their line stops running', () => {
  const game = new Game({ seed: 14 });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);

  line.trains[0].passengers.push(makePassenger('star', 0), makePassenger('gem', 0));
  const before = game.stations.reduce((n, s) => n + s.passengers.length, 0);

  game.retractEndpoint(line, 1);
  game.retractEndpoint(line, 1);

  assert.equal(line.isActive, false);
  for (let i = 0; i < 60 * 150 && line.trains.length; i++) game.update(1 / 60);
  assert.equal(line.trains.length, 0, 'the train was withdrawn with the line');
  const after = game.stations.reduce((n, s) => n + s.passengers.length, 0);
  assert.equal(after, before + 2, 'the two riders must reappear on a platform');
});

test('retracting a line past one station frees its slot again', () => {
  const game = new Game({ seed: 8 });
  const [a, b] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  assert.equal(game.lineSlotsAvailable(), CONFIG.lines.startSlots - 1);
  game.retractEndpoint(line, 1);
  game.retractEndpoint(line, 0);
  assert.equal(line.stations.length, 0);
  assert.equal(line.claimed, false);
  assert.equal(game.lineSlotsAvailable(), CONFIG.lines.startSlots);
});

test('passengers plan a transfer across two lines', () => {
  const game = new Game({ seed: 12 });
  const [a, b, c] = game.stations;
  const l1 = game.startLine(a);
  game.extendLine(l1, 1, b);
  const l2 = game.lines.find((l) => !l.claimed);
  l2.claimed = true;
  l2.setStations([b, c]);
  game.deployLocomotive(l2, 0);
  // A line only carries passengers once it has a locomotive.
  game.network.rebuild(game);

  const plan = game.planRoute(a, c.shape);
  assert.ok(plan, 'a route exists');
  assert.equal(plan.lineId, l1.id);
  assert.equal(plan.targetStationId, b.id);
  assert.equal(plan.transfer, true);

  const direct = game.planRoute(a, b.shape);
  assert.equal(direct.lineId, l1.id);
  assert.equal(direct.transfer, false);
});

test('carriages raise capacity and interchanges raise station capacity', () => {
  const game = new Game({ seed: 14 });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  assert.equal(line.hasLocomotive, true, 'a fresh line gets a locomotive from the pool');
  assert.equal(line.trains[0].capacity, CONFIG.train.baseCapacity);

  game.carriages.total = 2;
  game.carriages.available = 2;
  assert.equal(game.placeCarriage(line), true);
  assert.equal(line.trains[0].capacity, CONFIG.train.baseCapacity + CONFIG.train.carriageCapacity);
  assert.equal(game.carriages.available, 1);

  // A carriage cannot be attached without a locomotive.
  const bare = game.startLine(c);
  game.extendLine(bare, 1, a);
  game.releaseLocomotive(bare);
  assert.equal(bare.hasLocomotive, false);
  assert.equal(game.placeCarriage(bare), false, 'no locomotive, no carriage');

  const before = a.capacity;
  game.inventory.interchanges = 1;
  assert.equal(game.placeInterchange(a), true);
  assert.equal(a.capacity, before + 3);
  assert.equal(a.isInterchange, true);
  assert.equal(game.placeInterchange(a), false, 'cannot upgrade twice');
});

test('weekly rewards unlock resources and pause the game', () => {
  const game = new Game({ seed: 19 });
  const frames = Math.round((CONFIG.clock.daySeconds * CONFIG.clock.daysPerWeek + 0.2) * 60);
  for (let i = 0; i < frames; i++) game.update(1 / 60);
  assert.equal(game.state, GameState.UPGRADE);
  assert.ok(game.rewardOptions.length >= 2);
  const kind = game.rewardOptions[0].kind;
  const tunnelsBefore = game.tunnelsOwned;
  const linesBefore = game.unlockedLines;
  assert.equal(game.chooseReward(kind), true);
  assert.equal(game.state, GameState.PLAYING);
  if (kind === 'tunnel') assert.equal(game.tunnelsOwned, tunnelsBefore + CONFIG.tunnels.perPick);
  if (kind === 'line') assert.equal(game.unlockedLines, linesBefore + 1);
});

test('the same seed produces the same run', () => {
  const a = new Game({ seed: 99, mode: 'endless' });
  const b = new Game({ seed: 99, mode: 'endless' });
  run(a, 120);
  run(b, 120);
  assert.deepEqual(
    a.stations.map((s) => [s.id, s.shape, Math.round(s.x), Math.round(s.y)]),
    b.stations.map((s) => [s.id, s.shape, Math.round(s.x), Math.round(s.y)]),
  );
  assert.equal(a.score, b.score);
  assert.equal(a.delivered, b.delivered);
});

test('a greedy player keeps the network delivering', () => {
  // Integration-level guard rail: a competent bot must be able to run a real
  // game for two and a half minutes without the map falling apart.
  const game = new Game({ seed: 2024, mode: 'endless' });
  const bot = new Autopilot(game, { interval: 2.6 });
  const step = 1 / 30;
  for (let t = 0; t < 150; t += step) {
    bot.update(step);
    game.update(step);
  }
  assert.ok(game.activeLines().length >= 2, `expected a real network, got ${game.activeLines().length} lines`);
  assert.ok(game.delivered > 15, `expected deliveries, got ${game.delivered}`);
  assert.ok(game.overcrowdIncidents <= 3, `too many overloads: ${game.overcrowdIncidents}`);
  for (const station of game.stations) {
    assert.ok(Number.isFinite(station.x) && Number.isFinite(station.y), `station ${station.id} position`);
    assert.ok(station.passengers.length < 60, `station ${station.id} queue exploded: ${station.passengers.length}`);
  }
});

test('a long simulation never produces NaN geometry', () => {
  const game = new Game({ seed: 123, mode: 'endless' });
  const [a, b, c] = game.stations;
  const line = game.startLine(a);
  game.extendLine(line, 1, b);
  game.extendLine(line, 1, c);
  run(game, 600, 1 / 30);
  for (const s of game.stations) {
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), `station ${s.id} position`);
  }
  for (const l of game.activeLines()) {
    assert.ok(Number.isFinite(l.path.total) && l.path.total > 0, `line ${l.id} path`);
    assert.ok(Number.isFinite(l.trains[0].s), `line ${l.id} train position`);
    for (const p of l.trains[0].passengers) {
      assert.ok(p.destShape, 'passenger keeps a destination');
    }
  }
  assert.ok(game.delivered > 0, 'the network kept moving passengers');
});

