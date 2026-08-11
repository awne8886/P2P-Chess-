/* app.js — PeerJS connection (QR handshake), chess logic, stress-test
   timers, telemetry dashboard and chart.
   Design rule: the UI must boot and the buttons must work even if every
   CDN library fails — failures surface as readable status messages. */

/* ---------- COOP/COEP service worker (GitHub Pages & friends) ---------- */
if (!crossOriginIsolated && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').then(() => {
    // A brand-new SW never controls the first load: reload exactly once.
    if (!navigator.serviceWorker.controller && !sessionStorage.getItem('coi-reloaded')) {
      sessionStorage.setItem('coi-reloaded', '1');
      location.reload();
    }
  }).catch(() => { /* headers may already be served natively */ });
}

/* ------------------------------- Constants ------------------------------ */
const QR_PREFIX     = 'SFB1:';
const ID_RE         = /^sfb-[a-z0-9]{12}$/;
const UCI_RE        = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
// "Kiwipete" — famously dense tactical position, ideal for sustained load.
const STRESS_FEN    = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
const MAX_MSG_BYTES = 4096;
const MAX_MSGS_SEC  = 50;
const MAX_POINTS    = 300;
const SAMPLE_MS     = 500;
const SF_CDN        = 'https://cdn.jsdelivr.net/npm/stockfish@18.0.0/src/';

const $ = (id) => document.getElementById(id);

/* --------------------------------- State -------------------------------- */
let role = null, peer = null, conn = null;
let worker = null, engineReady = false, engineThreaded = false;
let peerInfo = null;
let mode = null, cfg = null;
let chessLibs = null, chess = null, ground = null;
let myColor = null, thinking = false, tStart = 0;
let lastTel = { nps: 0, nodes: 0, depth: 0 };
let ttds = [], samples = [];
let stressTimer = null, stressEndTimer = null;
let myResult = null, remoteResult = null;
let chart = null;
let camStream = null, scanRAF = 0;
let msgWindow = { t: 0, n: 0 };

const myCores = Math.max(1, navigator.hardwareConcurrency || 1);

/* -------------------------------- Helpers ------------------------------- */
const setStatus = (t) => { $('status').textContent = t; };
const fmt = (n) => (n === undefined || n === null) ? '–' : Number(n).toLocaleString('en-US');
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

function screen(name) {
  for (const s of ['s-connect', 's-mode', 's-run']) hide(s);
  show(name);
}

function setEngine(state, text) {           // state: wait | ok | warn | err
  const pill = $('engine-pill');
  pill.className = 'pill pill-' + state;
  $('engine-status').textContent = text;
}

function setIsoPill() {
  const pill = $('iso-pill');
  if (crossOriginIsolated) {
    pill.className = 'pill pill-ok';
    $('iso-status').textContent = 'Multi-thread ready';
  } else {
    pill.className = 'pill pill-warn';
    $('iso-status').textContent = 'Single-thread mode';
  }
}

function makeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return 'sfb-' + Array.from(bytes, (b) => alpha[b % 36]).join('');
}

/* ------------------- Lazy chess libraries (Mode A only) ------------------ */
function loadChessLibs() {
  if (chessLibs) return Promise.resolve(chessLibs);
  return Promise.all([
    import('https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm'),
    import('https://cdn.jsdelivr.net/npm/chessground@9.1.1/+esm'),
  ]).then(([cjs, cg]) => {
    chessLibs = { Chess: cjs.Chess, Chessground: cg.Chessground };
    return chessLibs;
  });
}

/* ------------------------------ Engine setup ---------------------------- */
function engineSources() {
  const local = (f) => new URL('stockfish/' + f, location.href).href;
  const s = [];
  if (crossOriginIsolated) {
    s.push({ label: 'local files',  js: local('stockfish-18-lite.js'), threaded: true });
    s.push({ label: 'CDN',          js: SF_CDN + 'stockfish-18-lite.js', threaded: true, crossOrigin: true });
  }
  s.push({ label: 'local files', js: local('stockfish-18-lite-single.js') });
  s.push({ label: 'CDN',         js: SF_CDN + 'stockfish-18-lite-single.js', crossOrigin: true });
  return s;
}

