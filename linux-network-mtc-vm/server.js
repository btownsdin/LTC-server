const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const midi = require('midi');

const PORT = parseInt(process.env.PORT || '8085', 10);
const MINIMAL_PORT = parseInt(process.env.MINIMAL_PORT || String(PORT + 1), 10);

// 1. HTTP Server: serves the dashboard HTML
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

// 3. Connect to the MTC source over ALSA.
// Your Mac converts LTC -> MTC and broadcasts it via Network MIDI (MIDI Studio).
// rtpmidid runs on this VM, discovers that session over mDNS, and exposes it
// as a normal ALSA sequencer port -- which is what node-midi sees below.
const input = new midi.Input();
const portCount = input.getPortCount();

console.log(`Found ${portCount} MIDI input port(s):`);
for (let i = 0; i < portCount; i++) {
    console.log(`   [${i}] ${input.getPortName(i)}`);
}

let portIndex = -1;

// Allow forcing a specific port index, e.g. `MIDI_PORT=1 npm start`
if (process.env.MIDI_PORT !== undefined) {
    const forced = parseInt(process.env.MIDI_PORT, 10);
    if (!Number.isNaN(forced) && forced >= 0 && forced < portCount) {
        portIndex = forced;
    } else {
        console.warn(`⚠️  MIDI_PORT=${process.env.MIDI_PORT} is out of range, ignoring.`);
    }
}

// Otherwise scan for a known name. rtpmidid ports are usually named after the
// remote session (whatever you called it in the Mac's Audio MIDI Setup),
// or generically include "Network" / the rtpmidid client name.
if (portIndex === -1) {
    const configured = (process.env.MIDI_PORT_NAME || '').trim();
    const PREFERRED = configured
        ? [configured]
        : ['Network', 'rtpmidi', 'RTP', 'Timecode', 'MTC', 'IAC Driver', 'Bus 1'];
    for (let i = 0; i < portCount; i++) {
        const name = input.getPortName(i);
        if (PREFERRED.some(p => name.includes(p))) {
            portIndex = i;
            break;
        }
    }
}

if (portIndex !== -1) {
    console.log(`Connecting to MIDI Port: ${input.getPortName(portIndex)}`);
    input.openPort(portIndex);
} else {
    console.log("No matching port found — creating virtual input port 'Timecode In'");
    console.log("   Connect rtpmidid's exported port to it with: aconnect <src> 'Timecode In'");
    input.openVirtualPort('Timecode In');
}

// 💥 CRITICAL TIMECODE FIX:
// By default node-midi ignores Sysex and Timing messages. Turn this OFF!
input.ignoreTypes(false, false, false);

input.on('message', (deltaTime, message) => {
    broadcast({ bytes: message });
});

// 4. Start the server, print LAN access links
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`🚀 Network MTC Timecode Server Online!`);
    console.log(`👉 Host Machine: http://localhost:${PORT}`);

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
