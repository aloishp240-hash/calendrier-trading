/* Barre d'onglets « Liquid Glass » : une bulle de verre qui se déplace avec un
   ressort (effet gelée : elle s'étire avec la vitesse et rebondit à l'arrivée),
   et qu'on peut faire glisser du doigt d'un onglet à l'autre. */
window.TC = window.TC || {};

TC.tabbar = (function () {
  'use strict';

  const STIFFNESS = 420;           // raideur du ressort
  const DAMPING = 24;              // amortissement (< critique : léger rebond)
  const DRAG_START = 6;            // px avant de considérer un glissement
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  let bar, bubble, tabs, onSelect;
  let x = 0, v = 0, target = 0, width = 0;
  let lifted = 0, liftTarget = 0;  // la bulle grossit quand on la saisit
  let raf = null, last = 0;
  let drag = null;                 // { startX, startBubble, moved, pointerId }
  let current = null;

  const geometry = (tab) => ({ left: tab.offsetLeft - 5, width: tab.offsetWidth + 10 });

  function render() {
    const stretch = reduced.matches ? 0 : Math.min(Math.abs(v) / 2400, 0.3);
    const lift = 1 + lifted * 0.1;
    const sx = (1 + stretch) * lift;
    const sy = (1 - stretch * 0.55) * lift;
    bubble.style.width = width + 'px';
    bubble.style.transform = `translateX(${x.toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
    bubble.classList.toggle('is-lifted', lifted > 0.5);
  }

  function step(now) {
    const dt = Math.min(0.032, (now - last) / 1000 || 0.016);
    last = now;
    const a = -STIFFNESS * (x - target) - DAMPING * v;
    v += a * dt;
    x += v * dt;
    lifted += (liftTarget - lifted) * Math.min(1, dt * 14);
    render();
    const settled = Math.abs(x - target) < 0.3 && Math.abs(v) < 4 && Math.abs(lifted - liftTarget) < 0.01;
    if (settled && !drag) {
      x = target; v = 0; lifted = liftTarget;
      render();
      raf = null;
      return;
    }
    raf = requestAnimationFrame(step);
  }

  function kick() {
    if (reduced.matches) { x = target; v = 0; lifted = liftTarget; render(); return; }
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(step); }
  }

  /* Onglet dont le centre est le plus proche de la position de la bulle */
  function nearest(px) {
    let best = tabs[0], dist = Infinity;
    for (const t of tabs) {
      const g = geometry(t);
      const d = Math.abs(g.left + g.width / 2 - (px + width / 2));
      if (d < dist) { dist = d; best = t; }
    }
    return best;
  }

  function highlight(tab) {
    tabs.forEach((t) => t.classList.toggle('is-hover', t === tab && drag && drag.moved));
  }

  /* Place la bulle sous l'onglet (animé sauf au premier affichage) */
  function moveTo(name, instant) {
    const tab = tabs.find((t) => t.dataset.tabBtn === name);
    if (!tab) return;
    current = name;
    const g = geometry(tab);
    width = g.width;
    target = g.left;
    if (instant || !bubble.style.transform) { x = target; v = 0; render(); return; }
    kick();
  }

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    drag = { startX: e.clientX, startBubble: x, moved: false, pointerId: e.pointerId };
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_START) return;
      drag.moved = true;
      // on part de la bulle si on l'a saisie, sinon de l'onglet touché
      const rect = bar.getBoundingClientRect();
      drag.startBubble = Math.min(Math.max(drag.startX - rect.left - width / 2, 0), bar.clientWidth - width);
      try { bar.setPointerCapture(e.pointerId); } catch (err) { /* le glissement marche aussi sans */ }
      liftTarget = 1;
    }
    const min = geometry(tabs[0]).left, max = geometry(tabs[tabs.length - 1]).left;
    target = Math.min(Math.max(drag.startBubble + dx, min - 8), max + 8);   // léger dépassement élastique
    highlight(nearest(target));
    kick();
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    drag = null;
    liftTarget = 0;
    highlight(null);
    if (moved) {
      const tab = nearest(target);
      bar.dataset.justDragged = '1';                     // évite le « clic » qui suit le glissement
      setTimeout(() => { delete bar.dataset.justDragged; }, 50);
      onSelect(tab.dataset.tabBtn);
    }
    kick();
  }

  function init(options) {
    bar = document.getElementById('tabbar');
    bubble = document.getElementById('tabIndicator');
    tabs = [...bar.querySelectorAll('.tab')];
    onSelect = options.onSelect;
    tabs.forEach((t) => t.addEventListener('click', (e) => {
      if (bar.dataset.justDragged) { e.preventDefault(); return; }
      onSelect(t.dataset.tabBtn);
    }));
    bar.addEventListener('pointerdown', onDown);
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
    bar.addEventListener('pointercancel', onUp);
    window.addEventListener('resize', () => { if (current) moveTo(current, true); });
  }

  return { init, moveTo };
})();