function startWorker() {
  try {
    // ?v=2 busts the HTTP cache so the fixed worker script is always fetched.
    worker = new Worker('./worker.js?v=2');
  } catch {
    setEngine('err', 'Engine worker blocked — serve the app over HTTPS, not file://');
    return;
  }
  worker.onmessage = (e) => onWorkerMsg(e.data || {});
  worker.onerror = () => setEngine('err', 'Engine worker crashed — reload the page.');
  worker.postMessage({ type: 'load', sources: engineSources() });
}

const uci = (cmd) => worker && worker.postMessage({ type: 'uci', cmd });

function onWorkerMsg(m) {
  switch (m.type) {
    case 'loaded':
      engineThreaded = !!m.threaded;
      setEngine('ok', `Stockfish 18 · ${m.threaded ? 'multi' : 'single'}-threaded · ${m.source}`);
      break;
    case 'loadfail':
      setEngine('wait', `Engine loading… (${m.source} variant unavailable, trying next)`);
      break;
    case 'uciok': uci('isready'); break;
    case 'readyok': engineReady = true; break;
    case 'telemetry':
      if (m.nps   !== undefined) lastTel.nps   = m.nps;
      if (m.nodes !== undefined) lastTel.nodes = m.nodes;
      if (m.depth !== undefined) lastTel.depth = m.depth;
      renderLocal();
      break;
    case 'bestmove': onBestmove(m.move); break;
    case 'fatal':
      setEngine('err', 'Engine failed to load — check the stockfish/ folder in your repo.');
      break;
  }
}

/* --------------------------- Peer / handshake --------------------------- */
function libsMissing() {
  if (typeof Peer !== 'function') {
    setStatus('Connection library failed to load — check your internet connection and reload.');
    return true;
  }
  return false;
}

function startHost() {
  if (libsMissing()) return;
  role = 'host';
  hide('role-pick'); show('host-panel');
  setStatus('Creating peer ID…');
  peer = new Peer(makeId());
  peer.on('open', (id) => {
    renderQR(QR_PREFIX + id);
    $('host-token').textContent = id;
    setStatus('Waiting for the other device to scan…');
  });
  peer.on('connection', (c) => {
    if (conn) { c.close(); return; }         // exactly one peer per session
    bindConn(c);
  });
  peer.on('error', (e) => setStatus('Connection error: ' + e.type));
}

function renderQR(text) {
  const img = $('qr-img');
  try {
    if (typeof qrcode !== 'function') throw new Error('qr lib missing');
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    img.src = qr.createDataURL(6, 8);        // local data: URL, no server
  } catch {
    img.closest('.qr-frame').classList.add('hidden');
    $('qr-fallback').textContent = 'QR unavailable on this device — use the token below instead.';
  }
}

function startJoin() {
  if (libsMissing()) return;
  role = 'join';
  hide('role-pick'); show('join-panel');
  startScanner();
}

function connectTo(id) {
  setStatus('Connecting…');
  peer = new Peer(makeId());
  peer.on('open', () => bindConn(peer.connect(id, { reliable: true })));
  peer.on('error', (e) => setStatus('Connection error: ' + e.type));
}

function handleToken(text) {
  if (typeof text !== 'string') return;
  const id = text.startsWith(QR_PREFIX) ? text.slice(QR_PREFIX.length) : text.trim();
  if (!ID_RE.test(id)) { setStatus('That does not look like a valid token.'); return; }
  stopScanner();
  connectTo(id);
}

function bindConn(c) {
  conn = c;
  conn.on('open', () => {
    setStatus('Connected — peer to peer.');
    send({ t: 'hello', cores: myCores, isolated: crossOriginIsolated === true });
    loadChessLibs().catch(() => {});         // pre-warm in the background
    enterModeScreen();
  });
  conn.on('data', (raw) => {
    const m = validateMsg(raw);
    if (m) handlePeerMsg(m);
  });
  conn.on('close', () => { setStatus('Peer disconnected.'); teardownRun(); });
  conn.on('error',  () => setStatus('Data channel error.'));
}

const send = (obj) => { if (conn && conn.open) conn.send(JSON.stringify(obj)); };

