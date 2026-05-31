"use strict";
// ibbs-online.js — Inter-BBS Who's Online grid viewer (external program / xtrn)
// Displays active users across all linked BBSes in a tiled grid with avatars.
// Read-only; no messaging. Uses sbbsimsg_lib.js for user discovery.

require('sbbsdefs.js', 'SS_USERON');

var lib = load({}, 'sbbsimsg_lib.js');
var avatar_lib = load({}, 'avatar_lib.js');
load('graphic.js');
try { load('frame.js'); } catch (e) { }
try { load(js.exec_dir + 'ascii_globe_texture.js'); } catch (e) { }

// ── layout constants ────────────────────────────────────────────────
var CELL_W     = 18;   // inner content width
var CELL_PAD   = 1;    // margin on each side
var SLOT_W     = CELL_W + CELL_PAD * 2;  // 16 columns per slot
var COLS       = Math.floor(console.screen_columns / SLOT_W);  // tiles per row
var AVA_W      = 10;   // avatar width  (Synchronet standard)
var AVA_H      = 6;    // avatar height (Synchronet standard)
var CELL_BODY_H = 10;  // content rows per tile group
var CELL_GAP_Y  = 1;   // blank spacer rows between tile groups
var CELL_H     = CELL_BODY_H + CELL_GAP_Y;
var PAGE_ROWS  = Math.floor((console.screen_rows - 2) / CELL_H);
var PAGE_SIZE  = COLS * PAGE_ROWS;
var GLOBE_TICK_MS = 140;
var GLOBE_MIN_W = 32;
var GLOBE_MIN_H = 12;
var GLOBE_HEIGHT_RATIO = 0.92;
var GLOBE_WIDTH_PER_HEIGHT = 2.0;
var GLOBE_CENTER_LAT_BIAS = 16; // positive tilts view northward (Europe-prominent)
var GLOBE_SIZE = 1.4; // ascii-globe upstream default size
var AUTO_REFRESH_MS = 15000;
var GLOBE_HYST_HI = 176;
var GLOBE_HYST_LO = 80;
var GLOBE_ASPECT = 2.0;
var GLOBE_BASE_SIZE = 1.4;
var INV_PI = 1 / Math.PI;

// ── color helpers (Synchronet ctrl-A shorthand) ─────────────────────
var C_RESET  = '\x01n';
var C_USER   = '\x01h\x01c';   // bright cyan
var C_BBS    = '\x01h\x01g';   // bright green
var C_ACT    = '\x01h\x01y';   // bright yellow (brown+high)
var C_DIM    = '\x01n\x01k\x01h'; // dark gray
var C_HDR    = '\x01n\x01h\x01w'; // bright white
var C_BAR    = '\x01n\x01c';   // cyan for dividers

// ── frame/globe state ───────────────────────────────────────────────
var ROOT_FRAME = null;
var BG_FRAME = null;
var UI_FRAME = null;
var GLOBE_FRAME = null;
var GLOBE = null;
var LAST_GLOBE_TICK = 0;
var BBS_INDEX_BY_HOST = null;
var BBS_INDEX_BY_NAME = null;
var BBS_INDEX_BY_IP = null;
var GEO_LOC_CACHE = {};
var GEO_IP_CACHE = null;
var GEO_IP_AVAILABLE = false;
var GEO_IP_LOOKUPS_THIS_RUN = 0;
var GEO_IP_MISSES = {};
var GEO_IP_MAX_LOOKUPS_PER_RUN = 4;
var GEO_IP_CACHE_FILE = null;
var MARKER_FGS = [
    LIGHTRED, RED,
    LIGHTMAGENTA, MAGENTA,
    LIGHTCYAN, CYAN,
    WHITE, LIGHTGRAY,
    BLUE, LIGHTBLUE,
    DARKGRAY,
    YELLOW, BROWN,
    GREEN
];
var MARKER_CTRL = [
    '\x01h\x01r', '\x01r',
    '\x01h\x01m', '\x01m',
    '\x01h\x01c', '\x01c',
    '\x01h\x01w', '\x01w',
    '\x01b', '\x01h\x01b',
    '\x01h\x01k',
    '\x01h\x01y', '\x01y',
    '\x01g'
];
var ACTIVE_MARKER_COLOR_BY_LABEL = {};

// ── NodeAction map for local users ─────────────────────────────────
var NodeAction = {};
try {
    NodeAction[NODE_MAIN] = 'Main menu'; NodeAction[NODE_RMSG] = 'Reading msgs';
    NodeAction[NODE_RMAL] = 'Reading mail'; NodeAction[NODE_SMAL] = 'Sending mail';
    NodeAction[NODE_RTXT] = 'Reading text'; NodeAction[NODE_RSML] = 'Reading sent mail';
    NodeAction[NODE_PMSG] = 'Private msg'; NodeAction[NODE_TQWK] = 'Xfer QWK';
    NodeAction[NODE_PCHT] = 'In chat'; NodeAction[NODE_PAGE] = 'Paging';
    NodeAction[NODE_DFLT] = 'Defaults'; NodeAction[NODE_XTRN] = 'Running door';
    NodeAction[NODE_DLNG] = 'Downloading'; NodeAction[NODE_ULNG] = 'Uploading';
    NodeAction[NODE_BXFR] = 'Bi-dir xfer'; NodeAction[NODE_LFIL] = 'Listing files';
    NodeAction[NODE_LOGN] = 'Logging on'; NodeAction[NODE_LCHT] = 'Local chat';
    NodeAction[NODE_MCHT] = 'Multinode chat';
} catch (e) { }

// ── door-name helpers ──────────────────────────────────────────────
// A node running an external program carries node.action == NODE_XTRN and a
// 1-based node.aux index into the external program list. Resolve that to the
// program's display name so the activity column shows the actual door instead
// of a generic "Running door".
function doorNameFromAux(aux) {
    if (!aux) return '';
    try {
        for (var i in xtrn_area.prog)
            if (xtrn_area.prog[i].number == aux - 1) return xtrn_area.prog[i].name;
    } catch (e) { }
    return '';
}

