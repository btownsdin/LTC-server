// ============================================================================
// main.js — Electron main process for the LTC → MTC app
// ============================================================================
// Owns the audio capture (bundled ffmpeg), the pure-JS LTC decoder, the MIDI
// output, and settings persistence. Talks to the renderer (the settings GUI)
// over IPC.
// ============================================================================

const { app, BrowserWindow, ipcMain, shell, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { spawn, execFile } = require('child_process');

let WebSocketServer = null;
try { WebSocketServer = require('ws').WebSocketServer; } catch (_) { /* dashboard disabled if absent */ }

const { LtcDecoder } = require('./ltc-decoder');
const { MtcSender, resolveFps } = require('./mtc-sender');

// --- Bundled ffmpeg. In a packaged app the binary lives inside the unpacked
//     asar, so rewrite the path accordingly. ------------------------------------
let ffmpegPath = require('ffmpeg-static');
if (ffmpegPath && ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

// --- MIDI (prebuilt native module; rebuilt for Electron at package time) -----
let midi = null;
try { midi = require('@julusian/midi'); }
catch (e) { try { midi = require('midi'); } catch (_) { /* reported to UI later */ } }

// --- Settings persistence (plain JSON in userData) ---------------------------
const SETTINGS_DEFAULTS = {
    audioInput: '0',
    channels: 2,
    ltcChannel: 0,
    fps: 'auto',           // 'auto' | '30' | '29.97' | '25' | '24' | '23.976'
    midiOut: 'IAC Driver',
    gain: 1.0,
    dashPort: 8085,        // LAN dashboard HTTP + WebSocket port
};
let settingsPath = null;
function loadSettings() {
    try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) }; }
    catch (_) { return { ...SETTINGS_DEFAULTS }; }
}
function saveSettings(s) {
    try { fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2)); } catch (_) {}
}

// --- Runtime state -----------------------------------------------------------
let win = null;
let captureProc = null;
let decoder = null;
let mtc = null;
let midiOut = null;
let running = false;
let residual = Buffer.alloc(0);
let lastSentTc = '';
let statusTimer = null;

// Dashboard (LAN) server state
let httpServer = null;
let wss = null;
let dashPort = 8085;
let dashUrls = { local: '', lan: '' };

// ---------------------------------------------------------------------------
// LAN dashboard: HTTP serves the two pages, WebSocket streams MTC bytes.
// Runs independently of conversion so the page is reachable any time; it just
// waits for data until Start is pressed.
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

function startDashboardServer(port) {
    stopDashboardServer();
    dashPort = port || 8085;

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

    httpServer.on('error', (e) => {
        pushStatus({ error: `Dashboard port ${dashPort} unavailable (${e.code}). Change the port and restart.` });
    });

    if (WebSocketServer) wss = new WebSocketServer({ server: httpServer });

    httpServer.listen(dashPort, '0.0.0.0', () => {
        const ip = lanIp();
        dashUrls = {
            local: `http://localhost:${dashPort}`,
            lan: ip ? `http://${ip}:${dashPort}` : '',
        };
        pushStatus({ dashUrls });
    });
}

function stopDashboardServer() {
    if (wss) { try { wss.close(); } catch (_) {} wss = null; }
    if (httpServer) { try { httpServer.close(); } catch (_) {} httpServer = null; }
}

function broadcastMtc(bytes) {
    if (!wss) return;
    const payload = JSON.stringify({ bytes });
    for (const client of wss.clients) {
        if (client.readyState === 1 /* OPEN */) client.send(payload);
    }
}

// ---------------------------------------------------------------------------
// Device enumeration
// ---------------------------------------------------------------------------
function listAudioInputs() {
    // ffmpeg prints the avfoundation device list to stderr.
    return new Promise((resolve) => {
        if (!ffmpegPath) return resolve([]);
        execFile(ffmpegPath, ['-hide_banner', '-f', 'avfoundation',
            '-list_devices', 'true', '-i', ''], (err, stdout, stderr) => {
            const text = (stderr || '') + (stdout || '');
            const lines = text.split('\n');
            const devices = [];
            let inAudio = false;
            for (const line of lines) {
                if (line.includes('AVFoundation audio devices')) { inAudio = true; continue; }
                if (line.includes('AVFoundation video devices')) { inAudio = false; continue; }
                const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
                if (inAudio && m) devices.push({ index: m[1], name: m[2] });
            }
            resolve(devices);
        });
    });
}

