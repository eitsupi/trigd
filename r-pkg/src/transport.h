#ifndef TRIGD_TRANSPORT_H
#define TRIGD_TRANSPORT_H

#include <stddef.h>

typedef struct {
    int fd;
    char socket_path[512];  /* Unix path or "tcp:PORT" on Windows */
    int connected;
} trigd_transport_t;

void transport_init(trigd_transport_t *t);
int transport_connect(trigd_transport_t *t);
int transport_send(trigd_transport_t *t, const char *data, size_t len);
int transport_has_data(trigd_transport_t *t);
int transport_recv_line(trigd_transport_t *t, char *buf, size_t bufsize, int timeout_ms);
void transport_close(trigd_transport_t *t);
int transport_reconnect(trigd_transport_t *t);

#endif