// Local node -> activity string (door name when running an external program).
function localAction(node) {
    if (node.action == NODE_XTRN && node.aux) {
        var name = doorNameFromAux(node.aux);
        if (name) return name;
    }
    return NodeAction[node.action] || '';
}

// Remote user -> activity string. Stock Synchronet broadcasts a numeric
// 'naction' and an 'xtrn' (program name) alongside the verbose 'action'
// string ("running external program NAME"). Prefer the bare name; otherwise
// strip the redundant prefix so the name (which the verbose form puts last,
// past the column width) leads.
function remoteAction(usr) {
    if (usr && usr.xtrn && (usr.naction === NODE_XTRN || /running external program/i.test(usr.action || '')))
        return String(usr.xtrn);
    var a = String((usr && usr.action) || '');
    return a.replace(/^\s*running external program\s+#\d+\s*$/i, 'a door')
            .replace(/^\s*running external program\s+/i, '')
            .replace(/^\s*at external program menu\s*$/i, 'xtrn menu');
}

// ── local web users (webv4 sessions) ───────────────────────────────
// Web visitors never occupy a BBS node, so system.get_node() can't see them.
// webv4 records each logged-in web user as an INI session file at
// data/user/<usernum>.web and treats the session as live while the file's
// mtime is newer than the [web] inactivity window. We mirror that convention
// (the same one the webv4_custom sidebar's nodelist.js uses) so our own web
// users show up in the grid alongside terminal and remote users.
var WEB_INACTIVITY_FALLBACK = 900; // seconds; webv4 [web] inactivity default
var WEB_CFG = null;

function webConfig() {
    if (WEB_CFG) return WEB_CFG;
    WEB_CFG = { inactivity: WEB_INACTIVITY_FALLBACK, guestNum: 0 };
    try {
        var f = new File(system.ctrl_dir + 'modopts.ini');
        if (f.open('r')) {
            var inact = f.iniGetValue('web', 'inactivity', WEB_INACTIVITY_FALLBACK);
            if (inact > 0) WEB_CFG.inactivity = inact;
            var guestAlias = f.iniGetValue('web', 'guest', 'Guest');
            f.close();
            if (guestAlias) {
                try { WEB_CFG.guestNum = system.matchuser(guestAlias) || 0; } catch (e) { }
            }
        }
    } catch (e) { }
    return WEB_CFG;
}

function readWebSession(usernum) {
    try {
        var f = new File(format('%suser/%04d.web', system.data_dir, usernum));
        if (!f.open('r')) return null;
        var o = f.iniGetObject();
        f.close();
        return o || null;
    } catch (e) {
        return null;
    }
}

// Scan webv4 session files for live web users. `seen` is a map of userNums
// already added as terminal nodes so a user connected both ways isn't shown
// twice; web-only users are added and recorded back into `seen`.
function fetchLocalWebUsers(seen) {
    var out = [];
    var cfg = webConfig();
    var files;
    try { files = directory(system.data_dir + 'user/*.web'); } catch (e) { return out; }
    if (!files || !files.length) return out;
    for (var i = 0; i < files.length; i++) {
        var path = files[i];
        var num = parseInt(file_getname(path), 10);
        if (!num || num < 1 || num > system.lastuser) continue;
        if (seen && seen[num]) continue;                          // already on a terminal node
        if (time() - file_date(path) >= cfg.inactivity) continue; // stale / logged out
        if (cfg.guestNum && num === cfg.guestNum) continue;       // hide the shared guest account
        var usr;
        try { usr = new User(num); } catch (e) { continue; }
        if (!usr || !usr.alias) continue;
        if (usr.settings & (USER_DELETED | USER_INACTIVE)) continue;
        if (usr.settings & USER_QUIET) continue;                  // user opted out of the online list
        var sess = readWebSession(num) || {};
        var act = String(sess.action || sess.xtrn || '');
        out.push({
            name: usr.alias,
            host: system.inetaddr || system.host_name || 'localhost',
            bbs: system.name,
            action: act || 'browsing',
            local: true,
            web: true,
            userNum: num,
            location: system.location || '',
            geoHint: system.inetaddr || ''
        });
        if (seen) seen[num] = true;
    }
    return out;
}

// ── fetch & build user list ────────────────────────────────────────
function fetchUsers() {
    lib.read_sys_list();
    var sent = 0;
    try { sent = lib.request_active_users(); } catch (e) {}

    // poll for responses (2 seconds)
    if (lib.sock) {
        var begin = system.timer;
        while (system.timer - begin < 2) {
            if (!lib.sock.poll(0.25)) continue;
            var message = lib.receive_active_users();
            if (message) lib.parse_active_users(message);
        }
    }

    var users = [];
    // Remote users
    for (var ip in lib.sys_list) {
        var sys = lib.sys_list[ip];
        if (!sys.users || !sys.users.length) continue;
        for (var u = 0; u < sys.users.length; u++) {
            var usr = sys.users[u];
            users.push({
                name: usr.name || '?',
                host: sys.host,
                ip: ip,
                bbs: sys.name || sys.host,
                action: remoteAction(usr),
                location: usr.location || sys.location || '',
                geoHint: usr.ip || usr.host || ''
            });
        }
    }
    // Local terminal users (occupy a node)
    var localSeen = {};
    for (var n = 0; n < system.nodes; n++) {
        try {
            var node = system.get_node(n + 1);
            if (!node || node.status !== NODE_INUSE) continue;
            var uname = system.username(node.useron);
            if (!uname) continue;
            localSeen[node.useron] = true;
            users.push({
                name: uname,
                host: system.inetaddr || system.host_name || 'localhost',
                bbs: system.name,
                action: localAction(node),
                local: true,
                userNum: node.useron,
                location: system.location || '',
                geoHint: system.inetaddr || ''
            });
        } catch (e) {}
    }
    // Local web users (webv4 sessions, no node) — deduped against terminal nodes
    try {
        var webUsers = fetchLocalWebUsers(localSeen);
        for (var w = 0; w < webUsers.length; w++) users.push(webUsers[w]);
    } catch (e) {}
    users.sort(function (a, b) {
        if (a.local && !b.local) return -1;
        if (!a.local && b.local) return 1;
        var bbsCmp = (a.bbs || '').toLowerCase().localeCompare((b.bbs || '').toLowerCase());
        if (bbsCmp !== 0) return bbsCmp;
        var nameCmp = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
        if (nameCmp !== 0) return nameCmp;
        return (a.host || '').toLowerCase().localeCompare((b.host || '').toLowerCase());
    });
    return users;
}

// ── avatar helpers ─────────────────────────────────────────────────
// Returns array of CELL_W-wide ctrl-A strings (AVA_H rows), or null.
function getAvatarRows(u) {
    try {
        var usernum = u.local ? u.userNum : 0;
        var netaddr = u.local ? undefined : u.host;
        var bbsid = u.bbs || undefined;  // BBS name for bbses.ini -> qnet avatar lookup
        var obj = avatar_lib.read(usernum, u.name, netaddr, bbsid);
        if (!avatar_lib.is_enabled(obj)) return null;
        var graphic = new Graphic(AVA_W, AVA_H);
        graphic.BIN = base64_decode(obj.data);
        graphic.attr_mask = ~graphic.defs.BLINK;
        var msg = graphic.MSG;  // ctrl-A encoded, rows separated by \x01N\r\n
        var raw = msg.split('\r\n');
        var rows = [];
        for (var i = 0; i < AVA_H && i < raw.length; i++) {
            // Strip trailing \x01N if present (we add our own reset)
            var line = raw[i].replace(/\x01[Nn]\s*$/, '');
            rows.push(line + C_RESET);
        }
        while (rows.length < AVA_H) rows.push('');
        return rows;
    } catch (e) {
        return null;
    }
}

// ── text helpers ───────────────────────────────────────────────────
function truncate(s, maxLen) {
    if (s.length <= maxLen) return s;
    return s.substr(0, maxLen - 1) + '\xfa';  // middle dot ellipsis
}

// Center plain text in `w` columns, returns string of exactly `w` visible chars.
function centerText(s, w) {
    if (typeof s !== 'string') s = '';
    if (s.length > w) s = truncate(s, w);
    var left = Math.floor((w - s.length) / 2);
    var right = w - s.length - left;
    var out = '';
    for (var i = 0; i < left; i++) out += ' ';
    out += s;
    for (var i = 0; i < right; i++) out += ' ';
    return out;
}

function repeatCh(ch, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += ch;
    return s;
}

function cellInnerX(col) {
    return col * SLOT_W + CELL_PAD + 1;
}

function drawCellCentered(col, y, color, text) {
    text = String(text || '');
    if (text.length > CELL_W) text = truncate(text, CELL_W);
    var x = cellInnerX(col) + Math.floor((CELL_W - text.length) / 2);
    if (x < cellInnerX(col)) x = cellInnerX(col);
    uiGoto(x, y);
    uiPrint(color + text + C_RESET);
}

function uiClear(attr) {
    if (UI_FRAME) {
        if (attr !== undefined) UI_FRAME.clear(attr);
        else UI_FRAME.clear();
        return;
    }
    console.clear(attr);
}

function uiGoto(x, y) {
    if (UI_FRAME) UI_FRAME.gotoxy(x, y);
    else console.gotoxy(x, y);
}

function uiPrint(text) {
    if (UI_FRAME) UI_FRAME.putmsg(String(text));
    else console.print(String(text));
}

function uiCycle() {
    if (ROOT_FRAME) ROOT_FRAME.cycle();
}

function normalizeHost(host) {
    host = String(host || '').trim().toLowerCase();
    if (!host.length) return '';
    host = host.replace(/^[a-z]+:\/\//, '');
    host = host.replace(/\/.*$/, '');
    if (host.charAt(0) === '[') {
        var close = host.indexOf(']');
        if (close > 0) host = host.substring(1, close);
    } else {
        var colons = (host.match(/\:/g) || []).length;
        if (colons === 1) host = host.replace(/\:\d+$/, '');
    }
    return host;
}

function hash32(str) {
    var h = 2166136261;
    str = String(str || '');
    for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0);
}

function hashToLatLon(key) {
    var h1 = hash32(key);
    var h2 = hash32(key + '|lon');
    var lat = ((h1 % 14000) / 100) - 70;   // [-70, 70]
    var lon = ((h2 % 36000) / 100) - 180;  // [-180, 180]
    return { lat: lat, lon: lon };
}

function clamp(n, min, max) {
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

function cleanLocToken(tok) {
    tok = String(tok || '').toLowerCase();
    tok = tok.replace(/[\.\(\)\[\]]/g, ' ');
    tok = tok.replace(/\s+/g, ' ').trim();
    return tok;
}

function validLatLon(lat, lon) {
    return isFinite(lat) && isFinite(lon)
        && lat >= -90 && lat <= 90
        && lon >= -180 && lon <= 180;
}

function isPrivateIPv4(ip) {
    if (!isIPv4(ip)) return false;
    var p = ip.split('.');
    var a = parseInt(p[0], 10);
    var b = parseInt(p[1], 10);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
}

function loadGeoIpCache() {
    if (GEO_IP_CACHE !== null) return;
    GEO_IP_CACHE = {};
    try {
        GEO_IP_CACHE_FILE = system.data_dir + 'ibbs-online-geoip.json';
        var f = new File(GEO_IP_CACHE_FILE);
        if (!f.open('r')) return;
        var raw = f.read();
        f.close();
        if (!raw || !raw.length) return;
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') GEO_IP_CACHE = parsed;
    } catch (_) { }
}

function saveGeoIpCache() {
    if (!GEO_IP_CACHE || !GEO_IP_CACHE_FILE) return;
    try {
        var f = new File(GEO_IP_CACHE_FILE);
        if (!f.open('w+')) return;
        f.write(JSON.stringify(GEO_IP_CACHE));
        f.close();
    } catch (_) { }
}

function initGeoIp() {
    if (GEO_IP_CACHE !== null) return;
    loadGeoIpCache();
    try {
        if (typeof js.global.get_geoip !== 'function') load(js.global, 'geoip.js');
        GEO_IP_AVAILABLE = (typeof js.global.get_geoip === 'function');
    } catch (_) {
        GEO_IP_AVAILABLE = false;
    }
}

function geoIpLatLon(hostOrIp, seedKey) {
    var key = normalizeHost(hostOrIp);
    if (!key.length) return null;
    initGeoIp();
    if (!GEO_IP_AVAILABLE || !GEO_IP_CACHE) return null;

    var cached = GEO_IP_CACHE[key];
    if (cached && validLatLon(Number(cached.lat), Number(cached.lon))) {
        return { lat: Number(cached.lat), lon: Number(cached.lon) };
    }
    if (GEO_IP_MISSES[key]) return null;
    if (GEO_IP_LOOKUPS_THIS_RUN >= GEO_IP_MAX_LOOKUPS_PER_RUN) return null;
    if (isPrivateIPv4(key)) {
        GEO_IP_MISSES[key] = true;
        return null;
    }

    GEO_IP_LOOKUPS_THIS_RUN++;
    try {
        var geo = js.global.get_geoip(key);
        if (!geo) {
            GEO_IP_MISSES[key] = true;
            return null;
        }
        var lat = Number(geo.latitude);
        var lon = Number(geo.longitude);
        if (!validLatLon(lat, lon)) {
            GEO_IP_MISSES[key] = true;
            return null;
        }
        // deterministic pin spread within the same city
        var h = hash32((seedKey || key) + '|geo-lat');
        var h2 = hash32((seedKey || key) + '|geo-lon');
        lat = clamp(lat + ((((h % 1000) / 1000) - 0.5) * 0.8), -75, 75);
        lon = clamp(lon + ((((h2 % 1000) / 1000) - 0.5) * 0.8), -180, 180);
        GEO_IP_CACHE[key] = { lat: +lat.toFixed(4), lon: +lon.toFixed(4) };
        saveGeoIpCache();
        return { lat: GEO_IP_CACHE[key].lat, lon: GEO_IP_CACHE[key].lon };
    } catch (_) {
        GEO_IP_MISSES[key] = true;
        return null;
    }
}

function isIPv4(host) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(host || ''));
}

