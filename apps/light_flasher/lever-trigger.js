
'use strict';

const DEFAULTS = Object.freeze({
  armOffMs: 1000,
  maxFirstPullMs: 1500,
  settleOffMs: 250,
  staleMs: 2500,
  cooldownMs: 1000
});

class LeverTrigger {
  constructor(now = Date.now, opts = {}) {
    this.now = now;
    this.opts = { ...DEFAULTS, ...opts };
    this.enabled = false;
    this.state = 'disabled';
    this.offSince = null;
    this.onSince = null;
    this.firstPullAt = null;
    this.cooldownUntil = 0;
    this.lastPulseMs = null;
    this.events = [];
    this.triggers = 0;
    this.rejected = 0;
    this.lastReason = 'Lever trigger off';
    this.runActive = false;
  }

  setEnabled(on) {
    on = on === true;
    if (on !== this.enabled) {
      this.enabled = on;
      this.reset(on ? 'Waiting for first pull' : 'Lever trigger off');
    }
  }

  reset(reason) {
    this.state = this.enabled ? 'waitOff' : 'disabled';
    this.offSince = null;
    this.onSince = null;
    this.firstPullAt = null;
    this.runActive = false;
    this.lastReason = reason;
  }

  record(kind, extra = {}) {
    this.events.push({
      at: new Date(this.now()).toISOString(),
      kind,
      ...extra
    });
    if (this.events.length > 30) this.events.shift();
  }

  runStarted() {
    this.runActive = true;
    this.state = 'running';
    this.lastReason = 'Light sequence running while lever is held';
  }

  runEnded() {
    this.runActive = false;
    this.cooldownUntil = this.now() + this.opts.cooldownMs;
    this.reset('Cooldown after release');
  }

  update(status, statusAt, allowed) {
    const t = this.now();
    const o = this.opts;

    if (!this.enabled || !allowed) {
      if (this.runActive) return 'stop';
      this.reset('Blocked or disabled');
      return null;
    }

    if (
      (status !== 'EIN' && status !== 'AUS') ||
      !Number.isFinite(statusAt) ||
      t - statusAt > o.staleMs
    ) {
      if (this.runActive) return 'stop';
      this.reset('OEM light status unknown or stale');
      return null;
    }

    if (this.runActive) {
      if (status === 'AUS') {
        this.record('release');
        return 'stop';
      }
      return null;
    }

    if (t < this.cooldownUntil) return null;

    switch (this.state) {
      case 'waitOff':
        if (status === 'AUS') {
          if (this.offSince === null) this.offSince = t;
          if (t - this.offSince >= o.armOffMs) {
            this.state = 'firstReady';
            this.lastReason = 'Ready for first short pull';
          }
        } else {
          this.offSince = null;
        }
        return null;

      case 'firstReady':
        if (status === 'EIN') {
          this.onSince = t;
          this.state = 'firstPull';
        }
        return null;

      case 'firstPull':
        if (status === 'AUS') {
          this.lastPulseMs = t - this.onSince;

          if (this.lastPulseMs > o.maxFirstPullMs) {
            this.rejected++;
            this.record('rejected', {
              durationMs: this.lastPulseMs,
              reason: 'First pull held too long'
            });
            this.reset('First pull too long; re-arm');
            return null;
          }

          this.state = 'waitSecond';
          this.offSince = t;
          this.lastReason = 'First pull accepted; pull again and hold';
        } else if (t - this.onSince > o.maxFirstPullMs) {
          this.rejected++;
          this.reset('First pull too long; re-arm');
        }
        return null;

      case 'waitSecond':
        if (status === 'EIN') {
          if (t - this.offSince < o.settleOffMs) {
            this.rejected++;
            this.reset('Second pull too soon; re-arm');
            return null;
          }

          this.state = 'running';
          this.runActive = true;
          this.triggers++;
          this.record('trigger', { firstPullMs: this.lastPulseMs });
          this.lastReason = 'Second pull held; sequence started';
          return 'start';
        }
        return null;

      default:
        return null;
    }
  }

  snapshot() {
    return {
      enabled: this.enabled,
      state: this.state,
      reason: this.lastReason,
      triggers: this.triggers,
      rejected: this.rejected,
      lastPulseMs: this.lastPulseMs,
      runActive: this.runActive,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - this.now()),
      limits: { ...this.opts },
      events: this.events.slice()
    };
  }
}

module.exports = { LeverTrigger, DEFAULTS };
