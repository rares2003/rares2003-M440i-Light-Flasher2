'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ManualFlash = require('../apps/light_flasher/manual-flash');
const Timing = require('../apps/light_flasher/timing');

const INDEX = { 0x43: [0x0F, 0x26, 0xC0], 0x44: [0x0F, 0x26, 0xD0] };
const hex = (a) => a.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');

// Simulated FLM pair on a fake clock. opts.pwm0Off=false: PWM 0 leaves the LEDs on.
// opts.rejectRestart: a START while the routine runs is answered with NRC 0x24.
function rig(opts = {}) {
    let t = 0;
    const state = { 0x43: { running: false, pwm: 0 }, 0x44: { running: false, pwm: 0 } };
    const log = [];
    const diag = {
        available: true,
        async physical(addr, sid, data) {
            t += opts.rttMs || 120;
            const s = state[addr];
            log.push(hex([addr, sid, ...data]));
            if (sid === 0x22 && data[0] === 0xF1) return [0x62, 0xF1, 0x50, ...INDEX[addr]];
            if (sid === 0x22 && data[0] === 0xD6) {
                const rec = [];
                for (let ch = 0; ch < 15; ch++) {
                    const lit = ch === 7 && s.running && (s.pwm > 0 || opts.pwm0Off === false);
                    rec.push(lit ? 60 : 0, lit ? 0x03 : 0, lit ? 0xE8 : 0, lit ? 13 : 0, 0);
                }
                return [0x62, 0xD6, 0xDB, ...rec];
            }
            if (sid === 0x31 && data[0] === 0x01) {
                if (opts.rejectRestart && s.running) return [0x7F, 0x31, 0x24];
                s.running = true; s.pwm = data[4]; return [0x71, 0x01, 0xA5, 0x4B];
            }
            if (sid === 0x31 && data[0] === 0x02) { s.running = false; s.pwm = 0; return [0x71, 0x02, 0xA5, 0x4B]; }
            if (sid === 0x10) return [0x50, data[0]];
            return [0x7F, sid, 0x11];
        },
    };
    const lf = new ManualFlash(diag, { warn() {}, info() {} }, async (ms) => { t += ms; }, () => t, null);
    return { lf, log, state, now: () => t };
}
const req = (fast, extra = {}) => ({ pattern: 'alternate', intervalMs: 100, durationMs: 2000, fast, ...extra });

test('fast mode: PWM 0 instead of STOP between pulses, STOP only at the end', async () => {
    const r = rig();
    await r.lf.run(req(true), () => true);
    const midStops = r.log.slice(0, -4).filter((x) => x.endsWith('3102A54B'));
    assert.equal(midStops.length, 0, 'no STOP while the pattern runs');
    assert.ok(r.log.filter((x) => x.includes('3101A54B080001')).length > 4, 'PWM 0 used to switch off');
    assert.deepEqual(r.log.slice(-4), ['433102A54B', '443102A54B', '431001', '441001']);
    assert.deepEqual(r.lf.fast.offVerified, { left: true, right: true });
    assert.equal(r.log.filter((x) => x.endsWith('22D6DB')).length, 4, '2 preflight + 1 OFF check per side');
    assert.equal(r.state[0x43].running || r.state[0x44].running, false);
    assert.equal(r.lf.config.mode, 'fast-test');
});

test('fast mode is faster than standard on the same transport', async () => {
    const gap = async (fast) => {
        const r = rig();
        await r.lf.run(req(fast), () => true);
        return Timing.summarize(r.lf.trace).startDispatchGaps.meanMs;
    };
    const std = await gap(false), fast = await gap(true);
    assert.ok(fast < std - 100, `fast ${fast} ms vs standard ${std} ms`);
    const r = rig();
    await r.lf.run(req(true), () => true);
    assert.ok(Timing.summarize(r.lf.trace).pwm0OffResponses.count > 0);
});

test('fast mode stops with STOP when PWM 0 does not switch off', async () => {
    const r = rig({ pwm0Off: false });
    await assert.rejects(r.lf.run(req(true), () => true), /PWM 0 not confirmed as OFF/);
    assert.equal(r.lf.fast.offVerified.left, false);
    // only the left side was ever switched on, so only it needs STOP; both return to default session
    assert.deepEqual(r.log.slice(-3), ['433102A54B', '431001', '441001']);
    assert.equal(r.state[0x43].running, false);
    assert.equal(r.log.filter((x) => x.includes('3101A54B083C01')).length, 1, 'only the first pulse ran');
});

test('fast mode stops cleanly when a restart is rejected', async () => {
    const r = rig({ rejectRestart: true });
    await assert.rejects(r.lf.run(req(true), () => true), /reply 7F3124/);
    assert.equal(r.state[0x43].running || r.state[0x44].running, false);
    assert.equal(r.lf.cleanupUnconfirmed, false);
});

test('standard mode unchanged: STOP after every pulse', async () => {
    const r = rig();
    await r.lf.run(req(false), () => true);
    assert.equal(r.lf.fast, null);
    assert.equal(r.log.filter((x) => x.includes('3101A54B0800')).length, 0);
    const starts = r.log.filter((x) => x.includes('3101A54B083C01')).length;
    const stops = r.log.filter((x) => x.endsWith('3102A54B')).length;
    assert.ok(stops >= starts);
});

test('fast setting defaults OFF', () => {
    const app = require('../apps/light_flasher/app.json');
    assert.equal(app.settings.find((x) => x.key === 'fastTest').default, false);
});
