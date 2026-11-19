#ifndef MGU_CARPLAY_LIVE_FILTER_H
#define MGU_CARPLAY_LIVE_FILTER_H
#include <stdint.h>
#include "eq_dsp.h"
/* Offline-only test API. No system daemon changes or vehicle deployment. */
typedef struct {
    int target_open, negotiated, armed, format, access;
    unsigned channels, rate;
    uint64_t intercepted_writes, processed_frames, bypassed_frames;
    uint64_t mmap_writes, unsupported_calls, partial_writes;
    /* Snapshot bridge (non-realtime producer -> audio thread). */
    int bridge_active;      /* bridge thread running or poll API used */
    int applied_valid;      /* last applied snapshot was valid (else: fail-safe bypass) */
    uint32_t applied_revision;
    uint64_t bridge_polls, bridge_publishes, bridge_rejects, bridge_applies;
    int bridge_last_error;  /* MGU_EQ_SNAP_* of the last poll */
} MguCarplayLiveStats;
void mgu_cp_live_snapshot(MguCarplayLiveStats *out);
int mgu_cp_live_arm(const MguEqConfig *config);
int mgu_cp_live_reconfigure(const MguEqConfig *config);
void mgu_cp_live_disarm(void);

/*
 * Snapshot bridge. A non-realtime producer reads the DSP service snapshot file
 * (native/equalizer-dsp/snapshot.js) and hands validated configurations to the
 * audio thread through a wait-free triple buffer. The audio thread never takes
 * the bridge lock and never performs I/O; it only consumes the newest slot at
 * the start of a target write and crossfades (25 ms) into it.
 *
 * Valid + enabled  -> arm (fade in from bypass) or reconfigure
 * Valid + disabled -> fade to bypass, then disarm (bit-exact pass-through)
 * Missing/corrupt  -> same as disabled (fail-safe); deleting the file is a rollback
 *
 * Producers: either the bridge thread or explicit poll calls, never both.
 * If MGU_CP_LIVE_SNAPSHOT is set in the host environment, opening the target
 * PCM starts the bridge thread for that path (manual opt-in gate).
 */
int mgu_cp_live_bridge_poll(const char *path);  /* returns MGU_EQ_SNAP_* of the read */
int mgu_cp_live_bridge_start(const char *path, unsigned interval_ms);
void mgu_cp_live_bridge_stop(void);
#endif
