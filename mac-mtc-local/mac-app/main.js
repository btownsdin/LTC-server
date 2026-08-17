// ============================================================================
// main.js — Electron main process for the LTC → MTC app
// ============================================================================
// Audio capture + LTC decode happen in the RENDERER (via getUserMedia + Web
// Audio), which is what makes the macOS mic prompt and device list work
// reliably. The main process owns everything else: the MIDI output, the MTC
// quarter-frame generator, and the LAN dashboard (HTTP + WebSocket). The
// renderer streams decoded timecode frames here over IPC.
// ============================================================================

const { app, BrowserWindow, ipcMain, shell, session, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const dgram = require('dgram');

let WebSocketServer = null;
try { WebSocketServer = require('ws').WebSocketServer; } catch (_) {}

const { MtcSender, resolveFps } = require('./mtc-sender');

// Last-resort guard: convert an otherwise-fatal main-process error into a
// message in the app window instead of the scary "A JavaScript error occurred"
// crash dialog. (Real logic errors are still surfaced; the app just survives.)
process.on('uncaughtException', (err) => {
    try {
        const msg = (err && err.code === 'EADDRINUSE')
            ? 'The dashboard port is already in use — another copy of the app may be running.'
            : ('Unexpected error: ' + (err && err.message ? err.message : String(err)));
        if (win && !win.isDestroyed()) win.webContents.send('status', { error: msg });
        console.error('uncaughtException:', err);
    } catch (_) {}
});

// --- MIDI (prebuilt native module; rebuilt for Electron at package time) -----
let midi = null;
try { midi = require('@julusian/midi'); }
catch (e) { try { midi = require('midi'); } catch (_) {} }

// --- Settings persistence (plain JSON in userData) ---------------------------
const SETTINGS_DEFAULTS = {
    audioDeviceId: '',     // chosen input (empty = system default)
    channels: 2,
    ltcChannel: 0,
    fps: 'auto',
    midiOut: 'IAC Driver',
    gain: 1.0,
    dashPort: 8085,
    tslEnabled: false,     // watch a TSL 5.0 UMD tally source on the LAN
    tslPort: 9910,         // UDP port the TSL source sends to
    tslAddress: 1,         // the one tally "INDEX" to watch (see the source's config)
};
let settingsPath = null;
function loadSettings() {
    try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) }; }
    catch (_) { return { ...SETTINGS_DEFAULTS }; }
}
function saveSettings(s) { try { fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2)); } catch (_) {} }

// --- Runtime state -----------------------------------------------------------
let win = null;
let mtc = null;
let midiOut = null;
let rate = resolveFps(30, false);
let fpsMode = 'auto';
let running = false;

// Dashboard (LAN) server
let httpServer = null, wss = null, dashPort = 8085, dashUrls = { local: '', lan: '' };

// TSL 5.0 tally listener
let tslSocket = null, tslState = 'off';

