/* Barre d'onglets « Liquid Glass ».
   - Au repos : une pastille teintée, à l'intérieur de la barre, sous l'onglet actif.
   - Doigt posé : la pastille devient une lentille de verre transparente, plus
     grande que la barre, qui grossit légèrement ce qui est dessous ; elle reste
     ainsi tant que le doigt est posé et le suit s'il glisse.
   - Déplacement avec un ressort (effet gelée : étirement selon la vitesse, léger
     rebond à l'arrivée). */
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

  const GROW = 16;                 // la lentille est plus large que la pastille (px)
  const geometry = (tab) => ({ left: tab.offsetLeft, width: tab.offsetWidth });

  function render() {
    const stretch = reduced.matches ? 0 : Math.min(Math.abs(v) / 2400, 0.3);
    const sx = 1 + stretch;
    const sy = 1 - stretch * 0.55;
    const grow = GROW * lifted;
    bubble.style.width = (width + grow).toFixed(2) + 'px';
    bubble.style.transform = `translateX(${(x - grow / 2).toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
  }

  function setLifted(on) {
    liftTarget = on ? 1 : 0;
    bubble.classList.toggle('is-lifted', on);       // transitions CSS : taille, verre, reflets
    bar.classList.toggle('is-pressing', on);
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

  /* Onglet sous la lentille : légèrement grossi, comme à travers du verre */
  function highlight(tab) {
    tabs.forEach((t) => t.classList.toggle('is-hover', t === tab));
  }

  /* Position de la bulle pour que son centre soit sous le doigt */
  function fingerTarget(clientX) {
    const rect = bar.getBoundingClientRect();
    const min = geometry(tabs[0]).left, max = geometry(tabs[tabs.length - 1]).left;
    return Math.min(Math.max(clientX - rect.left - width / 2, min - 8), max + 8);   // léger dépassement élastique
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

  /* Doigt posé : la lentille apparaît tout de suite sous le doigt et y reste */
  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    drag = { startX: e.clientX, moved: false, pointerId: e.pointerId };
    try { bar.setPointerCapture(e.pointerId); } catch (err) { /* le suivi marche aussi sans */ }
    setLifted(true);
    target = fingerTarget(e.clientX);
    highlight(nearest(target));
    kick();
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.abs(e.clientX - drag.startX) >= DRAG_START) drag.moved = true;
    target = fingerTarget(e.clientX);
    highlight(nearest(target));
    kick();
  }

  /* Doigt levé : la lentille redevient pastille et se pose sur l'onglet le plus proche */
  function onUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const cancelled = e.type === 'pointercancel';
    drag = null;
    setLifted(false);
    highlight(null);
    bar.dataset.justHandled = '1';                       // évite le « clic » qui suit
    setTimeout(() => { delete bar.dataset.justHandled; }, 60);
    if (cancelled) moveTo(current);
    else onSelect(nearest(target).dataset.tabBtn);
    kick();
  }

  function init(options) {
    bar = document.getElementById('tabbar');
    bubble = document.getElementById('tabIndicator');
    tabs = [...bar.querySelectorAll('.tab')];
    onSelect = options.onSelect;
    tabs.forEach((t) => t.addEventListener('click', (e) => {
      if (bar.dataset.justHandled) { e.preventDefault(); return; }    // déjà traité au doigt levé
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
