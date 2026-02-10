// renderer.js — Pure rendering functions for trigd plot display.
// Extracted from vscode-ext/src/webview-provider.ts (getRendererScript).
// All functions are global so app.js can call them.

function mapFontFamily(family) {
    if (!family || family === '' || family === 'sans') return 'sans-serif';
    if (family === 'serif' || family === 'Times') return 'serif';
    if (family === 'mono' || family === 'Courier') return 'monospace';
    return family + ', sans-serif';
}

function applyGc(ctx, gc) {
    if (!gc) return;
    if (gc.col != null) ctx.strokeStyle = gc.col;
    if (gc.fill != null) ctx.fillStyle = gc.fill;
    ctx.lineWidth = gc.lwd || 1;
    ctx.lineCap = gc.lend || 'round';
    ctx.lineJoin = gc.ljoin || 'round';
    ctx.miterLimit = gc.lmitre || 10;
    if (gc.lty && gc.lty.length > 0) {
        ctx.setLineDash(gc.lty);
    } else {
        ctx.setLineDash([]);
    }
    if (gc.font) {
        var size = gc.font.size || 12;
        var family = mapFontFamily(gc.font.family);
        var face = gc.font.face || 1;
        var style = '';
        if (face === 2 || face === 4) style += 'bold ';
        if (face === 3 || face === 4) style += 'italic ';
        ctx.font = style + size + 'px ' + family;
    }
}

async function replay(canvas, container, plot) {
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var containerW = container.clientWidth;
    var containerH = container.clientHeight;

    var plotW = plot.device.width;
    var plotH = plot.device.height;
    var scaleX = containerW / plotW;
    var scaleY = containerH / plotH;
    var scale = Math.min(scaleX, scaleY);

    var drawW = plotW * scale;
    var drawH = plotH * scale;

    canvas.width = drawW * dpr;
    canvas.height = drawH * dpr;
    canvas.style.width = drawW + 'px';
    canvas.style.height = drawH + 'px';

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr * scale, dpr * scale);

    ctx.save();

    if (plot.device.bg) {
        ctx.fillStyle = plot.device.bg;
        ctx.fillRect(0, 0, plotW, plotH);
    } else {
        ctx.clearRect(0, 0, plotW, plotH);
    }

    var ops = plot.ops;
    for (var i = 0; i < ops.length; i++) {
        await renderOp(ctx, ops[i], plotH);
    }

    ctx.restore();
}

