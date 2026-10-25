/* Anamnese — controles no estilo Apple: menus de seleção, calendário, seletor de hora e escala 0–10.
 * O controle nativo continua no formulário (valor, FormData e eventos funcionam igual); só a aparência e a interação mudam. */
(function () {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const I = {
    updown: svg('<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>'), check: svg('<path d="M20 6 9 17l-5-5"/>'),
    chevL: svg('<path d="m15 6-6 6 6 6"/>'), chevR: svg('<path d="m9 6 6 6-6 6"/>'), chevD: svg('<path d="m6 9 6 6 6-6"/>'),
    cal: svg('<rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/>'), clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')
  };
  const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmtDate = v => { const [y, m, d] = v.split('-'); return `${+d} de ${MESES[+m - 1]} de ${y}`; };
  const fire = el => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  // rola só dentro do contêiner (rolar o elemento "para a vista" rolaria a página inteira e fecharia o menu)
  const scrollWithin = (box, el, center) => {
    if (!box || !el) return;
    const top = el.offsetTop - box.offsetTop;
    if (center) box.scrollTop = top - (box.clientHeight - el.offsetHeight) / 2;
    else if (top < box.scrollTop) box.scrollTop = top;
    else if (top + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + el.offsetHeight - box.clientHeight;
  };

  /* ---------- popover genérico (camada superior: fica acima até de diálogos abertos) ---------- */
  let pop = null, cleanup = null, owner = null;
  function ensurePop() {
    if (pop && pop.isConnected) return pop;
    pop = document.createElement('div');
    pop.setAttribute('popover', 'manual');
    pop.className = 'pop';
    document.body.appendChild(pop);
    return pop;
  }
  function closePop(refocus) {
    if (!pop || !pop.matches(':popover-open')) return;
    if (cleanup) cleanup(); cleanup = null;
    try { pop.hidePopover(); } catch (e) {} pop.innerHTML = ''; pop.className = 'pop';
    if (owner) owner.classList.remove('open');
    if (refocus && owner) owner.focus({ preventScroll: true });
    owner = null;
  }
  function place(anchor, p, opts = {}) {
    const r = anchor.getBoundingClientRect(), vw = innerWidth, vh = innerHeight, m = 10;
    if (opts.matchWidth) p.style.minWidth = Math.max(r.width, 220) + 'px';
    const pw = p.offsetWidth, ph = p.offsetHeight;
    let left = opts.alignRight ? r.right - pw : r.left;
    left = Math.min(Math.max(m, left), vw - pw - m);
    let top = r.bottom + 6, below = true;
    if (top + ph > vh - m) {
      if (r.top - 6 - ph > m) { top = r.top - 6 - ph; below = false; }
      else top = Math.max(m, vh - m - ph);
    }
    p.style.left = left + 'px'; p.style.top = top + 'px';
    // a superfície cresce a partir do controle que a abriu
    p.style.transformOrigin = `${Math.min(Math.max(r.left + r.width / 2 - left, 16), pw - 16)}px ${below ? 'top' : 'bottom'}`;
  }
  function openPop(anchor, html, cls, opts, onMount) {
    closePop();
    const p = ensurePop();
    // com um diálogo modal aberto, tudo fora dele fica inerte: o menu precisa morar dentro do diálogo
    const host = anchor.closest('dialog[open]') || document.body;
    if (p.parentNode !== host) host.appendChild(p);
    p.className = 'pop ' + (cls || '');
    p.innerHTML = html;
    p.style.minWidth = '';
    p.showPopover();
    owner = anchor; anchor.classList.add('open');
    place(anchor, p, opts);
    const onDown = e => { if (!p.contains(e.target) && !anchor.contains(e.target)) closePop(); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(true); } };
    // rolar a página ou o teclado do celular aparecer/sumir não fecha o menu: ele acompanha o controle
    const follow = () => {
      if (owner !== anchor) return;
      if (!anchor.isConnected) return closePop();
      const r = anchor.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return closePop();
      place(anchor, p, opts);
    };
    const onScroll = e => { if (!p.contains(e.target)) requestAnimationFrame(follow); };
    const onResize = () => requestAnimationFrame(follow);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    addEventListener('resize', onResize);
    cleanup = () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', onResize);
    };
    if (onMount) onMount(p);
  }

  /* ---------- menu de seleção (substitui a lista nativa quadrada) ---------- */
  function openMenu(sel, btn) {
    const opts = [...sel.options];
    const html = `<div class="menu" role="listbox">${opts.map((o, i) => `<button type="button" role="option" class="mi ${i === sel.selectedIndex ? 'on' : ''}" data-i="${i}" ${o.disabled ? 'disabled' : ''} aria-selected="${i === sel.selectedIndex}"><span class="mi-ck">${I.check}</span><span class="mi-t">${esc(o.text || '—')}</span></button>`).join('')}</div>`;
    openPop(btn, html, 'pop-menu', { matchWidth: true, alignRight: btn.classList.contains('right') }, p => {
      const cur = p.querySelector('.mi.on') || p.querySelector('.mi:not([disabled])');
      if (cur) { scrollWithin(p.querySelector('.menu'), cur, true); cur.focus({ preventScroll: true }); }
      p.onclick = e => { const b = e.target.closest('.mi'); if (b && !b.disabled) pick(+b.dataset.i); };
      p.onkeydown = e => {
        const items = [...p.querySelectorAll('.mi:not([disabled])')];
        let k = items.indexOf(document.activeElement);
        const go = n => { const it = items[Math.max(0, Math.min(items.length - 1, n))]; if (it) { it.focus({ preventScroll: true }); scrollWithin(p.querySelector('.menu'), it); } };
        if (e.key === 'ArrowDown') { e.preventDefault(); go(k + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); go(k - 1); }
        else if (e.key === 'Home') { e.preventDefault(); go(0); }
        else if (e.key === 'End') { e.preventDefault(); go(items.length - 1); }
        else if (e.key === 'Tab') closePop();
        else if (e.key.length === 1 && /\S/.test(e.key)) {
          const L = e.key.toLowerCase();
          const j = items.findIndex((b, ix) => ix > k && b.textContent.trim().toLowerCase().startsWith(L));
          const jj = j >= 0 ? j : items.findIndex(b => b.textContent.trim().toLowerCase().startsWith(L));
          if (jj >= 0) { items[jj].focus({ preventScroll: true }); scrollWithin(p.querySelector('.menu'), items[jj]); }
        }
      };
    });
    function pick(i) {
      if (sel.selectedIndex !== i) { sel.selectedIndex = i; fire(sel); }
      closePop(true);
    }
  }

  /* ---------- calendário ---------- */
  function openDate(inp, btn) {
    const today = new Date();
    const cur = inp.value ? new Date(inp.value + 'T12:00:00') : null;
    const v = { y: (cur || today).getFullYear(), m: (cur || today).getMonth(), mode: 'days' };
    const min = inp.min || '', max = inp.max || '';
    const okDay = s => (!min || s >= min) && (!max || s <= max);
    const maxY = max ? +max.slice(0, 4) : today.getFullYear() + 10, minY = min ? +min.slice(0, 4) : 1920;
    const render = p => {
      let body = '';
      if (v.mode === 'days') {
        const first = new Date(v.y, v.m, 1).getDay(), dim = new Date(v.y, v.m + 1, 0).getDate();
        let cells = '';
        for (let i = 0; i < first; i++) cells += '<span></span>';
        for (let d = 1; d <= dim; d++) {
          const s = `${v.y}-${pad(v.m + 1)}-${pad(d)}`;
          cells += `<button type="button" class="dp-d ${s === iso(today) ? 'today' : ''} ${s === inp.value ? 'sel' : ''}" data-s="${s}" ${okDay(s) ? '' : 'disabled'}>${d}</button>`;
        }
        body = `<div class="dp-dow">${['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map(x => `<span>${x}</span>`).join('')}</div><div class="dp-grid">${cells}</div>`;
      } else if (v.mode === 'years') {
        let ys = ''; for (let y = maxY; y >= minY; y--) ys += `<button type="button" class="dp-y ${y === v.y ? 'sel' : ''}" data-y="${y}">${y}</button>`;
        body = `<div class="dp-years">${ys}</div>`;
      } else {
        body = `<div class="dp-months">${MESES.map((n, i) => `<button type="button" class="dp-m ${i === v.m ? 'sel' : ''}" data-m="${i}">${n.slice(0, 3)}</button>`).join('')}</div>`;
      }
      p.innerHTML = `<div class="dp">
        <div class="dp-head"><button type="button" class="dp-title ${v.mode !== 'days' ? 'on' : ''}" data-a="mode">${v.mode === 'years' ? 'Escolha o ano' : v.mode === 'months' ? v.y : MESES[v.m] + ' ' + v.y}${I.chevR}</button>
          ${v.mode === 'days' ? `<div class="dp-nav"><button type="button" class="ib" data-a="prev" aria-label="Mês anterior">${I.chevL}</button><button type="button" class="ib" data-a="next" aria-label="Próximo mês">${I.chevR}</button></div>` : ''}</div>
        ${body}
        <div class="dp-foot"><button type="button" class="lnk" data-a="clear">Limpar</button>${okDay(iso(today)) ? '<button type="button" class="lnk b" data-a="today">Hoje</button>' : ''}</div></div>`;
      if (v.mode === 'years') scrollWithin(p.querySelector('.dp-years'), p.querySelector('.dp-y.sel'), true);
    };
    const set = s => { inp.value = s; fire(inp); closePop(true); };
    openPop(btn, '', 'pop-date', {}, p => {
      render(p); place(btn, p);
      p.onclick = e => {
        const t = e.target.closest('button'); if (!t || t.disabled) return;
        const a = t.dataset.a;
        if (t.dataset.s) return set(t.dataset.s);
        if (t.dataset.y) { v.y = +t.dataset.y; v.mode = 'months'; }
        else if (t.dataset.m !== undefined) { v.m = +t.dataset.m; v.mode = 'days'; }
        else if (a === 'mode') v.mode = v.mode === 'days' ? 'years' : 'days';
        else if (a === 'prev') { v.m--; if (v.m < 0) { v.m = 11; v.y--; } }
        else if (a === 'next') { v.m++; if (v.m > 11) { v.m = 0; v.y++; } }
        else if (a === 'today') return set(iso(today));
        else if (a === 'clear') { inp.value = ''; fire(inp); return closePop(true); }
        render(p);
      };
      const f = p.querySelector('.dp-d.sel') || p.querySelector('.dp-d.today') || p.querySelector('.dp-d:not([disabled])'); if (f) f.focus({ preventScroll: true });
    });
  }

  /* ---------- hora (duas colunas, como as rodas do iOS) ---------- */
  function openTime(inp, btn) {
    const [h0, m0] = (inp.value || '09:00').split(':').map(Number);
    const st = { h: h0, m: m0 };
    const mins = []; for (let m = 0; m < 60; m += 5) mins.push(m); if (!mins.includes(m0)) { mins.push(m0); mins.sort((a, b) => a - b); }
    const col = (k, arr, cur) => `<div class="tp-col" data-k="${k}">${arr.map(x => `<button type="button" class="tp-i ${x === cur ? 'sel' : ''}" data-v="${x}">${pad(x)}</button>`).join('')}</div>`;
    const html = `<div class="tp"><div class="tp-cols">${col('h', [...Array(24).keys()], st.h)}<span class="tp-sep">:</span>${col('m', mins, st.m)}</div>
      <div class="dp-foot"><span class="tp-val">${pad(st.h)}:${pad(st.m)}</span><button type="button" class="lnk b" data-a="ok">OK</button></div></div>`;
    openPop(btn, html, 'pop-time', {}, p => {
      p.querySelectorAll('.tp-i.sel').forEach(b => scrollWithin(b.parentElement, b, true));
      p.onclick = e => {
        const t = e.target.closest('button'); if (!t) return;
        if (t.dataset.a === 'ok') return closePop(true);
        const k = t.parentElement.dataset.k; if (!k) return;
        st[k] = +t.dataset.v;
        t.parentElement.querySelectorAll('.tp-i').forEach(b => b.classList.toggle('sel', b === t));
        t.parentElement.scrollTo({ top: t.offsetTop - t.parentElement.offsetTop - (t.parentElement.clientHeight - t.offsetHeight) / 2, behavior: reduced.matches ? 'auto' : 'smooth' });
        inp.value = `${pad(st.h)}:${pad(st.m)}`; fire(inp);
        p.querySelector('.tp-val').textContent = inp.value;
      };
    });
  }

  /* ---------- montagem ---------- */
  function wrapNative(el, kind) {
    el.dataset.ui = '1';
    const wrap = document.createElement('span');
    wrap.className = 'ctl ctl-' + kind + (el.classList.contains('sin') ? ' inline' : '');
    el.parentNode.insertBefore(wrap, el); wrap.appendChild(el);
    el.classList.add('ctl-native'); el.tabIndex = -1; el.setAttribute('aria-hidden', 'true');
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'ctl-btn' + (el.classList.contains('sin') ? ' right' : '');
    wrap.appendChild(btn);
    const lab = el.closest('label');
    if (lab) {
      const t = [...lab.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim() || (lab.querySelector('.sl') || {}).textContent || '';
      if (t) btn.setAttribute('aria-label', t);
      if (!lab.dataset.uifix) {
        lab.dataset.uifix = '1';
        lab.addEventListener('click', e => {
          // composedPath: o alvo pode já ter sido trocado pelo repaint do botão
          if (e.composedPath().some(n => n.nodeType === 1 && n.matches('.ctl,input,select,textarea,a,button'))) return;
          e.preventDefault(); btn.click();
        });
      }
    }
    return btn;
  }
  function enhanceSelect(sel) {
    const btn = wrapNative(sel, 'select');
    btn.setAttribute('aria-haspopup', 'listbox');
    const paint = () => {
      const o = sel.options[sel.selectedIndex];
      const has = o && o.text;
      btn.innerHTML = `<span class="cv ${has && o.value !== '' ? '' : 'ph'}">${esc(has ? o.text : 'Selecionar')}</span><span class="ci">${I.updown}</span>`;
    };
    sel.addEventListener('change', paint); sel.addEventListener('input', paint);
    btn.addEventListener('click', () => { if (owner === btn) return closePop(); paint(); openMenu(sel, btn); });
    btn.addEventListener('keydown', e => { if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); btn.click(); } });
    paint();
  }
  function enhancePicker(inp, kind) {
    const btn = wrapNative(inp, kind);
    btn.setAttribute('aria-haspopup', 'dialog');
    const paint = () => {
      const v = inp.value;
      btn.innerHTML = `<span class="ci">${kind === 'date' ? I.cal : I.clock}</span><span class="cv ${v ? '' : 'ph'}">${v ? (kind === 'date' ? fmtDate(v) : v) : (kind === 'date' ? 'Selecionar data' : '--:--')}</span>`;
    };
    inp.addEventListener('input', paint); inp.addEventListener('change', paint);
    btn.addEventListener('click', () => { if (owner === btn) return closePop(); kind === 'date' ? openDate(inp, btn) : openTime(inp, btn); });
    paint();
  }
  // escala 0–10 (dor, estresse): toques em vez de digitar números
  function enhanceScale(inp) {
    inp.dataset.ui = '1';
    const wrap = document.createElement('div');
    wrap.className = 'scale';
    inp.parentNode.insertBefore(wrap, inp); wrap.appendChild(inp);
    inp.classList.add('ctl-native'); inp.tabIndex = -1;
    const row = document.createElement('div'); row.className = 'scale-row'; row.setAttribute('role', 'radiogroup');
    for (let i = 0; i <= 10; i++) row.insertAdjacentHTML('beforeend', `<button type="button" class="sc" data-v="${i}" style="--k:${i / 10}" role="radio" aria-label="${i}">${i}</button>`);
    wrap.appendChild(row);
    const paint = () => row.querySelectorAll('.sc').forEach(b => { const on = inp.value !== '' && +b.dataset.v === +inp.value; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    row.addEventListener('click', e => {
      const b = e.target.closest('.sc'); if (!b) return;
      inp.value = inp.value !== '' && +inp.value === +b.dataset.v ? '' : b.dataset.v; fire(inp); paint();
    });
    inp.addEventListener('input', paint); paint();
  }
  function enhance(root) {
    (root || document).querySelectorAll('select:not([data-ui])').forEach(enhanceSelect);
    (root || document).querySelectorAll('input[type=date]:not([data-ui])').forEach(el => enhancePicker(el, 'date'));
    (root || document).querySelectorAll('input[type=time]:not([data-ui])').forEach(el => enhancePicker(el, 'time'));
    (root || document).querySelectorAll('input[type=number][min="0"][max="10"]:not([data-ui])').forEach(enhanceScale);
  }
  let queued = false;
  function start() {
    enhance();
    new MutationObserver(() => {
      if (queued) return; queued = true;
      queueMicrotask(() => { queued = false; enhance(); });
    }).observe(document.body, { childList: true, subtree: true });
    // ao trocar de tela ou fechar um diálogo, nenhum menu fica órfão
    addEventListener('hashchange', () => closePop());
    document.addEventListener('close', () => closePop(), true);
  }
  window.UIControls = { enhance, close: closePop };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
