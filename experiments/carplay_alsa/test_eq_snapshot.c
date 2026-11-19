/* Cross-language snapshot test: reads fixtures written by tests/equalizer_snapshot.test.js. */
#define _GNU_SOURCE
#include "eq_snapshot.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static size_t load(const char *dir, const char *name, unsigned char *buf, size_t cap) {
    char path[512];
    snprintf(path, sizeof path, "%s/%s", dir, name);
    FILE *f = fopen(path, "rb");
    assert(f);
    const size_t n = fread(buf, 1, cap, f);
    fclose(f);
    return n;
}
int main(int argc, char **argv) {
    assert(argc == 2);
    const char *dir = argv[1];
    unsigned char node[MGU_EQ_SNAPSHOT_SIZE + 8], mine[MGU_EQ_SNAPSHOT_SIZE];
    MguEqSnapshot s;

    assert(mgu_eq_crc32((const unsigned char *)"123456789", 9) == 0xCBF43926u);

    /* Node fixture "boost": revision 42, enabled, no auto headroom, preamp -1.5 dB. */
    assert(load(dir, "boost.snapshot", node, sizeof node) == MGU_EQ_SNAPSHOT_SIZE);
    assert(mgu_eq_snapshot_parse(node, MGU_EQ_SNAPSHOT_SIZE, &s) == MGU_EQ_SNAP_OK);
    assert(s.revision == 42 && s.config.enabled == 1 && s.config.auto_headroom == 0);
    assert(s.config.preamp_db == -1.5);
    assert(s.config.bands[0].frequency_hz == 100 && s.config.bands[0].gain_db == 6 && s.config.bands[0].q == 1);
    assert(s.config.bands[3].gain_db == -3.5);
    assert(s.config.bands[6].frequency_hz == 12000 && s.config.bands[6].q == 2.25);
    /* The C encoder is byte-identical to snapshot.js. */
    assert(mgu_eq_snapshot_encode(&s.config, 42, mine) == MGU_EQ_SNAP_OK);
    assert(memcmp(mine, node, MGU_EQ_SNAPSHOT_SIZE) == 0);

    assert(load(dir, "neutral.snapshot", node, sizeof node) == MGU_EQ_SNAPSHOT_SIZE);
    assert(mgu_eq_snapshot_parse(node, MGU_EQ_SNAPSHOT_SIZE, &s) == MGU_EQ_SNAP_OK);
    MguEqConfig defaults;
    mgu_eq_defaults(&defaults);
    assert(s.revision == 0 && !s.config.enabled && s.config.auto_headroom);
    for (int i = 0; i < MGU_EQ_BANDS; ++i)
        assert(s.config.bands[i].frequency_hz == defaults.bands[i].frequency_hz && s.config.bands[i].gain_db == 0);

    /* Rejections. */
    assert(load(dir, "boost.snapshot", node, sizeof node) == MGU_EQ_SNAPSHOT_SIZE);
    assert(mgu_eq_snapshot_parse(node, 200, &s) == MGU_EQ_SNAP_ESIZE);
    node[40] ^= 1;
    assert(mgu_eq_snapshot_parse(node, MGU_EQ_SNAPSHOT_SIZE, &s) == MGU_EQ_SNAP_ECRC);
    node[40] ^= 1;
    node[8] = 2;
    assert(mgu_eq_snapshot_parse(node, MGU_EQ_SNAPSHOT_SIZE, &s) == MGU_EQ_SNAP_ELAYOUT);
    MguEqConfig bad = defaults;
    bad.bands[2].gain_db = 12;
    assert(mgu_eq_snapshot_encode(&bad, 1, mine) == MGU_EQ_SNAP_OK);
    mine[20] |= 8; /* unknown flag, then re-seal the CRC */
    {
        const uint32_t crc = mgu_eq_crc32(mine, 200);
        for (int i = 0; i < 4; ++i) mine[200 + i] = (unsigned char)(crc >> (8 * i));
    }
    assert(mgu_eq_snapshot_parse(mine, MGU_EQ_SNAPSHOT_SIZE, &s) == MGU_EQ_SNAP_EFLAGS);
    bad.bands[2].gain_db = 12.5;
    assert(mgu_eq_snapshot_encode(&bad, 1, mine) == MGU_EQ_SNAP_ECONFIG);

    /* File reader: missing, symlink (never followed), wrong size. */
    char path[512], link_path[512];
    snprintf(path, sizeof path, "%s/missing.snapshot", dir);
    assert(mgu_eq_snapshot_read(path, &s) == MGU_EQ_SNAP_ENOENT);
    snprintf(path, sizeof path, "%s/boost.snapshot", dir);
    assert(mgu_eq_snapshot_read(path, &s) == MGU_EQ_SNAP_OK && s.revision == 42);
    snprintf(link_path, sizeof link_path, "%s/link.snapshot", dir);
    unlink(link_path);
    assert(symlink(path, link_path) == 0);
    assert(mgu_eq_snapshot_read(link_path, &s) == MGU_EQ_SNAP_EIO);
    unlink(link_path);
    snprintf(path, sizeof path, "%s/short.snapshot", dir);
    FILE *f = fopen(path, "wb");
    assert(f && fwrite("MGEQSNP1", 1, 8, f) == 8);
    fclose(f);
    assert(mgu_eq_snapshot_read(path, &s) == MGU_EQ_SNAP_ESIZE);
    unlink(path);
    puts("PASS: snapshot v1 parser matches snapshot.js byte-for-byte; corrupt, oversized, unknown-flag, symlinked and missing files rejected");
    return 0;
}