function explicitLatLonFromText(location) {
    var s = String(location || '');
    var m = s.match(/(-?\d{1,2}(?:\.\d+)?)\s*[,\/]\s*(-?\d{1,3}(?:\.\d+)?)/);
    if (!m) return null;
    var lat = parseFloat(m[1]);
    var lon = parseFloat(m[2]);
    if (!validLatLon(lat, lon)) return null;
    return { lat: lat, lon: lon };
}

var GEO_REGION_CENTERS = {
    // countries / broad regions
    'usa': [39.8, -98.6], 'united states': [39.8, -98.6], 'us': [39.8, -98.6],
    'canada': [56.1, -106.3], 'uk': [54.0, -2.0], 'united kingdom': [54.0, -2.0], 'scotland': [56.5, -4.0],
    'germany': [51.2, 10.5], 'deu': [51.2, 10.5],
    'italy': [42.8, 12.5], 'spain': [40.4, -3.7], 'argentina': [-38.4, -63.6],
    'brazil': [-14.2, -51.9], 'brasil': [-14.2, -51.9], 'australia': [-25.3, 133.8],
    'new zealand': [-41.2, 174.8], 'nz': [-41.2, 174.8], 'hungary': [47.2, 19.5],
    'netherlands': [52.2, 5.3], 'nl': [52.2, 5.3], 'belgium': [50.6, 4.7], 'be': [50.6, 4.7],
    'portugal': [39.4, -8.2], 'norway': [60.5, 8.5], 'philippines': [12.9, 121.8], 'barbados': [13.1, -59.6],
    // common state / province markers in sbbslist
    'al': [32.8, -86.8], 'ak': [64.2, -149.5], 'az': [34.0, -111.6], 'ar': [34.9, -92.4],
    'ca': [36.8, -119.4], 'co': [39.0, -105.5], 'de': [39.0, -75.5], 'fl': [27.8, -81.7],
    'ga': [32.7, -83.4], 'il': [40.0, -89.2], 'in': [39.9, -86.2], 'ky': [37.8, -85.8],
    'ma': [42.3, -71.8], 'md': [39.0, -76.7], 'mi': [44.3, -85.4], 'mn': [46.7, -94.6],
    'ms': [32.7, -89.7], 'nc': [35.5, -79.4], 'nj': [40.1, -74.7], 'nv': [39.3, -116.6],
    'ny': [42.9, -75.5], 'oh': [40.4, -82.8], 'ok': [35.6, -97.5], 'or': [44.0, -120.6],
    'pa': [41.2, -77.2], 'tn': [35.7, -86.7], 'tx': [31.0, -99.3], 'ut': [39.3, -111.7],
    'va': [37.5, -78.8], 'wa': [47.5, -120.5], 'wi': [44.6, -89.6], 'wv': [38.5, -80.6], 'wy': [43.0, -107.6],
    'alabama': [32.8, -86.8], 'alaska': [64.2, -149.5], 'arizona': [34.0, -111.6], 'arkansas': [34.9, -92.4],
    'california': [36.8, -119.4], 'calif': [36.8, -119.4], 'colorado': [39.0, -105.5], 'delaware': [39.0, -75.5],
    'florida': [27.8, -81.7], 'georgia': [32.7, -83.4], 'illinois': [40.0, -89.2], 'indiana': [39.9, -86.2],
    'massachusetts': [42.3, -71.8], 'maryland': [39.0, -76.7], 'michigan': [44.3, -85.4], 'minnesota': [46.7, -94.6],
    'mississippi': [32.7, -89.7], 'north carolina': [35.5, -79.4], 'new jersey': [40.1, -74.7], 'nevada': [39.3, -116.6],
    'new york': [42.9, -75.5], 'ohio': [40.4, -82.8], 'oklahoma': [35.6, -97.5], 'oregon': [44.0, -120.6],
    'pennsylvania': [41.2, -77.2], 'tennessee': [35.7, -86.7], 'texas': [31.0, -99.3], 'utah': [39.3, -111.7],
    'virginia': [37.5, -78.8], 'washington': [47.5, -120.5], 'wisconsin': [44.6, -89.6], 'west virginia': [38.5, -80.6],
    'nsw': [-31.3, 147.0], 'vic': [-37.0, 144.0], 'act': [-35.5, 149.0], 'western australia': [-26.0, 121.0],
    'bc': [53.7, -127.6], 'qc': [52.9, -71.9], 'quebec': [52.9, -71.9], 'alberta': [53.9, -115.0],
    'pr': [18.2, -66.4]
};

