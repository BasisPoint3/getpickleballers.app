// live.html: the live link (docs/LIVE_LINK.md, D-96).
//
// Shows one group's live game, or its leaderboard between games, on any
// screen with a browser. No sign-in: the page calls live_board(token) with the
// publishable key and listens on the private Realtime channel live:<token>,
// which the database feeds beside the group's own channel. It follows the
// viewer's rules from docs/LIVE_GAME.md: the score comes from the latest
// `game` event, the board is read again after every (re)join and match
// change, and "Reconnecting…" covers whatever was last shown until it has.
//
// Realtime is spoken directly over a websocket (Phoenix's protocol: join,
// heartbeat, broadcast), so the page has no dependencies and nothing to
// build, like the rest of the site.
(function () {
  // Filled in when the production Supabase project exists. Until then, and
  // for the local stack, open the page once with ?api=<url>&key=<publishable key>
  // and it remembers them.
  const PRODUCTION = { api: '', key: '' };
  // The App Store link, once there is one. Until then the QR code carries
  // this page's own link, so people can follow on their phones.
  const APP_STORE_URL = '';

  const token = (location.hash || '').slice(1).toLowerCase();
  const config = resolveConfig();

  const els = {
    name: document.getElementById('group-name'),
    status: document.getElementById('status'),
    main: document.getElementById('main'),
    overlay: document.getElementById('overlay'),
    overlayText: document.getElementById('overlay-text'),
  };

  // What the page knows.
  let board = null;            // the last live_board, or null before the first read
  let linkDead = false;        // live_board said there's no such link
  let joined = false;          // the channel is joined
  let readSince = false;       // the board was read since the channel was joined
  let lastFinal = null;        // { match, game, at }: a game that just ended, kept 20 s
  let wakeLock = null;
  let clockOffset = 0;         // this device's clock minus the server's, from the last read
  let ticking = null;          // the elapsed-time ticker while a game is on

  function resolveConfig() {
    const params = new URLSearchParams(location.search);
    let api = params.get('api');
    let key = params.get('key');
    try {
      if (api && key) {
        localStorage.setItem('liveLinkApi', api);
        localStorage.setItem('liveLinkKey', key);
      } else {
        api = localStorage.getItem('liveLinkApi');
        key = localStorage.getItem('liveLinkKey');
      }
    } catch (e) { /* private mode: fall through */ }
    if (!api || !key) ({ api, key } = PRODUCTION);
    return api && key ? { api: api.replace(/\/$/, ''), key } : null;
  }

  // ---------------------------------------------------------------------------
  // Reading the board
  // ---------------------------------------------------------------------------

  let readTimer = null;
  async function readBoard() {
    if (!config || !token) return;
    try {
      const res = await fetch(`${config.api}/rest/v1/rpc/live_board`, {
        method: 'POST',
        headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_token: token }),
      });
      if (!res.ok) throw new Error(`live_board: ${res.status}`);
      const next = await res.json();
      if (next === null) {
        linkDead = true;
      } else {
        board = next;
        linkDead = false;
        if (next.as_of) clockOffset = Date.now() - Date.parse(next.as_of);
      }
      readSince = true;
    } catch (e) {
      // Keep what's shown; try again soon.
      clearTimeout(readTimer);
      readTimer = setTimeout(readBoard, 5000);
    }
    render();
  }

  // ---------------------------------------------------------------------------
  // Hearing changes
  // ---------------------------------------------------------------------------

  let ws = null;
  let heartbeat = null;
  let reconnectDelay = 1000;
  let ref = 0;
  let heartbeatUnanswered = false;

  function connect() {
    if (!config || !token || ws) return;
    const url = config.api.replace(/^http/, 'ws') + `/realtime/v1/websocket?apikey=${encodeURIComponent(config.key)}&vsn=1.0.0`;
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => {
      send(socket, `realtime:live:${token}`, 'phx_join', {
        config: { broadcast: { self: false }, presence: { key: '' }, private: true },
        access_token: config.key,
      });
      // A heartbeat the server never answers means the connection is dead
      // even if the socket says otherwise (a sleeping TV, a dropped Wi-Fi).
      heartbeatUnanswered = false;
      heartbeat = setInterval(() => {
        if (heartbeatUnanswered) { socket.close(); return; }
        heartbeatUnanswered = true;
        send(socket, 'phoenix', 'heartbeat', {});
      }, 15000);
    };
    socket.onmessage = (m) => {
      let d;
      try { d = JSON.parse(m.data); } catch (e) { return; }
      if (d.topic === 'phoenix') {
        heartbeatUnanswered = false;
      } else if (d.event === 'phx_reply' && d.topic === `realtime:live:${token}`) {
        if (d.payload && d.payload.status === 'ok') {
          joined = true;
          readSince = false;
          reconnectDelay = 1000;
          readBoard();
        } else {
          // Refused: the link is gone. Say so, and stop trying.
          linkDead = true;
          joined = false;
          render();
          socket.close();
        }
      } else if (d.event === 'broadcast' && d.payload) {
        heard(d.payload.event, d.payload.payload);
      } else if (d.event === 'phx_error' || d.event === 'phx_close') {
        socket.close();
      }
    };
    socket.onclose = () => {
      clearInterval(heartbeat);
      joined = false;
      if (ws === socket) ws = null;
      render();
      if (!linkDead) {
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 10000);
      }
    };
    socket.onerror = () => socket.close();
  }

  function send(socket, topic, event, payload) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ topic, event, payload, ref: String(++ref) }));
  }

  function heard(event, payload) {
    if (event === 'game') {
      const match = board && board.matches.find((m) => m.id === payload.match_id);
      if (!match) { readBoard(); return; }
      const i = match.games.findIndex((g) => g.id === payload.id);
      if (i >= 0) match.games[i] = payload; else match.games.push(payload);
      match.games.sort((a, b) => a.game_number - b.game_number);
      if (payload.status === 'final') lastFinal = { match, game: payload, at: Date.now() };
      render();
      if (payload.status === 'final') setTimeout(render, 20500);
    } else if (event === 'match') {
      readBoard();
      // The rating replay fills in the new numbers a few seconds after a
      // match is confirmed.
      if (payload.status === 'confirmed') setTimeout(readBoard, 5000);
    }
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  function render() {
    fitRows.pending = false;
    if (!config) {
      setStatus('', false);
      els.main.innerHTML = message('This page isn\'t set up yet.',
        'Open it once as <code>live.html?api=&lt;url&gt;&amp;key=&lt;key&gt;#&lt;token&gt;</code> and it remembers.');
      overlay(false);
      return;
    }
    if (!token || linkDead) {
      els.name.textContent = '';
      setStatus('', false);
      els.main.innerHTML = message('This link isn\'t live anymore.', 'Ask the group\'s organizer for a new one.');
      overlay(false);
      keepAwake(false);
      drawQR();
      return;
    }
    overlay(!(joined && readSince), 'Reconnecting…');
    drawQR();
    if (!board) return;

    els.name.textContent = board.group.name;
    const live = board.matches.filter((m) => currentGame(m));
    if (live.length) {
      setStatus('Live', true);
      // Up to four games at once, two across; the boards shrink to fit.
      const shown = live.slice(-4);
      const count = shown.length > 2 ? 'four' : shown.length > 1 ? 'two' : 'one';
      els.main.innerHTML = `<div class="boards ${count}">${shown.map((m) => boardHTML(m)).join('')}</div>`
        + (live.length > 4 ? `<div class="more">and ${live.length - 4} more game${live.length > 5 ? 's' : ''} on</div>` : '');
      startTicking(shown);
      keepAwake(true);
    } else if (lastFinal && Date.now() - lastFinal.at < 20000) {
      stopTicking();
      setStatus('Final', false);
      els.main.innerHTML = `<div class="boards">${boardHTML(lastFinal.match, lastFinal.game)}</div>`;
      keepAwake(true);
    } else {
      stopTicking();
      setStatus('No game on right now', false);
      els.main.innerHTML = standingsHTML(board.standings);
      keepAwake(false);
      fitRows();
    }
  }

  function setStatus(text, live) {
    els.status.textContent = text;
    els.status.classList.toggle('live', live);
  }

  // How long the match has been going, as the prototype's Live Game page
  // shows it: m:ss, next to the Live dot (one game), or on each board (two).
  function elapsed(match) {
    const ms = Date.now() - clockOffset - Date.parse(match.started_at);
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(sec).padStart(2, '0');
  }
  function tick(shown) {
    if (shown.length === 1) {
      els.status.innerHTML = `Live<span class="clock">${elapsed(shown[0])}</span>`;
    } else {
      els.status.textContent = 'Live';
      els.main.querySelectorAll('.board .clock').forEach((el, i) => { if (shown[i]) el.textContent = elapsed(shown[i]); });
    }
  }
  function startTicking(shown) {
    stopTicking();
    tick(shown);
    ticking = setInterval(() => tick(shown), 1000);
  }
  function stopTicking() {
    clearInterval(ticking);
    ticking = null;
  }

  function overlay(show, text) {
    els.overlay.hidden = !show;
    if (text) els.overlayText.textContent = text;
  }

  function message(title, sub) {
    return `<div class="message"><p>${title}</p><p class="sub">${sub}</p></div>`;
  }

  // The game being played: the one in progress, else none.
  function currentGame(match) {
    return match.games.find((g) => g.status === 'in_progress') || null;
  }

  function boardHTML(match, game) {
    const g = game || currentGame(match);
    const doubles = match.team_a.length === 2;
    const serving = g.serving_team;
    const receiving = serving === 'A' ? 'B' : 'A';
    const score = (t) => (t === 'A' ? g.team_a_score : g.team_b_score);
    const team = (t) => (t === 'A' ? match.team_a : match.team_b);
    const final = g.status === 'final';
    const wins = { A: 0, B: 0 };
    for (const x of match.games) if (x.winning_team) wins[x.winning_team]++;
    const needed = match.format === 'best_of_5' ? 3 : match.format === 'best_of_3' ? 2 : 1;

    let call;
    if (final) {
      const w = g.winning_team;
      call = `${score(w)}–${score(w === 'A' ? 'B' : 'A')}`;
    } else if (!serving) {
      call = '0-0';
    } else {
      call = `${score(serving)}-${score(receiving)}` + (doubles && g.server_number ? `-${g.server_number}` : '');
    }

    let top = '';
    if (!game && board.matches.filter((m) => currentGame(m)).length > 1) top += '<span class="clock"></span>';
    if (needed > 1) {
      top += `<span>Game ${g.game_number} of ${needed * 2 - 1}</span>`;
      // Games won so far, in the team colors: the rows below say whose is whose.
      if (wins.A || wins.B) top += `<span class="games"><b class="a">${wins.A}</b>–<b class="b">${wins.B}</b></span>`;
    }
    if (!final && serving && isGamePoint(g, serving)) {
      const decides = needed > 1 && wins[serving] + 1 >= needed;
      top += `<span class="tag">${decides ? 'Match point' : 'Game point'}</span>`;
    }

    let serverLine;
    if (final) {
      const w = g.winning_team;
      const decided = wins[w] >= needed;
      serverLine = `${esc(teamName(team(w)))} ${decided && needed > 1 ? 'win the match' : doubles ? 'win' : 'wins'}`;
    } else if (!serving) {
      serverLine = 'Starting…';
    } else {
      const server = g.server_player_id && team(serving).find((p) => p.id === g.server_player_id);
      serverLine = `<span class="ball"></span>${server ? esc(server.name) : `Team ${serving}`} serving`;
    }

    const row = (t) => {
      const won = final && g.winning_team === t;
      return `<div class="team ${t.toLowerCase()}${!final && serving === t ? ' serving' : ''}${won ? ' won' : ''}">
        <div class="names">${team(t).map((p) => `<span class="name"><span class="slot">${!final && g.server_player_id === p.id ? '<span class="ball"></span>' : ''}</span>${esc(p.name)}</span>`).join('')}</div>
        <div class="points">${score(t)}</div>
      </div>`;
    };

    return `<section class="board${final ? ' final' : ''}">
      <div class="board-top">${final ? '<span>Final</span>' : ''}${top}</div>
      <div class="call">${call}</div>
      <div class="server">${serverLine}</div>
      <div class="teams">${row('A')}${row('B')}</div>
    </section>`;
  }

  // The serving team wins the game with one more point.
  function isGamePoint(g, serving) {
    const mine = (serving === 'A' ? g.team_a_score : g.team_b_score) + 1;
    const theirs = serving === 'A' ? g.team_b_score : g.team_a_score;
    return mine >= g.points_to_win && mine - theirs >= g.win_by;
  }

  function teamName(players) { return players.map((p) => p.name).join(' & '); }

  function standingsHTML(rows) {
    if (!rows.length) {
      return message('No one is ranked yet.', 'Players show up here after three games.');
    }
    return `<div class="standings"><div class="standings-title">Leaderboard</div><div class="rows">${rows.map((r, i) => `
      <div class="row${i === 0 ? ' first' : ''}">
        <span class="rank">${i + 1}</span>
        <span class="name">${esc(r.name)}</span>
        <span class="number ${r.number > 0 ? 'up' : r.number < 0 ? 'down' : ''}">${plusMinus(r.number)}</span>
        <span class="record">${r.wins}–${r.losses}</span>
      </div>`).join('')}</div></div>`;
  }

  // Drop rows from the bottom until the list fits the screen.
  function fitRows() {
    const list = els.main.querySelector('.rows');
    if (!list) return;
    let guard = 200;
    while (list.scrollHeight > list.clientHeight + 1 && list.children.length > 3 && guard--) {
      list.removeChild(list.lastElementChild);
    }
  }

  function plusMinus(n) {
    const fixed = Math.abs(n).toFixed(1);
    if (fixed === '0.0') return '0.0';
    return (n > 0 ? '+' : '−') + fixed;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------------------
  // Staying awake, staying current
  // ---------------------------------------------------------------------------

  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { wakeLock = null; }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      readBoard();
      connect();
      render();
    }
  });
  // The QR code, when the screen has room for it (a TV, a laptop, an iPad
  // on a stand; not a phone). It needs about 8 cm to scan from a few metres.
  let qrFor = null;
  function drawQR() {
    const qr = document.getElementById('qr');
    const roomy = window.innerWidth >= 900 && window.innerHeight >= 520;
    if (!roomy || !token || linkDead || !config) {
      qr.hidden = true;
      document.body.classList.remove('has-qr');
      return;
    }
    const target = APP_STORE_URL || `${location.origin}${location.pathname}#${token}`;
    if (qrFor !== target) {
      try {
        document.getElementById('qr-code').innerHTML = window.QR.svg(target);
        qrFor = target;
      } catch (e) { qr.hidden = true; return; }
    }
    document.getElementById('qr-caption').textContent = APP_STORE_URL ? 'Get the app' : 'Follow on your phone';
    qr.hidden = false;
    document.body.classList.add('has-qr');
  }

  window.addEventListener('resize', () => { drawQR(); if (els.main.querySelector('.rows')) render(); });
  setInterval(readBoard, 60000);

  render();
  readBoard();
  connect();
})();
