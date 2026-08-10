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