function getRegionCenter(token) {
    var t = cleanLocToken(token);
    if (GEO_REGION_CENTERS[t]) return { lat: GEO_REGION_CENTERS[t][0], lon: GEO_REGION_CENTERS[t][1] };
    return null;
}

function locToLatLon(location, seedKey) {
    var loc = String(location || '').trim();
    if (!loc.length) return null;
    var cacheKey = loc.toLowerCase() + '|' + String(seedKey || '').toLowerCase();
    if (GEO_LOC_CACHE[cacheKey]) return GEO_LOC_CACHE[cacheKey];

    var ll = explicitLatLonFromText(loc);
    if (ll) {
        GEO_LOC_CACHE[cacheKey] = ll;
        return ll;
    }

    var tokens = loc.split(/[,\/|]/);
    var base = null;
    for (var i = tokens.length - 1; i >= 0; i--) {
        base = getRegionCenter(tokens[i]);
        if (base) break;
    }
    if (!base) {
        var words = cleanLocToken(loc).split(' ');
        for (var w = words.length - 1; w >= 0; w--) {
            base = getRegionCenter(words[w]);
            if (base) break;
        }
    }
    if (!base) base = getRegionCenter(loc);
    if (!base) return null;

    // Deterministic jitter keeps systems in the same region separated.
    var h = hash32((seedKey || '') + '|' + loc);
    var h2 = hash32((seedKey || '') + '|lon|' + loc);
    var latJ = (((h % 1000) / 1000) - 0.5) * 3.0;
    var lonJ = (((h2 % 1000) / 1000) - 0.5) * 4.0;
    ll = {
        lat: clamp(base.lat + latJ, -75, 75),
        lon: clamp(base.lon + lonJ, -180, 180)
    };
    GEO_LOC_CACHE[cacheKey] = ll;
    return ll;
}

