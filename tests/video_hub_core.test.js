'use strict';

// Video Hub 0.2.0: the parked gate, the link store, the paced decoder (pause, end of file,
// length, resolver cache, stale frame buffers) and the phone companion's library endpoints.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const media = require('../apps/mgu_video_hub/media');
const v = require('../apps/mgu_video_hub/video_bridge');
const { ParkedGuard } = require('../apps/mgu_video_hub/safety');
const { LinkStore } = require('../apps/mgu_video_hub/links');
const { Companion } = require('../apps/mgu_video_hub/companion');
const { Diagnostics, FILE } = require('../apps/mgu_video_hub/diagnostics');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, ms, what) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (test()) return; await sleep(25); }
    assert.fail('Timed out waiting for ' + what);
}
function rm(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    names.forEach(name => {
        const file = path.join(dir, name);
        if (fs.lstatSync(file).isDirectory()) rm(file); else fs.unlinkSync(file);
    });
    fs.rmdirSync(dir);
}

function checkGuard() {
    let now = 1000;
    const g = new ParkedGuard({now:() => now});
    assert.strictEqual(g.state(), 'no-signal', 'no speed value yet: locked');
    assert.strictEqual(g.allowed(), false);
    assert.strictEqual(g.update(0), true);
    assert.strictEqual(g.allowed(), true);
    assert.strictEqual(g.hint(), '');
    for (const bad of [65535, -1, NaN, Infinity, '0', null, undefined]) assert.strictEqual(g.update(bad), false);
    now += 4999; assert.strictEqual(g.allowed(), true);
    now += 2; assert.strictEqual(g.state(), 'no-signal', 'a stale value locks, invalid values do not refresh it');
    g.update(32); assert.strictEqual(g.allowed(), true, '0.5 km/h is still standing');
    g.update(33); assert.strictEqual(g.state(), 'moving');
    assert.ok(/Moving/.test(g.hint()));
}
function checkLinks(dir) {
    fs.writeFileSync(path.join(dir, 'youtube.json'), JSON.stringify(['aaaaaaaaaaa', 'not an id', 'bbbbbbbbbbb', 'aaaaaaaaaaa']));
    const s = new LinkStore(dir);
    assert.deepStrictEqual(s.list().map(l => l.id), ['bbbbbbbbbbb', 'aaaaaaaaaaa'], '0.1.x list is read, newest first');
    assert.strictEqual(s.describe('aaaaaaaaaaa', {title:'  First\nvideo ', duration:213.4}), true);
    assert.strictEqual(s.describe('aaaaaaaaaaa', {title:'First video', duration:213}), false, 'unchanged: no write');
    assert.strictEqual(s.describe('zzzzzzzzzzz', {title:'x'}), false);
    s.add('ccccccccccc'); s.add('aaaaaaaaaaa');
    assert.deepStrictEqual(s.list().map(l => l.id), ['aaaaaaaaaaa', 'ccccccccccc', 'bbbbbbbbbbb']);
    assert.throws(() => s.add('../../etc'));
    const again = new LinkStore(dir);
    assert.deepStrictEqual(again.find('aaaaaaaaaaa'), {id:'aaaaaaaaaaa', title:'First video', duration:213}, 'title survives re-adding and a restart');
    assert.strictEqual(again.remove('bbbbbbbbbbb'), true);
    assert.strictEqual(again.remove('bbbbbbbbbbb'), false);
    assert.strictEqual(new LinkStore(dir).length, 2);
    for (let i = 0; i < 130; i++) again.add(('000' + i).slice(-3) + 'xxxxxxxx');
    assert.strictEqual(again.length, 100, 'bounded');
    fs.unlinkSync(path.join(dir, 'youtube.json'));
}
function checkResolverParsing() {
    assert.strictEqual(v.parseClock('3:33'), 213);
    assert.strictEqual(v.parseClock('1:02:03'), 3723);
    assert.strictEqual(v.parseClock('45'), 45);
    for (const bad of ['', 'NA', '0', 'https://x', '1:2:3:4']) assert.strictEqual(v.parseClock(bad), null);
    assert.deepStrictEqual(v.parseResolver('Title über\nhttps://r1.example/videoplayback?sig=1\n3:33\n'),
        {url:'https://r1.example/videoplayback?sig=1', title:'Title über', duration:213});
    assert.deepStrictEqual(v.parseResolver('https://r1.example/v\n'), {url:'https://r1.example/v', title:'', duration:null}, 'URL only still plays');
    assert.strictEqual(v.parseResolver('T\nhttps://a.example/video\nhttps://a.example/audio\n3:00'), null, 'split video+audio formats are refused');
    assert.strictEqual(v.parseResolver('http://plain.example/x'), null);
}
function checkStale(dir) {
    const shm = path.join(dir, 'shm');
    fs.mkdirSync(shm);
    const dead = cp.spawnSync(process.execPath, ['-e', '']).pid;
    const names = {dead:'mgu-video-vhub-' + dead + '-0123abcd', own:'mgu-video-vhub-' + process.pid + '-0123abcd',
        parent:'mgu-video-vhub-' + process.ppid + '-89abcdef', other:'mgu-video-other-1-0123abcd'};
    Object.keys(names).forEach(k => fs.writeFileSync(path.join(shm, names[k]), 'x'));
    assert.strictEqual(v.sweepStale(shm), 1);
    assert.deepStrictEqual(fs.readdirSync(shm).sort(), [names.other, names.own, names.parent].sort(),
        'only the buffer of a process that no longer exists is removed');
    assert.strictEqual(v.sweepStale(path.join(dir, 'missing')), 0);
    rm(shm);
}
async function checkMissingResolver() {
    const events = [];
    const p = new v.VideoBridge({warn() {}}, {ffmpeg:'/test/ffmpeg', resolver:null, aplay:null, shmDir:os.tmpdir(),
        proxyProvider:() => 'http://127.0.0.1:1', onEvent:(level, code) => events.push(code)});
    p.start({type:'youtube', id:'dQw4w9WgXcQ'}, 0, 640, 'off');
    assert.strictEqual(p.resolving, null, 'a missing yt-dlp must not leave the player "resolving" forever');
    assert.strictEqual(p.active, false);
    assert.ok(/yt-dlp/.test(p.error));
    assert.ok(events.includes('youtube.resolver_missing'));
    let outcome = 'pending';
    const handle = v.resolveYoutube('dQw4w9WgXcQ', null, e => { outcome = e.message; });
    assert.strictEqual(outcome, 'pending', 'the callback never runs before the caller has its handle');
    assert.strictEqual(typeof handle.kill, 'function');
    await sleep(20);
    assert.ok(/yt-dlp/.test(outcome));
    p.dispose();
}
async function checkDecoder(dir) {
    const ffmpeg = v.executable('ffmpeg');
    if (!ffmpeg) { console.log('Skipping decoder checks: ffmpeg missing'); return; }
    const movie = path.join(dir, 'clip.mp4');
    cp.execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15', '-t', '8', '-c:v', 'mpeg4', '-y', movie]);
    const events = [];
    const p = new v.VideoBridge({warn() {}}, {ffmpeg, resolver:null, aplay:null, shmDir:dir, onEvent:(level, code) => events.push(code)});
    const source = {type:'local', path:movie, name:'clip'};

    // paced at 15 fps, and a pause does not get replayed in fast-forward afterwards
    p.start(source, 0, 640, 'off');
    await until(() => p.frames >= 10, 4000, 'first frames');
    assert.strictEqual(p.status, 'Playing');
    const t0 = Date.now(), f0 = p.frames;
    await sleep(1000);
    const rate = (p.frames - f0) / ((Date.now() - t0) / 1000);
    assert.ok(rate > 11 && rate < 18, 'about 15 frames a second, got ' + rate.toFixed(1));
    p.pause();
    assert.strictEqual(p.status, 'Paused');
    const paused = p.frames;
    await sleep(1500);
    assert.strictEqual(p.frames, paused, 'no frame is shown while paused');
    assert.strictEqual(fs.existsSync(p.path), true, 'the paused picture stays');
    p.pause();
    await sleep(500);
    const burst = p.frames - paused;
    assert.ok(burst >= 4 && burst <= 10, 'resume continues at playback speed (0.1.4 raced ahead), got ' + burst + ' frames in 0.5 s');
    assert.ok(Math.abs(p.position - p.frames / v.FPS) < 0.01);
    await until(() => p.duration !== null, 3000, 'length of the file');
    assert.ok(Math.abs(p.duration - 8) < 0.3, 'length read from ffmpeg: ' + p.duration);

    // seek close to the end: plays out, then reports the end and keeps the last picture
    p.start(source, 7, 640, 'off');
    assert.strictEqual(p.duration !== null, true, 'a known length is there at once after a seek');
    await until(() => p.ended, 5000, 'end of file');
    assert.strictEqual(p.status, 'Finished');
    assert.strictEqual(p.playing, false);
    assert.strictEqual(p.active, false);
    assert.ok(p.frames >= 10 && p.frames <= 16, 'the queued last frames are shown too: ' + p.frames);
    assert.ok(p.position > 7.6 && p.position <= 8.1);
    assert.strictEqual(fs.existsSync(p.path), true);
    const header = fs.readFileSync(p.path).slice(0, 64);
    assert.strictEqual(header.readUInt32LE(16), p.frames, 'sequence in the ring is the last frame shown');

    // paused when the decoder reaches the end: finishes only after resuming
    p.start(source, 7.5, 640, 'off');
    await until(() => p.frames >= 1, 4000, 'frame after seek');
    p.pause();
    await sleep(900);
    assert.strictEqual(p.ended, false);
    assert.strictEqual(p.status, 'Paused');
    p.pause();
    await until(() => p.ended, 3000, 'end after resume');

    // past the end: a clear outcome, not a silent "stopped"
    p.start(source, 60, 640, 'off');
    await until(() => !p.playing, 5000, 'decoder exit');
    assert.strictEqual(p.ended, false);
    assert.strictEqual(p.status, 'Nothing to play');
    assert.ok(/No video frames/.test(p.error));

    p.start({type:'local', path:path.join(dir, 'missing.mp4'), name:'x'}, 0, 640, 'off');
    await until(() => !p.playing, 5000, 'decoder error');
    assert.strictEqual(p.status, 'Decoder stopped');
    assert.ok(/missing\.mp4/.test(p.error), p.error);

    p.dispose();
    assert.strictEqual(fs.existsSync(p.path), false);
    assert.ok(events.includes('playback.paused') && events.includes('playback.resumed') && events.includes('decoder.first_frame'));

    // YouTube: title and length reach the app; seeking reuses the resolved stream
    const counter = path.join(dir, 'resolver-calls'), fake = path.join(dir, 'fake-yt-dlp');
    fs.writeFileSync(fake, '#!/bin/sh\necho x >> "' + counter + '"\necho "Schöner Clip"\necho "https://stream.example/video.mp4"\necho "0:08"\n', {mode:0o755});
    const meta = [];
    const y = new v.VideoBridge({warn() {}}, {ffmpeg, resolver:fake, aplay:null, shmDir:dir,
        proxyProvider:() => 'http://video:secret@127.0.0.1:9', mediaProxyProvider:() => 'http://127.0.0.1:9', onMeta:m => meta.push(m)});
    const decoded = [];
    y._decode = (input, seconds) => decoded.push([input, seconds]);
    y.start({type:'youtube', id:'dQw4w9WgXcQ'}, 0, 640, 'off');
    assert.ok(y.resolving, 'resolving until yt-dlp answers');
    assert.strictEqual(y.active, true);
    await until(() => decoded.length === 1, 4000, 'fake resolver');
    assert.strictEqual(y.resolving, null);
    assert.deepStrictEqual(meta, [{id:'dQw4w9WgXcQ', title:'Schöner Clip', duration:8}]);
    assert.strictEqual(y.duration, 8);
    y.start({type:'youtube', id:'dQw4w9WgXcQ'}, 5, 640, 'off');
    assert.deepStrictEqual(decoded[1], ['https://stream.example/video.mp4', 5], 'seek starts at once from the cached stream');
    assert.strictEqual(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1, 'yt-dlp ran once');
    y.start({type:'youtube', id:'aaaaaaaaaaa'}, 0, 640, 'off');
    await until(() => decoded.length === 3, 4000, 'second video');
    assert.strictEqual(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 2, 'another video is resolved again');
    y.dispose();
    [movie, counter, fake].forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
}
function request(method, port, target, body, headers) {
    return new Promise((resolve, reject) => {
        const r = http.request({host:'127.0.0.1', port, path:target, method, headers:headers || {}}, res => {
            let s = '';
            res.on('data', b => { s += b; });
            res.on('end', () => resolve({code:res.statusCode, data:s, json:(() => { try { return JSON.parse(s); } catch (_) { return null; } })()}));
        });
        r.on('error', reject);
        r.end(body);
    });
}
async function checkCompanion(dir) {
    let host = null;
    const store = new LinkStore(dir), removed = [];
    const events = {
        address:() => host,
        youtube:id => store.add(id), links:() => store.list(),
        removeLink:id => { if (!store.remove(id)) throw new Error('Link not found'); },
        removeFile:name => { media.removeImported(dir, name); removed.push(name); },
    };
    const c = new Companion(dir, events, {warn() {}});
    assert.strictEqual(c.link(), null, 'no address yet: no QR');
    host = '172.16.222.1'; c.hostAt = 0;
    assert.strictEqual(c.link(), 'http://172.16.222.1:18879/?t=' + c.token, 'the address is picked up when Wi-Fi comes up later');
    assert.strictEqual(c.link('/diagnostics.json'), 'http://172.16.222.1:18879/diagnostics.json?t=' + c.token);
    c.start();
    await until(() => c.listening, 2000, 'companion');
    const port = c.http.address().port, t = '?t=' + c.token, json = {'content-type':'application/json'};

    // a second instance cannot listen; it reports that and can start once the port is free
    const second = new Companion(dir, events, {warn() {}});
    second.start();
    await until(() => second.error, 2000, 'port conflict');
    assert.ok(/in use/.test(second.error));
    assert.strictEqual(second.http, null, 'ready for a retry');
    assert.strictEqual(second.listening, false);

    for (const bad of ['', '?t=' + c.token.slice(1), '?t=' + c.token + '0', '?t=%00'])
        assert.strictEqual((await request('GET', port, '/library' + bad)).code, 403);
    let r = await request('GET', port, '/library' + t);
    assert.deepStrictEqual([r.code, r.json.files, r.json.links, r.json.usedBytes], [200, [], [], 0]);

    const body = Buffer.from('fake mp4 data');
    const upload = name => request('POST', port, '/upload' + t, body, {'x-filename':encodeURIComponent(name), 'content-length':body.length});
    assert.strictEqual((await upload('Holiday (1).mp4')).code, 201);
    r = await upload('Holiday (1).mp4');
    assert.strictEqual(r.code, 409);
    assert.ok(!r.data.includes(dir) && !/EEXIST/.test(r.data), 'no file-system path or errno text reaches the phone: ' + r.data);
    fs.writeFileSync(path.join(dir, 'videos', 'notes.txt'), 'keep');
    fs.symlinkSync('/etc/hostname', path.join(dir, 'videos', 'link.mp4'));
    await request('POST', port, '/youtube' + t, JSON.stringify({url:'https://youtu.be/dQw4w9WgXcQ'}), json);
    store.describe('dQw4w9WgXcQ', {title:'A title', duration:213});
    r = await request('GET', port, '/library' + t);
    assert.deepStrictEqual(r.json.files, [{name:'Holiday (1).mp4', size:body.length}], 'only real uploaded videos are listed');
    assert.deepStrictEqual(r.json.links, [{id:'dQw4w9WgXcQ', title:'A title', duration:213}]);
    assert.strictEqual(r.json.usedBytes, body.length);

    const del = payload => request('POST', port, '/delete' + t, typeof payload === 'string' ? payload : JSON.stringify(payload), json);
    for (const name of ['../youtube.json', 'notes.txt', 'link.mp4', '/etc/passwd', 'videos/Holiday (1).mp4', '', 'Missing.mp4'])
        assert.ok([400, 404].includes((await del({kind:'file', name})).code), 'must refuse to delete ' + JSON.stringify(name));
    assert.strictEqual((await del({kind:'folder', name:'x'})).code, 400);
    assert.strictEqual((await del('not json')).code, 400);
    assert.strictEqual((await del('"text"')).code, 400);
    assert.strictEqual((await del('x'.repeat(6000))).code, 413);
    assert.strictEqual((await request('POST', port, '/delete?t=wrong', JSON.stringify({kind:'file', name:'Holiday (1).mp4'}), json)).code, 403);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'videos')).sort(), ['Holiday (1).mp4', 'link.mp4', 'notes.txt']);
    assert.strictEqual((await del({kind:'file', name:'Holiday (1).mp4'})).code, 200);
    assert.deepStrictEqual(removed, ['Holiday (1).mp4']);
    assert.strictEqual((await del({kind:'link', id:'dQw4w9WgXcQ'})).code, 200);
    assert.strictEqual((await del({kind:'link', id:'dQw4w9WgXcQ'})).code, 404);
    r = await request('GET', port, '/library' + t);
    assert.deepStrictEqual([r.json.files, r.json.links], [[], []]);
    r = await request('GET', port, '/' + t);
    assert.ok(r.code === 200 && r.data.includes('/library') && r.data.includes('/delete'), 'the phone page uses the new endpoints');

    await new Promise(resolve => c.http.close(resolve));
    c.stop();
    second.start();
    await until(() => second.listening, 2000, 'retry after the port is free');
    assert.strictEqual(second.error, '');
    await new Promise(resolve => second.http.close(resolve));
    second.stop();
}
async function checkDiagnostics(dir) {
    const d = new Diagnostics(dir, '0.2.0'), file = path.join(dir, FILE);
    d.add('INFO', 'app.started', 'one'); d.add('INFO', 'library.changed', 'two');
    assert.strictEqual(fs.existsSync(file), false, 'routine events are bundled, not written one by one');
    d.add('ERROR', 'decoder.failed', 'three');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).events.length, 3, 'an error is written at once, with what came before');
    d.add('INFO', 'playback.stopped', 'four');
    d.flush();
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).events.length, 4, 'flush on exit loses nothing');
    d.add('WARN', 'uplink.state', 'five');
    await sleep(1700);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).events.length, 5, 'and the timer writes the rest');
}

async function run() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhub-core-'));
    try {
        checkGuard(); checkLinks(dir); checkResolverParsing(); checkStale(dir);
        await checkMissingResolver(); await checkDecoder(dir); await checkCompanion(dir); await checkDiagnostics(dir);
    } finally { rm(dir); }
    console.log('Video Hub core tests passed: parked gate, links, paced decoder, resolver cache, companion library, diagnostics');
}
run().catch(e => { console.error(e); process.exitCode = 1; });
