/*
 * faxmodem – kapselt spandsp (T.30 über G.711-Audio) als Hilfsprozess für SIPFunk.
 *
 *   faxmodem send <datei.tif> [kennung] [kopfzeile] [maxbit]
 *   faxmodem recv <datei.tif> [kennung]
 *
 * Protokoll (Lockstep, 8 kHz, 16 bit little endian, 20 ms = 160 Samples):
 *   stdin:  je Frame 320 Byte Audio vom Gegenüber
 *   stdout: je gelesenem Frame genau 320 Byte Audio zum Gegenüber
 *   stderr: Protokollzeilen; zum Schluss genau eine Zeile
 *           "RESULT <code> <seiten> <text>"   (code 0 = Erfolg)
 * stdin-EOF = aufgelegt: dann t30_terminate (die FRITZ!Box legt nach DCN sofort auf,
 * bevor spandsp Phase E erreicht – ohne terminate gälte ein zugestelltes Fax als fehlgeschlagen).
 *
 * Lizenz: AGPL-3.0-or-later (wie SIPFunk); spandsp steht unter LGPL-2.1.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <inttypes.h>
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#endif
#define SPANDSP_EXPOSE_INTERNAL_STRUCTURES
#include <spandsp.h>

#define FRAME 160

static int done = 0;
static int result = -1;
static int pages = 0;

static void on_log(int level, const char *text) {
    (void) level;
    fprintf(stderr, "LOG %s", text);
    size_t n = strlen(text);
    if (n == 0 || text[n - 1] != '\n') fputc('\n', stderr);
}

static int on_phase_b(t30_state_t *s, void *ud, int r) {
    (void) ud; (void) r;
    char ident[64] = "";
    const char *id = t30_get_rx_ident(s);
    if (id) snprintf(ident, sizeof ident, "%s", id);
    fprintf(stderr, "PHASE B gegenstelle=\"%s\"\n", ident);
    return T30_ERR_OK;
}

static int on_phase_d(t30_state_t *s, void *ud, int r) {
    (void) ud; (void) r;
    t30_stats_t st;
    t30_get_transfer_statistics(s, &st);
    pages = st.pages_tx > st.pages_rx ? st.pages_tx : st.pages_rx;
    fprintf(stderr, "PHASE D seiten=%d bitrate=%d ecm=%d\n", pages, st.bit_rate, st.error_correcting_mode);
    return T30_ERR_OK;
}

static void on_phase_e(t30_state_t *s, void *ud, int code) {
    (void) ud;
    t30_stats_t st;
    t30_get_transfer_statistics(s, &st);
    pages = st.pages_tx > st.pages_rx ? st.pages_tx : st.pages_rx;
    result = code;
    done = 1;
}

int main(int argc, char **argv) {
    if (argc < 3 || (strcmp(argv[1], "send") != 0 && strcmp(argv[1], "recv") != 0)) {
        fprintf(stderr, "Aufruf: faxmodem send|recv <datei.tif> [kennung] [kopfzeile] [maxbit]\n");
        return 2;
    }
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    setvbuf(stderr, NULL, _IOLBF, 0);
    const int sending = strcmp(argv[1], "send") == 0;
    const char *file = argv[2];
    const char *ident = argc > 3 ? argv[3] : "";
    const char *header = argc > 4 ? argv[4] : "";
    const int maxbit = argc > 5 ? atoi(argv[5]) : 14400;

    fax_state_t *fax = fax_init(NULL, sending);
    if (!fax) { fprintf(stderr, "RESULT -1 0 fax_init fehlgeschlagen\n"); return 1; }
    t30_state_t *t30 = fax_get_t30_state(fax);

    logging_state_t *lg = fax_get_logging_state(fax);
    span_log_set_level(lg, SPAN_LOG_SHOW_SEVERITY | SPAN_LOG_SHOW_PROTOCOL | SPAN_LOG_FLOW);
    span_log_set_message_handler(lg, on_log);
    lg = t30_get_logging_state(t30);
    span_log_set_level(lg, SPAN_LOG_SHOW_SEVERITY | SPAN_LOG_SHOW_PROTOCOL | SPAN_LOG_FLOW);
    span_log_set_message_handler(lg, on_log);

    fax_set_transmit_on_idle(fax, 1);   /* auch in Pausen Audio liefern: der RTP-Strom darf nie abreißen */
    if (*ident) t30_set_tx_ident(t30, ident);
    if (*header) t30_set_tx_page_header_info(t30, header);
    t30_set_ecm_capability(t30, 1);
    int modems = T30_SUPPORT_V27TER | T30_SUPPORT_V29;
    if (maxbit >= 14400) modems |= T30_SUPPORT_V17;
    if (maxbit < 9600) modems = T30_SUPPORT_V27TER;
    t30_set_supported_modems(t30, modems);
    if (sending) t30_set_tx_file(t30, file, -1, -1);
    else t30_set_rx_file(t30, file, -1);
    t30_set_phase_b_handler(t30, on_phase_b, NULL);
    t30_set_phase_d_handler(t30, on_phase_d, NULL);
    t30_set_phase_e_handler(t30, on_phase_e, NULL);

    int16_t rx[FRAME], tx[FRAME];
    while (!done) {
        size_t got = fread(rx, sizeof(int16_t), FRAME, stdin);
        if (got < FRAME) {           /* aufgelegt */
            fprintf(stderr, "LOG stdin geschlossen: Verbindung beendet\n");
            t30_terminate(t30);
            break;
        }
        fax_rx(fax, rx, FRAME);
        int n = fax_tx(fax, tx, FRAME);
        if (n < FRAME) memset(tx + (n < 0 ? 0 : n), 0, sizeof(int16_t) * (FRAME - (n < 0 ? 0 : n)));
        fwrite(tx, sizeof(int16_t), FRAME, stdout);
        fflush(stdout);
    }
    if (!done) { result = T30_ERR_CALLDROPPED; }
    fprintf(stderr, "RESULT %d %d %s\n", result, pages, t30_completion_code_to_str(result));
    fax_release(fax);
    fax_free(fax);
    return result == T30_ERR_OK ? 0 : 1;
}