function buildBbsIndex() {
    if (BBS_INDEX_BY_HOST && BBS_INDEX_BY_NAME && BBS_INDEX_BY_IP) return;
    BBS_INDEX_BY_HOST = {};
    BBS_INDEX_BY_NAME = {};
    BBS_INDEX_BY_IP = {};
    try {
        var f = new File(system.data_dir + 'sbbslist.json');
        if (!f.open('r')) return;
        var raw = f.read();
        f.close();
        if (!raw || !raw.length) return;
        var list = JSON.parse(raw);
        if (!(list instanceof Array)) return;
        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            if (!b || typeof b !== 'object') continue;
            if (b.name) BBS_INDEX_BY_NAME[String(b.name).toLowerCase()] = b;
            if (b.service && b.service.length) {
                for (var s = 0; s < b.service.length; s++) {
                    var svc = b.service[s];
                    if (!svc || !svc.address) continue;
                    var h = normalizeHost(svc.address);
                    if (!h.length) continue;
                    BBS_INDEX_BY_HOST[h] = b;
                    if (isIPv4(h)) BBS_INDEX_BY_IP[h] = b;
                }
            }
        }
    } catch (e) { }
}

function bbsEntryForUser(u) {
    buildBbsIndex();
    var ip = normalizeHost(u && u.ip);
    if (ip && BBS_INDEX_BY_IP && BBS_INDEX_BY_IP[ip]) return BBS_INDEX_BY_IP[ip];
    var host = normalizeHost(u && u.host);
    if (host && BBS_INDEX_BY_HOST && BBS_INDEX_BY_HOST[host]) return BBS_INDEX_BY_HOST[host];
    var name = (u && u.bbs) ? String(u.bbs).toLowerCase() : '';
    if (name && BBS_INDEX_BY_NAME && BBS_INDEX_BY_NAME[name]) return BBS_INDEX_BY_NAME[name];
    return null;
}

function markerCharFromLabel(label) {
    var s = String(label || '').trim();
    if (!s.length) return 'O';
    // Ignore a leading "The " so "The Quantum Wormhole" keys as "Q".
    var stripped = s.replace(/^the\b\s*/i, '');
    if (stripped.length) s = stripped;
    var m = s.match(/[A-Za-z0-9]/);
    if (!m) return 'O';
    return m[0].toUpperCase();
}

function markerLabelKey(label) {
    return String(label || '').toLowerCase();
}

function rebuildActiveMarkerColorMap(users) {
    var oldMap = ACTIVE_MARKER_COLOR_BY_LABEL || {};
    var nextMap = {};
    var labels = [];
    var seen = {};
    var i;
    var n;
    var c;
    var key;
    var idx;
    var paletteLen = MARKER_FGS.length;
    var counts = [];
    var pending = [];
    for (c = 0; c < paletteLen; c++) counts[c] = 0;

    for (i = 0; i < users.length; i++) {
        key = markerLabelKey(users[i] && users[i].bbs);
        if (!key.length || seen[key]) continue;
        seen[key] = true;
        labels.push(key);
    }
    labels.sort();

    // Keep prior assignments when possible to avoid color "jumping" on refresh.
    for (n = 0; n < labels.length; n++) {
        key = labels[n];
        idx = oldMap[key];
        if (idx !== undefined && idx >= 0 && idx < paletteLen && counts[idx] === 0) {
            nextMap[key] = idx;
            counts[idx]++;
        } else {
            pending.push(key);
        }
    }

    // Assign unused colors first; only reuse when palette is exhausted.
    for (n = 0; n < pending.length; n++) {
        key = pending[n];
        idx = -1;
        for (c = 0; c < paletteLen; c++) {
            if (counts[c] === 0) { idx = c; break; }
        }
        if (idx < 0) {
            var start = hash32(key) % paletteLen;
            idx = start;
            var bestCount = counts[idx];
            for (c = 1; c < paletteLen; c++) {
                var probe = (start + c) % paletteLen;
                if (counts[probe] < bestCount) {
                    idx = probe;
                    bestCount = counts[probe];
                }
            }
        }
        nextMap[key] = idx;
        counts[idx]++;
    }

    ACTIVE_MARKER_COLOR_BY_LABEL = nextMap;
}

