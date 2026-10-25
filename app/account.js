/* Telas de conta: entrar, criar conta, recuperar, bloquear e cartões de Ajustes.
 * Usa funções e variáveis globais do index.html (db, route, toast, openDialog...) apenas quando é chamado. */
window.APP_VERSION = '2.3.0';
const Account = (() => {
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} }
  };
  const LEGACY_KEY = 'anamnese_db_v1';
  const LOCK_KEY = 'anamnese2:autolock';
  const cfgServer = () => (window.ANAMNESE_CONFIG && window.ANAMNESE_CONFIG.supabaseUrl) || '';
  const serverDefault = () => cfgServer() || Vault.lastKnown().server || '';
  const minutes = () => { const m = +LS.get(LOCK_KEY); return [2, 5, 10, 15, 30].includes(m) ? m : 10; };

  const LOGO = '<div class="logo"><svg width="38" height="38" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M28 40H72V216H28Z"/><path d="M178 40H226L138 128L226 216H178L90 128Z"/></svg></div>';

  function errText(e) {
    const c = e && e.code;
    if (c === 'rate_limited') {
      const s = e.retryAfter || 30;
      return `Muitas tentativas. Aguarde ${s >= 60 ? Math.ceil(s / 60) + ' min' : s + ' s'} e tente de novo.`;
    }
    const m = {
      invalid_credentials: 'E-mail ou senha incorretos.',
      need_totp: 'Digite o código de 6 dígitos do seu aplicativo autenticador.',
      invalid_totp: 'Código inválido ou já usado. Aguarde o próximo código e tente de novo.',
      email_taken: 'Este e-mail já tem uma conta.',
      invalid_invite: 'Código de convite incorreto, ou o cadastro está fechado.',
      registration_closed: 'O cadastro está fechado neste servidor.',
      email_not_confirmed: 'Este e-mail ainda não foi confirmado.',
      email_send_failed: 'O Supabase não conseguiu enviar o e-mail. Confira o limite de envios, o template do e-mail ou configure um SMTP próprio (veja o GUIA-SUPABASE). Se o cadastro foi criado pela metade, apague o usuário em Authentication → Users e tente de novo.',
      same_password: 'A nova senha precisa ser diferente da atual.',
      invalid_otp: 'Código do e-mail inválido ou expirado. Peça um novo.',
      need_totp_recovery: 'Você ativou a verificação em duas etapas: digite também o código do aplicativo e peça um novo código por e-mail.',
      not_configured: 'Este aplicativo ainda não foi ligado ao Supabase (arquivo config.js).',
      mfa_required: 'É preciso confirmar o código de 2 etapas.', no_vault: 'Esta conta não tem cofre de dados.',
      network: 'Sem conexão com o servidor. Confira a internet e o endereço do servidor.',
      network_first: 'Sem conexão. Na primeira vez neste aparelho é preciso estar online.',
      origin_not_allowed: 'Este servidor não aceita conexões deste aplicativo.',
      session_expired: 'Sessão expirada. Entre novamente.', unauthorized: 'Sessão inválida. Entre novamente.',
      too_large: 'Dados grandes demais.', quota_exceeded: 'Limite de registros do servidor atingido.',
      bad_request: 'Dados inválidos. Confira os campos.', internal_error: 'Erro no servidor. Tente de novo em instantes.',
      not_found: 'Servidor não encontrado. Confira o endereço.', offline: 'É preciso estar online para isso.', locked: 'Sessão bloqueada.',
      totp_already_enabled: 'A verificação em duas etapas já está ativa.'
    };
    return m[c] || (e && e.message) || 'Algo deu errado.';
  }

  /* ---------- helpers de tela ---------- */
  const show = html => { const a = $('#auth'); a.classList.remove('hidden'); $('#authBox').innerHTML = html; const f = $('#authBox input:not([type=checkbox])'); if (f) setTimeout(() => { if (!$('#authBox').contains(document.activeElement)) f.focus(); }, 30); };
  const hide = () => { $('#auth').classList.add('hidden'); $('#authBox').innerHTML = ''; };
  const err = t => { const e = $('#aErr'); if (e) e.textContent = t || ''; };
  function busy(on, label) {
    const b = $('#aGo'); if (!b) return;
    if (!b.dataset.l) b.dataset.l = b.textContent;
    b.disabled = on; b.textContent = on ? (label || 'Aguarde…') : b.dataset.l;
  }
  const pwField = (id, label, auto) => `<label class="f">${label}<div class="pwrow"><input type="password" id="${id}" autocomplete="${auto}" required><button type="button" class="btn sm" data-eye="${id}">Ver</button></div></label>`;
  const bindEyes = () => document.querySelectorAll('#authBox [data-eye], #dlg [data-eye]').forEach(b => b.onclick = () => {
    const i = document.getElementById(b.dataset.eye); const t = i.type === 'password'; i.type = t ? 'text' : 'password'; b.textContent = t ? 'Ocultar' : 'Ver';
  });
  const serverField = () => (cfgServer() ? '' : `<label class="f">Endereço do servidor<input type="text" id="aServer" value="${esc(serverDefault())}" autocomplete="off"></label>`);
  const serverValue = () => { const i = $('#aServer'); return (i && i.value.trim()) || serverDefault(); };
  const trustBox = () => `<label class="check"><input type="checkbox" id="aTrust" checked><span>Aparelho meu: manter os dados criptografados aqui para usar sem internet</span></label>`;

  /* ---------- entrar ---------- */
  function showLogin(pre = {}) {
    show(`${LOGO}<h2>Kuravo</h2><div class="muted" style="text-align:center">Entre na sua conta</div>
      <form id="fLogin">
        ${serverField()}
        <label class="f">E-mail<input type="email" id="aEmail" autocomplete="username" required value="${esc(pre.email || Vault.lastKnown().email)}"></label>
        ${pwField('aPass', 'Senha', 'current-password')}
        <label class="f hidden" id="aTotpWrap">Código de 6 dígitos<input type="text" id="aTotp" inputmode="numeric" autocomplete="one-time-code" autocapitalize="off"></label>
        ${trustBox()}
        <div id="aErr" class="autherr"></div>
        <button class="btn primary" id="aGo" style="justify-content:center;width:100%">Entrar</button>
      </form>
      <div class="authlinks"><a id="lReg">Criar conta</a> · <a id="lRec">Esqueci a senha</a></div>
      <div class="muted" style="text-align:center;font-size:12px;margin-top:10px">versão ${window.APP_VERSION}</div>`);
    bindEyes();
    $('#lReg').onclick = () => showRegister();
    $('#lRec').onclick = () => showRecover();
    $('#fLogin').onsubmit = async e => {
      e.preventDefault(); err(''); busy(true, 'Entrando…');
      try {
        resetDb();
        await Vault.login({ server: serverValue(), email: $('#aEmail').value, password: $('#aPass').value, totp: $('#aTotp').value.trim(), trusted: $('#aTrust').checked });
        await afterAuth();
      } catch (x) {
        if (x.code === 'need_totp') { $('#aTotpWrap').classList.remove('hidden'); $('#aTotp').focus(); }
        if (x.code === 'email_not_confirmed') {
          try { await Vault.beginConfirm({ server: serverValue(), email: $('#aEmail').value, password: $('#aPass').value, trusted: $('#aTrust').checked }); showConfirm($('#aEmail').value); toast('Enviamos um novo código por e-mail.'); return; }
          catch (y) { err(errText(y)); return; }
        }
        err(errText(x));
      } finally { busy(false); }
    };
  }

  /* ---------- criar conta ---------- */
  function showRegister() {
    show(`${LOGO}<h2>Criar conta</h2>
      <form id="fReg">
        ${serverField()}
        <label class="f">Código de convite<input type="text" id="aInv" autocomplete="off" required></label>
        <label class="f">E-mail<input type="email" id="aEmail" autocomplete="username" required></label>
        ${pwField('aPass', 'Senha (mín. 12 caracteres)', 'new-password')}
        ${pwField('aPass2', 'Repita a senha', 'new-password')}
        <div class="muted" id="aStrength" style="font-size:13px;min-height:18px"></div>
        <label class="check"><input type="checkbox" id="aAck" required><span>Entendo que, se eu esquecer a senha <b>e</b> perder a chave de recuperação, ninguém poderá recuperar os dados (eles são criptografados no meu aparelho).</span></label>
        ${trustBox()}
        <div id="aErr" class="autherr"></div>
        <button class="btn primary" id="aGo" style="justify-content:center;width:100%">Criar conta</button>
      </form>
      <div class="authlinks"><a id="lBack">Já tenho conta</a></div>`);
    bindEyes();
    $('#lBack').onclick = () => showLogin();
    $('#aPass').oninput = () => { const i = Vault.pwIssue($('#aPass').value, $('#aEmail').value); $('#aStrength').textContent = $('#aPass').value ? (i || 'Senha forte.') : ''; $('#aStrength').style.color = i ? 'var(--danger)' : 'var(--ok)'; };
    $('#fReg').onsubmit = async e => {
      e.preventDefault(); err('');
      if ($('#aPass').value !== $('#aPass2').value) return err('As senhas não são iguais.');
      busy(true, 'Criando conta… (pode levar alguns segundos)');
      try {
        resetDb();
        const r = await Vault.register({ server: serverValue(), email: $('#aEmail').value, password: $('#aPass').value, invite: $('#aInv').value.trim(), trusted: $('#aTrust').checked });
        showRecoveryKey(r.recoveryKey, $('#aEmail').value, r.needConfirm);
      } catch (x) { err(errText(x)); busy(false); }
    };
  }

  function showRecoveryKey(key, email, needConfirm) {
    show(`${LOGO}<h2>Guarde sua chave de recuperação</h2>
      <p class="muted" style="margin:0">É a <b>única</b> forma de recuperar seus dados se você esquecer a senha. Ela é mostrada só agora. Guarde fora deste aparelho (papel num lugar seguro, gerenciador de senhas).</p>
      <div class="reckey" id="recKey">${esc(key)}</div>
      <div class="row" style="flex-wrap:wrap;justify-content:center"><button class="btn sm" id="rCopy">Copiar</button><button class="btn sm" id="rDl">Baixar arquivo</button></div>
      <label class="check"><input type="checkbox" id="rOk"><span>Guardei a chave em um lugar seguro, fora deste aparelho</span></label>
      <button class="btn primary" id="rGo" disabled style="justify-content:center;width:100%">Continuar</button>`);
    $('#rOk').onchange = () => { $('#rGo').disabled = !$('#rOk').checked; };
    $('#rCopy').onclick = async () => { try { await navigator.clipboard.writeText(key); toast('Chave copiada'); } catch { toast('Selecione a chave e copie manualmente'); } };
    $('#rDl').onclick = () => download('chave-de-recuperacao-anamnese.txt',
      `ANAMNESE - CHAVE DE RECUPERAÇÃO\r\nConta: ${email}\r\nGerada em: ${new Date().toLocaleString('pt-BR')}\r\n\r\n${key}\r\n\r\nGuarde este arquivo fora do computador/celular (pendrive, gerenciador de senhas ou impresso).\r\nQuem tiver esta chave e o seu e-mail pode redefinir a senha. Sem ela, esquecendo a senha, os dados NÃO podem ser recuperados.\r\n`, 'text/plain');
    $('#rGo').onclick = () => (needConfirm ? showConfirm(email) : afterAuth());
  }

  function showConfirm(email) {
    show(`${LOGO}<h2>Confirme seu e-mail</h2><p class="muted" style="margin:0">Acabamos de enviar um código para <b>${esc(email)}</b>. Digite-o abaixo (olhe também o spam). Só vale o <b>último</b> código recebido. Se não chegar em 1 minuto, use "Reenviar".</p>
      <form id="fConf"><label class="f">Código<input type="text" id="aOtp" inputmode="numeric" autocomplete="one-time-code" required></label>
        <div id="aInfo" class="muted" style="font-size:13px;min-height:18px"></div><div id="aErr" class="autherr"></div>
        <button class="btn primary" id="aGo" style="justify-content:center;width:100%">Confirmar e entrar</button></form>
      <div class="authlinks"><a id="lResend">Reenviar código</a></div>`);
    let cool = 60, tm = null;   // o Supabase acabou de enviar um código: só aceita outro depois de 60 s
    const tick = () => { const a = $('#lResend'); if (!a) return clearInterval(tm); a.textContent = cool > 0 ? `Reenviar código (${cool}s)` : 'Reenviar código'; a.style.opacity = cool > 0 ? .5 : 1; if (cool-- <= 0) clearInterval(tm); };
    setTimeout(() => { tm = setInterval(tick, 1000); tick(); }, 0);
    $('#lResend').onclick = async () => {
      if (cool > 0) return; err(''); $('#aInfo').textContent = 'Enviando…';
      try { await Vault.resendConfirm(); $('#aInfo').textContent = '✔ Novo código enviado para ' + email + '. Pode levar até 1 minuto; use apenas o mais recente.'; cool = 60; clearInterval(tm); tm = setInterval(tick, 1000); tick(); }
      catch (x) { $('#aInfo').textContent = ''; err(errText(x)); }
    };
    $('#fConf').onsubmit = async e => {
      e.preventDefault(); err(''); busy(true, 'Confirmando…');
      try { resetDb(); await Vault.confirmSignup($('#aOtp').value); await afterAuth(); } catch (x) { err(errText(x)); } finally { busy(false); }
    };
  }

  /* ---------- recuperar senha ---------- */
  function showRecover() {
    show(`${LOGO}<h2>Redefinir senha</h2><p class="muted" style="margin:0">Você precisa de <b>duas</b> coisas: um código enviado ao seu e-mail e a chave de recuperação que guardou ao criar a conta. Seus dados continuam intactos.</p>
      <form id="fRec">
        ${serverField()}
        <label class="f">E-mail<input type="email" id="aEmail" autocomplete="username" required value="${esc(Vault.lastKnown().email)}"></label>
        <button type="button" class="btn" id="aSend" style="justify-content:center;width:100%">Enviar código por e-mail</button>
        <label class="f">Código recebido por e-mail<input type="text" id="aOtp" inputmode="numeric" autocomplete="one-time-code" required></label>
        <label class="f">Chave de recuperação<input type="text" id="aKey" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-…" required></label>
        ${pwField('aPass', 'Nova senha (mín. 12 caracteres)', 'new-password')}
        ${pwField('aPass2', 'Repita a nova senha', 'new-password')}
        <label class="f">Código de 2 etapas (só se você ativou)<input type="text" id="aTotp" inputmode="numeric" autocomplete="off"></label>
        ${trustBox()}
        <div id="aErr" class="autherr"></div>
        <button class="btn primary" id="aGo" style="justify-content:center;width:100%">Redefinir e entrar</button>
      </form>
      <div class="authlinks"><a id="lBack">Voltar</a></div>`);
    bindEyes();
    $('#lBack').onclick = () => showLogin();
    $('#aSend').onclick = async () => {
      err(''); const em = $('#aEmail').value.trim(); if (!em) return err('Digite o e-mail.');
      try { await Vault.recoverStart(em); err(''); $('#aErr').style.color = 'var(--ok)'; $('#aErr').textContent = '✔ Se o e-mail tiver conta, o código foi enviado. Use apenas o mais recente.'; $('#aOtp').focus(); } catch (x) { $('#aErr').style.color = ''; err(errText(x)); }
    };
    $('#fRec').onsubmit = async e => {
      e.preventDefault(); err('');
      if ($('#aPass').value !== $('#aPass2').value) return err('As senhas não são iguais.');
      busy(true, 'Redefinindo…');
      try {
        resetDb();
        await Vault.recover({ server: serverValue(), email: $('#aEmail').value, otp: $('#aOtp').value, recoveryKey: $('#aKey').value, newPassword: $('#aPass').value, totp: $('#aTotp').value.trim(), trusted: $('#aTrust').checked });
        toast('Senha redefinida ✔');
        await afterAuth();
      } catch (x) { err(errText(x)); } finally { busy(false); }
    };
  }

  /* ---------- tela bloqueada ---------- */
  function showUnlock() {
    show(`${LOGO}<h2>Sessão bloqueada</h2><div class="muted" style="text-align:center">${esc(Vault.lockedEmail())}</div>
      <form id="fUnlock">
        ${pwField('aPass', 'Senha', 'current-password')}
        <div id="aErr" class="autherr"></div>
        <button class="btn primary" id="aGo" style="justify-content:center;width:100%">Desbloquear</button>
      </form>
      <div class="authlinks"><a id="lOut">Sair desta conta</a></div>`);
    bindEyes();
    $('#lOut').onclick = async () => { await Vault.logout({ wipe: true }); resetDb(); showLogin(); };
    $('#fUnlock').onsubmit = async e => {
      e.preventDefault(); err(''); busy(true, 'Abrindo…');
      try { await Vault.unlock($('#aPass').value); await afterAuth(true); }
      catch (x) { err(errText(x)); }
      finally { busy(false); }
    };
  }

  /* ---------- depois de entrar ---------- */
  const resetDb = () => { db = DEFAULTS(); };

  async function afterAuth(fromUnlock) {
    hide();
    applyTheme();
    paintMode(); paintStatus();
    bumpIdle();
    if (!fromUnlock) await new Promise(r => offerLegacy(r)); // migração da versão 1.x
    route();
  }

  function legacyData() {
    try {
      const d = JSON.parse(LS.get(LEGACY_KEY));
      if (d && Array.isArray(d.patients) && (d.patients.length || (d.appointments || []).length)) return d;
    } catch {}
    return null;
  }
  function offerLegacy(done) {
    const d = legacyData();
    if (!d) return done();
    const n = d.patients.length, m = (d.appointments || []).length;
    openDialog(`<h2>Dados da versão anterior</h2>
      <p>Encontrei neste aparelho <b>${n} paciente(s)</b> e <b>${m} consulta(s)</b> guardados pela versão antiga, <b>sem criptografia</b>. Quer levá-los para esta conta criptografada?</p>
      <div class="bar" style="flex-wrap:wrap"><button class="btn danger" id="lgDel">Apagar sem importar</button><button class="btn" id="lgLater">Agora não</button><button class="btn primary" id="lgImp">Importar e apagar a cópia antiga</button></div>`);
    $('#lgLater').onclick = () => { closeDialog(); done(); };
    $('#lgDel').onclick = () => { closeDialog(); confirmDlg('Apagar a cópia antiga <b>sem</b> importar? Isso não pode ser desfeito.', 'Apagar', () => { LS.del(LEGACY_KEY); toast('Cópia antiga apagada'); done(); }); };
    $('#lgImp').onclick = async () => {
      const ids = new Set(db.patients.map(p => p.id)), aids = new Set(db.appointments.map(a => a.id));
      d.patients.forEach(p => { if (!ids.has(p.id)) db.patients.push(p); });
      (d.appointments || []).forEach(a => { if (!aids.has(a.id)) db.appointments.push(a); });
      if (!db.settings.profissional && d.settings) { const { pin, ...rest } = d.settings; db.settings = { ...db.settings, ...rest }; }
      await Vault.commit(db);
      LS.del(LEGACY_KEY);
      closeDialog(); toast('Dados importados e cópia antiga apagada ✔'); applyTheme(); done();
    };
  }

  /* ---------- bloqueio automático ---------- */
  let idleT = null, hiddenAt = 0;
  function bumpIdle() {
    clearTimeout(idleT);
    if (!Vault.isUnlocked()) return;
    idleT = setTimeout(() => Vault.lock(), minutes() * 60000);
  }
  function onLocked() {
    clearTimeout(idleT);
    resetDb();
    $('#main').innerHTML = ''; $('#side').innerHTML = ''; $('#bottom').innerHTML = ''; $('#printArea').innerHTML = '';
    closeDialog();
    const pv = $('#preview'); pv.classList.add('hidden'); pv.innerHTML = '';
    $('#modeBanner').classList.add('hidden');
    showUnlock();
  }

  /* ---------- indicadores ---------- */
  function pillHtml() { return '<div class="syncrow"><span id="syncPill" role="button" tabindex="0"><i></i><span id="syncTxt"></span></span></div>'; }
  function paintStatus() {
    const st = Vault.status(), el = $('#syncPill');
    const map = {
      synced: ['ok', 'Sincronizado'], syncing: ['warn', 'Sincronizando…'], pending: ['warn', 'Enviando alterações…'],
      offline: ['warn', st.pending ? `Offline · ${st.pending} alteração(ões) só neste aparelho` : 'Offline'],
      error: ['bad', 'Erro de sincronização'], reauth: ['bad', 'Sessão expirada · toque para entrar'], idle: ['warn', 'Conectando…']
    };
    const [cls, txt] = map[st.state] || map.idle;
    if (el) { el.className = cls; $('#syncTxt').textContent = txt; el.title = st.detail || ''; }
    const ac = $('#acStatus'); if (ac) ac.textContent = txt + (st.lastSync ? ' · última: ' + new Date(st.lastSync).toLocaleTimeString('pt-BR') : '');
    const sd = $('#sideDot'), ss = $('#sideSync'); if (sd) { sd.className = 'sa-dot ' + cls; ss.textContent = txt; }
  }
  function paintMode() {
    const s = Vault.session(), b = $('#modeBanner');
    if (s && s.mode === 'test') { b.textContent = 'MODO TESTE: use apenas pacientes fictícios. Para pacientes reais é preciso hospedagem certificada HDS.'; b.classList.remove('hidden'); }
    else b.classList.add('hidden');
  }
  function onPillClick() {
    const st = Vault.status();
    if (st.state === 'reauth') return reauthDialog();
    Vault.syncNow(); toast('Sincronizando…');
  }
  function reauthDialog() {
    const s = Vault.session();
    openDialog(`<h2>Sessão expirada</h2><p class="muted" style="margin:0">${s && s.totpEnabled ? 'Digite o código de 6 dígitos do aplicativo autenticador para continuar sincronizando.' : 'Toque em continuar para reconectar.'}</p>
      ${s && s.totpEnabled ? '<label class="f">Código<input type="text" id="raC" inputmode="numeric" autocomplete="one-time-code"></label>' : ''}
      <div id="raE" class="autherr"></div><div class="bar"><button class="btn" id="raX">Depois</button><button class="btn primary" id="raOk">Continuar</button></div>`);
    $('#raX').onclick = closeDialog;
    $('#raOk').onclick = async () => {
      const ok = await Vault.silentRelogin(($('#raC') || {}).value);
      if (ok) { closeDialog(); toast('Reconectado ✔'); } else $('#raE').textContent = Vault.status().detail === 'invalid_totp' ? errText({ code: 'invalid_totp' }) : 'Não foi possível reconectar. Tente de novo.';
    };
  }
  function safeRerender() {
    const a = document.activeElement;
    const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && $('#main').contains(a);
    if ($('#pf') || ($('#dlg') && $('#dlg').open) || !$('#preview').classList.contains('hidden') || typing) { toast('Há dados novos de outro aparelho. Volte à lista para ver.'); return; }
    route();
  }

  /* ---------- Ajustes: cartões ---------- */
  function sideFooter() {
    const e = Vault.email() || '';
    return `<button class="side-acct" onclick="location.hash='#/config'"><span class="avatar sm" ${av(e)}>${esc((e[0] || '?').toUpperCase())}</span><span class="sa-t"><b>${esc(e)}</b><small>Conta e segurança</small></span></button>`;
  }

  function settingsCard() {
    const s = Vault.session(); if (!s) return '';
    let host = ''; try { host = new URL(s.server).host; } catch {}
    const e = s.email || '';
    return `<div class="profile"><span class="avatar xl" ${av(e)}>${esc((e[0] || '?').toUpperCase())}</span><div><b>${esc(e)}</b><span>${ICON.lock} Fichas criptografadas neste aparelho</span></div></div>
      <h3 class="sec">Conta e segurança</h3>
      <div class="group">
        <button class="row-btn" id="acSync">${sq('sync', C.blue)}<span>Sincronização</span><span class="rv" id="acStatus"></span><span class="chev">${ICON.chevR}</span></button>
        <button class="row-btn" id="acPw">${sq('key', C.gray)}<span>Alterar senha</span><span class="chev">${ICON.chevR}</span></button>
        <button class="row-btn" id="ac2fa">${sq('shield', C.green)}<span>Verificação em duas etapas</span><span class="rv ${s.totpEnabled ? '' : 'warn'}">${s.totpEnabled ? 'Ativada' : 'Ativar'}</span><span class="chev">${ICON.chevR}</span></button>
        <label class="srow">${sq('timer', C.orange)}<span class="sl">Bloqueio automático</span><select id="acLock" class="sin">${[2, 5, 10, 15, 30].map(m => `<option value="${m}" ${m === minutes() ? 'selected' : ''}>${m} minutos</option>`).join('')}</select></label>
        <div class="srow static">${sq('globe', C.cyan)}<span class="sl">Banco de dados</span><span class="rv">${esc(host)}${s.mode === 'test' ? ' · modo teste' : ''}</span></div>
      </div>
      <div class="group"><button class="row-btn danger" id="acOut">${ICON.logout}<span>Sair deste aparelho</span></button></div>`;
  }

  function privacyCard() {
    const s = Vault.session(); if (!s) return '';
    const it = (ic, c, t, d) => `<div class="prow-i">${sq(ic, c)}<div><b>${t}</b><span>${d}</span></div></div>`;
    return `<h3 class="sec">Privacidade (RGPD)</h3>
      ${s.mode === 'test' ? '<div class="alertcard">' + sq('warn', C.red) + '<div><b>Modo teste</b><span>Não cadastre pacientes reais. Pacientes reais só com hospedagem certificada HDS.</span></div></div>' : ''}
      <div class="group">
        ${it('lock', C.blue, 'Criptografia de ponta a ponta', 'As fichas são cifradas (AES-256) neste aparelho antes de irem ao servidor. Nem o Supabase nem quem administra o projeto conseguem lê-las.')}
        ${it('key', C.gray, 'Acesso protegido', 'Senha forte, verificação em duas etapas, bloqueio automático e sessões que expiram.')}
        ${it('person', C.indigo, 'Direitos do paciente', 'Use “Exportar” na ficha (acesso e portabilidade), “Editar” (retificação) e “Excluir” (apagamento).')}
        ${it('doc', C.orange, 'Informação e consentimento', 'Informe o paciente sobre o tratamento dos dados (art. 13 do RGPD) e registre o consentimento na ficha.')}
        ${it('timer', C.purple, 'Conservação', 'Defina e respeite um prazo; apague fichas que não precisa mais guardar (referência CNIL: 5 anos ativos + 15 de arquivo).')}
        ${it('warn', C.red, 'Incidentes', 'Em caso de perda ou vazamento de dados, avise a CNIL em até 72 horas.')}
      </div>`;
  }

  function bindSettings() {
    paintStatus();
    $('#acSync').onclick = () => { Vault.syncNow(); toast('Sincronizando…'); };
    $('#acLock').onchange = e => { LS.set(LOCK_KEY, e.target.value); bumpIdle(); toast('Bloqueio automático: ' + e.target.value + ' min'); };
    $('#acOut').onclick = () => confirmDlg('Sair e <b>apagar os dados deste aparelho</b>? Eles continuam seguros na sua conta e voltam quando você entrar de novo (é preciso estar online).', 'Sair', async () => { await Vault.logout({ wipe: true }); clearTimeout(idleT); onLockedClean(); showLogin(); });
    $('#acPw').onclick = changePwDialog;
    $('#ac2fa').onclick = () => (Vault.session().totpEnabled ? disable2fa() : setup2fa());
  }
  function onLockedClean() {
    resetDb(); $('#main').innerHTML = ''; $('#side').innerHTML = ''; $('#bottom').innerHTML = ''; $('#printArea').innerHTML = ''; $('#modeBanner').classList.add('hidden');
  }

  function changePwDialog() {
    openDialog(`<h2>Alterar senha</h2>
      ${pwField('cpOld', 'Senha atual', 'current-password')}${pwField('cpNew', 'Nova senha (mín. 12 caracteres)', 'new-password')}${pwField('cpNew2', 'Repita a nova senha', 'new-password')}
      <div id="cpE" class="autherr"></div><div class="bar"><button class="btn" id="cpX">Cancelar</button><button class="btn primary" id="aGo">Alterar</button></div>`);
    bindEyes(); $('#cpX').onclick = closeDialog;
    $('#aGo').onclick = async () => {
      if ($('#cpNew').value !== $('#cpNew2').value) return ($('#cpE').textContent = 'As senhas não são iguais.');
      busy(true, 'Alterando…');
      try { await Vault.changePassword($('#cpOld').value, $('#cpNew').value); closeDialog(); toast('Senha alterada ✔ (outros aparelhos precisarão entrar de novo)'); }
      catch (x) { $('#cpE').textContent = errText(x); busy(false); }
    };
  }

  async function setup2fa() {
    try {
      const r = await Vault.totpSetup();
      const q = qrcode(0, 'M'); q.addData(r.uri); q.make();
      const svg = q.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
      openDialog(`<h2>Ativar verificação em duas etapas</h2>
        <p class="muted" style="margin:0">1) Abra um aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Aegis, 2FAS…).<br>2) Escaneie o QR code, ou digite a chave.<br>3) Digite abaixo o código de 6 dígitos que aparecer.<br><b>Atenção:</b> não há códigos de reserva. Se perder o celular, será preciso remover o fator no painel do Supabase.</p>
        <div class="qrbox">${svg}</div><div class="reckey" style="font-size:14px">${esc(r.secret.match(/.{1,4}/g).join(' '))}</div>
        <label class="f">Código<input type="text" id="t2c" inputmode="numeric" autocomplete="one-time-code" maxlength="7"></label>
        <div id="t2e" class="autherr"></div><div class="bar"><button class="btn" id="t2x">Cancelar</button><button class="btn primary" id="aGo">Ativar</button></div>`);
      $('#t2x').onclick = closeDialog;
      $('#aGo').onclick = async () => {
        busy(true, 'Verificando…');
        try { const res = await Vault.totpEnable($('#t2c').value); if (res.backupCodes && res.backupCodes.length) showBackupCodes(res.backupCodes); else { closeDialog(); toast('Duas etapas ativada ✔'); route(); } }
        catch (x) { $('#t2e').textContent = errText(x); busy(false); }
      };
    } catch (x) { toast(errText(x)); }
  }
  function showBackupCodes(codes) {
    openDialog(`<h2>Códigos de reserva</h2><p class="muted" style="margin:0">Se perder o celular, cada código abaixo entra <b>uma vez</b> no lugar do código do aplicativo. Guarde-os fora deste aparelho. Eles não serão mostrados de novo.</p>
      <div class="reckey" style="font-size:16px;line-height:1.8">${codes.map(esc).join('<br>')}</div>
      <div class="bar"><button class="btn" id="bcDl">Baixar</button><button class="btn primary" id="bcOk">Já guardei</button></div>`);
    $('#bcDl').onclick = () => download('codigos-de-reserva-anamnese.txt', 'ANAMNESE - CÓDIGOS DE RESERVA (uso único)\r\n\r\n' + codes.join('\r\n') + '\r\n', 'text/plain');
    $('#bcOk').onclick = () => { closeDialog(); toast('Duas etapas ativada ✔'); route(); };
  }
  function disable2fa() {
    openDialog(`<h2>Desativar duas etapas</h2>${pwField('d2p', 'Senha', 'current-password')}
      <label class="f">Código do aplicativo<input type="text" id="d2c" inputmode="numeric" autocomplete="one-time-code"></label>
      <div id="d2e" class="autherr"></div><div class="bar"><button class="btn" id="d2x">Cancelar</button><button class="btn danger" id="aGo">Desativar</button></div>`);
    bindEyes(); $('#d2x').onclick = closeDialog;
    $('#aGo').onclick = async () => {
      busy(true, 'Desativando…');
      try { await Vault.totpDisable($('#d2p').value, $('#d2c').value.trim()); closeDialog(); toast('Duas etapas desativada'); route(); }
      catch (x) { $('#d2e').textContent = errText(x); busy(false); }
    };
  }

  function deleteAccountDialog() {
    const s = Vault.session();
    openDialog(`<h2>Excluir conta e todos os dados</h2><p>Isso apaga <b>definitivamente</b> a conta e todas as fichas do servidor e deste aparelho. Não há como desfazer. Exporte um backup antes se precisar.</p>
      ${pwField('dlP', 'Senha', 'current-password')}${s && s.totpEnabled ? '<label class="f">Código de 2 etapas<input type="text" id="dlC" inputmode="numeric"></label>' : ''}
      <div id="dlE" class="autherr"></div><div class="bar"><button class="btn" id="dlX">Cancelar</button><button class="btn danger" id="aGo">Excluir tudo</button></div>`);
    bindEyes(); $('#dlX').onclick = closeDialog;
    $('#aGo').onclick = async () => {
      busy(true, 'Excluindo…');
      try { await Vault.deleteAccount($('#dlP').value, ($('#dlC') || {}).value); closeDialog(); onLockedClean(); clearTimeout(idleT); toast('Conta excluída'); showLogin(); }
      catch (x) { $('#dlE').textContent = errText(x); busy(false); }
    };
  }

  /* ---------- início ---------- */
  function init() {
    Vault.init({ getDb: () => db, defaultSettings: () => DEFAULTS().settings, onRemote: safeRerender, onStatus: paintStatus, onLock: onLocked });
    ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(ev => document.addEventListener(ev, bumpIdle, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (Vault.isUnlocked()) {
        if (hiddenAt && Date.now() - hiddenAt >= minutes() * 60000) Vault.lock(); else { bumpIdle(); Vault.syncNow(); }
      }
      hiddenAt = 0;
    });
    window.addEventListener('online', () => Vault.isUnlocked() && Vault.syncNow());
    setInterval(() => { if (Vault.isUnlocked()) Vault.syncNow(); }, 60000);
    document.addEventListener('click', e => { if (e.target.closest && e.target.closest('#syncPill')) onPillClick(); });
    showLogin();
  }

  return { init, errText, pillHtml, paintStatus, sideFooter, settingsCard, privacyCard, bindSettings, deleteAccountDialog, lockNow: () => Vault.lock() };
})();
