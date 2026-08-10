const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { LTCDecoder } = require('libltc-wrapper');

// ---- Configuration (override with environment variables) -------------------
const PORT        = parseInt(process.env.PORT || '8085', 10);
const AUDIO_DEV   = process.env.AUDIO_DEV   || 'plughw:1,0'; // `arecord -l` to find yours
const SAMPLE_RATE = parseInt(process.env.SAMPLE_RATE || '48000', 10);
const CHANNELS    = parseInt(process.env.CHANNELS || '2', 10);   // channels the device captures
const LTC_CHANNEL = parseInt(process.env.LTC_CHANNEL || '0', 10); // which channel carries LTC
const FPS         = parseFloat(process.env.FPS || '30');   // e.g. 30, 25, 24, or 29.97
// Optional: override the capture command entirely (used for testing / non-ALSA sources)
const CAPTURE_CMD = process.env.CAPTURE_CMD || null;

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

// 2. WebSocket Server: live timecode streaming
const wss = new WebSocket.Server({ server });

function broadcast(data) {
    const payload = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

// 3. LTC decoder (reference libltc). We feed it mono s16 samples.
const decoder = new LTCDecoder(SAMPLE_RATE, FPS, 's16');

function fpsLabel(drop) {
    if (drop) return FPS === 30 ? '29.97d' : `${FPS}d`;
    return `${FPS}`;
}

// De-interleave the LTC channel out of the captured audio and decode it.
const frameBytes = CHANNELS * 2; // bytes per interleaved sample-frame (s16 = 2 bytes)
let residual = Buffer.alloc(0);

function processAudio(chunk) {
    const buf = residual.length ? Buffer.concat([residual, chunk]) : chunk;
    const nFrames = Math.floor(buf.length / frameBytes);
    const usable = nFrames * frameBytes;

    // Pull just the LTC channel into a mono s16 buffer
    const mono = Buffer.allocUnsafe(nFrames * 2);
    for (let i = 0; i < nFrames; i++) {
        const sample = buf.readInt16LE(i * frameBytes + LTC_CHANNEL * 2);
        mono.writeInt16LE(sample, i * 2);
    }
    residual = buf.subarray(usable); // carry the partial sample-frame to next chunk

    decoder.write(mono);

    let f;
    while ((f = decoder.read()) !== undefined) {
        broadcast({
            tc: { h: f.hours, m: f.minutes, s: f.seconds, f: f.frames },
            fps: fpsLabel(f.drop_frame_format),
            drop: f.drop_frame_format,
            reverse: f.reverse
        });
    }
}

// 4. Capture audio from the interface via ALSA arecord (or a custom command)
function startCapture() {
    let child;
    if (CAPTURE_CMD) {
        console.log(`Starting capture via custom command: ${CAPTURE_CMD}`);
        child = spawn('sh', ['-c', CAPTURE_CMD]);
    } else {
        const args = [
            '-D', AUDIO_DEV,
            '-f', 'S16_LE',
            '-c', String(CHANNELS),
            '-r', String(SAMPLE_RATE),
            '-t', 'raw',
            '-q'
        ];
        console.log(`Starting capture: arecord ${args.join(' ')}`);
        console.log(`   Decoding LTC on channel ${LTC_CHANNEL} @ ${FPS} fps`);
        child = spawn('arecord', args);
    }

    child.stdout.on('data', processAudio);
    child.stderr.on('data', d => process.stderr.write(`[capture] ${d}`));

    child.on('error', err => {
        if (err.code === 'ENOENT') {
            console.error("\n\u274c 'arecord' not found. Install it with:  sudo apt-get install alsa-utils\n");
        } else {
            console.error('\u274c Capture process error:', err.message);
        }
    });

    child.on('exit', (code, signal) => {
        console.error(`\u26a0\ufe0f  Capture process exited (code=${code}, signal=${signal}). Restarting in 2s...`);
        residual = Buffer.alloc(0);
        setTimeout(startCapture, 2000);
    });

    return child;
}

// 5. Start the server + capture, print LAN access links
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`\ud83d\ude80 LTC Timecode Server Online!`);
    console.log(`\ud83d\udc49 Host Machine: http://localhost:${PORT}`);

    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`\ud83d\udc49 LAN Devices:  http://${net.address}:${PORT}`);
            }
        }
    }
    console.log(`==================================================\n`);

    startCapture();
});