function markerColorIndex(label) {
    var key = markerLabelKey(label);
    if (ACTIVE_MARKER_COLOR_BY_LABEL[key] !== undefined) return ACTIVE_MARKER_COLOR_BY_LABEL[key];
    return hash32(key) % MARKER_FGS.length;
}

function markerAttrFromLabel(label, local) {
    return BG_BLACK | MARKER_FGS[markerColorIndex(label)] | HIGH;
}

function markerCtrlColorFromLabel(label, local) {
    return MARKER_CTRL[markerColorIndex(label)];
}

function buildGlobePins(users) {
    var pins = [];
    var seen = {};
    for (var i = 0; i < users.length; i++) {
        var u = users[i];
        var host = normalizeHost(u.host || u.ip || u.bbs || u.name);
        var uniq = normalizeHost(u.ip) || host;
        if (!uniq) continue;
        if (seen[uniq]) continue;
        seen[uniq] = true;
        var entry = bbsEntryForUser(u);
        var ll = null;
        var seed = host || u.bbs || u.name;
        if (u.location) ll = locToLatLon(u.location, seed);
        if (!ll && entry && entry.location) ll = locToLatLon(entry.location, seed);
        if (!ll) {
            var geoKey = normalizeHost(u.geoHint || u.ip || u.host);
            ll = geoIpLatLon(geoKey, seed);
        }
        if (!ll) {
            var hint = host;
            if (u.location) hint += '|' + u.location;
            else if (entry && entry.location) hint += '|' + entry.location;
            else if (u.bbs) hint += '|' + u.bbs;
            ll = hashToLatLon(hint);
        }
        var label = u.bbs || host;
        pins.push({
            lat: ll.lat,
            lon: ll.lon,
            local: !!u.local,
            label: label,
            marker: markerCharFromLabel(label)
        });
        if (pins.length >= 120) break;
    }
    return pins;
}

function AsciiGlobe(frame) {
    this.frame = frame;
    this.angle = 0;
    this.centerLonDeg = -95; // "American-centric" initial view
    this.centerLatDeg = GLOBE_CENTER_LAT_BIAS;
    this.spinStep = 0.055;
    this.size = GLOBE_SIZE;
    this.pins = [];
    this.waterChar = '-';
    this.landChar = '#';
    this.waterAttrLo = BG_BLACK | BLUE;
    this.landAttrHi = BG_BLACK | GREEN;
    this.texW = 0;
    this.texH = 0;
    this.texMask = null;
    this.prevLand = null;
    this.prevW = 0;
    this.prevH = 0;

    var tex = null;
    try {
        if (typeof getAsciiGlobeTextureData === 'function') tex = getAsciiGlobeTextureData();
    } catch (_) { }
    if (tex && tex.width > 0 && tex.height > 0 && tex.mask && tex.mask.length) {
        this.texW = tex.width;
        this.texH = tex.height;
        this.texMask = tex.mask;
    }
}

AsciiGlobe.prototype.setPins = function (pins) {
    this.pins = (pins && pins.length) ? pins.slice(0) : [];
};

AsciiGlobe.prototype.setSize = function (size) {
    size = Number(size);
    if (!isFinite(size)) return;
    if (size < 0.6) size = 0.6;
    if (size > 2.4) size = 2.4;
    this.size = size;
};

AsciiGlobe.prototype._markerAttr = function (pin) {
    return markerAttrFromLabel(pin && pin.label, pin && pin.local);
};

AsciiGlobe.prototype._textureReady = function () {
    return !!(this.texMask && this.texW > 0 && this.texH > 0);
};

AsciiGlobe.prototype._ensurePrevLand = function (w, h) {
    if (this.prevLand && this.prevW === w && this.prevH === h) return;
    var size = w * h;
    if (typeof Uint8Array === 'function') this.prevLand = new Uint8Array(size);
    else {
        this.prevLand = new Array(size);
        for (var i = 0; i < size; i++) this.prevLand[i] = 0;
    }
    this.prevW = w;
    this.prevH = h;
};

AsciiGlobe.prototype._sampleMask = function (latRad, lonRad) {
    var uf = ((lonRad * INV_PI) * 0.5 + 0.5) * this.texW;
    var vf = (0.5 - latRad * INV_PI) * this.texH;

    var u0 = uf | 0;
    var v0 = vf | 0;
    var uFrac = uf - u0;
    var vFrac = vf - v0;

    var u1 = u0 + 1;
    if (u0 < 0) u0 += this.texW;
    else if (u0 >= this.texW) u0 -= this.texW;
    if (u1 < 0) u1 += this.texW;
    else if (u1 >= this.texW) u1 -= this.texW;

    var v1 = v0 + 1;
    if (v0 < 0) v0 = 0;
    else if (v0 >= this.texH) v0 = this.texH - 1;
    if (v1 < 0) v1 = 0;
    else if (v1 >= this.texH) v1 = this.texH - 1;

    var m00 = this.texMask[v0 * this.texW + u0];
    var m01 = this.texMask[v0 * this.texW + u1];
    var m10 = this.texMask[v1 * this.texW + u0];
    var m11 = this.texMask[v1 * this.texW + u1];

    var a = m00 + (m01 - m00) * uFrac;
    var b = m10 + (m11 - m10) * uFrac;
    return a + (b - a) * vFrac;
};

