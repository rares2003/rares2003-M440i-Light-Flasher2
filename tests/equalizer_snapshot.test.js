'use strict';
// Native snapshot bridge, Node side: layout, checksum, atomic publish by the service.
// `node tests/equalizer_snapshot.test.js --fixture DIR` additionally writes
// cross-language fixtures that experiments/carplay_alsa/test_eq_snapshot.c reads.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Core = require('../native/equalizer-dsp/core');
const Snapshot = require('../native/equalizer-dsp/snapshot');
const { Service } = require('../native/equalizer-dsp/server');
let tests = 0;
function test(name, fn) { fn(); console.log('PASS ' + name); tests++; }
function remove(p) {
    if (!fs.existsSync(p)) return;
    if (fs.statSync(p).isDirectory()) { fs.readdirSync(p).forEach((n) => remove(path.join(p, n))); fs.rmdirSync(p); }
    else fs.unlinkSync(p);
}
function boosted() {
    const c = Core.defaults(); c.enabled = true; c.autoHeadroom = false; c.preampDb = -1.5;
    c.bands[0].gainDb = 6; c.bands[3].gainDb = -3.5; c.bands[6].q = 2.25; c.bands[6].frequencyHz = 12000;
    return c;
}

test('CRC-32 matches the IEEE check value', () => {
    assert.strictEqual(Snapshot.crc32(Buffer.from('123456789'), 0, 9), 0xCBF43926);
});
test('layout v1 is 204 bytes with magic, size and flags', () => {
    const b = Snapshot.encode(boosted(), 42);
    assert.strictEqual(b.length, 204);
    assert.strictEqual(b.toString('latin1', 0, 8), 'MGEQSNP1');
    assert.strictEqual(b.readUInt32LE(8), 1);
    assert.strictEqual(b.readUInt32LE(12), 204);
    assert.strictEqual(b.readUInt32LE(16), 42);
    assert.strictEqual(b.readUInt32LE(20), 1);
    assert.strictEqual(b.readDoubleLE(24), -1.5);
    assert.strictEqual(b.readDoubleLE(32 + 8), 6);
    assert.strictEqual(b.readDoubleLE(32 + 6 * 24), 12000);
});
test('decode round-trips the validated configuration', () => {
    const d = Snapshot.decode(Snapshot.encode(boosted(), 7));
    assert.strictEqual(d.revision, 7);
    assert.deepStrictEqual(d.config, Core.validate(boosted()));
    assert.deepStrictEqual(Snapshot.decode(Snapshot.encode(Core.defaults(), 0)).config, Core.defaults());
});
test('corrupt, truncated, unknown-flag and out-of-range snapshots are rejected', () => {
    const good = Snapshot.encode(boosted(), 3);
    const flip = Buffer.from(good); flip[40] ^= 1;
    assert.throws(() => Snapshot.decode(flip), /checksum/);
    assert.throws(() => Snapshot.decode(good.slice(0, 200)), /size/);
    const magic = Buffer.from(good); magic[0] = 0x4E; magic.writeUInt32LE(Snapshot.crc32(magic, 0, 200), 200);
    assert.throws(() => Snapshot.decode(magic), /layout/);
    const flags = Buffer.from(good); flags.writeUInt32LE(5, 20); flags.writeUInt32LE(Snapshot.crc32(flags, 0, 200), 200);
    assert.throws(() => Snapshot.decode(flags), /flags/);
    const range = Buffer.from(good); range.writeDoubleLE(13, 40); range.writeUInt32LE(Snapshot.crc32(range, 0, 200), 200);
    assert.throws(() => Snapshot.decode(range), /band/);
    assert.throws(() => Snapshot.encode(boosted(), -1), /revision/);
});
test('service publishes the snapshot on start and after every set', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-snap-')), runtime = path.join(root, 'run');
    try {
        const service = new Service({ runtime, stateFile: path.join(root, 'data', 'settings.json') });
        service.publishSnapshot();
        const file = path.join(runtime, Snapshot.FILE_NAME);
        let d = Snapshot.decode(fs.readFileSync(file));
        assert.strictEqual(d.revision, 0); assert.strictEqual(d.config.enabled, false);
        const status = service.set(boosted(), 0);
        d = Snapshot.decode(fs.readFileSync(file));
        assert.strictEqual(d.revision, 1);
        assert.deepStrictEqual(d.config, Core.validate(boosted()));
        assert.strictEqual(status.nativeSnapshot.revision, 1);
        assert.strictEqual(status.nativeSnapshot.error, '');
        assert.strictEqual(status.stockCarPlayRouted, false);
        assert.ok(!fs.existsSync(file + '.tmp'));
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o640);
    } finally { remove(root); }
});
test('an unwritable runtime directory is reported, not fatal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-snap-')), blocker = path.join(root, 'run');
    try {
        fs.writeFileSync(blocker, 'not a directory');
        const service = new Service({ runtime: blocker, stateFile: path.join(root, 'settings.json') });
        const status = service.set(boosted(), 0);
        assert.strictEqual(status.revision, 1);
        assert.ok(status.nativeSnapshot.error.length > 0);
        assert.strictEqual(status.nativeSnapshot.revision, null);
    } finally { remove(root); }
});

const at = process.argv.indexOf('--fixture');
if (at > 0) {
    const dir = process.argv[at + 1];
    fs.writeFileSync(path.join(dir, 'boost.snapshot'), Snapshot.encode(boosted(), 42));
    fs.writeFileSync(path.join(dir, 'neutral.snapshot'), Snapshot.encode(Core.defaults(), 0));
    console.log('Fixtures written to ' + dir);
}
console.log(tests + ' snapshot tests passed');
