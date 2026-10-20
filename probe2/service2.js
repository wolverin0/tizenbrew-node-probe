"use strict";
/* Minimal probe: prove vm+require+fs work, and write a marker into the config
   so the PC can read it back via TizenBrew's GetModules. */
var fs = require('fs');
var os = require('os');

var marker = 'PROBE2OK|' + process.version + '|uid=' +
    ((typeof process.getuid === 'function') ? process.getuid() : '?') +
    '|' + ((typeof process.cwd === 'function') ? process.cwd() : '?');

var cfgPath = '/home/owner/share/tizenbrewConfig.json';

function addMarker(m) {
    var c;
    try { c = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch (e) { c = { modules: [], autoLaunchServiceList: [], autoLaunchModule: '' }; }
    if (!c.modules) c.modules = [];
    c.modules.push(m);
    fs.writeFileSync(cfgPath, JSON.stringify(c, null, 4));
}

try {
    addMarker(marker);
    fs.writeFileSync('/home/owner/share/probe2.txt', marker + '\n');
} catch (e) {
    try { addMarker('PROBE2ERR|' + String(e)); } catch (e2) {}
}
