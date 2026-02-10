# trigd — Three-layer Graphics Device for R

![Experimental](https://img.shields.io/badge/status-experimental-orange)

**trigd** is a hard fork of [jgd](https://github.com/grantmcdermott/jgd)
(JSON Graphics Device) by Grant McDermott. It is a lightweight, C-based R
graphics device that serializes plotting operations as JSON and streams them
over a Unix domain socket to an external renderer.

## Why fork?

jgd's original architecture couples the renderer to a VS Code extension: a
Node.js socket server runs inside the extension host, and plots are displayed
in a VS Code webview panel. This means jgd can only be used from VS Code.

trigd replaces the VS Code extension with a standalone **Go server** and a
**browser frontend**. The Go server bridges R (Unix socket, NDJSON) and the
browser (HTTP + WebSocket), so plots can be viewed in any web browser
regardless of which editor or terminal is running R. This makes the device
usable from Neovim, Emacs, a plain terminal, or any other environment.

### Key differences from jgd

| | jgd | trigd |
|---|---|---|
| Renderer host | VS Code extension (Node.js) | Standalone Go server |
| Viewer | VS Code webview panel | Any web browser |
| Editor dependency | VS Code required | None |
| Server binary | None (embedded in extension) | Single Go binary |
| Browser frontend | N/A | Embedded static assets served over HTTP |

The R package (pure C, zero dependencies) is largely shared between the two
projects.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  R Process                                      │
│                                                 │
│  trigd R package (pure C)                       │
│  ┌───────────────────────────────────────────┐  │
│  │ DevDesc callbacks → JSON serializer       │  │
│  │                     → socket client       │──┼──┐
│  └───────────────────────────────────────────┘  │  │
└─────────────────────────────────────────────────┘  │
     Unix domain socket (NDJSON)                     │
┌─────────────────────────────────────────────────┐  │
│  Go server (trigd binary)                       │◄─┘
│                                                 │
│  Unix socket ←→ Hub ←→ WebSocket                │
│                  ↓                              │
│  HTTP static file server (embedded assets)      │
└───────────────────────┬─────────────────────────┘
                        │ HTTP + WebSocket
┌───────────────────────▼─────────────────────────┐
│  Browser                                        │
│                                                 │
│  Canvas2D renderer + plot history + toolbar     │
└─────────────────────────────────────────────────┘
```

The R package hooks into R's graphics engine via the standard `DevDesc`
callback interface. Every drawing primitive — lines, rectangles, circles,
polygons, text, paths, raster images, clipping regions — is captured as a JSON
object and streamed over the socket. The Go server relays these frames to
connected browsers via WebSocket. The browser replays the operations on a
Canvas2D surface.

## What works

- **Base graphics**: `plot()`, `hist()`, `lines()`, `points()`, `text()`,
  `abline()`, `polygon()`, `polyline()`, `rect()`, `image()`, `path()`
- **ggplot2**: Full support via no-op stubs for R 4.1+ pattern/mask/group
  callbacks
- **Plot history**: Back/forward navigation with toolbar buttons
- **Incremental updates**: `plot()` + `lines()` = one history entry
- **Live resize**: Resizing the browser window re-renders the current plot at
  new dimensions with proper layout reflow
- **Text metrics**: Round-trip measurement using the browser's Canvas2D context
  for accurate label positioning, with server-side 2-second timeout fallback
- **Export**: PNG and SVG from the toolbar dropdown
- **Auto-discovery**: The server writes a discovery file so the R package can
  find the socket automatically

## Prerequisites

- **R** (≥ 4.0)
- **Go** (≥ 1.22) — to build the server
- macOS, Linux, or Windows (TCP transport on Windows)

## Installation

### R package

```r
pak::pak("./r-pkg")
```

### Go server

```bash
cd server
go build -o trigd .
```

This produces a single `trigd` binary.

## Usage

1. Start the server:

```bash
./server/trigd
# trigd server ready
#   R socket:  /tmp/trigd-XXXXXX.sock
#   HTTP:      http://127.0.0.1:XXXXX/
```

2. Open the HTTP URL in a browser.

3. In R (with `TRIGD_SOCKET` set, or in the same TMPDIR so auto-discovery
   works):

```r
library(trigd)
trigd()

plot(1:10)
lines(1:10, col = "red", lwd = 3)
hist(rnorm(1000), col = "steelblue")

library(ggplot2)
ggplot(mtcars, aes(wt, mpg)) +
  geom_point(aes(color = factor(cyl))) +
  theme_minimal()
```

## Running tests

The integration test suite uses [Deno](https://deno.land/) to exercise the Go
server as a black box through its external interfaces (Unix socket, HTTP,
WebSocket).

```bash
# Build the server and run all tests
cd tests/server
deno run --allow-all run.ts

# Or, if the server binary is already built:
TRIGD_SERVER_BIN=../../server/trigd deno test --allow-all tests/
```

## Roadmap

- [ ] Rust rewrite of the server for production-quality font metrics using
  [parley](https://github.com/linebender/parley) (built on
  [fontations](https://github.com/googlefonts/fontations)), following the
  approach pioneered by [vellogd](https://github.com/yutannihilation/vellogd-r)

## License

MIT

