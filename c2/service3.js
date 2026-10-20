"use strict";
/* Config-channel implant v6.
   PC -> TV : ModuleAction add  "CMD_<id>_<b64url(op\nargs...)>"
   TV -> PC : GetModules(true) returns "RES_<id>_<b64url(json)>"
   Node 4.4.3 / uid 5001. No execSync / no cp.exec (native abort). fs-only + net. */

var fs = require('fs');
var CFG = '/home/owner/share/tizenbrewConfig.json';
var TMP = CFG + '.probe.tmp';
var VERSION = 6;

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

function boot() {
    var c = readCfg();
    if (!c) { return; }
    if (!c.modules) { c.modules = []; }
    c.modules = c.modules.filter(function (m) { return m.indexOf('CMD_') !== 0; });
    c.modules.push('BOOT_' + b64e(JSON.stringify({
        v: VERSION,
        node: process.version,
        uid: (typeof process.getuid === 'function') ? process.getuid() : null,
        cwd: (typeof process.cwd === 'function') ? process.cwd() : null
    })));
    writeCfg(c);
}
boot();

function reply(id, result) {
    var c = readCfg();
    if (!c) { return; }
    if (!c.modules) { c.modules = []; }
    c.modules.push('RES_' + id + '_' + b64e(JSON.stringify(result)));
    writeCfg(c);
}

function walk(root, depth, cb, state) {
    state.seen++;
    if (state.seen > state.maxSeen) { return; }
    var st;
    try { st = fs.lstatSync(root); } catch (e) { return; }
    if (st.isSymbolicLink()) { return; }
    if (st.isDirectory()) {
        if (depth <= 0) { return; }
        var items;
        try { items = fs.readdirSync(root); } catch (e) { return; }
        for (var i = 0; i < items.length; i++) {
            if (state.hits >= state.maxHits) { return; }
            walk(root + (root === '/' ? '' : '/') + items[i], depth - 1, cb, state);
        }
        return;
    }
    if (st.isFile()) {
        if (state.hits >= state.maxHits) { return; }
        cb(root, st, state);
    }
}

function opGrep(root, pattern, depth, maxHits, maxBytes) {
    var hits = [];
    var state = { seen: 0, maxSeen: 60000, hits: 0, maxHits: maxHits || 100 };
    walk(root, depth || 4, function (p, st, s) {
        if (st.size > (maxBytes || 4 * 1024 * 1024)) { return; }
        var buf;
        try { buf = fs.readFileSync(p); } catch (e) { return; }
        var txt = buf.toString('latin1');
        var idx = txt.indexOf(pattern);
        if (idx >= 0) {
            var start = Math.max(0, idx - 120);
            var end = Math.min(txt.length, idx + pattern.length + 120);
            hits.push({
                path: p, size: st.size, off: idx,
                ctx: txt.slice(start, end).replace(/[^\x20-\x7e]/g, '.')
            });
            s.hits++;
        }
    }, state);
    return { root: root, pattern: pattern, scanned: state.seen, hits: hits };
}

function opTree(root, depth, maxEntries) {
    var out = [];
    var state = { seen: 0, maxSeen: 60000, hits: 0, maxHits: maxEntries || 800 };
    walk(root, depth || 3, function (p, st, s) {
        s.hits++;
        out.push({
            p: p, size: st.size, mode: (st.mode & 4095).toString(8),
            uid: st.uid, gid: st.gid, dir: st.isDirectory()
        });
    }, state);
    return { root: root, count: out.length, entries: out };
}

function opFindProc(substr) {
    var pids = [];
    try { pids = fs.readdirSync('/proc'); } catch (e) { return { error: String(e) }; }
    var out = [];
    for (var i = 0; i < pids.length; i++) {
        if (!/^\d+$/.test(pids[i])) { continue; }
        var cmd = '';
        try { cmd = fs.readFileSync('/proc/' + pids[i] + '/cmdline').toString('latin1').replace(/\0/g, ' ').trim(); } catch (e) { continue; }
        if (!substr || cmd.indexOf(substr) >= 0) {
            var exe = '';
            try { exe = fs.readlinkSync('/proc/' + pids[i] + '/exe'); } catch (e2) {}
            out.push({ pid: parseInt(pids[i], 10), cmd: cmd, exe: exe });
        }
    }
    return { match: substr, count: out.length, procs: out };
}

function opStrings(path, minLen, maxCount, maxBytes) {
    var buf;
    try { buf = fs.readFileSync(path); } catch (e) { return { error: String(e) }; }
    if (buf.length > (maxBytes || 64 * 1024 * 1024)) { return { error: 'too big', size: buf.length }; }
    var txt = buf.toString('latin1');
    var re = new RegExp('[\\x20-\\x7e]{' + (minLen || 6) + ',}', 'g');
    var out = [];
    var m;
    while ((m = re.exec(txt)) !== null) {
        out.push(m[0]);
        if (out.length >= (maxCount || 400)) { break; }
    }
    return { path: path, size: buf.length, count: out.length, strings: out };
}

function doSyncOp(op, rest) {
    if (op === 'ping') { return { pong: true, v: VERSION, node: process.version }; }
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

    if (op === 'grep') {
        var a = rest.split('\n');
        return opGrep(a[0], a[1], parseInt(a[2], 10) || 5, parseInt(a[3], 10) || 100, parseInt(a[4], 10) || (4 * 1024 * 1024));
    }
    if (op === 'tree') {
        var t = rest.split('\n');
        return opTree(t[0], parseInt(t[1], 10) || 3, parseInt(t[2], 10) || 800);
    }
    if (op === 'findproc') { return opFindProc(rest); }
    if (op === 'strings') {
        var s = rest.split('\n');
        return opStrings(s[0], parseInt(s[1], 10) || 6, parseInt(s[2], 10) || 400, parseInt(s[3], 10) || (64 * 1024 * 1024));
    }

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