function listMidiOutputs() {
    if (!midi) return [];
    const out = new midi.Output();
    const names = [];
    const n = out.getPortCount();
    for (let i = 0; i < n; i++) names.push(out.getPortName(i));
    out.closePort();
    return names;
}

// ---------------------------------------------------------------------------
// Open MIDI output (named port match, or virtual port fallback)
// ---------------------------------------------------------------------------
function openMidi(matchName) {
    if (!midi) throw new Error('MIDI module unavailable');
    const out = new midi.Output();
    const n = out.getPortCount();
    let idx = -1;
    for (let i = 0; i < n; i++) {
        const name = out.getPortName(i);
        if (name.includes(matchName) || name.includes('Bus 1')) { idx = i; break; }
    }
    if (idx !== -1) { out.openPort(idx); return { out, name: out.getPortName(idx), virtual: false }; }
    out.openVirtualPort('LTC to MTC');
    return { out, name: 'LTC to MTC (virtual)', virtual: true };
}

// ---------------------------------------------------------------------------
// Start / stop the conversion pipeline
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Microphone/audio permission (macOS). The capture runs in a child ffmpeg
// process, which never triggers the TCC prompt on its own — the main process
// must ask explicitly. Without this, ffmpeg exits immediately (commonly code
// 234 = EINVAL) because it can't open the audio device.
// ---------------------------------------------------------------------------
async function ensureMicPermission() {
    if (process.platform !== 'darwin' || !systemPreferences.getMediaAccessStatus) {
        return true; // not macOS, or older Electron — nothing to gate on
    }
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return true;

    if (status === 'not-determined') {
        // Shows the system prompt, attributed to this app.
        try {
            const ok = await systemPreferences.askForMediaAccess('microphone');
            if (ok) return true;
        } catch (_) { /* fall through to denied handling */ }
    }

    // denied / restricted / prompt refused — guide the user to the setting.
    pushStatus({
        error: 'Microphone access is required to read the LTC audio input.\n' +
               'Enable it in System Settings → Privacy & Security → Microphone ' +
               '(look for "LTC to MTC", or "Electron" if you launched via npm start), ' +
               'then quit and reopen the app.',
    });
    try { shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'); } catch (_) {}
    return false;
}

async function startConversion(settings) {
    stopConversion();

    if (!ffmpegPath) { pushStatus({ error: 'ffmpeg not bundled correctly.' }); return; }

    // Gate on microphone permission before spawning ffmpeg.
    const permitted = await ensureMicPermission();
    if (!permitted) { pushStatus({ running: false }); return; }

    // MIDI is optional — the LAN dashboard still works without it.
    let midiInfo = null;
    try { midiInfo = openMidi(settings.midiOut); midiOut = midiInfo.out; }
    catch (e) {
        midiOut = null;
        pushStatus({ error: 'MIDI output unavailable (dashboard still works): ' + e.message });
    }

    const fpsGuess = settings.fps === 'auto' ? 30 : parseFloat(settings.fps);
    let rate = resolveFps(fpsGuess, false);

    // Every MTC byte array goes to the MIDI port (if open) AND to the dashboard.
    const send = (bytes) => {
        if (midiOut) { try { midiOut.sendMessage(bytes); } catch (_) {} }
        broadcastMtc(bytes);
    };
    mtc = new MtcSender(send, rate);
    mtc.start();

    const frameBytes = settings.channels * 2;
    const ltcCh = settings.ltcChannel;

    decoder = new LtcDecoder(48000, (frame) => {
        // Respect a manual fps override; otherwise follow the signal.
        let r;
        if (settings.fps === 'auto') {
            r = resolveFps(frame.fps || 30, frame.drop);
        } else {
            r = resolveFps(parseFloat(settings.fps), frame.drop);
        }
        if (r.rateCode !== rate.rateCode) { rate = r; mtc.setRate(r); }
        mtc.updateTimecode({ h: frame.hours, m: frame.minutes, s: frame.seconds, f: frame.frames });
        lastSentTc = `${pad(frame.hours)}:${pad(frame.minutes)}:${pad(frame.seconds)}:${pad(frame.frames)}`;
    });
    decoder.setGain(settings.gain || 1.0);

    residual = Buffer.alloc(0);

    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'avfoundation',
        '-i', `:${settings.audioInput}`,
        '-ac', String(settings.channels),
        '-ar', '48000',
        '-f', 's16le', '-',
    ];
    captureProc = spawn(ffmpegPath, args);

    captureProc.stdout.on('data', (chunk) => {
        const buf = residual.length ? Buffer.concat([residual, chunk]) : chunk;
        const nFrames = Math.floor(buf.length / frameBytes);
        const usable = nFrames * frameBytes;
        const mono = new Int16Array(nFrames);
        for (let i = 0; i < nFrames; i++) {
            mono[i] = buf.readInt16LE(i * frameBytes + ltcCh * 2);
        }
        residual = buf.subarray(usable);
        decoder.process(mono);
    });
    captureProc.stderr.on('data', (d) => {
        const msg = d.toString();
        if (msg.trim()) pushStatus({ error: msg.trim() });
    });
    captureProc.on('exit', (code) => {
        if (!running) return;
        if (code === 234 || code === 251 || code === 1) {
            pushStatus({ error:
                `Audio capture failed (ffmpeg code ${code}). Likely causes:\n` +
                `• Microphone permission not granted (System Settings → Privacy & Security → Microphone)\n` +
                `• Wrong "Audio input" selected — click ↻ Rescan and pick your USB interface\n` +
                `• "Channels" set higher than the device provides` });
        } else {
            pushStatus({ error: `Capture stopped (ffmpeg code ${code}).` });
        }
        running = false;
        pushStatus({ running: false, locked: false });
    });

    running = true;
    const midiName = midiInfo ? midiInfo.name : 'none';
    const midiVirtual = midiInfo ? midiInfo.virtual : false;
    pushStatus({ running: true, midiName, virtual: midiVirtual });

    // Push live status (timecode, fps, level, lock) to the UI ~15×/sec
    statusTimer = setInterval(() => {
        if (!decoder) return;
        pushStatus({
            running: true,
            tc: lastSentTc || '--:--:--:--',
            fps: rate.label,
            level: decoder.readPeak(),
            locked: mtc ? mtc.isRunning() : false,
            midiName,
            virtual: midiVirtual,
            clients: wss ? wss.clients.size : 0,
        });
    }, 66);
}