// ---------------------------------------------------------------------------
// LAN dashboard
// ---------------------------------------------------------------------------
function lanIp() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of (nets[name] || [])) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return '';
}
function startDashboardServer(port, attempt) {
    stopDashboardServer();
    dashPort = port || 8085;
    attempt = attempt || 0;
    const serve = (file, res) => {
        fs.readFile(path.join(__dirname, 'dashboard', file), (err, data) => {
            if (err) { res.writeHead(500); return res.end('Error loading ' + file); }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    };
    httpServer = http.createServer((req, res) => {
        const url = (req.url || '/').split('?')[0];
        if (url === '/' || url === '/index.html') return serve('index.html', res);
        if (url === '/minimal' || url === '/minimal.html') return serve('minimal.html', res);
        res.writeHead(404); res.end();
    });

    // If the port is taken (e.g. another copy of the app is open), don't crash —
    // try the next few ports, then report clearly if none are free.
    httpServer.on('error', (e) => {
        try { httpServer.close(); } catch (_) {}
        httpServer = null; wss = null;
        if (e.code === 'EADDRINUSE' && attempt < 10) {
            pushStatus({ error: `Port ${dashPort} in use — trying ${dashPort + 1}…` });
            startDashboardServer(dashPort + 1, attempt + 1);
        } else {
            pushStatus({ error:
                `Could not start the dashboard (port ${dashPort}: ${e.code}). ` +
                `Another copy of the app may be running — quit it, or change the Port in the app.` });
        }
    });

    if (WebSocketServer) wss = new WebSocketServer({ server: httpServer });
    httpServer.listen(dashPort, '0.0.0.0', () => {
        const ip = lanIp();
        dashUrls = { local: `http://localhost:${dashPort}`, lan: ip ? `http://${ip}:${dashPort}` : '' };
        pushStatus({ dashUrls, error: null });
    });
}
function stopDashboardServer() {
    if (wss) { try { wss.close(); } catch (_) {} wss = null; }
    if (httpServer) { try { httpServer.close(); } catch (_) {} httpServer = null; }
}
function broadcastMtc(bytes) {
    if (!wss) return;
    const payload = JSON.stringify({ bytes });
    for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
}

// --- Decoded timecode broadcast (for external tools, e.g. a Companion module) ---
// The renderer already hands us fully-decoded h/m/s/f (see onFrame below), so
// unlike the standalone server.js this needs no MTC re-parsing — just forward
// it as clean JSON alongside the existing raw `{ bytes }` broadcast. "Running"
// uses the same digit-movement + 2s tolerance the dashboards already use, so
// a frozen-but-still-arriving timecode reads as "paused" consistently.
const RUN_TOLERANCE_MS = 2000;
let lastFrameH = -1, lastFrameM = -1, lastFrameS = -1;
let lastMovementTime = 0;
let runWatchdog = null;

function pad2(n) { return String(n).padStart(2, '0'); }
function tcString(h, m, s, f) { return `${pad2(h)}:${pad2(m)}:${pad2(s)}:${pad2(f)}`; }

function broadcastDecodedTimecode(h, m, s, f, fpsLabel) {
    if (!wss) return;
    const now = Date.now();
    if (h !== lastFrameH || m !== lastFrameM || s !== lastFrameS || lastFrameH === -1) {
        lastMovementTime = now;
    }
    lastFrameH = h; lastFrameM = m; lastFrameS = s;

    const isRunning = (now - lastMovementTime) < RUN_TOLERANCE_MS;
    const payload = JSON.stringify({
        tc: { h, m, s, f },
        fps: fpsLabel,
        running: isRunning,
        timecode: tcString(h, m, s, f),
    });
    for (const c of wss.clients) if (c.readyState === 1) c.send(payload);

    clearTimeout(runWatchdog);
    runWatchdog = setTimeout(() => {
        if (!wss) return;
        const pausedPayload = JSON.stringify({
            tc: { h: lastFrameH, m: lastFrameM, s: lastFrameS, f: 0 },
            fps: fpsLabel,
            running: false,
            timecode: tcString(lastFrameH, lastFrameM, lastFrameS, 0),
        });
        for (const c of wss.clients) if (c.readyState === 1) c.send(pausedPayload);
    }, RUN_TOLERANCE_MS);
}

// ---------------------------------------------------------------------------
// TSL 5.0 tally listener
// ---------------------------------------------------------------------------
// Watches for TSL 5.0 UMD packets from ONE tally source on the LAN (identified
// by its "INDEX" / tally address) and broadcasts whether that source is in
// preview, program, both, or neither to the dashboard. Point the tally
// source's UMD output at this Mac's LAN IP + the configured port.
//
// Packet layout (little-endian), same as the reference bitfocus
// companion-module-tslproducts-umdlistener:
//   PBC(2) VER(1) FLAGS(1) SCREEN(2) INDEX(2) CONTROL(2) LENGTH(2) TEXT(LENGTH)
// CONTROL's low bits pack the "text tally": 0=off, 1=program(red),
// 2=preview(green), 3=both(amber). Some senders wrap UDP payloads in the same
// DLE/STX framing used on TCP/serial, so that's unwrapped first, same as the
// reference module.
function parseTsl5Packet(data) {
    if (data[0] === 0xfe && data[1] === 0x02) {
        data = data.slice(2);
        const clean = [];
        for (let i = 0; i < data.length; i++) {
            if (data[i] === 0xfe && data[i + 1] === 0xfe) { clean.push(0xfe); i++; }
            else clean.push(data[i]);
        }
        data = Buffer.from(clean);
    }
    if (data.length < 12) return null;

    const INDEX = data.readUInt16LE(6);
    const CONTROL = data.readUInt16LE(8);
    const textTally = (CONTROL >> 2) & 0b11;

    const state = { 0: 'off', 1: 'program', 2: 'preview', 3: 'both' }[textTally] || 'off';
    return { index: INDEX, state };
}

function tslBroadcast(state) {
    tslState = state;
    pushStatus({ tslState: state });
    if (!wss) return;
    const payload = JSON.stringify({ tally: { state } });
    for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
}

function startTslListener(port, address) {
    stopTslListener();
    if (!port) return;

    try {
        tslSocket = dgram.createSocket('udp4');
        tslSocket.on('error', (e) => {
            pushStatus({ error: `TSL listener error on port ${port}: ${e.message}` });
            try { tslSocket.close(); } catch (_) {}
            tslSocket = null;
        });
        tslSocket.on('message', (msg) => {
            let parsed;
            try { parsed = parseTsl5Packet(msg); } catch (_) { return; }
            if (!parsed || parsed.index !== address) return; // not our one watched source
            tslBroadcast(parsed.state);
        });
        tslSocket.bind(port, () => {
            pushStatus({ tslListening: true, tslPort: port, tslAddress: address });
        });
    } catch (e) {
        pushStatus({ error: `Could not start TSL listener: ${e.message}` });
        tslSocket = null;
    }
}

function stopTslListener() {
    if (tslSocket) { try { tslSocket.close(); } catch (_) {} tslSocket = null; }
    tslState = 'off';
}

// ---------------------------------------------------------------------------
// MIDI
// ---------------------------------------------------------------------------
function listMidiOutputs() {
    if (!midi) return [];
    const out = new midi.Output();
    const names = [];
    for (let i = 0; i < out.getPortCount(); i++) names.push(out.getPortName(i));
    out.closePort();
    return names;
}
function openMidi(matchName) {
    if (!midi) throw new Error('MIDI module unavailable');
    const out = new midi.Output();
    let idx = -1;
    for (let i = 0; i < out.getPortCount(); i++) {
        const name = out.getPortName(i);
        if (name.includes(matchName) || name.includes('Bus 1')) { idx = i; break; }
    }
    if (idx !== -1) { out.openPort(idx); return { out, name: out.getPortName(idx), virtual: false }; }
    out.openVirtualPort('LTC to MTC');
    return { out, name: 'LTC to MTC (virtual)', virtual: true };
}

// ---------------------------------------------------------------------------
// Engine: start/stop the MTC sender + dashboard feed. Frames arrive via IPC.
// ---------------------------------------------------------------------------
function engineStart(settings) {
    engineStop();
    fpsMode = settings.fps;
    const fpsGuess = fpsMode === 'auto' ? 30 : parseFloat(fpsMode);
    rate = resolveFps(fpsGuess, false);

    let midiInfo = null;
    try { midiInfo = openMidi(settings.midiOut); midiOut = midiInfo.out; }
    catch (e) { midiOut = null; pushStatus({ error: 'MIDI output unavailable (dashboard still works): ' + e.message }); }

    const send = (bytes) => {
        if (midiOut) { try { midiOut.sendMessage(bytes); } catch (_) {} }
        broadcastMtc(bytes);
    };
    mtc = new MtcSender(send, rate);
    mtc.start();
    running = true;

    return { ok: true, midiName: midiInfo ? midiInfo.name : 'none', virtual: midiInfo ? midiInfo.virtual : false };
}
function engineStop() {
    running = false;
    if (mtc) { mtc.stop(); mtc = null; }
    if (midiOut) { try { midiOut.closePort(); } catch (_) {} midiOut = null; }
    clearTimeout(runWatchdog);
    lastFrameH = lastFrameM = lastFrameS = -1;
}

// A decoded LTC frame from the renderer.
function onFrame(frame) {
    if (!mtc) return;
    const r = (fpsMode === 'auto')
        ? resolveFps(frame.fps || 30, frame.drop)
        : resolveFps(parseFloat(fpsMode), frame.drop);
    if (r.rateCode !== rate.rateCode) { rate = r; mtc.setRate(r); }
    mtc.updateTimecode({ h: frame.h, m: frame.m, s: frame.s, f: frame.f });
    broadcastDecodedTimecode(frame.h, frame.m, frame.s, frame.f, r.label);
}

function pushStatus(obj) { if (win && !win.isDestroyed()) win.webContents.send('status', obj); }

// Periodic dashboard viewer-count ping to the UI
setInterval(() => {
    if (win && !win.isDestroyed()) pushStatus({ clients: wss ? wss.clients.size : 0, rateLabel: rate.label });
}, 500);

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('get-init', async () => ({
    settings: loadSettings(),
    midiOutputs: listMidiOutputs(),
    midiAvailable: !!midi,
    dashAvailable: !!WebSocketServer,
    dashUrls,
}));
ipcMain.handle('refresh-midi', () => ({ midiOutputs: listMidiOutputs() }));
ipcMain.handle('engine-start', (_e, settings) => { saveSettings(settings); return engineStart(settings); });

// Trigger the macOS microphone prompt from the MAIN process. On packaged apps a
// renderer getUserMedia call alone doesn't reliably fire the OS (TCC) prompt —
// this does, attributed to the app via its NSMicrophoneUsageDescription.
ipcMain.handle('request-mic', async () => {
    if (process.platform !== 'darwin' || !systemPreferences.getMediaAccessStatus) return { ok: true };
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return { ok: true, status };
    if (status === 'denied' || status === 'restricted') {
        try { shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'); } catch (_) {}
        return { ok: false, status };
    }
    try {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        return { ok: !!granted, status: granted ? 'granted' : 'denied' };
    } catch (e) {
        return { ok: false, status: 'error', error: e.message };
    }
});
ipcMain.handle('engine-stop', () => { engineStop(); return true; });
ipcMain.handle('frame', (_e, frame) => { onFrame(frame); return true; });
ipcMain.handle('save-settings', (_e, settings) => { saveSettings(settings); return true; });
ipcMain.handle('open-dashboard', () => { if (dashUrls.local) shell.openExternal(dashUrls.local); return true; });
ipcMain.handle('set-dash-port', (_e, port) => {
    const p = parseInt(port, 10);
    if (p >= 1024 && p <= 65535 && p !== dashPort) startDashboardServer(p);
    return true;
});
ipcMain.handle('set-tsl-config', (_e, cfg) => {
    const s = loadSettings();
    const merged = {
        ...s,
        tslEnabled: !!cfg.enabled,
        tslPort: parseInt(cfg.port, 10) || SETTINGS_DEFAULTS.tslPort,
        tslAddress: parseInt(cfg.address, 10) || SETTINGS_DEFAULTS.tslAddress,
    };
    saveSettings(merged);
    if (merged.tslEnabled) startTslListener(merged.tslPort, merged.tslAddress);
    else stopTslListener();
    return true;
});

// ---------------------------------------------------------------------------
// Window / lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
    win = new BrowserWindow({
        width: 460, height: 760, resizable: false,
        title: 'LTC → MTC', backgroundColor: '#14161a',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, nodeIntegration: false,
        },
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');

    // Allow the renderer's getUserMedia request through Electron; the OS (TCC)
    // still shows the real microphone prompt on first use.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
        cb(permission === 'media' || permission === 'microphone' ? true : false);
    });

    const s = loadSettings();
    startDashboardServer(s.dashPort || 8085);
    if (s.tslEnabled) startTslListener(s.tslPort || SETTINGS_DEFAULTS.tslPort, s.tslAddress || SETTINGS_DEFAULTS.tslAddress);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { engineStop(); stopDashboardServer(); stopTslListener(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { engineStop(); stopDashboardServer(); stopTslListener(); });