/* ----------------------- Incoming message validation -------------------- */
function validateMsg(raw) {
  const now = Date.now();
  if (now - msgWindow.t > 1000) msgWindow = { t: now, n: 0 };
  if (++msgWindow.n > MAX_MSGS_SEC) return null;
  if (typeof raw !== 'string' || raw.length > MAX_MSG_BYTES) return null;
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string') return null;

  switch (m.t) {
    case 'hello':
      return isInt(m.cores, 1, 256) && typeof m.isolated === 'boolean' ? m : null;
    case 'start':
      return (m.mode === 'match' || m.mode === 'stress')
        && isInt(m.threads, 1, 64) && isInt(m.depth, 1, 40)
        && isInt(m.duration, 5, 600) ? m : null;
    case 'move':
      return typeof m.uci === 'string' && UCI_RE.test(m.uci)
        && isInt(m.ttd, 0, 1e7) && isInt(m.nodes, 0, 1e12) && isInt(m.nps, 0, 1e10) ? m : null;
    case 'telemetry':
      return isInt(m.el, 0, 1e6) && isInt(m.nps, 0, 1e10) && isInt(m.nodes, 0, 1e13) ? m : null;
    case 'result':
      return isInt(m.avg, 0, 1e10) && typeof m.res === 'number' && m.res >= 0 && m.res <= 10 ? m : null;
    case 'gameover':
    case 'abort':
      return typeof m.reason === 'string' && m.reason.length <= 128 ? m : null;
    default:
      return null;
  }
}

function handlePeerMsg(m) {
  switch (m.t) {
    case 'hello':   peerInfo = { cores: m.cores, isolated: m.isolated }; updateThreadInfo(); break;
    case 'start':   if (role === 'join') beginMode(m); break;
    case 'move':    onPeerMove(m); break;
    case 'telemetry': onPeerTelemetry(m); break;
    case 'result':  remoteResult = m; maybeDeclareStressWinner(); break;
    case 'gameover': break;
    case 'abort':   setStatus('Peer ended the session.'); teardownRun(); break;
  }
}

/* ------------------------------- QR scanner ----------------------------- */
async function startScanner() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('scan-hint').textContent = 'Camera not available here — paste the token below instead.';
    return;
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    $('scan-hint').textContent = 'Camera permission denied — paste the token below instead.';
    return;
  }
  const video = $('cam');
  video.classList.remove('hidden');
  video.srcObject = camStream;
  await video.play();
  $('scan-hint').textContent = "Point the camera at the host's QR code…";

  const detector = ('BarcodeDetector' in window)
    ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
  const canvas = document.createElement('canvas');
  const cx = canvas.getContext('2d', { willReadFrequently: true });

  const tick = async () => {
    if (!camStream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      try {
        if (detector) {
          const codes = await detector.detect(video);
          if (codes.length) { handleToken(codes[0].rawValue); return; }
        } else if (typeof jsQR === 'function') {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          cx.drawImage(video, 0, 0);
          const img = cx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height);
          if (code) { handleToken(code.data); return; }
        } else {
          $('scan-hint').textContent = 'QR scanner unavailable — paste the token below instead.';
          return;
        }
      } catch { /* keep scanning */ }
    }
    scanRAF = requestAnimationFrame(tick);
  };
  scanRAF = requestAnimationFrame(tick);
}

function stopScanner() {
  cancelAnimationFrame(scanRAF);
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  $('cam').classList.add('hidden');
}

/* ------------------------------ Mode select ----------------------------- */
function enterModeScreen() {
  screen('s-mode');
  if (role === 'host') { show('mode-host'); updateThreadInfo(); }
  else show('mode-wait');
}

function matchedThreads() {
  if (!peerInfo) return 1;
  if (!crossOriginIsolated || !peerInfo.isolated || !engineThreaded) return 1;
  return Math.max(1, Math.min(myCores, peerInfo.cores, 8));
}

function updateThreadInfo() {
  if (role !== 'host' || !peerInfo) return;
  const t = matchedThreads();
  $('thread-info').textContent =
    `Matched baseline: ${t} thread${t > 1 ? 's' : ''} per device ` +
    `(this device: ${myCores} cores, remote: ${peerInfo.cores} cores` +
    (t === 1 && (myCores > 1 || peerInfo.cores > 1) ? ' — limited to 1: multi-threading unavailable on at least one side' : '') + ')';
}

function hostStart(m) {
  if (!peerInfo) { setStatus('Still exchanging device info — try again in a second.'); return; }
  if (!engineReady) { setStatus('Engine is still loading — wait for the green pill, then try again.'); return; }
  const c = {
    t: 'start', mode: m,
    threads: matchedThreads(),
    depth: parseInt($('sel-depth').value, 10),
    duration: parseInt($('sel-duration').value, 10),
  };
  send(c);
  beginMode(c);
}

