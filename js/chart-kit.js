/* Outils communs aux graphiques : courbes lissées (sans fausse bosse),
   échantillonnage régulier (pour transformer une courbe en une autre en douceur),
   dégradés et animations. */
window.TC = window.TC || {};

TC.chart = (function () {
  'use strict';

  const SVG = 'http://www.w3.org/2000/svg';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const SAMPLES = 96;

  function el(name, attrs = {}) {
    const n = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  }

  /* Tangentes d'une interpolation cubique monotone (Fritsch–Carlson) :
     la courbe passe par chaque point sans jamais dépasser entre deux. */
  function tangents(xs, ys) {
    const n = xs.length;
    const d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / ((xs[i + 1] - xs[i]) || 1));
    m[0] = d[0] || 0;
    m[n - 1] = d[n - 2] || 0;
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return m;
  }

  /* Échantillonne la courbe lissée en n points régulièrement espacés en x */
  function sample(points, n = SAMPLES) {
    if (points.length === 1) return Array.from({ length: n }, () => [points[0][0], points[0][1]]);
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const m = tangents(xs, ys);
    const x0 = xs[0], x1 = xs[xs.length - 1];
    const out = [];
    let seg = 0;
    for (let k = 0; k < n; k++) {
      const x = x0 + ((x1 - x0) * k) / (n - 1);
      while (seg < xs.length - 2 && x > xs[seg + 1]) seg++;
      const h = (xs[seg + 1] - xs[seg]) || 1;
      const t = Math.min(1, Math.max(0, (x - xs[seg]) / h));
      const t2 = t * t, t3 = t2 * t;
      const y = (2 * t3 - 3 * t2 + 1) * ys[seg] + (t3 - 2 * t2 + t) * h * m[seg]
        + (-2 * t3 + 3 * t2) * ys[seg + 1] + (t3 - t2) * h * m[seg + 1];
      out.push([x, y]);
    }
    return out;
  }

  const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = (pts, baseY) => `${line(pts)} L${pts[pts.length - 1][0].toFixed(1)} ${baseY} L${pts[0][0].toFixed(1)} ${baseY} Z`;
  const band = (top, bottom) => `${line(top)} ${bottom.slice().reverse().map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')} Z`;

  /* Dégradé vertical de la couleur d'accent vers transparent */
  function gradient(defs, id, opacity = 0.32) {
    const g = el('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
    const a = el('stop', { offset: '0' });
    a.style.stopColor = 'var(--accent)';
    a.style.stopOpacity = opacity;
    const b = el('stop', { offset: '1' });
    b.style.stopColor = 'var(--accent)';
    b.style.stopOpacity = 0;
    g.append(a, b);
    defs.append(g);
    return `url(#${id})`;
  }

  /* Animation (0 → 1) avec décélération douce ; instantanée si « réduire les animations » */
  function tween(duration, frame) {
    if (reduced.matches) { frame(1); return () => {}; }
    const start = performance.now();
    let id = null, stopped = false;
    const tick = (now) => {
      if (stopped) return;
      const k = Math.min(1, (now - start) / duration);
      frame(1 - Math.pow(1 - k, 3));
      if (k < 1) id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => { stopped = true; cancelAnimationFrame(id); };
  }

  const mix = (a, b, t) => a.map((p, i) => [p[0], p[1] + ((b[i] ? b[i][1] : p[1]) - p[1]) * t]);

  return { el, sample, line, area, band, gradient, tween, mix, SAMPLES };
})();