function stopConversion() {
    running = false;
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (mtc) { mtc.stop(); mtc = null; }
    if (captureProc) { try { captureProc.kill('SIGKILL'); } catch (_) {} captureProc = null; }
    if (midiOut) { try { midiOut.closePort(); } catch (_) {} midiOut = null; }
    decoder = null;
    residual = Buffer.alloc(0);
    lastSentTc = '';
    pushStatus({ running: false, tc: '--:--:--:--', level: 0, locked: false });
}

function pushStatus(obj) { if (win && !win.isDestroyed()) win.webContents.send('status', obj); }
function pad(n) { return String(n).padStart(2, '0'); }

// ---------------------------------------------------------------------------
// IPC wiring
// ---------------------------------------------------------------------------
ipcMain.handle('get-init', async () => ({
    settings: loadSettings(),
    audioInputs: await listAudioInputs(),
    midiOutputs: listMidiOutputs(),
    midiAvailable: !!midi,
    ffmpegAvailable: !!ffmpegPath,
    dashAvailable: !!WebSocketServer,
    dashUrls,
}));
ipcMain.handle('refresh-devices', async () => ({
    audioInputs: await listAudioInputs(),
    midiOutputs: listMidiOutputs(),
}));
ipcMain.handle('start', async (_e, settings) => { saveSettings(settings); await startConversion(settings); return true; });
ipcMain.handle('stop', () => { stopConversion(); return true; });
ipcMain.handle('save-settings', (_e, settings) => { saveSettings(settings); return true; });
ipcMain.handle('set-gain', (_e, g) => { if (decoder) decoder.setGain(g); return true; });
ipcMain.handle('open-dashboard', () => { if (dashUrls.local) shell.openExternal(dashUrls.local); return true; });
ipcMain.handle('set-dash-port', (_e, port) => {
    const p = parseInt(port, 10);
    if (p >= 1024 && p <= 65535 && p !== dashPort) startDashboardServer(p);
    return true;
});

// ---------------------------------------------------------------------------
// Window / app lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
    win = new BrowserWindow({
        width: 460,
        height: 760,
        resizable: false,
        title: 'LTC → MTC',
        backgroundColor: '#14161a',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    const s = loadSettings();
    startDashboardServer(s.dashPort || 8085);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { stopConversion(); stopDashboardServer(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { stopConversion(); stopDashboardServer(); });
