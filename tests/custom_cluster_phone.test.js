'use strict';
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const StatusLine = require('../apps/custom_cluster/status_line');
const L = require('../apps/custom_cluster/layout_panels');
const { ClusterLayers } = require('../apps/custom_cluster/cluster_layers');
const { PhoneBridge, HOLD_MS } = require('../apps/custom_cluster/phone_bridge');

// ---- geometry: one thin line, never over a layout element or the telltale row
assert.ok(StatusLine.MAP_RECT.x + StatusLine.MAP_RECT.w <= 1088 && StatusLine.MAP_RECT.y + StatusLine.MAP_RECT.h <= 480, 'inside the map window');
assert.ok(StatusLine.MAP_RECT.y >= 384 + 40, 'below the lyrics bands (next line ends at y 384)');
const side = L.SIDES[0];
const dialBottom = side.y + 320; // face texture box; lowest lit pixel is y 505
for (const layout of Object.keys(StatusLine.PANEL_RECTS)) {
    const r = StatusLine.panelRect(layout), cover = L.COVERS[0];
    assert.strictEqual(r.h, 4, layout + ' stays thin');
    assert.ok(r.x >= cover.x + 40 && r.x + r.w <= cover.x + cover.w - 40, layout + ' well inside the left cover');
    assert.ok(r.y >= dialBottom && r.y + r.h < cover.y + cover.h - 40, layout + ' below the dial, clear of the bottom strip');
    assert.ok(r.y >= 48 && r.y + r.h < 600, layout + ' outside telltale row and bottom strip');
    assert.ok(r.x + r.w <= 416, layout + ' left of the map aperture');
}
assert.deepStrictEqual(StatusLine.color('opened').slice(0, 3).map((v) => v > 0.5), [false, true, false], 'green');
assert.deepStrictEqual(StatusLine.color('closed').slice(0, 3).map((v) => v > 0.5), [true, false, false], 'red');
assert.strictEqual(StatusLine.color('unknown'), null);
assert.strictEqual(StatusLine.valid('opened') && StatusLine.valid('closed'), true);
assert.strictEqual(StatusLine.valid('unknown') || StatusLine.valid(''), false);

// ---- cluster layers: line follows the phone state and the tested layout
class FakeRenderer extends EventEmitter {
    constructor() { super(); this.backend = 'id7'; this.targets = 'map:1088x480,panel:1920x720';
        this.effects = []; this.uniforms = []; this.drops = []; }
    connect() { this.emit('ready'); } close() {}
    effect(o) { this.effects.push(o); return this.effects.length + 100; }
    image(o) { this.effects.push(o); return this.effects.length + 100; }
    pixels() { return true; }
    uniform(ref, name, value) { this.uniforms.push({ ref, name, value }); }
    set() {} drop(ref) { this.drops.push(ref); } status() {}
}
const log = { info() {}, warn() {} };
const opts = (more) => Object.assign({ layout: 'g80', panelTestMode: 'probe', panelTarget: 'panel', accent: 'm',
    sixwbTheme: 'comfort', sixwbColorSource: 'original', colorMode: 'palette', colorBrightness: 100,
    wazeMap: 'auto', phoneBadge: true }, more || {});
