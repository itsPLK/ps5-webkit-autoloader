/*
 * HTTP Server - serves the cached frontend files from the generated file
 * registry and handles the /install route (installs the homescreen app once
 * the cache is complete and shuts the server down).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>
#include <microhttpd.h>

#include "wkali.h"
#include "http_server.h"
#include "file_registry.h"
#include "inflate.h"
#include "app_installer.h"
#include "webkit_cleaner.h"
#include "simulate_corrupt.h"

/* CORS is intentionally `*`: the installer page is also served from the PC
 * host (manuals.playstation.net over HTTPS), which cross-origin XHRs this
 * on-console server (http://127.0.0.1:18181) for /version and
 * /install. The server binds 127.0.0.1 only and lives for seconds.
 * Do not restrict unless that flow changes. */
#define CORS_ORIGIN "*"

/* Shared flag — set to 0 by a successful /install or /exit, read by the main loop.
 * atomic so the store in a connection thread is visible to the main loop. */
atomic_int http_keep_running = 1;

/* Set to 1 only when /install succeeds so shutdown knows to notify success. */
atomic_int install_completed = 0;

/* Set to 1 by a successful /clear-webkit-data, read by the main loop to
 * re-launch the browser. atomic so the store in a connection thread is
 * visible to the main loop. */
atomic_int webkit_data_cleared = 0;

static void add_cors_headers(struct MHD_Response *resp) {
    MHD_add_response_header(resp, "Access-Control-Allow-Origin", CORS_ORIGIN);
}

static const FileEntry *registry_lookup(const char *url) {
    if (strcmp(url, ROUTE_INDEX) == 0)
        return file_registry_find(ROUTE_INDEX_HTML);
    return file_registry_find(url);
}

