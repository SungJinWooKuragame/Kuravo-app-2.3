/* Anamnese — interações no estilo Apple.
 * Sheet arrastável no celular: acompanha o dedo 1:1, resiste ao passar do limite (rubber-band),
 * decide fechar/voltar pela projeção do impulso (não só pela distância) e continua na velocidade do dedo. */
(function () {
  'use strict';
  const small = matchMedia('(max-width: 820px)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';
  const EASE_SETTLE = 'cubic-bezier(0.34, 1.25, 0.64, 1)'; // leve overshoot: só depois de um gesto com impulso

  const rubber = (o, dim, c = 0.55) => (o * dim * c) / (dim + c * Math.abs(o));
  const project = (v, r = 0.99) => ((v / 1000) * r) / (1 - r); // v em px/s

  // alça (grabber) real, para ter área de toque própria sem bloquear a rolagem do conteúdo
  function addGrabber(d) {
    const box = d.querySelector('.dlg');
    if (box && !box.querySelector(':scope > .grab')) {
      const g = document.createElement('div');
      g.className = 'grab'; g.setAttribute('aria-hidden', 'true');
      box.prepend(g);
    }
  }

  function init() {
    const d = document.getElementById('dlg');
    if (!d) return;
    new MutationObserver(() => addGrabber(d)).observe(d, { childList: true });

    let drag = null, anim = null;
    const setY = y => { d.style.transform = `translateY(${y}px)`; };

    d.addEventListener('pointerdown', e => {
      if (!small.matches || !d.open || e.button > 0) return;
      const handle = e.target.closest('.grab, .dlg > h2');
      if (!handle) return;
      if (anim) { // agarrar no meio da animação: continua de onde o olho viu
        const m = new DOMMatrixReadOnly(getComputedStyle(d).transform);
        anim.cancel(); anim = null; setY(m.m42);
      }
      const cur = new DOMMatrixReadOnly(getComputedStyle(d).transform).m42 || 0;
      drag = { id: e.pointerId, y0: e.clientY - cur, hist: [{ y: e.clientY, t: e.timeStamp }], y: cur, live: false };
    });

    d.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const raw = e.clientY - drag.y0;
      if (!drag.live) {
        if (Math.abs(raw - drag.y) < 6) return; // pequena histerese antes de assumir o gesto
        drag.live = true;
        d.setPointerCapture(e.pointerId);
        d.style.transition = 'none';
      }
      drag.y = raw >= 0 ? raw : rubber(raw, d.offsetHeight);
      setY(drag.y);
      drag.hist.push({ y: e.clientY, t: e.timeStamp });
      if (drag.hist.length > 6) drag.hist.shift();
    });

    function release(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const g = drag; drag = null;
      if (!g.live) return;
      const a = g.hist[0], b = g.hist[g.hist.length - 1];
      const dt = Math.max(1, b.t - a.t);
      const v = ((b.y - a.y) / dt) * 1000;             // px/s no momento da soltura
      const h = d.offsetHeight;
      const dismiss = g.y + project(v) > Math.max(h * 0.35, 110) || v > 1100;
      const target = dismiss ? h + 24 : 0;
      const dist = Math.abs(target - g.y);
      // duração derivada da velocidade do dedo: a animação continua no mesmo ritmo do gesto
      const dur = reduced.matches ? 120 : Math.round(Math.min(420, Math.max(180, (dist / Math.max(Math.abs(v), 600)) * 1000 * 1.6)));
      anim = d.animate([{ transform: `translateY(${g.y}px)` }, { transform: `translateY(${target}px)` }],
        { duration: dur, easing: dismiss || v < 0 ? EASE_DRAWER : EASE_SETTLE, fill: 'forwards' });
      anim.onfinish = () => {
        anim = null;
        if (dismiss) d.close();
        d.getAnimations().forEach(x => x.cancel());
        d.style.transform = ''; d.style.transition = '';
      };
    }
    d.addEventListener('pointerup', release);
    d.addEventListener('pointercancel', release);
    d.addEventListener('close', () => { d.style.transform = ''; d.style.transition = ''; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