const lines = (fake) => fake.effects.filter((e) => e.fs === StatusLine.LINE_FS);
{
    const fake = new FakeRenderer(), c = new ClusterLayers(log, null, fake);
    c.settings(opts({ phoneBadge: false }));
    c.phone('opened');
    assert.strictEqual(lines(fake).length, 0, 'off by default / when the setting is off');
    c.settings(opts());
    assert.strictEqual(lines(fake).length, 1, 'switching the setting on shows the stored state');
    const first = lines(fake)[0];
    assert.strictEqual(first.target, 'map');
    assert.deepStrictEqual([first.x, first.y, first.w, first.h], [StatusLine.MAP_RECT.x, StatusLine.MAP_RECT.y, StatusLine.MAP_RECT.w, StatusLine.MAP_RECT.h]);
    assert.strictEqual(first.klass, 'overlay');
    assert.strictEqual(first.contend, false, 'never takes the centre slot');
    assert.strictEqual(first.guide_hold, false, 'BMW turn box stays');
    assert.strictEqual(first.z, StatusLine.Z);
    const ref = fake.effects.indexOf(first) + 101;
    assert.deepStrictEqual(fake.uniforms.filter((u) => u.ref === ref).pop().value, StatusLine.color('opened'));
    c.phone('closed');
    assert.strictEqual(lines(fake).length, 1, 'colour change reuses the layer');
    assert.deepStrictEqual(fake.uniforms.filter((u) => u.ref === ref).pop().value, StatusLine.color('closed'));
    c.phone('closed');
    assert.strictEqual(fake.uniforms.filter((u) => u.ref === ref).length, 2, 'same state sends nothing');
    // parked KOMBI test moves it into the tested layout, and back afterwards
    c.sample({ speed: 0, rpm: 790, stage: 'P', gear: 0 });
    assert.strictEqual(c.armPanel(), true);
    assert.ok(fake.drops.includes(ref), 'map line removed before the panel line appears');
    const panelLine = lines(fake)[1];
    assert.ok(panelLine, 'line follows into the panel');
    assert.strictEqual(panelLine.target, 'panel');
    const want = StatusLine.panelRect('g80');
    assert.deepStrictEqual([panelLine.x, panelLine.y], [want.x, want.y]);
    assert.strictEqual(lines(fake).filter((e) => e.target === 'map').length, 1, 'never in both places');
    c.phone('unknown');
    assert.ok(fake.drops.includes(fake.effects.indexOf(panelLine) + 101), 'unknown (or stale) state: no line');
}
{
    const fake = new FakeRenderer(), c = new ClusterLayers(log, null, fake);
    c.settings(opts({ layout: 'sport' }));
    c.sample({ speed: 0, rpm: 790, stage: 'P', gear: 0 });
    c.phone('opened');
    c.armPanel();
    const r = lines(fake).filter((e) => e.target === 'panel').pop();
    assert.ok(r && r.x === StatusLine.panelRect('sport').x, 'each layout uses its own position');
}

// ---- phone bridge: token route, retry, loopback-only health, stale state
function get(host, port, p) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: host, port, path: p }, (res) => {
            let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
        }).on('error', reject);
    });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function bridgeTest() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-phone-'));
    let t = 1000000, changes = 0, addr = null;
    const port = 38000 + (process.pid % 1000);
    const b = new PhoneBridge(dir, log, () => { changes++; }, {
        now: () => t, port, address: undefined, resolveAddress: () => addr, netStatusPort: 0 });
    assert.strictEqual(b.reported(), 'unknown');
    b.setEnabled(true);
    assert.strictEqual(b.listening(), false, 'no Wi-Fi address: waits instead of binding everywhere');
    assert.strictEqual(b.url('on'), null);
    await wait(60);
    assert.strictEqual((await get('127.0.0.1', port, '/.mgu-cluster-health')).status, 503, 'not listening -> not healthy');
    addr = '127.0.0.2';
    t += 6000; b.tick(); await wait(80);
    assert.strictEqual(b.listening(), true, 'retry finds the address later');
    const h = await get('127.0.0.1', port, '/.mgu-cluster-health');
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.headers['x-mgu-custom-cluster'], '1');
    assert.strictEqual((await get('127.0.0.2', port, '/.mgu-cluster-health')).status, 404, 'health answers loopback only (phone side never sees it)');
    const base = '/s/' + b.token + '/';
    assert.strictEqual((await get('127.0.0.2', port, '/s/wrong/on')).status, 404);
    assert.strictEqual((await get('127.0.0.2', port, base + 'x')).status, 404);
    assert.strictEqual((await get('127.0.0.2', port, base + 'on')).body, 'OK');
    assert.strictEqual(b.reported(), 'opened');
    assert.strictEqual((await get('127.0.0.2', port, base + 'off')).status, 200);
    assert.strictEqual(b.reported(), 'closed');
    assert.strictEqual(changes >= 2, true);
    assert.strictEqual(b.url('off'), 'http://127.0.0.2:' + port + base + 'off');
    t += HOLD_MS + 1000;
    assert.strictEqual(b.reported(), 'unknown', 'an event from long ago says nothing');
    b.stop();
    await wait(60);
    assert.strictEqual(b.listening(), false);
    await assert.rejects(get('127.0.0.1', port, '/.mgu-cluster-health'), 'health endpoint gone when disabled');
    const again = new PhoneBridge(dir, log, null, { port, resolveAddress: () => null, netStatusPort: 0 });
    assert.strictEqual(again.token, b.token, 'token survives restarts');
}
bridgeTest().then(() => console.log('custom-cluster phone status line and link tests passed'),
    (e) => { console.error(e); process.exitCode = 1; });
