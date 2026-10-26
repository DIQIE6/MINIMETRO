/**
 * LAN multiplayer client (M1: same seed race).
 *
 * Every player runs the identical map and their own network; the winner is
 * whoever survives longest. So nothing about the simulation is synchronised -
 * this only carries a handful of small messages a second:
 *
 *   - the room roster (players, alive, delivered, survival time)
 *   - my own status, posted a few times a second
 *
 * The push channel is Server-Sent Events, which the host server already speaks.
 */

const NO_HOST =
  '连不上联机主机。请双击项目里的 start-online.cmd（或运行 node tools/net-server.mjs），' +
  '然后从它打印的地址进入游戏。';

const WRONG_SERVER =
  '这个地址上没有联机服务——你打开的是单机服务。' +
  '请改用 start-online.cmd 启动联机主机，并从它打印的地址（局域网玩家用那个 192.168/10.x 地址）进入。';

export class Net {
  constructor(base = '') {
    this.base = base || '';
    this.code = null;
    this.id = null;
    this.name = '';
    this.isHost = false;
    this.seed = null;
    this.room = null;
    this.started = false;
    this.error = '';
    this._stream = null;
    this._statusTimer = 0;
    this._lastPost = 0;
    this.onRoom = null;
  }

  get connected() {
    return !!this.id && !!this.code;
  }

  /** A short label so players can tell each other apart. */
  static defaultName() {
    const adjectives = ['飞驰', '准时', '夜班', '环线', '快线'];
    const nouns = ['司机', '乘客', '调度', '站长'];
    const a = adjectives[Math.floor(Math.random() * adjectives.length)];
    const n = nouns[Math.floor(Math.random() * nouns.length)];
    return a + n;
  }

  async _post(path, body) {
    let res;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error(NO_HOST);
    }
    // A plain static server answers 404/405 for the room API: that is the
    // single-player server, not the multiplayer host.
    if (res.status === 404 || res.status === 405 || res.status === 501) throw new Error(WRONG_SERVER);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  async host(name = Net.defaultName(), seed = null) {
    this.name = name;
    const data = await this._post('/api/host', { name, seed });
    this.code = data.code;
    this.id = data.id;
    this.seed = data.seed;
    this.isHost = true;
    this.started = false;
    this._subscribe();
    return data;
  }

  async join(code, name = Net.defaultName()) {
    this.name = name;
    const data = await this._post('/api/join', { code: String(code).toUpperCase().trim(), name });
    this.code = data.code;
    this.id = data.id;
    this.seed = data.seed;
    this.isHost = data.hostId === data.id;
    this.started = data.started;
    this._subscribe();
    return data;
  }

  async start(seed = null) {
    const data = await this._post('/api/start', { code: this.code, id: this.id, seed });
    this.started = true;
    if (Number.isFinite(data.seed)) this.seed = data.seed;
    return data;
  }

  /** Report my own progress. Called from the game loop. */
  report(game, force = false) {
    if (!this.connected || !game) return;
    const now = performance.now();
    // ~4 posts a second is plenty for a "who is still alive" board.
    if (!force && now - this._lastPost < 250) return;
    this._lastPost = now;
    const body = {
      code: this.code,
      id: this.id,
      alive: game.state === 'playing' || game.state === 'upgrade',
      delivered: game.delivered,
      time: game.time,
      finished: game.state === 'gameover',
    };
    fetch(`${this.base}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  _subscribe() {
    this._closeStream();
    const url = `${this.base}/api/events?code=${encodeURIComponent(this.code)}&id=${encodeURIComponent(this.id)}`;
    try {
      const stream = new EventSource(url);
      stream.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'room') {
            this.room = msg.room;
            const wasStarted = this.started;
            this.started = !!msg.room.started;
            this.onRoom?.(msg.room, { justStarted: this.started && !wasStarted });
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      stream.onerror = () => {
        this.error = NO_HOST;
      };
      this._stream = stream;
    } catch (error) {
      this.error = error.message;
    }
  }

  _closeStream() {
    if (this._stream) {
      try {
        this._stream.close();
      } catch {
        /* already gone */
      }
      this._stream = null;
    }
  }

  leave() {
    this._closeStream();
    this.code = null;
    this.id = null;
    this.room = null;
    this.started = false;
    this.isHost = false;
  }
}

/** Sorted for display: still-alive players first, longest survivor at the top. */
export function ranking(room) {
  if (!room) return [];
  return room.players.slice().sort((a, b) => {
    const aDone = a.finished || !a.alive;
    const bDone = b.finished || !b.alive;
    if (aDone !== bDone) return aDone ? 1 : -1;
    if (aDone) return b.time - a.time;
    return b.delivered - a.delivered;
  });
}