function beginMode(c) {
  cfg = { threads: c.threads, depth: c.depth, duration: c.duration };
  mode = c.mode;
  ttds = []; samples = []; myResult = null; remoteResult = null;
  lastTel = { nps: 0, nodes: 0, depth: 0 };
  $('verdict').textContent = '';
  screen('s-run');
  initChart();
  uci('setoption name Threads value ' + cfg.threads);
  uci('setoption name Hash value 32');
  uci('ucinewgame');
  if (mode === 'match') beginMatch(); else beginStress();
}

/* ----------------------------- Mode A: match ---------------------------- */
async function beginMatch() {
  show('board-wrap');
  $('l-extra-label').textContent = 'last TTD (ms)';
  $('r-extra-label').textContent = 'last TTD (ms)';
  let libs;
  try { libs = await loadChessLibs(); }
  catch { endRun('Could not load the chess libraries — check the connection and restart the mode.'); return; }
  chess = new libs.Chess();
  myColor = role === 'host' ? 'w' : 'b';
  ground = libs.Chessground($('board'), {
    fen: chess.fen(), viewOnly: true, coordinates: false,
    orientation: myColor === 'w' ? 'white' : 'black',
  });
  setStatus(`Match — fixed depth ${cfg.depth}, ${cfg.threads} thread(s) each. You are ${myColor === 'w' ? 'White' : 'Black'}.`);
  if (chess.turn() === myColor) think();
}

function think() {
  thinking = true;
  tStart = performance.now();
  uci('position fen ' + chess.fen());
  uci('go depth ' + cfg.depth);
}

function onBestmove(moveStr) {
  if (mode === 'match' && thinking) {
    thinking = false;
    if (typeof moveStr !== 'string' || !UCI_RE.test(moveStr)) { endRun('Engine returned an unusable move.'); return; }
    const ttd = Math.round(performance.now() - tStart);
    if (!applyUci(moveStr)) { endRun('Engine move rejected by rules engine.'); return; }
    ttds.push(ttd);
    $('l-extra').textContent = fmt(ttd);
    send({ t: 'move', uci: moveStr, ttd, nodes: lastTel.nodes || 0, nps: lastTel.nps || 0 });
    afterMove();
  }
  // Mode B: bestmove arrives after 'stop' — nothing to do.
}

function onPeerMove(m) {
  if (mode !== 'match' || !chess || chess.turn() === myColor) { endRun('Protocol violation from peer.'); return; }
  if (!applyUci(m.uci)) {
    send({ t: 'abort', reason: 'illegal move received' });
    endRun('Received an illegal move — session stopped.');
    return;
  }
  $('r-extra').textContent = fmt(m.ttd);
  $('r-nps').textContent = fmt(m.nps);
  $('r-nodes').textContent = fmt(m.nodes);
  afterMove(true);
}

function applyUci(u) {
  try {
    chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || undefined });
  } catch { return false; }
  if (ground) ground.set({ fen: chess.fen() });
  return true;
}

function afterMove(fromPeer = false) {
  if (chess.isGameOver()) {
    const reason = chess.isCheckmate() ? 'checkmate' : 'draw';
    send({ t: 'gameover', reason });
    const avgTtd = ttds.length ? Math.round(ttds.reduce((a, b) => a + b, 0) / ttds.length) : 0;
    $('verdict').textContent = `Game over (${reason}). This device averaged ${fmt(avgTtd)} ms to depth ${cfg.depth}. Lower is faster.`;
    setStatus('Match finished.');
    return;
  }
  if (fromPeer && chess.turn() === myColor) think();
}

/* --------------------------- Mode B: stress test ------------------------ */
function beginStress() {
  hide('board-wrap');
  $('l-extra-label').textContent = 'depth';
  $('r-extra-label').textContent = 'depth';
  setStatus(`Stress test — go infinite for ${cfg.duration}s at ${cfg.threads} thread(s).`);
  uci('position fen ' + STRESS_FEN);
  uci('go infinite');
  const t0 = performance.now();

  stressTimer = setInterval(() => {
    const el = Math.round(performance.now() - t0);
    const nps = lastTel.nps || 0;
    samples.push(nps);
    addPoint(0, el / 1000, nps);
    $('l-extra').textContent = fmt(lastTel.depth);
    send({ t: 'telemetry', el, nps, nodes: lastTel.nodes || 0 });
  }, SAMPLE_MS);

  stressEndTimer = setTimeout(() => {
    clearInterval(stressTimer); stressTimer = null;
    uci('stop');
    const q = Math.max(1, Math.floor(samples.length / 4));
    const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    const avg = Math.round(mean(samples));
    const res = Math.round((mean(samples.slice(-q)) / Math.max(1, mean(samples.slice(0, q)))) * 100) / 100;
    myResult = { avg, res };
    send({ t: 'result', avg, res });
    maybeDeclareStressWinner();
  }, cfg.duration * 1000);
}

