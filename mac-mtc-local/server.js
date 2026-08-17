const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const midi = require('midi');

const PORT = parseInt(process.env.PORT || '8085', 10);
const MINIMAL_PORT = parseInt(process.env.MINIMAL_PORT || String(PORT + 1), 10);

// 1. HTTP Server: Feeds the dashboard HTML file to devices hitting the IP
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                return res.end('Error loading index.html');
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

// 1b. Second HTTP server: a minimal, full-screen MM:SS-only view on its own port
const minimalServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'minimal.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                return res.end('Error loading minimal.html');
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

// 2. WebSocket servers: one per HTTP server, both fed by the same broadcast()
const wss = new WebSocket.Server({ server });
const minimalWss = new WebSocket.Server({ server: minimalServer });

function broadcast(data) {
    const payload = JSON.stringify(data);
    for (const server of [wss, minimalWss]) {
        server.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }
}

// --- Server-side MTC decoding -----------------------------------------
// index.html / minimal.html decode raw MIDI bytes themselves in the browser,
// which is fine for the dashboards but means every new client (like a
// Companion module) would have to reimplement MTC quarter-frame math just
// to read the clock. So in addition to the raw `{ bytes }` broadcast below,
// we decode here too and broadcast a clean, ready-to-use payload:
//   { tc: { h, m, s, f }, fps, running, timecode: "HH:MM:SS:FF" }
// This is purely additive — existing WebSocket clients that only look for
// `msg.bytes` are unaffected.
const RUN_TOLERANCE_MS = 2000; // matches the dashboards' "paused" flywheel window
const FPS_RATES = ['24', '25', '29.97d', '30'];

let qfPieces = new Array(8).fill(0);
let qfMask = 0;
let lastQuarterFrameTime = 0;
let currentFPS = '30';
let lastH = -1, lastM = -1, lastS = -1;
let lastMovementTime = 0;
let watchdogTimer = null;

function pad2(n) {
    return String(n).padStart(2, '0');
}

function tcString(h, m, s, f) {
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}:${pad2(f)}`;
}

function emitDecodedFrame(h, m, s, f) {
    const now = Date.now();
    if (h !== lastH || m !== lastM || s !== lastS || lastH === -1) {
        lastMovementTime = now;
    }
    lastH = h; lastM = m; lastS = s;

    const running = (now - lastMovementTime) < RUN_TOLERANCE_MS;

    broadcast({
        tc: { h, m, s, f },
        fps: currentFPS,
        running,
        timecode: tcString(h, m, s, f)
    });

    // If no further frames arrive within the tolerance window, push one more
    // update flipping running to false so listeners (e.g. Companion) don't
    // have to run their own watchdog timer just to detect "paused".
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
        broadcast({
            tc: { h: lastH, m: lastM, s: lastS, f: 0 },
            fps: currentFPS,
            running: false,
            timecode: tcString(lastH, lastM, lastS, 0)
        });
    }, RUN_TOLERANCE_MS);
}

function decodeMTC(message) {
    if (!message || message.length === 0) return;

    // Quarter Frame messages (0xF1) — assembled 8-at-a-time into one frame
    if (message[0] === 0xF1 && message.length >= 2) {
        const value = message[1];
        const pieceIndex = (value >> 4) & 0x07;
        const nibble = value & 0x0F;

        qfPieces[pieceIndex] = nibble;
        qfMask |= (1 << pieceIndex);
        lastQuarterFrameTime = Date.now();

        if (qfMask === 0xFF) {
            const f = qfPieces[0] | (qfPieces[1] << 4);
            const s = qfPieces[2] | (qfPieces[3] << 4);
            const m = qfPieces[4] | (qfPieces[5] << 4);
            const h = qfPieces[6] | ((qfPieces[7] & 0x01) << 4);
            const rateType = (qfPieces[7] >> 1) & 0x03;
            currentFPS = FPS_RATES[rateType] || '30';

            emitDecodedFrame(h, m, s, f);
            qfMask = 0;
        }
    }
    // Full Frame SysEx (F0 7F <id> 01 01 hh mm ss ff F7)
    else if (message[0] === 0xF0 && message[1] === 0x7F && message[3] === 0x01 && message[4] === 0x01 && message.length >= 10) {
        if (Date.now() - lastQuarterFrameTime > 200) {
            const h = message[5] & 0x1F;
            const m = message[6];
            const s = message[7];
            const f = message[8];
            const rateType = (message[5] >> 5) & 0x03;
            currentFPS = FPS_RATES[rateType] || '30';

            emitDecodedFrame(h, m, s, f);
        }
    }
}

// 3. Connect to Native macOS CoreMIDI Framework
const input = new midi.Input();
const portCount = input.getPortCount();
let portIndex = -1;

// Scan available ports for your virtual IAC Driver patchbay
for (let i = 0; i < portCount; i++) {
    const name = input.getPortName(i);
    if (name.includes('IAC Driver') || name.includes('Bus 1')) {
        portIndex = i;
        break;
    }
}

// Fallback to the first available port if IAC isn't running explicitly
if (portIndex === -1 && portCount > 0) {
    portIndex = 0;
}

if (portIndex !== -1) {
    console.log(`Connecting to MIDI Port: ${input.getPortName(portIndex)}`);
    input.openPort(portIndex);
// 💥 CRITICAL TIMECODE FIX: 
    // By default, Node ignores Sysex and Timing messages. Turn this OFF!
    // (false, false, false) = (Don't ignore Sysex, Don't ignore Timing, Don't ignore Active Sensing)
    input.ignoreTypes(false, false, false);
    
    // Listen for incoming MIDI buffer streams from your DAW/QLab
    input.on('message', (deltaTime, message) => {
console.log("🔥 DATA SPOTTED:", message);
        // Forward raw byte array safely down the network pipeline
        broadcast({ bytes: message });
        // Also decode it server-side for clients that just want the clock
        decodeMTC(message);
    });
} else {
    console.error("❌ No MIDI ports found. Open 'Audio MIDI Setup' and enable your IAC Driver.");
}

// 4. Initialize the Engine and print LAN access links
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`🚀 Timecode Server Online!`);
    console.log(`👉 Host Machine: http://localhost:${PORT}`);
    
    // Auto-detect and print your Mac's local network IP address
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`👉 LAN Devices:  http://${net.address}:${PORT}`);
            }
        }
    }
    console.log(`==================================================\n`);
});

minimalServer.listen(MINIMAL_PORT, '0.0.0.0', () => {
    console.log(`🖥️  Minimal MM:SS view: http://localhost:${MINIMAL_PORT}`);
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`                        http://${net.address}:${MINIMAL_PORT}`);
            }
        }
    }
    console.log(`==================================================\n`);
});