enum MHD_Result http_on_request(void *cls, struct MHD_Connection *conn,
                                const char *url, const char *method,
                                const char *version, const char *upload_data,
                                size_t *upload_data_size, void **con_cls) {

    (void)cls;
    (void)version;
    (void)upload_data;
    (void)upload_data_size;
    float fw = 0.0f;
    const char *ua = MHD_lookup_connection_value(conn, MHD_HEADER_KIND, "User-Agent");
    if (ua) {
        const char *ps5 = strstr(ua, "PlayStation 5/");
        if (ps5) fw = strtof(ps5 + 14, NULL);
    }

    /* Handle CORS Preflight (OPTIONS) */
    if (strcmp(method, "OPTIONS") == 0) {
        struct MHD_Response *resp =
            MHD_create_response_from_buffer(0, NULL, MHD_RESPMEM_PERSISTENT);
        add_cors_headers(resp);
        MHD_add_response_header(resp, "Access-Control-Allow-Methods",
                                "GET, OPTIONS");
        MHD_add_response_header(resp, "Access-Control-Allow-Headers",
                                "Content-Type");
        enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_OK, resp);
        MHD_destroy_response(resp);
        return ret;
    }

    /* ── Initial call for a new request ────────────────────── */
    if (*con_cls == NULL) {
        *con_cls = (void *)1;
        return MHD_YES;
    }

    struct MHD_Response *resp = NULL;
    int http_status = MHD_HTTP_OK;

    if (strcmp(url, ROUTE_INSTALL) == 0) {
        /* Called by the installer page once the AppCache is fully cached. The
         * homescreen app is only installed/updated now — never on startup —
         * so a shortcut is never created for a partial cache. On failure the
         * server stays up and the page tells the user to re-run the installer. */
        int err = wkali_install_app_if_needed();
        if (err == 0) {
            wkali_log("[WKALI] App installed. Stopping server...\n");
            resp = MHD_create_response_from_buffer(strlen("OK"), (void *)"OK",
                                                   MHD_RESPMEM_PERSISTENT);
            MHD_add_response_header(resp, "Content-Type", "text/plain");
            http_status = MHD_HTTP_OK;
            atomic_store(&install_completed, 1);
            atomic_store(&http_keep_running, 0);
        } else {
            wkali_log("[WKALI] App install failed (%d). Staying up.\n", err);
            const char *fail = "Install failed";
            resp = MHD_create_response_from_buffer(strlen(fail), (void *)fail,
                                                   MHD_RESPMEM_PERSISTENT);
            MHD_add_response_header(resp, "Content-Type", "text/plain");
            http_status = MHD_HTTP_INTERNAL_SERVER_ERROR;
        }
    } else if (strcmp(url, ROUTE_EXIT) == 0) {
        wkali_log("[WKALI] Exit requested by client. Stopping server...\n");
        resp = MHD_create_response_from_buffer(2, (void *)"OK",
                                               MHD_RESPMEM_PERSISTENT);
        MHD_add_response_header(resp, "Content-Type", "text/plain");
        http_status = MHD_HTTP_OK;
        atomic_store(&http_keep_running, 0);
    } else if (strcmp(url, ROUTE_VERSION) == 0) {
        resp = MHD_create_response_from_buffer(strlen(WKAL_FULL_VERSION),
                                               (void *)WKAL_FULL_VERSION,
                                               MHD_RESPMEM_PERSISTENT);
        MHD_add_response_header(resp, "Content-Type", "text/plain");
        extern int sceUserServiceGetForegroundUser(int *);
        int uid = -1;
        if (sceUserServiceGetForegroundUser(&uid) == 0 && uid > 0) {
            char uid_hdr[32];
            snprintf(uid_hdr, sizeof(uid_hdr), "%08x", (unsigned int)uid);
            MHD_add_response_header(resp, "X-User-Id", uid_hdr);
        }
    } else if (strcmp(url, "/logs") == 0) {
        const char *pos_str = MHD_lookup_connection_value(conn, MHD_GET_ARGUMENT_KIND, "pos");
        size_t pos = 0;
        if (pos_str) pos = (size_t)strtoull(pos_str, NULL, 10);

        char *logs = malloc(16384 + 64);
        if (logs) {
            size_t copied = wkali_wait_logs(&pos, logs, 16384);
            /* Append the new pos as an HTTP header so the client knows */
            resp = MHD_create_response_from_buffer(copied, (void *)logs, MHD_RESPMEM_MUST_FREE);
            char pos_hdr[64];
            snprintf(pos_hdr, sizeof(pos_hdr), "%zu", pos);
            MHD_add_response_header(resp, "X-Log-Pos", pos_hdr);
            MHD_add_response_header(resp, "Content-Type", "text/plain");
        } else {
            const char *oom = "500 Internal Server Error\n";
            resp = MHD_create_response_from_buffer(strlen(oom), (void *)oom, MHD_RESPMEM_PERSISTENT);
        }
    } else if (strcmp(url, ROUTE_CLEAR_WEBKIT_DATA) == 0) {
        int err = wkali_clear_webkit_data();
        if (err == 0) {
            wkali_log("[WKALI] WebKit data cleared successfully. Will re-launch browser.\n");
            simulate_on_clear_success();
            resp = MHD_create_response_from_buffer(2, (void *)"OK",
                                                   MHD_RESPMEM_PERSISTENT);
            MHD_add_response_header(resp, "Content-Type", "text/plain");
            http_status = MHD_HTTP_OK;
            atomic_store(&webkit_data_cleared, 1);
        } else {
            wkali_log("[WKALI] WebKit data clear failed.\n");
            const char *fail = "Clear failed";
            resp = MHD_create_response_from_buffer(strlen(fail), (void *)fail,
                                                   MHD_RESPMEM_PERSISTENT);
            MHD_add_response_header(resp, "Content-Type", "text/plain");
            http_status = MHD_HTTP_INTERNAL_SERVER_ERROR;
        }
    } else {
        const FileEntry *entry = registry_lookup(url);
        if (entry) {
            if (strcmp(url, "/") != 0 && strcmp(url, "/index.html") != 0 && strcmp(url, "/logs") != 0) {
                wkali_log("[HTTP] Serving %s (size: %zu)\n", url, entry->size);
            }
            void *payload = (void *)entry->data;
            size_t payload_size = entry->size;
            enum MHD_ResponseMemoryMode mem_mode = MHD_RESPMEM_PERSISTENT;
            unsigned char *decompressed = NULL;

            if (entry->compressed) {
                /* Inflate the raw-DEFLATE blob (src/inflate.c, vendored puff)
                 * into a fresh heap buffer; MHD frees it with MUST_FREE. */
                decompressed = malloc(entry->orig_size);
                if (!decompressed) {
                    const char *oom = "503 Out of Memory\n";
                    resp = MHD_create_response_from_buffer(strlen(oom),
                                                           (void *)oom,
                                                           MHD_RESPMEM_PERSISTENT);
                    MHD_add_response_header(resp, "Content-Type", "text/plain");
                    http_status = MHD_HTTP_SERVICE_UNAVAILABLE;
                    add_cors_headers(resp);
                    enum MHD_Result ret = MHD_queue_response(conn, http_status, resp);
                    MHD_destroy_response(resp);
                    return ret;
                }
                unsigned long destlen = entry->orig_size;
                unsigned long sourcelen = entry->size;
                int err = puff(decompressed, &destlen, entry->data, &sourcelen);
                if (err != 0) {
                    free(decompressed);
                    const char *bad = "500 Inflate Error\n";
                    resp = MHD_create_response_from_buffer(strlen(bad),
                                                           (void *)bad,
                                                           MHD_RESPMEM_PERSISTENT);
                    MHD_add_response_header(resp, "Content-Type", "text/plain");
                    http_status = MHD_HTTP_INTERNAL_SERVER_ERROR;
                    add_cors_headers(resp);
                    enum MHD_Result ret = MHD_queue_response(conn, http_status, resp);
                    MHD_destroy_response(resp);
                    return ret;
                }
                payload = decompressed;
                payload_size = destlen;
                mem_mode = MHD_RESPMEM_MUST_FREE;
            }

            /* Dynamically strip incompatible exploit files from the cache manifest */
            if (strcmp(url, ROUTE_CACHE_MANIFEST) == 0 && (fw > 0.0f || strcmp(WKALI_FORCE_EXPLOIT, "auto") != 0)) {
                if (strcmp(WKALI_FORCE_EXPLOIT, "umtx2") == 0) {
                    wkali_log("[WKALI] FORCE_EXPLOIT is set, caching umtx2 exploit\n");
                } else if (strcmp(WKALI_FORCE_EXPLOIT, "poops") == 0) {
                    wkali_log("[WKALI] FORCE_EXPLOIT is set, caching poops exploit\n");
                } else if (strcmp(WKALI_FORCE_EXPLOIT, "p2jb") == 0) {
                    wkali_log("[WKALI] FORCE_EXPLOIT is set, caching p2jb exploit\n");
                } else {
                    if (fw <= 5.50f) {
                        wkali_log("[WKALI] Detected firmware %.2f <= 5.50, caching umtx2 exploit\n", fw);
                    } else if (fw <= 12.00f) {
                        wkali_log("[WKALI] Detected firmware %.2f <= 12.00, caching poops exploit\n", fw);
                    } else {
                        wkali_log("[WKALI] Detected firmware %.2f > 12.00, caching p2jb exploit\n", fw);
                    }
                }

                char *filtered = malloc(payload_size + 1);
                if (filtered) {
                    char *src = (char *)payload;
                    char *dst = filtered;
                    size_t remaining = payload_size;
                    
                    while (remaining > 0) {
                        char *nl = memchr(src, '\n', remaining);
                        size_t line_len = nl ? (size_t)(nl - src) + 1 : remaining;
                        
                        char line[1024];
                        size_t copy_len = line_len < sizeof(line) ? line_len : sizeof(line) - 1;
                        memcpy(line, src, copy_len);
                        line[copy_len] = '\0';
                        
                        int keep = 1;
                        if (strcmp(WKALI_FORCE_EXPLOIT, "umtx2") == 0) {
                            if (strstr(line, "/slopkit/")) keep = 0;
                        } else if (strcmp(WKALI_FORCE_EXPLOIT, "poops") == 0
                            || strcmp(WKALI_FORCE_EXPLOIT, "p2jb") == 0) {
                            if (strstr(line, "/umtx2/")) keep = 0;
                        } else {
                            if (fw <= 5.50f && strstr(line, "/slopkit/")) keep = 0;
                            if (fw > 5.50f && strstr(line, "/umtx2/")) keep = 0;
                        }
                        
                        if (keep) {
                            memcpy(dst, src, line_len);
                            dst += line_len;
                        }
                        
                        src += line_len;
                        remaining -= line_len;
                    }
                    
                    if (mem_mode == MHD_RESPMEM_MUST_FREE) free(payload);
                    payload = filtered;
                    payload_size = dst - filtered;
                    mem_mode = MHD_RESPMEM_MUST_FREE;
                }
            }

            /* Test simulation hook (no-op unless compiled with SIMULATE=1|2) */
            simulate_corrupt_manifest(url, &payload, &payload_size, &mem_mode);

            resp = MHD_create_response_from_buffer(payload_size, payload,
                                                   mem_mode);
            MHD_add_response_header(resp, "Content-Type", entry->content_type);
            if (strcmp(url, ROUTE_CACHE_MANIFEST) == 0 ||
                strstr(entry->content_type, "text/html") != NULL) {
                MHD_add_response_header(resp, "Cache-Control",
                                        "no-cache, must-revalidate");
            }
        } else {
            const char *not_found = "404 Not Found\n";
            resp = MHD_create_response_from_buffer(strlen(not_found),
                                                   (void *)not_found,
                                                   MHD_RESPMEM_PERSISTENT);
            MHD_add_response_header(resp, "Content-Type", "text/plain");
            http_status = MHD_HTTP_NOT_FOUND;
        }
    }

    if (!resp)
        return MHD_NO;

    add_cors_headers(resp);
    enum MHD_Result ret = MHD_queue_response(conn, http_status, resp);
    MHD_destroy_response(resp);

    return ret;
}
