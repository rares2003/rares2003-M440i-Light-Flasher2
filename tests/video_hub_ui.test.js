'use strict';

// Draws every Video Hub page from a view model with the kit's real recorder and checks the
// controls each page offers. VIDEO_HUB_UI_DUMP=<dir> also writes the pages as PNG files.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('../kit/runtime/gauges');
const kitCanvas = require('../kit/runtime/canvas');
const { Recorder, play } = require('../kit/runtime/record');
const { THEMES } = require('../kit/runtime/themes');
const media = require('../apps/mgu_video_hub/media');
const { makeUi, ascii, clock, megabytes, PAGE, PAGE_SIZE, VIDEO, W, H } = require('../apps/mgu_video_hub/ui');

const ui = makeUi(G, kitCanvas);
const dump = process.env.VIDEO_HUB_UI_DUMP;
const calls = [];
const actions = {};
['play', 'toggle', 'seek', 'open', 'turn', 'recheck', 'rescan', 'stop', 'back'].forEach(name => {
    actions[name] = arg => calls.push([name, arg]);
});
actions.video = (cv, x, y, w, h) => calls.push(['video', x, y, w, h]);

function render(name, model, theme) {
    const cv = new Recorder(W, H, {textScale:1});
    cv.reset();
    ui.draw(cv, theme || THEMES.ice, model, actions);
    if (dump) {
        const out = new kitCanvas.Canvas(W, H);
        play(cv.words(), out);
        fs.writeFileSync(path.join(dump, name + '.png'), out.png());
    }
    return cv;
}
const keys = cv => cv.targets.map(t => t.key);
const press = (cv, key) => cv.targets.find(t => t.key === key).run();
const base = extra => Object.assign({allowed:true, lock:'parked', lockHint:'', notice:null, currentId:null}, extra);

function videos(n) {
    return Array.from({length:n}, (_, i) => ({id:'Library:/v/' + i, type:'local', source:i % 3 ? 'Library' : 'USB',
        title:i === 1 ? 'A very long holiday film title that cannot possibly fit into one single row of the list' : 'Video ' + (i + 1),
        detail:(i % 3 ? 'Uploaded' : 'USB drive') + '  ·  ' + megabytes((i + 1) * 31e6)}));
}
function listModel(page, all, index, extra) {
    const list = media.pageOf(all, index, PAGE_SIZE);
    list.total = all.length;
    return base(Object.assign({page, list}, extra));
}

