import { GameState } from './game.js';
import { CONFIG } from './config.js';
import { SHAPES, NORMAL_SHAPES, SPECIAL_SHAPES, shapeOutline } from './shapes.js';

/** The game's own outline for a shape, as a small inline SVG. */
function shapeSvg(id, size = 22) {
  const half = size / 2;
  const pts = shapeOutline(id, 0, 0, half - 2);
  if (!pts.length) return '';
  const d =
    pts.map((p, i) => (i ? 'L' : 'M') + (half + p.x).toFixed(1) + ' ' + (half + p.y).toFixed(1)).join(' ') + ' Z';
  return (
    '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">' +
    '<path d="' + d + '" fill="#fff" stroke="#39393b" stroke-width="1.7" stroke-linejoin="round"/></svg>'
  );
}

function escapeText(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function icon(name) {
  switch (name) {
    case 'line':
      return '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 18 L9 8 L14 13 L21 4" fill="none" stroke="#39393b" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    case 'tunnel':
      return '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M2.5 19 A9.5 9.5 0 0 1 21.5 19" fill="none" stroke="#39393b" stroke-width="2.4" stroke-linecap="round"/><path d="M6 19 C6 11 18 11 18 19" fill="none" stroke="#7aa7d8" stroke-width="2.4"/></svg>';
    case 'carriage':
      return '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="2.5" y="7" width="19" height="10" rx="3.2" fill="none" stroke="#39393b" stroke-width="2.3"/><circle cx="7" cy="12" r="1.7" fill="#39393b"/><circle cx="17" cy="12" r="1.7" fill="#39393b"/></svg>';
    case 'loco':
      return '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4.5 17 V13 h15 V17" fill="none" stroke="#39393b" stroke-width="2.3" stroke-linejoin="round"/><path d="M6.5 13 V6.2 A1.7 1.7 0 0 1 8.2 4.5 h3.1 L16 9.5 h2.3 A1.2 1.2 0 0 1 19.5 10.7 V13" fill="none" stroke="#39393b" stroke-width="2.2" stroke-linejoin="round"/><circle cx="8" cy="18.2" r="1.9" fill="#39393b"/><circle cx="16" cy="18.2" r="1.9" fill="#39393b"/></svg>';
    case 'interchange':
      return '<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="8.2" fill="none" stroke="#39393b" stroke-width="2.3"/><circle cx="12" cy="12" r="3.1" fill="#39393b"/></svg>';
    default:
      return '';
  }
}

/**
 * Everything that is not the map: score, clock, the line tray, the resource
 * tray, weekly rewards and the game-over card.
 */
export class Hud {
  constructor(hooks = {}) {
    this.hooks = hooks;
    const $ = (id) => document.getElementById(id);
    this.els = {
      delivered: $('stat-delivered'),
      score: $('stat-score'),
      clock: $('stat-clock'),
      lines: $('lines'),
      inventory: $('inventory'),
      toasts: $('toasts'),
      hint: $('hint'),
      speeds: $('speeds'),
      restart: $('btn-restart'),
      overlayStart: $('overlay-start'),
      overlayUpgrade: $('overlay-upgrade'),
      overlayGameOver: $('overlay-gameover'),
      upgradeWeek: $('upgrade-week'),
      rewards: $('rewards'),
      gameoverTitle: $('gameover-title'),
      gameoverReason: $('gameover-reason'),
      gameoverSummary: $('gameover-summary'),
      btnAgain: $('btn-again'),
      btnMenu: $('btn-menu'),
      modes: $('modes'),
      overlayRules: $('overlay-rules'),
      rulesBody: $('rules-body'),
      btnRules: $('btn-rules'),
      btnRulesBack: $('btn-rules-back'),
      btnOnline: $('btn-online'),
      overlayLobby: $('overlay-lobby'),
      overlayResults: $('overlay-results'),
      lobbyChoice: $('lobby-choice'),
      lobbyCode: $('lobby-code'),
      lobbyHint: $('lobby-hint'),
      lobbyRoom: $('lobby-room'),
      lobbyRoomCode: $('lobby-room-code'),
      lobbyRoster: $('lobby-roster'),
      lobbyWait: $('lobby-wait'),
      btnHost: $('btn-host'),
      btnJoin: $('btn-join'),
      btnLobbyStart: $('btn-lobby-start'),
      btnLobbyLeave: $('btn-lobby-leave'),
      btnLobbyBack: $('btn-lobby-back'),
      btnResultsAgain: $('btn-results-again'),
      btnResultsMenu: $('btn-results-menu'),
      resultsTitle: $('results-title'),
      resultsLine: $('results-line'),
      resultsList: $('results-list'),
      board: $('board'),
      boardList: $('board-list'),
    };
    this._sig = {};
    this._speed = 1;
    this._bind();
  }

  _bind() {
    this.els.speeds?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-speed]');
      if (!btn) return;
      this.hooks.onSpeed?.(Number(btn.dataset.speed));
    });
    this.els.restart?.addEventListener('click', () => this.hooks.onRestart?.());
    this.els.btnAgain?.addEventListener('click', () => this.hooks.onRestart?.());
    this.els.btnMenu?.addEventListener('click', () => this.hooks.onMenu?.());
    this.els.btnRules?.addEventListener('click', () => this.showRules());
    this.els.btnOnline?.addEventListener('click', () => this.hooks.onOnline?.());
    this.els.btnHost?.addEventListener('click', () => this.hooks.onHost?.());
    this.els.btnJoin?.addEventListener('click', () =>
      this.hooks.onJoin?.(this.els.lobbyCode ? this.els.lobbyCode.value : ''),
    );
    this.els.lobbyCode?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.hooks.onJoin?.(this.els.lobbyCode.value);
    });
    this.els.btnLobbyStart?.addEventListener('click', () => this.hooks.onStart?.());
    this.els.btnLobbyLeave?.addEventListener('click', () => this.hooks.onLeave?.());
    this.els.btnLobbyBack?.addEventListener('click', () => this.hooks.onLeave?.());
    this.els.btnResultsAgain?.addEventListener('click', () => this.hooks.onRaceAgain?.());
    this.els.btnResultsMenu?.addEventListener('click', () => this.hooks.onMenu?.());
    this.els.btnRulesBack?.addEventListener('click', () => this.hideRules());
    this.els.modes?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      this.hooks.onMode?.(btn.dataset.mode);
    });
  }

  setSpeed(value) {
    this._speed = value;
    for (const btn of this.els.speeds?.querySelectorAll('button[data-speed]') || []) {
      btn.classList.toggle('on', Number(btn.dataset.speed) === value);
    }
  }

  /**
   * The rules panel. Built from the same tables the simulation uses - the shape
   * list and the passenger flow weights - so it cannot drift out of date.
   */
  buildRules() {
    const body = this.els.rulesBody;
    if (!body || body.dataset.built === '1') return;
    body.dataset.built = '1';

    const shapeIds = [...NORMAL_SHAPES, ...SPECIAL_SHAPES];
    const rows = shapeIds
      .map((id) => {
        const s = SHAPES[id] || { label: id, role: '' };
        const flows = CONFIG.passenger.flows[id] || {};
        const goes = Object.entries(flows)
          .filter((pair) => pair[1] > 0)
          .sort((a, b) => b[1] - a[1])
          .map((pair) => {
            const label = SHAPES[pair[0]] ? SHAPES[pair[0]].label : pair[0];
            const stars = pair[1] >= 3 ? '★★★' : pair[1] >= 2 ? '★★' : '★';
            return shapeSvg(pair[0], 15) + ' ' + label + ' ' + stars;
          })
          .join('<br />');
        const never = Object.entries(flows)
          .filter((pair) => !(pair[1] > 0))
          .map((pair) => (SHAPES[pair[0]] ? SHAPES[pair[0]].label : pair[0]));
        return (
          '<tr><td class="shape-cell">' +
          shapeSvg(id, 26) +
          '</td><td><b>' +
          s.label +
          '</b><div class="muted">' +
          s.role +
          '</div></td><td>' +
          goes +
          (never.length ? '<div class="muted">从不去：' + never.join('、') + '</div>' : '') +
          '</td></tr>'
        );
      })
      .join('');

    const section = (title, inner) =>
      '<section><h3>' + title + '</h3>' + inner + '</section>';
    const list = (items) => '<ul class="rules-list">' + items.map((t) => '<li>' + t + '</li>').join('') + '</ul>';
    const table = (head, bodyRows) =>
      '<table class="rules-table"><thead><tr>' +
      head.map((h) => '<th>' + h + '</th>').join('') +
      '</tr></thead><tbody>' +
      bodyRows +
      '</tbody></table>';

    body.innerHTML =
      section(
        '目标',
        '<p>乘客只想去和自身形状相同的车站。把每个人送到目的地，别让站台挤爆。</p>',
      ) +
      section(
        '操作',
        table(
          ['操作', '结果'],
          [
            ['从<b>车站</b>本身拖出去', '在这里开一条新线'],
            ['拖线路两端的 <b>T</b>', '延长这条线'],
            ['拖 T <b>划过</b>沿线的一个车站', '把那个车站从这条线摘掉'],
            ['拖 T 到<b>对端终点站</b>', '闭合成环线'],
            ['按住线路<b>中段</b>拖动', '改道，两端邻居不变'],
            ['把线路中段拖<b>压到</b>沿线车站上', '摘掉那个车站'],
            ['<b>右键</b>线路上的车站', '直接摘除，邻居自动接上'],
            ['底部<b>车头</b>拖到线路', '这条线开出一列车（一条线可以跑多列、可以反向）'],
            ['底部<b>车厢</b>拖到列车上', '加挂一节（只能挂在有车头的线上）'],
            ['车厢拖到空白处', '拆下来退回托盘'],
            ['拖<b>车体</b>', '整列车在本线调度，或转到另一条线'],
            ['底部<b>隧道</b>拖到山地', '把翻山的那一段改成隧道，不再减速'],
          ]
            .map((pair) => '<tr><td>' + pair[0] + '</td><td>' + pair[1] + '</td></tr>')
            .join(''),
        ),
      ) +
      section(
        '车站',
        '<p class="muted">形状决定这个街区的性质，也决定它的乘客想去哪里。★越多表示去那里的乘客越多。</p>' +
          table(['', '街区', '乘客主要去向'], rows),
      ) +
      section(
        '资源与规则',
        list([
          '<b>线路</b>：开局 ' + CONFIG.lines.startSlots + ' 条，每周奖励可以解锁更多。',
          '<b>隧道</b>：开局 ' + CONFIG.tunnels.start + ' 条。<b>过河会自动消耗</b>一条，不用手动放；每条线每一处过河都要算。',
          '<b>山区</b>：轨道直接翻山会减速到 ' + Math.round(CONFIG.terrain.surfaceSpeed * 100) + '%，把隧道拖到山地上就变成穿山隧道，恢复全速。',
          '<b>车头 / 车厢</b>：车头决定这条线能不能跑；车厢提高每列车的载客量。',
          '<b>一周 = ' + CONFIG.clock.daySeconds * 7 + ' 秒</b>（一天 ' + CONFIG.clock.daySeconds + ' 秒），每周结束会暂停让你选一项奖励。',
          '<b>地图是逐渐展开的</b>：开局只看得见一小块，两周之内慢慢扩大到全图。新车站只会出现在看得见的地方。',
          '<b>普通模式</b>：站台超载倒计时归零就结束。<b>无尽模式</b>：超载只清空站台并扣分。',
        ]),
      ) +
      section(
        '之后的模式',
        '<p class="muted">联机模式（同图竞速、每日挑战）还在做，主菜单会在这里多出几个入口。</p>',
      );
  }

  showRules() {
    this.buildRules();
    this.els.overlayStart?.classList.add('hidden');
    this.els.overlayRules?.classList.remove('hidden');
  }

  hideRules() {
    this.els.overlayRules?.classList.add('hidden');
    this.els.overlayStart?.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ online
  /** The lobby: create or join, then wait for the host to start. */
  showLobby() {
    this.els.overlayStart?.classList.add('hidden');
    this.els.overlayRules?.classList.add('hidden');
    this.els.overlayLobby?.classList.remove('hidden');
    this.setLobbyHint('');
    this.renderLobby();
  }

  hideLobby() {
    this.els.overlayLobby?.classList.add('hidden');
  }

  setLobbyHint(text) {
    if (this.els.lobbyHint) this.els.lobbyHint.textContent = text || '';
  }

  /**
   * @param {object|null} room
   * @param {{id?:string, isHost?:boolean, code?:string, connected?:boolean}} me
   */
  renderLobby(room = null, me = null) {
    const inRoom = !!(room && me && me.connected);
    this.els.lobbyRoom?.classList.toggle('hidden', !inRoom);
    this.els.lobbyChoice?.classList.toggle('hidden', inRoom);
    if (!inRoom) return;
    if (this.els.lobbyRoomCode) this.els.lobbyRoomCode.textContent = room.code;
    const list = this.els.lobbyRoster;
    if (list) {
      list.innerHTML = room.players
        .map((p) => {
          const me2 = p.id === me.id ? '<span class="me">你</span>' : '';
          const host = p.id === room.hostId ? '<span class="me">房主</span>' : '';
          return '<li><span class="who">' + escapeText(p.name) + '</span>' + host + me2 + '</li>';
        })
        .join('');
    }
    const startBtn = this.els.btnLobbyStart;
    if (startBtn) {
      startBtn.disabled = !me.isHost;
      startBtn.classList.toggle('hidden', !me.isHost);
    }
    if (this.els.lobbyWait) {
      this.els.lobbyWait.textContent = me.isHost
        ? room.players.length < 2
          ? '把房间号告诉其他人；一个人也能先跑一局。'
          : '人都到齐了就点「开始比赛」。'
        : '等待房主开始比赛…';
    }
  }

  /** The live board shown while racing. */
  renderBoard(room, me, rankingFn) {
    const board = this.els.board;
    if (!board) return;
    if (!room || !me || !me.connected) {
      board.classList.add('hidden');
      return;
    }
    board.classList.remove('hidden');
    const rows = rankingFn(room);
    const list = this.els.boardList;
    if (list) {
      list.innerHTML = rows
        .map((p, i) => {
          const out = p.finished || !p.alive;
          const how = out ? '存活 ' + p.time.toFixed(0) + 's' : '送达 ' + p.delivered;
          const me2 = p.id === me.id ? '<span class="me">你</span>' : '';
          return (
            '<li class="' + (out ? 'out' : '') + '"><span class="rank">' + (i + 1) + '</span>' +
            '<span class="who">' + escapeText(p.name) + '</span>' + me2 +
            '<span class="how">' + how + '</span></li>'
          );
        })
        .join('');
    }
  }

  hideBoard() {
    this.els.board?.classList.add('hidden');
  }

  showResults(rows, me, line) {
    this.els.overlayResults?.classList.remove('hidden');
    if (this.els.resultsLine) this.els.resultsLine.textContent = line || '';
    const list = this.els.resultsList;
    if (!list) return;
    list.innerHTML = rows
      .map((p, i) => {
        const out = p.finished || !p.alive;
        const how = out ? '存活 ' + p.time.toFixed(0) + 's' : '仍在运行 · 送达 ' + p.delivered;
        const me2 = me && p.id === me.id ? '<span class="me">你</span>' : '';
        return (
          '<li class="' + (out ? 'out' : '') + '"><span class="rank">' + (i + 1) + '</span>' +
          '<span class="who">' + escapeText(p.name) + '</span>' + me2 +
          '<span class="how">' + how + '</span></li>'
        );
      })
      .join('');
    if (this.els.resultsTitle) {
      const mine = rows.findIndex((p) => me && p.id === me.id);
      this.els.resultsTitle.textContent = mine === 0 ? '你赢了 · 活得最久' : '比赛结束 · 第 ' + (mine + 1) + ' 名';
    }
  }

  hideResults() {
    this.els.overlayResults?.classList.add('hidden');
  }

  showStart() {
    this.els.overlayStart?.classList.remove('hidden');
  }

  hideStart() {
    this.els.overlayStart?.classList.add('hidden');
    this.els.overlayRules?.classList.add('hidden');
    this.els.overlayLobby?.classList.add('hidden');
    this.els.overlayResults?.classList.add('hidden');
  }

  sync(game) {
    if (!game) return;
    if (this.els.delivered.textContent !== String(game.delivered)) {
      this.els.delivered.textContent = String(game.delivered);
    }
    if (this.els.score.textContent !== String(game.score)) {
      this.els.score.textContent = String(game.score);
    }
    const clock = game.clockLabel;
    if (this.els.clock.textContent !== clock) this.els.clock.textContent = clock;

    // A short flash on the score every time somebody arrives.
    const pulsing = game.scorePulse > 0;
    if (this._sig.pulse !== String(pulsing)) {
      this._sig.pulse = String(pulsing);
      this.els.delivered.parentElement?.classList.toggle('pulse', pulsing);
    }

    this.syncLines(game);
    this.syncInventory(game);
    this.syncToasts(game);
    this.syncUpgrade(game);
    this.syncGameOver(game);

    const hintText = this.hintText(game);
    if (this.els.hint.textContent !== hintText) this.els.hint.textContent = hintText;
    const fade = game.time > 50 && !game.placement && !game.vehicleDrag ? '0' : '0.95';
    if (this.els.hint.style.opacity !== fade) this.els.hint.style.opacity = fade;
  }

  hintText(game) {
    if (game.vehicleDrag) {
      // Dragging a whole train off a line is a different gesture from pulling a
      // spare locomotive out of the tray, so it gets its own line.
      if (game.vehicleDrag.kind === 'train') return '松开在另一条线路上，这列车就会改跑那条线';
      return '松开在线路上即可部署车头 · 车厢只能接到已有车头的线路上';
    }
    if (game.placement?.item === 'carriage') return '点击一条线路，给它加一节车厢';
    if (game.placement?.item === 'interchange') return '点击一个车站，把它升级为换乘站';
    if (game.segmentDrag) return '松开在另一个车站上，线路就会改从那里经过（两端邻居不变）';
    if (game.drag) return '继续拖过更多车站，松手接上 · 拖回起点可撤销 · 拖到另一端的 T 上闭合成环线';
    if (game.locomotiveShortage) return '把底部的「车头」拖到线路上，这条线才会开始运营';
    if (game.time > 60) return '';
    return '拖线路两端的 T 延长线路 · 从车站本身拖出＝开新线 · 拖线路中段可改道 · 右键车站可摘除';
  }

  syncLines(game) {
    const visible = game.lines.slice(0, game.unlockedLines);
    const sig = visible
      .map(
        (l) =>
          `${l.claimed ? 1 : 0}:${l.stations.length}:${l.carriages}:${l.isLoop ? 1 : 0}:${l.retiring ? 1 : 0}:${l.trains.length}`,
      )
      .join('|');
    if (this._sig.lines === sig) return;
    this._sig.lines = sig;
    const frag = document.createDocumentFragment();
    for (const line of visible) {
      const chip = document.createElement('span');
      chip.className = `chip ${line.claimed ? '' : 'dashed'}${line.retiring ? ' retiring' : ''}`;
      chip.style.setProperty('--c', line.color.stroke);
      chip.dataset.lineId = line.id;
      if (line.retiring) {
        chip.classList.add('flat');
        chip.innerHTML = `<span class="dot"></span><span class="sub">停运中 · 送完乘客即撤线</span>`;
        chip.title = `${line.color.name} 正在把车上的乘客送完，之后就会消失`;
      } else if (line.claimed) {
        chip.classList.add('flat');
        chip.classList.toggle('needs-loco', !line.hasLocomotive && !line.retiring);
        const status = line.retiring
          ? ''
          : line.trains.length
            ? line.trains.length > 1
              ? ` · <b>${line.trains.length} 列车</b>`
              : ''
            : ' · <b>缺车头</b>';
        chip.innerHTML =
          `<span class="dot"></span><span class="sub">${line.stations.length} 站${
            line.isLoop ? ' · 环线' : ''
          }${line.carriages ? ` · ${line.carriages} 厢` : ''}${status}</span>` +
          '<button class="clear" title="停运这条线路">×</button>';
        chip.title = line.hasLocomotive
          ? `${line.color.name}：${line.stations.length} 个车站`
          : `${line.color.name} 还没有车头：把底部的车头拖到这条线上`;
        chip.querySelector('.clear')?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.hooks.onClearLine?.(line);
        });
      } else {
        chip.innerHTML = `<span class="dot"></span><span class="sub">空闲 ${line.color.name}</span>`;
        chip.title = '按住地图上任意一个非末端的车站向外拖，就会从那里开出一条新线路';
      }
      frag.appendChild(chip);
    }
    this.els.lines.replaceChildren(frag);
  }

  syncInventory(game) {
    const free = game.freeTunnels();
    const interchanges = game.inventory?.interchanges ?? 0;
    // Both pools are owned by the game state; stay tolerant while they are
    // still being wired up so a missing pool never breaks the whole HUD.
    const loco = game.locomotives ?? { available: 0, total: 0 };
    const carriage = game.carriages ?? { available: 0, total: 0 };
    const locoAvailable = loco.available ?? 0;
    const locoTotal = loco.total ?? 0;
    const carriageAvailable = carriage.available ?? 0;
    const carriageTotal = carriage.total ?? 0;

    // Deliberately no drag state in the signature: rebuilding the tray mid-drag
    // would tear out the button the pointer went down on. Drag feedback lives in
    // hintText(), which is refreshed every frame anyway.
    const sig = `${game.tunnelsOwned}:${free}:${locoAvailable}/${locoTotal}:${carriageAvailable}/${carriageTotal}:${interchanges}:${
      game.placement?.item || ''
    }`;
    if (this._sig.inv === sig) return;
    this._sig.inv = sig;

    const chip = (opts) => {
      const b = document.createElement('button');
      b.className = `chip flat${opts.armed ? ' armed' : ''}${opts.extraClass ? ` ${opts.extraClass}` : ''}`;
      b.innerHTML = `${opts.glyph}<span class="count">${opts.count}</span><span class="sub">${opts.label}</span>`;
      if (opts.disabled) b.disabled = true;
      if (opts.onPointerDown && !opts.disabled) {
        b.classList.remove('flat');
        b.addEventListener('pointerdown', opts.onPointerDown);
      } else if (opts.onClick) {
        b.classList.remove('flat');
        b.addEventListener('click', opts.onClick);
      }
      if (opts.title) b.title = opts.title;
      return b;
    };

    const frag = document.createDocumentFragment();
    frag.appendChild(
      chip({
        // Not a vehicle: the tray's vehicle selector must keep finding exactly
        // the locomotive and the carriage.
        extraClass: 'tunnel draggable',
        glyph: icon('tunnel'),
        count: `${free}/${game.tunnelsOwned}`,
        label: '隧道',
        // Crossing water always spends a tunnel on its own. Dragging one is for
        // the other job: putting a line through a hill instead of over it.
        disabled: free <= 0,
        onPointerDown: (event) => this.hooks.onVehicleDrag?.('tunnel', event),
        title: '过河自动消耗隧道；把隧道拖到山地上，那条线路就改为穿山而过（不再减速）',
      }),
    );
    frag.appendChild(
      chip({
        extraClass: 'vehicle draggable',
        glyph: icon('loco'),
        count: `${locoAvailable}/${locoTotal}`,
        label: '车头',
        disabled: locoAvailable <= 0,
        title: '按住拖到一条线路上，这条线就会开出一列车',
        onPointerDown: (event) => this.hooks.onVehicleDrag?.('loco', event),
      }),
    );
    frag.appendChild(
      chip({
        extraClass: 'vehicle draggable',
        glyph: icon('carriage'),
        count: `${carriageAvailable}/${carriageTotal}`,
        label: '车厢',
        disabled: carriageAvailable <= 0,
        title: '按住拖到已经有车头的线路上，给它挂一节车厢',
        onPointerDown: (event) => this.hooks.onVehicleDrag?.('carriage', event),
      }),
    );
    frag.appendChild(
      chip({
        glyph: icon('interchange'),
        count: interchanges,
        label: '换乘站',
        disabled: interchanges <= 0,
        armed: game.placement?.item === 'interchange',
        title: '点击后放到一个车站上，把它升级为换乘站',
        onClick:
          interchanges > 0
            ? () => {
                game.beginPlacement('interchange');
                this._sig.inv = '';
              }
            : null,
      }),
    );
    this.els.inventory.replaceChildren(frag);
  }

  syncToasts(game) {
    const sig = game.toasts.map((t) => t.id).join('|');
    if (this._sig.toasts === sig) return;
    this._sig.toasts = sig;
    const frag = document.createDocumentFragment();
    for (const toast of game.toasts) {
      const div = document.createElement('div');
      div.className = 'toast';
      div.textContent = toast.text;
      frag.appendChild(div);
    }
    this.els.toasts.replaceChildren(frag);
  }

  syncUpgrade(game) {
    const show = game.state === GameState.UPGRADE;
    this.els.overlayUpgrade?.classList.toggle('hidden', !show);
    if (!show) return;
    const sig = `${game.week}:${game.rewardOptions.map((o) => o.kind).join(',')}`;
    if (this._sig.upgrade === sig) return;
    this._sig.upgrade = sig;
    this.els.upgradeWeek.textContent = String(game.rewardWeek);
    const frag = document.createDocumentFragment();
    for (const option of game.rewardOptions) {
      const btn = document.createElement('button');
      btn.className = 'reward';
      btn.innerHTML = `<span class="icon">${icon(option.icon)}</span><span><b>${option.label}</b><span>${option.hint}</span></span>`;
      btn.addEventListener('click', () => this.hooks.onReward?.(option.kind));
      frag.appendChild(btn);
    }
    this.els.rewards.replaceChildren(frag);
  }

  syncGameOver(game) {
    const show = game.state === GameState.GAMEOVER;
    this.els.overlayGameOver?.classList.toggle('hidden', !show);
    if (!show) {
      this._sig.over = '';
      return;
    }
    const summary = game.summary || {};
    const sig = `${summary.score}:${summary.delivered}`;
    if (this._sig.over === sig) return;
    this._sig.over = sig;
    const station = game.gameOverStation;
    this.els.gameoverTitle.textContent = game.mode.overcrowdFatal ? '线路瘫痪了' : '本局结束';
    this.els.gameoverReason.textContent = station
      ? `${station.id} 站台的乘客等得太久，站台彻底挤爆了。`
      : '地铁网络停止了运转。';
    this.els.gameoverSummary.innerHTML = `
      <div><b>${summary.score ?? 0}</b>总得分</div>
      <div><b>${summary.delivered ?? 0}</b>送达乘客</div>
      <div><b>${summary.stations ?? 0}</b>车站数量</div>
      <div><b>${summary.lines ?? 0}</b>线路数量</div>
      <div><b>${summary.week ?? 1}</b>坚持周数</div>
      <div><b>${summary.incidents ?? 0}</b>超载次数</div>`;
  }
}
