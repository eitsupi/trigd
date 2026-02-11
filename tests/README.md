# trigd tests

Integration tests and benchmarks for the trigd server.

## Prerequisites

- [Deno](https://deno.land/) v2+
- [Go](https://go.dev/) 1.22+ (for building the Go server)
- R with the `trigd` package installed (for benchmarks only)

## Directory structure

```
tests/
  deno.json           # shared import map and task definitions
  server/
    helpers/          # test utilities (server lifecycle, mock clients)
    tests/            # integration tests
    run.ts            # build-and-test orchestrator
  bench/
    run.ts            # benchmark orchestrator
    bench-plot.R      # R benchmark script
    mock-metrics-client.ts  # auto-responding WebSocket client
```

## Running tests

All commands should be run from the `tests/` directory.

```bash
# Run integration tests (assumes server binary is already built)
deno task test

# Build the server then run tests
deno task build-and-test

# Verbose output
deno task test:verbose
```

You can also set `TRIGD_SERVER_BIN` to point to a pre-built binary:

```bash
TRIGD_SERVER_BIN=/path/to/trigd deno task test
```

## Running benchmarks

```bash
# Full benchmark: build server, connect mock client, run R benchmarks
deno run --allow-all bench/run.ts

# Skip build (use existing binary)
deno run --allow-all bench/run.ts --skip-build

# Run without mock client (tests timeout fallback path)
deno run --allow-all bench/run.ts --no-client
```

## Adding tests

1. Create a new `*_test.ts` file in `server/tests/`.
2. Import helpers from `../helpers/server.ts`, `../helpers/r_client.ts`, etc.
3. Use `Deno.test()` with the standard pattern: start server, connect clients, assert, then clean up in a `finally` block.