AsciiGlobe.prototype.tick = function () {
    var f = this.frame;
    if (!f || (typeof f.is_open !== 'undefined' && !f.is_open)) return;
    if (!this._textureReady()) return;
    var w = f.width | 0;
    var h = f.height | 0;
    if (w < 8 || h < 6) return;
    this._ensurePrevLand(w, h);

    var cx = (w - 1) / 2;
    var cy = (h - 1) / 2;
    var sizeScale = this.size / GLOBE_BASE_SIZE;
    var rx = Math.max(1, ((w - 2) * 0.5) * sizeScale);
    var ry = Math.max(1, (h - 2) * sizeScale);
    var invRx = 1 / rx;
    var invRy = 1 / ry;
    var ang = this.angle + (this.centerLonDeg * Math.PI / 180);
    var latAng = this.centerLatDeg * Math.PI / 180;
    var ca = Math.cos(ang);
    var sa = Math.sin(ang);
    var cl = Math.cos(latAng);
    var sl = Math.sin(latAng);

    f.clear();
    for (var y = 0; y < h; y++) {
        var sy = (cy - y) * invRy * GLOBE_ASPECT;
        var sy2 = sy * sy;
        if (sy2 > 1) continue;
        for (var x = 0; x < w; x++) {
            var sx = (x - cx) * invRx;
            var rr = sx * sx + sy2;
            if (rr > 1) continue;
            var sz = Math.sqrt(1 - rr);

            var tx = sx;
            var ty = sy * cl + sz * sl;
            var tz = -sy * sl + sz * cl;

            var wx = tx * ca - tz * sa;
            var wy = ty;
            var wz = tx * sa + tz * ca;

            if (wy < -1) wy = -1;
            else if (wy > 1) wy = 1;

            var latRad = Math.asin(wy);
            var lonRad = Math.atan2(-wz, wx);
            var interp = this._sampleMask(latRad, lonRad);

            var idx = y * w + x;
            var prev = this.prevLand[idx] ? 1 : 0;
            var threshold = prev ? GLOBE_HYST_LO : GLOBE_HYST_HI;
            var isLand = interp >= threshold;
            this.prevLand[idx] = isLand ? 1 : 0;

            f.setData(x, y, isLand ? this.landChar : this.waterChar, isLand ? this.landAttrHi : this.waterAttrLo, false);
        }
    }

    for (var i = 0; i < this.pins.length; i++) {
        var pin = this.pins[i];
        var latRad = (pin.lat * Math.PI) / 180;
        var lonRad = (pin.lon * Math.PI) / 180;
        var cLat = Math.cos(latRad);
        var wxp = cLat * Math.cos(lonRad);
        var wyp = Math.sin(latRad);
        var wzp = -cLat * Math.sin(lonRad);

        var txp = wxp * ca + wzp * sa;
        var typ = wyp;
        var tzp = -wxp * sa + wzp * ca;
        var sxp = txp;
        var syp = typ * cl - tzp * sl;
        var szp = typ * sl + tzp * cl;
        if (szp <= 0.02) continue;

        var px = Math.round(cx + sxp * rx);
        var py = Math.round(cy - (syp / GLOBE_ASPECT) * ry);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        var mch = markerCharFromLabel(pin && pin.marker);
        f.setData(px, py, mch, this._markerAttr(pin), false);
    }
    try { f.cycle(); } catch (_) { }
    this.angle += this.spinStep;
    if (this.angle >= Math.PI * 2) this.angle -= Math.PI * 2;
};

function initFrames() {
    if (typeof Frame !== 'function') return false;
    try {
        ROOT_FRAME = new Frame(1, 1, console.screen_columns, console.screen_rows, BG_BLACK | LIGHTGRAY);
        BG_FRAME = new Frame(1, 1, console.screen_columns, console.screen_rows, BG_BLACK | BLACK, ROOT_FRAME);
        UI_FRAME = new Frame(1, 1, console.screen_columns, console.screen_rows, BG_BLACK | LIGHTGRAY, ROOT_FRAME);
        UI_FRAME.transparent = true;

        var topBound = 3;                    // keep clear of top two rows
        var bottomBound = console.screen_rows - 1; // keep clear of bottom status row
        var maxH = Math.max(GLOBE_MIN_H, (bottomBound - topBound)); // preserve one row top/bottom margin
        var gh = Math.floor(console.screen_rows * GLOBE_HEIGHT_RATIO);
        gh = Math.max(GLOBE_MIN_H, Math.min(gh, maxH));
        var gw = Math.floor(gh * GLOBE_WIDTH_PER_HEIGHT);
        gw = Math.max(GLOBE_MIN_W, Math.min(gw, console.screen_columns - 2));
        var gx = Math.max(1, Math.floor((console.screen_columns - gw) / 2) + 1);
        var yMin = topBound;
        var yMax = bottomBound - gh + 1;
        var gy = Math.max(yMin, Math.min(yMax, Math.floor((yMin + yMax) / 2)));
        GLOBE_FRAME = new Frame(gx, gy, gw, gh, BG_BLACK | BLACK, BG_FRAME);
        GLOBE_FRAME.transparent = true;
        GLOBE = new AsciiGlobe(GLOBE_FRAME);

        ROOT_FRAME.open();
        BG_FRAME.open();
        UI_FRAME.open();
        GLOBE_FRAME.open();
        ROOT_FRAME.cycle();
        return true;
    } catch (e) {
        ROOT_FRAME = BG_FRAME = UI_FRAME = GLOBE_FRAME = GLOBE = null;
        return false;
    }
}

function tickGlobe(force) {
    if (!GLOBE) return;
    var now = Date.now ? Date.now() : time() * 1000;
    if (!force && (now - LAST_GLOBE_TICK) < GLOBE_TICK_MS) return;
    LAST_GLOBE_TICK = now;
    try { GLOBE.tick(); } catch (_) { }
    uiCycle();
}

// ── drawing ────────────────────────────────────────────────────────
function drawHeader(total) {
    uiClear(BG_BLACK | LIGHTGRAY);
    uiGoto(1, 1);
    uiPrint(C_HDR + ' Who\'s Online Across BBSes' + C_DIM + '  (' + total + ' users)');
    uiPrint(C_RESET + '\r\n');
    uiPrint(C_BAR + repeatCh('\xc4', console.screen_columns - 1) + C_RESET + '\r\n');
}

