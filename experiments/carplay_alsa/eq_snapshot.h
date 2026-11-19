#ifndef MGU_EQ_SNAPSHOT_H
#define MGU_EQ_SNAPSHOT_H
/*
 * Reader for the versioned DSP snapshot written by native/equalizer-dsp/snapshot.js.
 * Layout v1 (little endian, 204 bytes) is documented there. Parsing is pure and
 * allocation-free; reading a file performs I/O and must never run in an audio callback.
 */
#include <stddef.h>
#include <stdint.h>
#include "eq_dsp.h"

#define MGU_EQ_SNAPSHOT_SIZE 204
#define MGU_EQ_SNAPSHOT_LAYOUT 1

enum {
    MGU_EQ_SNAP_OK = 0,
    MGU_EQ_SNAP_ESIZE = -1,
    MGU_EQ_SNAP_ELAYOUT = -2,
    MGU_EQ_SNAP_ECRC = -3,
    MGU_EQ_SNAP_EFLAGS = -4,
    MGU_EQ_SNAP_ECONFIG = -5,
    MGU_EQ_SNAP_EIO = -6,
    MGU_EQ_SNAP_ENOENT = -7
};

typedef struct {
    uint32_t revision;
    MguEqConfig config;
} MguEqSnapshot;

uint32_t mgu_eq_crc32(const unsigned char *data, size_t len);
int mgu_eq_snapshot_parse(const unsigned char *data, size_t len, MguEqSnapshot *out);
/* Test/tooling helper: serialises exactly like snapshot.js (buffer must hold 204 bytes). */
int mgu_eq_snapshot_encode(const MguEqConfig *config, uint32_t revision, unsigned char *out);
/* Non-realtime: opens without following symlinks, requires a regular 204-byte file. */
int mgu_eq_snapshot_read(const char *path, MguEqSnapshot *out);

#endif
