'use strict';

// Runs Video Hub's main.js against a stand-in for the kit's context: page changes, the
// HMI's bar buttons, and above all that playback stops when the car moves, the speed
// value goes stale, the screen is hidden or another page is opened.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Module = require('module');

const APP = path.join(__dirname, '..', 'apps', 'mgu_video_hub');
const KIT = path.join(__dirname, '..', 'kit', 'runtime');
const { Recorder } = require(path.join(KIT, 'record'));
const { THEMES } = require(path.join(KIT, 'themes'));
const bridge = require(path.join(APP, 'video_bridge'));
const { PORT } = require(path.join(APP, 'companion'));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, ms, what) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (test()) return; await sleep(25); }
    assert.fail('Timed out waiting for ' + what);
}

async function run() {
    const ffmpeg = bridge.executable('ffmpeg');
    if (!ffmpeg) { console.log('Skipping Video Hub app test: ffmpeg missing'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhub-app-'));
    fs.mkdirSync(path.join(dir, 'videos'));
    cp.execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15', '-t', '4', '-c:v', 'mpeg4', '-y',
        path.join(dir, 'videos', 'Clip.mp4')]);
    fs.writeFileSync(path.join(dir, 'youtube.json'), JSON.stringify(['dQw4w9WgXcQ']));

    // main.js asks for the kit next to it (as installed); here the kit comes from kit/runtime
    let spec = null, video = null;
    const Original = bridge.VideoBridge;
    bridge.VideoBridge = class extends Original { constructor(log, opts) { super(log, opts); video = this; } };
    const load = Module._load;
    Module._load = function (request, parent) {
        if (parent && path.dirname(parent.filename) === APP && request.indexOf('./kit/') === 0) {
            if (request === './kit/mgu') return {run(s) { spec = s; }};
            return load.call(this, path.join(KIT, request.slice(6)), parent);
        }
        return load.apply(this, arguments);
    };
    const exitListeners = process.listeners('exit').slice();
    require(path.join(APP, 'main.js'));
    Module._load = load;

    const clicks = {}, hooks = {}, settings = {resolution:'640', audio:'off', renderer:'auto'};
    let frame = null, tick = null, visible = true, focus = true, speed = null, writes = 0;
    const ctx = {
        log:{info() {}, warn() {}, error() {}}, dataDir:dir, spec:{version:'0.2.0'},
        settings:{get:key => settings[key]},
        theme:() => THEMES.ice,
        signals:{watch:(iface, instance, handlers) => { speed = handlers.statusCarSpeed2; return Promise.resolve({}); }},
        display:{gpu:{ready:true, native:true, info:{video:true}, _write:() => { writes++; return true; }}, active:name => name === 'MAIN' && visible},
        ui:{onClick:(id, fn) => { clicks[id] = fn; }, onVisible:fn => { hooks.visible = fn; }, onFocus:fn => { hooks.focus = fn; },
            hasFocus:() => focus, image:(name, cv) => { frame = cv; return Promise.resolve(); }},
        onTab:fn => { hooks.tab = fn; },
        canvas:(w, h) => { const r = new Recorder(w, h, {textScale:1}); r.reset(); return r; },
        loop:(name, fps, fn) => { tick = fn; },
        sheet:() => false,
    };
    const keys = () => { tick(); return frame.targets.map(t => t.key); };
    const press = key => { tick(); frame.targets.find(t => t.key === key).run(); };
    const hasVideoOp = () => { tick(); return Array.prototype.indexOf.call(frame.u.subarray(0, frame.n), bridge.ID) >= 0 && writes > 0; };
    const parked = () => speed({speedVehicleCentreOfGravity:0});
    const playing = () => video.playing && !video.paused;
    const realNow = Date.now;

    try {
        await spec.start(ctx);
        assert.deepStrictEqual(Object.keys(clicks).sort(), ['BTN_ACTION', 'BTN_AUDIO_EQ', 'BTN_BACK', 'BTN_PAGE']);
        const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
        const declared = manifest.screens[0].buttons.map(b => b[0]).filter(id => id !== 'BTN_SETTINGS').sort();
        assert.deepStrictEqual(declared, Object.keys(clicks).sort(), 'every bar button in app.json has a handler, and the other way round');

        // library: the uploaded clip is listed; without a speed value nothing plays
        assert.deepStrictEqual(keys(), ['ITEM_0', 'RESCAN']);
        press('ITEM_0');
        assert.strictEqual(video.active, false, 'no speed signal: locked');
        assert.deepStrictEqual(keys(), ['ITEM_0', 'RESCAN'], 'still on the library page');
        hooks.tab(2);
        assert.ok(!keys().includes('PLAY_PAUSE'), 'the player page needs a chosen video');

        // parked: plays, the picture is handed to the renderer once frames exist
        parked();
        press('ITEM_0');
        assert.ok(playing());
        assert.deepStrictEqual(keys(), ['STOP', 'TO_LIST'], 'starting: nothing to pause yet');
        await until(() => video.frames > 3 && video.duration !== null, 5000, 'frames and length');
        assert.deepStrictEqual(keys(), ['SEEK_BACK', 'PLAY_PAUSE', 'STOP', 'TO_LIST'], '+15 s is not offered 15 s before the end (4 s clip)');
        assert.ok(hasVideoOp(), 'video rectangle drawn and the frame buffer registered');
        await until(() => video.position > 1, 3000, 'one second played');
        press('SEEK_BACK');
        assert.ok(playing() && video.position === 0, '-15 s near the start begins again');
        await until(() => video.frames > 3, 5000, 'frames after seek');
        press('PLAY_PAUSE'); assert.strictEqual(video.paused, true);
        clicks.BTN_ACTION(); assert.strictEqual(video.paused, false, 'the bar\'s Play / Pause does the same');

        // moving: stops at once, and cannot be started again
        speed({speedVehicleCentreOfGravity:640});
        assert.strictEqual(video.active, false, 'moving car: playback stopped');
        assert.strictEqual(fs.existsSync(video.path), false, 'and the picture is gone');
        clicks.BTN_ACTION();
        assert.strictEqual(video.active, false);
        speed({speedVehicleCentreOfGravity:65535});
        clicks.BTN_ACTION();
        assert.strictEqual(video.active, false, 'an invalid value does not unlock');

        // parked again: resumes where it was; a stale speed value stops it
        parked(); clicks.BTN_ACTION();
        assert.ok(playing());
        Date.now = () => realNow() + 6000;
        tick();
        Date.now = realNow;
        assert.strictEqual(video.active, false, 'no fresh speed value for 5 s: stopped');

        // hidden screen, lost focus, leaving the player page
        parked(); clicks.BTN_ACTION(); assert.ok(playing());
        visible = false; hooks.visible('MAIN', false); visible = true;
        assert.strictEqual(video.active, false, 'hidden screen: stopped');
        parked(); clicks.BTN_ACTION(); assert.ok(playing());
        focus = false; hooks.focus(); focus = true;
        assert.strictEqual(video.active, false, 'focus lost: stopped');
        parked(); clicks.BTN_ACTION(); assert.ok(playing());
        hooks.tab(1);
        assert.strictEqual(video.active, false, 'another page: stopped');
        assert.deepStrictEqual(keys(), ['ITEM_0'], 'the saved 0.1.x YouTube link is listed');
        parked(); clicks.BTN_ACTION(); assert.ok(playing());
        clicks.BTN_BACK();
        assert.strictEqual(video.active, false);
        assert.deepStrictEqual(keys(), ['ITEM_0', 'RESCAN'], 'Back returns to the list the video came from');

        // renderer without video support: refused with a reason, nothing is decoded
        ctx.display.gpu.info.video = false;
        parked(); press('ITEM_0');
        assert.strictEqual(video.active, false);
        ctx.display.gpu.info.video = true;

        // the bar's Next page walks Library -> YouTube -> Player -> Connection -> Library
        clicks.BTN_PAGE(); assert.deepStrictEqual(keys(), ['ITEM_0']);
        clicks.BTN_PAGE(); assert.ok(keys().includes('TO_LIST'));
        clicks.BTN_PAGE(); assert.deepStrictEqual(keys(), ['RECHECK', 'LOGS']);
        press('LOGS'); assert.deepStrictEqual(keys(), ['LOGS_BACK']);
        clicks.BTN_BACK(); assert.deepStrictEqual(keys(), ['RECHECK', 'LOGS']);
        press('RECHECK');
        clicks.BTN_AUDIO_EQ();                                  // no DSP service here: a notice, no crash
        await sleep(50);
        clicks.BTN_PAGE(); assert.deepStrictEqual(keys(), ['ITEM_0', 'RESCAN']);

        // YouTube without yt-dlp: a clear state instead of an endless "resolving"
        hooks.tab(1); parked(); press('ITEM_0');
        if (!video.resolver) { assert.strictEqual(video.active, false); assert.ok(/yt-dlp/.test(video.error)); }
        video.stop();
    } finally {
        Date.now = realNow;
        bridge.VideoBridge = Original;
        process.listeners('exit').filter(fn => exitListeners.indexOf(fn) < 0).forEach(fn => { fn(); process.removeListener('exit', fn); });
        const rm = d => { fs.readdirSync(d).forEach(n => { const f = path.join(d, n); if (fs.lstatSync(f).isDirectory()) rm(f); else fs.unlinkSync(f); }); fs.rmdirSync(d); };
        rm(dir);
    }
    console.log('Video Hub app test passed: pages, bar buttons, parked-only playback and every stop condition (port ' + PORT + ')');
    // the uplink poller and the phone server keep timers; the test is done
    setTimeout(() => process.exit(process.exitCode || 0), 50);
}
run().catch(e => { console.error(e); process.exit(1); });
