/*
 * DSP snapshot v1 reader (counterpart of native/equalizer-dsp/snapshot.js).
 * Copyright 2026 NamelsMissing contributors. SPDX-License-Identifier: MIT
 */
#define _GNU_SOURCE
#include "eq_snapshot.h"
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static const char MAGIC[8] = {'M', 'G', 'E', 'Q', 'S', 'N', 'P', '1'};
#define CRC_OFFSET 200

uint32_t mgu_eq_crc32(const unsigned char *data, size_t len) {
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; ++i) {
        c ^= data[i];
        for (int k = 0; k < 8; ++k) c = (c & 1u) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
    }
    return c ^ 0xFFFFFFFFu;
}
static uint32_t get_u32(const unsigned char *p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
static void put_u32(unsigned char *p, uint32_t v) {
    for (int i = 0; i < 4; ++i) p[i] = (unsigned char)(v >> (8 * i));
}
static double get_f64(const unsigned char *p) {
    uint64_t bits = 0;
    for (int i = 7; i >= 0; --i) bits = bits << 8 | p[i];
    double v;
    memcpy(&v, &bits, sizeof v);
    return v;
}
static void put_f64(unsigned char *p, double v) {
    uint64_t bits;
    memcpy(&bits, &v, sizeof bits);
    for (int i = 0; i < 8; ++i) p[i] = (unsigned char)(bits >> (8 * i));
}

int mgu_eq_snapshot_parse(const unsigned char *data, size_t len, MguEqSnapshot *out) {
    if (!data || !out || len != MGU_EQ_SNAPSHOT_SIZE) return MGU_EQ_SNAP_ESIZE;
    if (memcmp(data, MAGIC, 8) || get_u32(data + 8) != MGU_EQ_SNAPSHOT_LAYOUT ||
        get_u32(data + 12) != MGU_EQ_SNAPSHOT_SIZE) return MGU_EQ_SNAP_ELAYOUT;
    if (get_u32(data + CRC_OFFSET) != mgu_eq_crc32(data, CRC_OFFSET)) return MGU_EQ_SNAP_ECRC;
    const uint32_t flags = get_u32(data + 20);
    if (flags & ~3u) return MGU_EQ_SNAP_EFLAGS;
    MguEqSnapshot s;
    memset(&s, 0, sizeof s);
    s.revision = get_u32(data + 16);
    s.config.enabled = (flags & 1u) ? 1 : 0;
    s.config.auto_headroom = (flags & 2u) ? 1 : 0;
    s.config.preamp_db = get_f64(data + 24);
    for (int i = 0; i < MGU_EQ_BANDS; ++i) {
        const unsigned char *b = data + 32 + i * 24;
        s.config.bands[i].frequency_hz = get_f64(b);
        s.config.bands[i].gain_db = get_f64(b + 8);
        s.config.bands[i].q = get_f64(b + 16);
    }
    /* Same limits as core.js; every band is far below Nyquist at 44.1 kHz and up. */
    if (!mgu_eq_valid(&s.config, 44100)) return MGU_EQ_SNAP_ECONFIG;
    *out = s;
    return MGU_EQ_SNAP_OK;
}

int mgu_eq_snapshot_encode(const MguEqConfig *config, uint32_t revision, unsigned char *out) {
    if (!config || !out || !mgu_eq_valid(config, 44100)) return MGU_EQ_SNAP_ECONFIG;
    memset(out, 0, MGU_EQ_SNAPSHOT_SIZE);
    memcpy(out, MAGIC, 8);
    put_u32(out + 8, MGU_EQ_SNAPSHOT_LAYOUT);
    put_u32(out + 12, MGU_EQ_SNAPSHOT_SIZE);
    put_u32(out + 16, revision);
    put_u32(out + 20, (config->enabled ? 1u : 0u) | (config->auto_headroom ? 2u : 0u));
    put_f64(out + 24, config->preamp_db);
    for (int i = 0; i < MGU_EQ_BANDS; ++i) {
        unsigned char *b = out + 32 + i * 24;
        put_f64(b, config->bands[i].frequency_hz);
        put_f64(b + 8, config->bands[i].gain_db);
        put_f64(b + 16, config->bands[i].q);
    }
    put_u32(out + CRC_OFFSET, mgu_eq_crc32(out, CRC_OFFSET));
    return MGU_EQ_SNAP_OK;
}

int mgu_eq_snapshot_read(const char *path, MguEqSnapshot *out) {
    if (!path || !out) return MGU_EQ_SNAP_EIO;
    const int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) return errno == ENOENT ? MGU_EQ_SNAP_ENOENT : MGU_EQ_SNAP_EIO;
    unsigned char buf[MGU_EQ_SNAPSHOT_SIZE + 1];
    struct stat st;
    int rc = MGU_EQ_SNAP_EIO;
    if (fstat(fd, &st) == 0 && S_ISREG(st.st_mode)) {
        if (st.st_size != MGU_EQ_SNAPSHOT_SIZE) rc = MGU_EQ_SNAP_ESIZE;
        else {
            size_t got = 0;
            while (got < sizeof buf) {
                const ssize_t n = read(fd, buf + got, sizeof buf - got);
                if (n < 0 && errno == EINTR) continue;
                if (n <= 0) break;
                got += (size_t)n;
            }
            rc = mgu_eq_snapshot_parse(buf, got, out);
        }
    }
    close(fd);
    return rc;
}
