/* worker.js — owns the Stockfish WASM lifecycle and parses its UCI stdout.
   Tries engine sources in order (local multi-threaded → CDN multi-threaded →
   local single → CDN single) and reports which one loaded. */

let engine = null;
let lastTelemetryAt = 0;

const post = (m) => self.postMessage(m);

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'load') { loadEngine(Array.isArray(msg.sources) ? msg.sources : []); return; }
  if (msg.type === 'uci' && engine && typeof msg.cmd === 'string' && msg.cmd.length < 512) {
    engine.postMessage(msg.cmd);
  }
};

async function loadEngine(sources) {
  for (const src of sources) {
    try {
      let scriptUrl = src.js;
      const opts = {};

      if (src.crossOrigin) {
        // Cross-origin engines: pull the loader script and run it from a
        // same-origin blob so Emscripten's pthread helper workers are allowed
        // to spawn. File lookups (.wasm, worker parts) are pointed back at
        // the CDN, which serves CORS + CORP headers.
        const resp = await fetch(src.js);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = new Blob([await resp.text()], { type: 'text/javascript' });
        scriptUrl = URL.createObjectURL(blob);
        opts.mainScriptUrlOrBlob = blob;
        opts.locateFile = (p) => new URL(p, src.js).href;
      }

      importScripts(scriptUrl);

      if (typeof Stockfish === 'function') {
        // Modern nmrugg builds: Stockfish() returns a promise of the engine.
        const sf = await Stockfish(opts);
        sf.addMessageListener(onLine);
        engine = sf;
      } else if (typeof STOCKFISH === 'function') {
        // Legacy builds.
        engine = STOCKFISH();
        engine.onmessage = (l) => onLine(typeof l === 'string' ? l : l && l.data);
      } else {
        throw new Error('no engine entry point after importScripts');
      }

      post({ type: 'loaded', source: String(src.label || ''), threaded: !!src.threaded });
      engine.postMessage('uci');
      return;
    } catch (err) {
      post({ type: 'loadfail', source: String(src.label || ''), error: String(err && err.message || err) });
    }
  }
  post({ type: 'fatal', error: 'All engine sources failed to load.' });
}

function onLine(line) {
  if (typeof line !== 'string') return;

  if (line.startsWith('info ')) {
    const grab = (k) => {
      const m = line.match(new RegExp('\\b' + k + ' (\\d+)\\b'));
      return m ? parseInt(m[1], 10) : undefined;
    };
    const nps = grab('nps');
    if (nps === undefined) return;               // ignore info lines without perf data
    const now = Date.now();
    if (now - lastTelemetryAt < 100) return;     // throttle: max ~10 updates/s
    lastTelemetryAt = now;
    post({ type: 'telemetry', depth: grab('depth'), nodes: grab('nodes'), nps, time: grab('time') });
    return;
  }

  if (line.startsWith('bestmove')) {
    const m = line.match(/^bestmove (\S+)/);
    post({ type: 'bestmove', move: m ? m[1] : null });
    return;
  }

  if (line === 'uciok' || line === 'readyok') post({ type: line });
}