function checkText() {
    assert.strictEqual(ascii('Für Ärger: Straße – café'), 'Fuer Aerger: Strasse - cafe');
    assert.strictEqual(ascii('日本'), '??', 'no glyph: a visible placeholder, never an empty title');
    assert.strictEqual(clock(0), '0:00');
    assert.strictEqual(clock(75.9), '1:15');
    assert.strictEqual(clock(3723), '1:02:03');
    assert.strictEqual(megabytes(5 * 1048576), '5.0 MB');
    assert.strictEqual(megabytes(2048 * 1048576), '2.0 GB');
    assert.ok(Math.abs(VIDEO.w / VIDEO.h - 16 / 9) < 0.01, 'the picture keeps the decoder\'s 16:9');
    assert.ok(VIDEO.y + VIDEO.h <= H && VIDEO.x + VIDEO.w <= W);
}
function checkPaging() {
    const all = videos(19);
    assert.deepStrictEqual([media.pageOf(all, 0, 8).pages, media.pageOf(all, 2, 8).items.length], [3, 3]);
    assert.strictEqual(media.pageOf(all, 99, 8).page, 2, 'paging past the end stays on the last page');
    assert.strictEqual(media.pageOf(all, -4, 8).page, 0);
    assert.strictEqual(media.pageOf(all, 1, 8).start, 8, 'pages never overlap or shift');
    assert.deepStrictEqual(media.pageOf([], 3, 8), {page:0, pages:1, start:0, items:[]});
}
function checkLists() {
    let cv = render('library-empty', listModel(PAGE.LIBRARY, [], 0));
    assert.deepStrictEqual(keys(cv), ['EMPTY_CONNECT', 'RESCAN']);
    press(cv, 'EMPTY_CONNECT');
    assert.deepStrictEqual(calls.pop(), ['open', PAGE.CONNECTION]);

    const all = videos(19);
    cv = render('library', listModel(PAGE.LIBRARY, all, 0, {currentId:all[2].id}));
    assert.deepStrictEqual(keys(cv).slice(0, 8), [0, 1, 2, 3, 4, 5, 6, 7].map(i => 'ITEM_' + i));
    assert.ok(!keys(cv).includes('PREV'), 'first page: Previous is shown but cannot be pressed');
    assert.ok(keys(cv).includes('NEXT') && keys(cv).includes('RESCAN'));
    press(cv, 'ITEM_3');
    assert.deepStrictEqual(calls.pop(), ['play', all[3]]);
    press(cv, 'NEXT');
    assert.deepStrictEqual(calls.pop(), ['turn', 1]);
    cv = render('library-last', listModel(PAGE.LIBRARY, all, 2, {notice:{text:'Imported Holiday.mp4', level:'info'}}));
    assert.deepStrictEqual(keys(cv).slice(0, 3), ['ITEM_16', 'ITEM_17', 'ITEM_18']);
    assert.ok(keys(cv).includes('PREV') && !keys(cv).includes('NEXT'));
    const rects = cv.targets;
    rects.forEach((a, i) => rects.slice(i + 1).forEach(b => assert.ok(
        a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, a.key + ' overlaps ' + b.key)));

    const yt = [{id:'dQw4w9WgXcQ', type:'youtube', source:'YouTube', title:'Schöne Grüße aus München', detail:'3:33  ·  Online stream'},
        {id:'aaaaaaaaaaa', type:'youtube', source:'YouTube', title:'YouTube video aaaaaaaaaaa', detail:'Title appears after the first playback'}];
    cv = render('youtube', listModel(PAGE.YOUTUBE, yt, 0, {allowed:false, lock:'moving', lockHint:'Moving vehicle. Playback stopped.'}), THEMES.m_tricolour);
    assert.deepStrictEqual(keys(cv), ['ITEM_0', 'ITEM_1'], 'the YouTube list has no Rescan');
}
function checkPlayer() {
    const player = {title:'Schöne Grüße aus München: a long title that needs a second line to be readable', kind:'youtube',
        status:'Playing', error:'', position:83, duration:213, playing:true, paused:false, ended:false, busy:false, nearEnd:false, picture:true};
    let cv = render('player', base({page:PAGE.PLAYER, player}));
    assert.deepStrictEqual(calls.pop(), ['video', VIDEO.x, VIDEO.y, VIDEO.w, VIDEO.h]);
    assert.deepStrictEqual(keys(cv), ['SEEK_BACK', 'PLAY_PAUSE', 'SEEK_FORWARD', 'STOP', 'TO_LIST']);
    press(cv, 'SEEK_BACK'); assert.deepStrictEqual(calls.pop(), ['seek', -15]);
    press(cv, 'SEEK_FORWARD'); assert.deepStrictEqual(calls.pop(), ['seek', 15]);
    press(cv, 'PLAY_PAUSE'); assert.strictEqual(calls.pop()[0], 'toggle');
    press(cv, 'TO_LIST'); assert.strictEqual(calls.pop()[0], 'back');
    cv.targets.forEach(t => assert.ok(t.x >= VIDEO.x + VIDEO.w, t.key + ' must not cover the picture'));

    cv = render('player-starting', base({page:PAGE.PLAYER, player:Object.assign({}, player,
        {status:'Resolving YouTube stream...', position:0, duration:null, playing:false, busy:true, picture:false})}), THEMES.amber);
    assert.deepStrictEqual(keys(cv), ['STOP', 'TO_LIST'], 'nothing to pause or seek while the stream is prepared');
    calls.length = 0;
    cv = render('player-ended', base({page:PAGE.PLAYER, notice:{text:'That is past the end of the video.', level:'info'},
        player:Object.assign({}, player, {status:'Finished', position:213, playing:false, ended:true, nearEnd:true})}));
    assert.deepStrictEqual(keys(cv), ['PLAY_PAUSE', 'STOP', 'TO_LIST'], 'a finished video offers Play again, no seeking');
    calls.length = 0;
    cv = render('player-error', base({page:PAGE.PLAYER, allowed:false, lock:'no-signal', player:Object.assign({}, player,
        {status:'Decoder stopped', error:'/media/usb/film.mkv: Invalid data found when processing input', playing:false, picture:false})}));
    assert.deepStrictEqual(keys(cv), ['STOP', 'TO_LIST'], 'no Play while playback is locked');
    assert.ok(!calls.some(c => c[0] === 'video'), 'no video rectangle without a picture');
}
function checkConnection() {
    const rows = [
        {name:'Phone import', state:'ok', value:'172.16.222.1:18879  ·  ready'},
        {name:'Vehicle', state:'ok', value:'Parked  ·  playback allowed'},
        {name:'Video renderer', state:'ok', value:'Ready'},
        {name:'ffmpeg', state:'ok', value:'/usr/bin/ffmpeg'},
        {name:'yt-dlp', state:'wait', value:'Not installed: YouTube links cannot be played'},
        {name:'Internet', state:'wait', value:'Store uplink offline'},
        {name:'Audio', state:'off', value:'Off (Settings > Audio output)'}];
    const link = 'http://172.16.222.1:18879/?t=' + 'ab'.repeat(18);
    let cv = render('connection', base({page:PAGE.CONNECTION, connection:{ready:true, link, blocked:'', rows}}));
    assert.deepStrictEqual(keys(cv), ['RECHECK', 'LOGS']);
    press(cv, 'LOGS'); assert.deepStrictEqual(calls.pop(), ['open', PAGE.LOGS]);
    cv = render('connection-locked', base({page:PAGE.CONNECTION, notice:{text:'Checked again: 3 videos, ffmpeg found, yt-dlp missing.', level:'info'},
        connection:{ready:false, link:null, blocked:'The MGU has no Wi-Fi address yet. Connect the phone to the car\'s Wi-Fi.',
            rows:[{name:'Phone import', state:'bad', value:'The MGU has no Wi-Fi address yet.'}].concat(rows.slice(1))}}));
    assert.deepStrictEqual(keys(cv), ['RECHECK', 'LOGS']);
    const events = Array.from({length:10}, (_, i) => ({at:'2026-11-16T08:15:' + String(10 + i) + '.000Z',
        level:i === 4 ? 'ERROR' : i === 7 ? 'WARN' : 'INFO', event:'decoder.exited', detail:'code=0 frames=' + i * 100}));
    cv = render('logs', base({page:PAGE.LOGS, connection:{ready:true, link, blocked:'', rows},
        logs:{link:link.replace('/?t=', '/diagnostics.json?t='), events, total:212}}));
    assert.deepStrictEqual(keys(cv), ['LOGS_BACK']);
    press(cv, 'LOGS_BACK'); assert.deepStrictEqual(calls.pop(), ['open', PAGE.CONNECTION]);
}
function checkContrast() {
    // Ice White selects in pure white: a filled button must not get white text on it.
    assert.strictEqual(ui.inkOn('#ffffff'), '#05070a');
    assert.strictEqual(ui.inkOn(THEMES.m_tricolour.sel), '#ffffff');
}

checkText(); checkPaging(); checkLists(); checkPlayer(); checkConnection(); checkContrast();
console.log('Video Hub UI tests passed: text folding, paging, list, player, connection and log pages');