function onPeerTelemetry(m) {
  if (mode !== 'stress') return;
  addPoint(1, m.el / 1000, m.nps);
  $('r-nps').textContent = fmt(m.nps);
  $('r-nodes').textContent = fmt(m.nodes);
}

function maybeDeclareStressWinner() {
  if (!myResult || !remoteResult) return;
  const pct = (r) => Math.round(r * 100) + '%';
  const line = (who, r) => `${who}: avg ${fmt(r.avg)} NPS, throttling resistance ${pct(r.res)}`;
  const winner =
    myResult.avg === remoteResult.avg ? 'Dead heat!' :
    myResult.avg > remoteResult.avg ? 'This device wins on average NPS.' : 'The remote device wins on average NPS.';
  $('verdict').textContent = `${winner} — ${line('This device', myResult)} · ${line('Remote', remoteResult)}`;
  setStatus('Stress test finished.');
}

/* --------------------------------- Chart -------------------------------- */
function initChart() {
  if (typeof Chart !== 'function') { chart = null; return; }
  if (chart) chart.destroy();
  chart = new Chart($('chart'), {
    type: 'line',
    data: { datasets: [
      { label: 'This device (NPS)',   data: [], borderColor: '#38bdf8', pointRadius: 0, tension: 0.25 },
      { label: 'Remote device (NPS)', data: [], borderColor: '#f472b6', pointRadius: 0, tension: 0.25 },
    ]},
    options: {
      animation: false, parsing: false, responsive: true,
      scales: {
        x: { type: 'linear', title: { display: true, text: 'seconds' }, ticks: { color: '#8b8b9a' }, grid: { color: '#1c1c26' } },
        y: { beginAtZero: true, title: { display: true, text: 'nodes / second' }, ticks: { color: '#8b8b9a' }, grid: { color: '#1c1c26' } },
      },
      plugins: { legend: { labels: { color: '#cbd5e1' } } },
    },
  });
}

function addPoint(ds, x, y) {
  if (!chart) return;
  const data = chart.data.datasets[ds].data;
  data.push({ x, y });
  if (data.length > MAX_POINTS) data.shift();
  chart.update('none');
}

/* ------------------------------ Dashboard ------------------------------- */
function renderLocal() {
  $('l-nps').textContent = fmt(lastTel.nps);
  $('l-nodes').textContent = fmt(lastTel.nodes);
  if (mode === 'stress') $('l-extra').textContent = fmt(lastTel.depth);
}

/* ------------------------------- Teardown ------------------------------- */
function teardownRun() {
  if (stressTimer) clearInterval(stressTimer);
  if (stressEndTimer) clearTimeout(stressEndTimer);
  stressTimer = stressEndTimer = null;
  thinking = false;
  uci('stop');
}

function endRun(message) {
  teardownRun();
  setStatus(message);
}

/* --------------------------------- Wiring ------------------------------- */
$('btn-host').addEventListener('click', startHost);
$('btn-join').addEventListener('click', startJoin);
$('btn-manual').addEventListener('click', () => handleToken($('manual-token').value));
$('btn-match').addEventListener('click', () => hostStart('match'));
$('btn-stress').addEventListener('click', () => hostStart('stress'));
$('btn-end').addEventListener('click', () => {
  send({ t: 'abort', reason: 'user ended session' });
  endRun('Session ended.');
});

window.addEventListener('error', (e) => {
  setStatus('Something went wrong: ' + (e.message || 'script error'));
});

setIsoPill();
if (!window.isSecureContext) {
  setStatus('This app needs HTTPS (or localhost) — opening the file directly will not work.');
  setEngine('err', 'Blocked: not a secure context');
} else {
  setStatus('Pick a role to connect two devices.');
  startWorker();
}
