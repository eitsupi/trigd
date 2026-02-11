// app.js — WebSocket client, PlotHistory, message routing, toolbar, resize, metrics, export.
// Plot history, message routing, toolbar, resize, metrics, and export for the browser frontend.

(function() {
    'use strict';

    // ---- PlotHistory (ported from plot-history.ts) ----

    function PlotHistory(maxPlots) {
        this._sessions = new Map();
        this._activeSessionId = '';
        this._maxPlots = maxPlots || 50;
    }

    PlotHistory.prototype.addPlot = function(sessionId, plot) {
        var session = this._sessions.get(sessionId);
        if (!session) {
            session = { plots: [], currentIndex: -1 };
            this._sessions.set(sessionId, session);
        }
        session.plots.push(plot);
        while (session.plots.length > this._maxPlots) {
            session.plots.shift();
        }
        session.currentIndex = session.plots.length - 1;
        this._activeSessionId = sessionId;
    };

    PlotHistory.prototype.replaceCurrent = function(sessionId, plot) {
        var session = this._sessions.get(sessionId);
        if (!session || session.plots.length === 0) {
            return this.addPlot(sessionId, plot);
        }
        session.plots[session.currentIndex] = plot;
        this._activeSessionId = sessionId;
    };

    PlotHistory.prototype.appendOps = function(sessionId, plot) {
        var session = this._sessions.get(sessionId);
        if (!session || session.plots.length === 0) {
            return this.addPlot(sessionId, plot);
        }
        var current = session.plots[session.currentIndex];
        var newOps = plot.ops || [];
        for (var i = 0; i < newOps.length; i++) {
            current.ops.push(newOps[i]);
        }
        current.device = plot.device;
        this._activeSessionId = sessionId;
    };

    PlotHistory.prototype.currentPlot = function() {
        var session = this._sessions.get(this._activeSessionId);
        if (!session || session.currentIndex < 0) return null;
        return session.plots[session.currentIndex] || null;
    };

    PlotHistory.prototype.navigatePrevious = function() {
        var session = this._sessions.get(this._activeSessionId);
        if (!session || session.currentIndex <= 0) return null;
        session.currentIndex--;
        return session.plots[session.currentIndex];
    };

    PlotHistory.prototype.navigateNext = function() {
        var session = this._sessions.get(this._activeSessionId);
        if (!session || session.currentIndex >= session.plots.length - 1) return null;
        session.currentIndex++;
        return session.plots[session.currentIndex];
    };

    PlotHistory.prototype.removeCurrent = function() {
        var session = this._sessions.get(this._activeSessionId);
        if (!session || session.plots.length === 0) return null;
        session.plots.splice(session.currentIndex, 1);
        if (session.plots.length === 0) {
            session.currentIndex = -1;
            return null;
        }
        if (session.currentIndex >= session.plots.length) {
            session.currentIndex = session.plots.length - 1;
        }
        return session.plots[session.currentIndex];
    };

    PlotHistory.prototype.currentIndex = function() {
        var session = this._sessions.get(this._activeSessionId);
        return session ? session.currentIndex + 1 : 0;
    };

    PlotHistory.prototype.count = function() {
        var session = this._sessions.get(this._activeSessionId);
        return session ? session.plots.length : 0;
    };

    // ---- DOM references ----

    var canvas = document.getElementById('plot-canvas');
    var container = document.getElementById('canvas-container');
    var metricsCanvas = document.getElementById('metrics-canvas');
    var metricsCtx = metricsCanvas.getContext('2d');
    var btnPrev = document.getElementById('btn-prev');
    var btnNext = document.getElementById('btn-next');
    var btnDelete = document.getElementById('btn-delete');
    var exportSelect = document.getElementById('export-select');
    var plotInfo = document.getElementById('plot-info');
    var wsStatus = document.getElementById('ws-status');

    // ---- State ----

    var history = new PlotHistory(50);
    var ws = null;

    // ---- Toolbar updates ----

    function updateToolbar() {
        var idx = history.currentIndex();
        var total = history.count();
        plotInfo.textContent = total > 0 ? idx + ' / ' + total : 'No plots';
        btnPrev.disabled = idx <= 1;
        btnNext.disabled = idx >= total;
        btnDelete.disabled = total === 0;
        exportSelect.disabled = total === 0;
    }

    function replayCurrentPlot() {
        var plot = history.currentPlot();
        if (plot) {
            replay(canvas, container, plot);
        } else {
            var ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    // ---- Toolbar event handlers ----

    btnPrev.addEventListener('click', function() {
        if (history.navigatePrevious()) {
            replayCurrentPlot();
            updateToolbar();
        }
    });

    btnNext.addEventListener('click', function() {
        if (history.navigateNext()) {
            replayCurrentPlot();
            updateToolbar();
        }
    });

    btnDelete.addEventListener('click', function() {
        history.removeCurrent();
        replayCurrentPlot();
        updateToolbar();
    });

    exportSelect.addEventListener('change', function(e) {
        var fmt = e.target.value;
        if (!fmt) return;
        e.target.value = '';
        handleExport(fmt);
    });

    // ---- Export ----

    function handleExport(format) {
        var plot = history.currentPlot();
        if (!plot) return;

        var dpr = window.devicePixelRatio || 1;
        var exportW = canvas.width;
        var exportH = canvas.height;

        if (format === 'png') {
            renderToOffscreen(plot, exportW, exportH).then(function(blob) {
                if (!blob) return;
                downloadBlob(blob, 'plot.png');
            });
        } else if (format === 'svg') {
            var svg = plotToSvg(plot, exportW / dpr, exportH / dpr);
            var blob = new Blob([svg], { type: 'image/svg+xml' });
            downloadBlob(blob, 'plot.svg');
        }
    }

    function downloadBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function() { URL.revokeObjectURL(url); }, 1500);
    }

    // ---- Message handlers ----

    var renderScheduled = false;

    function scheduleRender() {
        if (!renderScheduled) {
            renderScheduled = true;
            requestAnimationFrame(function() {
                renderScheduled = false;
                replayCurrentPlot();
                updateToolbar();
            });
        }
    }

    function handleFrame(msg) {
        var plot = msg.plot;
        var sessionId = plot.sessionId || 'default';
        if (msg.incremental) {
            history.appendOps(sessionId, plot);
        } else {
            history.addPlot(sessionId, plot);
        }
        scheduleRender();
    }

    function handleMetricsRequest(msg) {
        var gc = msg.gc || {};
        var size = gc.font ? gc.font.size || 12 : 12;
        var family = gc.font ? mapFontFamily(gc.font.family) : 'sans-serif';
        var face = gc.font ? gc.font.face || 1 : 1;
        var style = '';
        if (face === 2 || face === 4) style += 'bold ';
        if (face === 3 || face === 4) style += 'italic ';
        metricsCtx.font = style + size + 'px ' + family;

        var width = 0, ascent = 0, descent = 0;
        var m;
        if (msg.kind === 'strWidth' && msg.str) {
            m = metricsCtx.measureText(msg.str);
            width = m.width;
        } else if (msg.kind === 'metricInfo') {
            var ch = msg.c > 0 ? String.fromCodePoint(msg.c) : 'M';
            m = metricsCtx.measureText(ch);
            width = m.width;
            ascent = m.actualBoundingBoxAscent || size * 0.75;
            descent = m.actualBoundingBoxDescent || size * 0.25;
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'metrics_response',
                id: msg.id,
                width: width,
                ascent: ascent,
                descent: descent
            }));
        }
    }

    // ---- Resize ----

    var resizeTimer = null;
    var resizeObserver = new ResizeObserver(function() {
        replayCurrentPlot();
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'resize',
                    width: container.clientWidth,
                    height: container.clientHeight
                }));
            }
        }, 300);
    });
    resizeObserver.observe(container);

    // ---- WebSocket ----

    var reconnectDelay = 2000;
    var maxReconnectDelay = 30000;

    function connect() {
        var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(proto + '//' + location.host + '/ws');

        ws.onopen = function() {
            reconnectDelay = 2000;
            wsStatus.className = 'connected';
            wsStatus.title = 'Connected';
            // Send initial resize so R knows the viewport size
            ws.send(JSON.stringify({
                type: 'resize',
                width: container.clientWidth,
                height: container.clientHeight
            }));
        };

        ws.onclose = function() {
            wsStatus.className = '';
            wsStatus.title = 'Disconnected';
            setTimeout(connect, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
        };

        ws.onerror = function() {
            // onclose will fire after this
        };

        ws.onmessage = function(e) {
            var msg;
            try {
                msg = JSON.parse(e.data);
            } catch (err) {
                return;
            }

            switch (msg.type) {
                case 'frame':
                    handleFrame(msg);
                    break;
                case 'metrics_request':
                    handleMetricsRequest(msg);
                    break;
                case 'close':
                    updateToolbar();
                    break;
            }
        };
    }

    connect();

})();