async function renderOp(ctx, op, plotH) {
    switch (op.op) {
        case 'line': {
            applyGc(ctx, op.gc);
            if (op.gc && op.gc.col != null) {
                ctx.beginPath();
                ctx.moveTo(op.x1, op.y1);
                ctx.lineTo(op.x2, op.y2);
                ctx.stroke();
            }
            break;
        }
        case 'polyline': {
            applyGc(ctx, op.gc);
            if (op.x.length < 2) break;
            ctx.beginPath();
            ctx.moveTo(op.x[0], op.y[0]);
            for (var i = 1; i < op.x.length; i++) {
                ctx.lineTo(op.x[i], op.y[i]);
            }
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'polygon': {
            applyGc(ctx, op.gc);
            ctx.beginPath();
            ctx.moveTo(op.x[0], op.y[0]);
            for (var i = 1; i < op.x.length; i++) {
                ctx.lineTo(op.x[i], op.y[i]);
            }
            ctx.closePath();
            if (op.gc && op.gc.fill != null) ctx.fill();
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'rect': {
            applyGc(ctx, op.gc);
            var rx = Math.min(op.x0, op.x1);
            var ry = Math.min(op.y0, op.y1);
            var rw = Math.abs(op.x1 - op.x0);
            var rh = Math.abs(op.y1 - op.y0);
            if (op.gc && op.gc.fill != null) {
                ctx.fillStyle = op.gc.fill;
                ctx.fillRect(rx, ry, rw, rh);
            }
            if (op.gc && op.gc.col != null) {
                ctx.strokeStyle = op.gc.col;
                ctx.strokeRect(rx, ry, rw, rh);
            }
            break;
        }
        case 'circle': {
            applyGc(ctx, op.gc);
            ctx.beginPath();
            ctx.arc(op.x, op.y, op.r, 0, 2 * Math.PI);
            if (op.gc && op.gc.fill != null) ctx.fill();
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'text': {
            applyGc(ctx, op.gc);
            ctx.save();
            ctx.translate(op.x, op.y);
            if (op.rot) ctx.rotate(-op.rot * Math.PI / 180);
            ctx.textBaseline = 'alphabetic';
            var align = 'left';
            if (op.hadj === 0.5) align = 'center';
            else if (op.hadj === 1) align = 'right';
            ctx.textAlign = align;
            if (op.gc && op.gc.col != null) {
                ctx.fillStyle = op.gc.col;
                ctx.fillText(op.str, 0, 0);
            }
            ctx.restore();
            break;
        }
        case 'clip': {
            ctx.restore();
            ctx.save();
            ctx.beginPath();
            ctx.rect(op.x0, op.y0, op.x1 - op.x0, op.y1 - op.y0);
            ctx.clip();
            break;
        }
        case 'path': {
            applyGc(ctx, op.gc);
            ctx.beginPath();
            for (var si = 0; si < op.subpaths.length; si++) {
                var subpath = op.subpaths[si];
                if (subpath.length === 0) continue;
                ctx.moveTo(subpath[0][0], subpath[0][1]);
                for (var i = 1; i < subpath.length; i++) {
                    ctx.lineTo(subpath[i][0], subpath[i][1]);
                }
                ctx.closePath();
            }
            var rule = op.winding === 'evenodd' ? 'evenodd' : 'nonzero';
            if (op.gc && op.gc.fill != null) ctx.fill(rule);
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'raster': {
            var img = new Image();
            img.src = op.data;
            await img.decode();
            ctx.save();
            var dw = op.w;
            var dh = op.h;
            var aw = Math.abs(dw);
            var ah = Math.abs(dh);
            var dx = dw >= 0 ? op.x : op.x + dw;
            var dy = op.y - ah;
            if (op.rot) {
                var cx = dx + aw / 2;
                var cy = dy + ah / 2;
                ctx.translate(cx, cy);
                ctx.rotate(-op.rot * Math.PI / 180);
                ctx.translate(-cx, -cy);
            }
            ctx.imageSmoothingEnabled = !!op.interpolate;
            ctx.drawImage(img, dx, dy, aw, ah);
            ctx.restore();
            break;
        }
    }
}

// Render a plot to an offscreen canvas and return a PNG Blob.
function renderToOffscreen(plot, width, height) {
    var offscreen = document.createElement('canvas');
    var plotW = plot.device.width;
    var plotH = plot.device.height;
    var scale = Math.min(width / plotW, height / plotH);
    offscreen.width = plotW * scale;
    offscreen.height = plotH * scale;
    var offCtx = offscreen.getContext('2d');
    offCtx.scale(scale, scale);
    if (plot.device.bg) {
        offCtx.fillStyle = plot.device.bg;
        offCtx.fillRect(0, 0, plotW, plotH);
    }
    return (async function() {
        for (var i = 0; i < plot.ops.length; i++) {
            await renderOp(offCtx, plot.ops[i], plotH);
        }
        return new Promise(function(resolve) {
            offscreen.toBlob(function(blob) { resolve(blob); }, 'image/png');
        });
    })();
}

// SVG export helpers

function svgEsc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function svgTag(name, attrs, selfClose) {
    return '<' + name + (attrs || '') + (selfClose ? '/>' : '>');
}

function svgClose(name) {
    return '</' + name + '>';
}

function svgGcStroke(gc) {
    if (!gc || gc.col == null) return ' stroke="none"';
    var s = ' stroke="' + svgEsc(gc.col) + '"';
    s += ' stroke-width="' + (gc.lwd || 1) + '"';
    s += ' stroke-linecap="' + svgEsc(gc.lend || 'round') + '"';
    s += ' stroke-linejoin="' + svgEsc(gc.ljoin || 'round') + '"';
    if (gc.lty && gc.lty.length > 0) s += ' stroke-dasharray="' + gc.lty.join(',') + '"';
    return s;
}

function svgGcFill(gc) {
    if (!gc || gc.fill == null) return ' fill="none"';
    return ' fill="' + svgEsc(gc.fill) + '"';
}

function svgFont(gc) {
    if (!gc || !gc.font) return { size: 12, family: 'sans-serif', style: '', weight: '' };
    var size = gc.font.size || 12;
    var family = mapFontFamily(gc.font.family);
    var face = gc.font.face || 1;
    return {
        size: size,
        family: family,
        weight: (face === 2 || face === 4) ? 'bold' : 'normal',
        style: (face === 3 || face === 4) ? 'italic' : 'normal'
    };
}

function plotToSvg(plot, exportW, exportH) {
    var w = plot.device.width;
    var h = plot.device.height;
    var outW = exportW || w;
    var outH = exportH || h;
    var s = svgTag('svg', ' xmlns="http://www.w3.org/2000/svg" width="' + outW + '" height="' + outH + '" viewBox="0 0 ' + w + ' ' + h + '"') + '\n';

    if (plot.device.bg) {
        s += svgTag('rect', ' width="' + w + '" height="' + h + '" fill="' + svgEsc(plot.device.bg) + '"', true) + '\n';
    }

    var clipId = 0;
    var inClip = false;

    for (var oi = 0; oi < plot.ops.length; oi++) {
        var op = plot.ops[oi];
        switch (op.op) {
            case 'clip': {
                if (inClip) s += svgClose('g') + '\n';
                clipId++;
                var cw = op.x1 - op.x0, ch = op.y1 - op.y0;
                var cx = Math.min(op.x0, op.x1), cy = Math.min(op.y0, op.y1);
                var aw = Math.abs(cw), ah = Math.abs(ch);
                s += svgTag('defs') + svgTag('clipPath', ' id="c' + clipId + '"') + svgTag('rect', ' x="' + cx + '" y="' + cy + '" width="' + aw + '" height="' + ah + '"', true) + svgClose('clipPath') + svgClose('defs') + '\n';
                s += svgTag('g', ' clip-path="url(#c' + clipId + ')"') + '\n';
                inClip = true;
                break;
            }
            case 'line':
                s += svgTag('line', ' x1="' + op.x1 + '" y1="' + op.y1 + '" x2="' + op.x2 + '" y2="' + op.y2 + '"' + svgGcStroke(op.gc) + ' fill="none"', true) + '\n';
                break;
            case 'rect': {
                var rx = Math.min(op.x0, op.x1), ry = Math.min(op.y0, op.y1);
                var rw = Math.abs(op.x1 - op.x0), rh = Math.abs(op.y1 - op.y0);
                s += svgTag('rect', ' x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\n';
                break;
            }
            case 'circle':
                s += svgTag('circle', ' cx="' + op.x + '" cy="' + op.y + '" r="' + op.r + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\n';
                break;
            case 'polyline': {
                if (op.x.length < 2) break;
                var pts = '';
                for (var i = 0; i < op.x.length; i++) pts += op.x[i] + ',' + op.y[i] + ' ';
                s += svgTag('polyline', ' points="' + pts.trim() + '"' + svgGcStroke(op.gc) + ' fill="none"', true) + '\n';
                break;
            }
            case 'polygon': {
                var pts = '';
                for (var i = 0; i < op.x.length; i++) pts += op.x[i] + ',' + op.y[i] + ' ';
                s += svgTag('polygon', ' points="' + pts.trim() + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\n';
                break;
            }
            case 'path': {
                var d = '';
                for (var si = 0; si < op.subpaths.length; si++) {
                    var sub = op.subpaths[si];
                    if (sub.length === 0) continue;
                    d += 'M' + sub[0][0] + ' ' + sub[0][1];
                    for (var i = 1; i < sub.length; i++) d += 'L' + sub[i][0] + ' ' + sub[i][1];
                    d += 'Z';
                }
                var rule = op.winding === 'evenodd' ? 'evenodd' : 'nonzero';
                s += svgTag('path', ' d="' + d + '" fill-rule="' + rule + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\n';
                break;
            }
            case 'text': {
                var f = svgFont(op.gc);
                var anchor = 'start';
                if (op.hadj === 0.5) anchor = 'middle';
                else if (op.hadj === 1) anchor = 'end';
                var col = (op.gc && op.gc.col != null) ? svgEsc(op.gc.col) : 'black';
                var transform = 'translate(' + op.x + ',' + op.y + ')';
                if (op.rot) transform += ' rotate(' + (-op.rot) + ')';
                s += svgTag('text', ' transform="' + transform + '" font-family="' + svgEsc(f.family) + '" font-size="' + f.size + '" font-weight="' + svgEsc(f.weight) + '" font-style="' + svgEsc(f.style) + '" text-anchor="' + anchor + '" fill="' + col + '"') + svgEsc(op.str) + svgClose('text') + '\n';
                break;
            }
            case 'raster': {
                var aw = Math.abs(op.w), ah = Math.abs(op.h);
                var dx = op.w >= 0 ? op.x : op.x + op.w;
                var dy = op.y - ah;
                var transform = '';
                if (op.rot) {
                    var cx = dx + aw / 2, cy = dy + ah / 2;
                    transform = ' transform="rotate(' + (-op.rot) + ',' + cx + ',' + cy + ')"';
                }
                var safeHref = /^data:image\//.test(op.data) ? op.data : svgEsc(op.data);
                s += svgTag('image', ' x="' + dx + '" y="' + dy + '" width="' + aw + '" height="' + ah + '" href="' + safeHref + '"' + transform, true) + '\n';
                break;
            }
        }
    }

    if (inClip) s += svgClose('g') + '\n';
    s += svgClose('svg');
    return s;
}