function drawGrid(users, page) {
    var startIdx = page * PAGE_SIZE;
    var y = 3; // row after header (1-based)

    for (var gr = 0; gr < PAGE_ROWS; gr++) {
        // Collect cells for this grid row
        var cells = [];
        for (var c = 0; c < COLS; c++) {
            var idx = startIdx + gr * COLS + c;
            if (idx < users.length) {
                cells.push(users[idx]);
            }
        }
        if (!cells.length) break;

        // Pre-fetch avatar rows for each cell
        var avatars = [];
        for (var c = 0; c < cells.length; c++) {
            avatars.push(getAvatarRows(cells[c]));
        }

        // Row 1: Username
        for (var c = 0; c < cells.length; c++) {
            drawCellCentered(c, y, C_USER, cells[c].name);
        }
        y++;

        // Row 2: BBS name
        for (var c = 0; c < cells.length; c++) {
            drawCellCentered(c, y, markerCtrlColorFromLabel(cells[c].bbs, !!cells[c].local), cells[c].bbs);
        }
        y++;

        // Rows 3-8: Avatar (6 rows)
        for (var ar = 0; ar < AVA_H; ar++) {
            for (var c = 0; c < cells.length; c++) {
                var slotX = cellInnerX(c);
                if (avatars[c]) {
                    var ax = slotX + Math.floor((CELL_W - AVA_W) / 2);
                    uiGoto(ax, y);
                    uiPrint(avatars[c][ar]);
                } else {
                    // No avatar — show placeholder on middle rows
                    if (ar === 2) {
                        drawCellCentered(c, y, C_DIM, 'no avatar');
                    }
                }
            }
            y++;
        }

        // Row 9: (spacer — keeps breathing room before activity)
        for (var c = 0; c < cells.length; c++) {
            drawCellCentered(c, y, C_BAR, '\xc4\xc4\xc4\xc4\xc4\xc4\xc4\xc4\xc4\xc4\xc4\xc4');
        }
        y++;

        // Row 10: Activity ("web " prefix marks a webv4 visitor vs. a node user)
        for (var c = 0; c < cells.length; c++) {
            var actText = cells[c].action || '';
            if (cells[c].web) actText = 'web ' + (actText || 'browsing');
            drawCellCentered(c, y, C_ACT, actText);
        }
        y++;

        // Optional blank spacer row between grid row blocks.
        if (CELL_GAP_Y > 0) y += CELL_GAP_Y;
    }
}

function drawFooter(page, totalPages) {
    uiGoto(1, console.screen_rows);
    uiPrint('\x01n\x014\x01h\x01w' + repeatCh(' ', console.screen_columns));
    uiGoto(1, console.screen_rows);
    uiPrint('\x01n\x014\x01h\x01w ');
    if (totalPages > 1) {
        uiPrint('Page ' + (page + 1) + '/' + totalPages + '  ');
    }
    uiPrint('\x18\x19/PgUp/PgDn)Navigate  R)efresh  Q)uit ');
    uiPrint(C_RESET);
}

// ── splash screen ──────────────────────────────────────────────────
function drawSplash() {
    try {
        var tdf = load("tdfonts_lib.js");
        tdf.opt = { width: 80, retry: true };
        uiClear(BG_BLACK | LIGHTGRAY);
        var art = tdf.output("WHOS ONLINE");
        var lines = art.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        // Vertically center in 23 rows
        var startY = Math.max(1, Math.floor((23 - lines.length) / 2));
        for (var i = 0; i < lines.length && startY + i <= 23; i++) {
            uiGoto(1, startY + i);
            uiPrint(lines[i] + "\x01n");
        }
        uiGoto(1, 23);
        uiPrint("\x01n\x01h\x01k" + centerText("scanning linked BBSes...", 80) + "\x01n");
    } catch (e) {
        // TDF unavailable; simple fallback
        uiClear(BG_BLACK | LIGHTGRAY);
        uiGoto(1, 11);
        uiPrint(C_HDR + centerText("WHO\x27S ONLINE", 80) + "\x01n");
        uiGoto(1, 13);
        uiPrint(C_DIM + centerText("scanning linked BBSes...", 80) + "\x01n");
    }
    uiCycle();
}

// ── main loop ──────────────────────────────────────────────────────
function main() {
    function nowMs() {
        return Date.now ? Date.now() : (time() * 1000);
    }

    initFrames();
    drawSplash();
    var page = 0;
    var users = fetchUsers();
    rebuildActiveMarkerColorMap(users);
    var totalPages = Math.max(1, Math.ceil(users.length / PAGE_SIZE));
    if (GLOBE) GLOBE.setPins(buildGlobePins(users));
    var lastAutoRefresh = nowMs();

    function redraw() {
        if (page >= totalPages) page = totalPages - 1;
        if (page < 0) page = 0;
        drawHeader(users.length);
        drawGrid(users, page);
        drawFooter(page, totalPages);
        uiCycle();
    }

    redraw();
    tickGlobe(true);

    function refreshData(showSplash, preservePage) {
        var oldPage = page;
        if (showSplash) drawSplash();
        users = fetchUsers();
        totalPages = Math.max(1, Math.ceil(users.length / PAGE_SIZE));
        rebuildActiveMarkerColorMap(users);
        if (preservePage) page = clamp(oldPage, 0, totalPages - 1);
        else page = 0;
        if (GLOBE) GLOBE.setPins(buildGlobePins(users));
        redraw();
        tickGlobe(true);
        lastAutoRefresh = nowMs();
    }

    while (true) {
        var k = console.inkey(K_NONE, 120);
        if (!k) {
            if ((nowMs() - lastAutoRefresh) >= AUTO_REFRESH_MS) {
                refreshData(false, true);
                continue;
            }
            tickGlobe(false);
            continue;
        }

        // ANSI escape sequence handling
        if (k === "\x1b") {
            var k2 = console.inkey(K_NONE, 100);
            if (k2 === "[") {
                var k3 = console.inkey(K_NONE, 100);
                switch (k3) {
                    case "A": // Up
                    case "5": // PgUp (followed by ~)
                        console.inkey(K_NONE, 50); // eat trailing ~
                        if (page > 0) { page--; redraw(); }
                        tickGlobe(true);
                        continue;
                    case "B": // Down
                    case "6": // PgDn
                        console.inkey(K_NONE, 50);
                        if (page < totalPages - 1) { page++; redraw(); }
                        tickGlobe(true);
                        continue;
                }
            }
            // bare ESC = quit
            if (!k2) break;
            continue;
        }

        switch (k.toUpperCase()) {
            case "Q": case "\r": return;
            case "R":
                refreshData(false, true);
                break;
            case "\x10": // ^P / PgUp
                if (page > 0) { page--; redraw(); }
                tickGlobe(true);
                break;
            case "\x0e": // ^N / PgDn
                if (page < totalPages - 1) { page++; redraw(); }
                tickGlobe(true);
                break;
        }
    }
}

main();
