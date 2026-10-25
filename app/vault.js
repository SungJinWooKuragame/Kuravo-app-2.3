/*
 * Anamnese – cofre criptografado + contas + sincronização (v2.0)
 *
 * Modelo de segurança ("conhecimento zero"):
 *   senha ──PBKDF2-SHA256 (600 000 iterações)──► mestre ──HKDF──► authSecret (vai ao servidor)
 *                                                          └────► kek        (NUNCA sai do aparelho)
 *   chave de dados (DK, aleatória, 256 bits) é guardada "embrulhada" pela kek (e pela chave de recuperação).
 *   Cada ficha/consulta é cifrada com a DK (AES-256-GCM) ANTES de sair do aparelho.
 *   O servidor só vê blocos ilegíveis. Quem não tem a senha (nem a chave de recuperação) não lê nada.
 */
(function (global) {
  'use strict';

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const PREFIX = 'anamnese2:';
  const KDF = { v: 1, alg: 'PBKDF2-SHA256', iter: 600000 };

  class VaultError extends Error {
    constructor(code, message, extra) { super(message || code); this.code = code; Object.assign(this, extra || {}); }
  }

  /* ---------------- codificação ---------------- */
  const b64u = {
    enc(buf) {
      const b = new Uint8Array(buf); let s = '';
      for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    dec(str) {
      str = String(str).replace(/-/g, '+').replace(/_/g, '/');
      while (str.length % 4) str += '=';
      const s = atob(str), b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
      return b;
    }
  };
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function b32enc(bytes) {
    let bits = 0, v = 0, out = '';
    for (const b of bytes) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += B32[(v << (5 - bits)) & 31];
    return out;
  }
  function b32dec(s) {
    let bits = 0, v = 0; const out = [];
    for (const c of s) { const i = B32.indexOf(c); if (i < 0) throw new Error('b32'); v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
    return new Uint8Array(out);
  }
  const rand = n => crypto.getRandomValues(new Uint8Array(n));
  const normEmail = e => String(e || '').trim().toLowerCase();

  /* ---------------- criptografia ---------------- */
  function needCrypto() {
    if (!(global.crypto && crypto.subtle)) throw new VaultError('no_crypto', 'Este aparelho/navegador não oferece criptografia segura (é preciso HTTPS).');
  }

  async function deriveKeys(password, email) {
    needCrypto();
    const base = await crypto.subtle.importKey('raw', enc.encode(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
    const master = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('anamnese.v1|' + normEmail(email)), iterations: KDF.iter }, base, 256);
    const hk = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
    const hkdf = info => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) });
    const authSecret = b64u.enc(await crypto.subtle.deriveBits(hkdf('anamnese/auth'), hk, 256));
    const kek = await crypto.subtle.deriveKey(hkdf('anamnese/kek'), hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return { authSecret, kek };
  }

  async function deriveRecovery(recBytes) {
    const hk = await crypto.subtle.importKey('raw', recBytes, 'HKDF', false, ['deriveBits', 'deriveKey']);
    const hkdf = info => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) });
    const recAuth = b64u.enc(await crypto.subtle.deriveBits(hkdf('anamnese/rec-auth'), hk, 256));
    const recKek = await crypto.subtle.deriveKey(hkdf('anamnese/rec-kek'), hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return { recAuth, recKek };
  }

  async function wrapRaw(kek, raw) {
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('wrap') }, kek, raw);
    return 'v1.' + b64u.enc(iv) + '.' + b64u.enc(ct);
  }
  async function unwrapRaw(kek, s) {
    const p = String(s).split('.');
    if (p.length !== 3 || p[0] !== 'v1') throw new Error('formato');
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(p[1]), additionalData: enc.encode('wrap') }, kek, b64u.dec(p[2])));
  }
  const importDk = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

  async function sealRecord(dk, accountId, id, obj) {
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(accountId + ':' + id) }, dk, enc.encode(JSON.stringify(obj)));
    return 'v1.' + b64u.enc(iv) + '.' + b64u.enc(ct);
  }
  async function openRecord(dk, accountId, id, blob) {
    const p = String(blob).split('.');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(p[1]), additionalData: enc.encode(accountId + ':' + id) }, dk, b64u.dec(p[2]));
    return JSON.parse(dec.decode(pt));
  }

  const formatRecovery = bytes => b32enc(bytes).match(/.{1,4}/g).join('-');
  function parseRecovery(text) {
    const s = String(text || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    if (s.length !== 32) throw new VaultError('bad_recovery_key', 'Chave de recuperação incompleta (são 32 letras e números).');
    try { return b32dec(s); } catch { throw new VaultError('bad_recovery_key', 'Chave de recuperação inválida.'); }
  }

  /* ---------------- regras de senha / servidor ---------------- */
  const COMMON = ['123456789012', 'password1234', 'motdepasse12', 'azertyuiop12', 'qwertyuiop12', 'abcdefghijkl', 'senhasenhasenha'];
  function pwIssue(pw, email) {
    pw = String(pw || '');
    if (pw.length < 12) return 'Use pelo menos 12 caracteres.';
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
    if (classes < 3 && pw.length < 16) return 'Misture maiúsculas, minúsculas, números e símbolos, ou use uma frase longa (16 caracteres ou mais).';
    const local = String(email || '').split('@')[0].toLowerCase();
    if (local.length >= 4 && pw.toLowerCase().includes(local)) return 'A senha não pode conter o seu e-mail.';
    if (COMMON.includes(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) return 'Essa senha é muito comum.';
    return '';
  }
  function normServer() { return apiUrl(); }   // o servidor é o projeto Supabase de config.js

  /* ---------------- rede (Supabase) ---------------- */
  const cfg = () => global.ANAMNESE_CONFIG || {};
  const apiUrl = () => String(cfg().supabaseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = () => String(cfg().supabaseKey || '').trim();
  const MODE = () => (cfg().mode === 'production' ? 'production' : 'test');

  function mapError(status, j) {
    j = (j && typeof j === 'object') ? j : {};
    const msg = String(j.message || j.msg || j.error_description || (typeof j.error === 'string' ? j.error : '') || '');
    const ec = String(j.error_code || '');
    if (status === 429 || ec === 'over_request_rate_limit' || ec === 'over_email_send_rate_limit') return 'rate_limited';
    if (ec === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'invalid_credentials';
    if (ec === 'email_not_confirmed' || /email not confirmed/i.test(msg)) return 'email_not_confirmed';
    if (ec === 'user_already_exists' || ec === 'email_exists' || /already (been )?registered/i.test(msg)) return 'email_taken';
    if (ec === 'signup_disabled') return 'registration_closed';
    if (ec === 'same_password') return 'same_password';
    if (ec === 'mfa_verification_failed' || ec === 'mfa_challenge_expired') return 'invalid_totp';
    if (/^(invalid_invite|bad_request|too_large|quota_exceeded|unauthorized|no_vault|mfa_required)$/.test(msg)) return msg;
    if (j.code === 'PGRST301' || j.code === 'PGRST303' || /jwt expired/i.test(msg)) return 'unauthorized';
    if (/error sending (confirmation|recovery|magic|email)|email address not authorized|smtp/i.test(msg) || ec === 'unexpected_failure' && /sending/i.test(msg)) return 'email_send_failed';
    if (status === 500 && /database error saving new user/i.test(msg)) return 'invalid_invite';
    if (status === 401) return 'unauthorized';
    return 'http_' + status;
  }

  async function sb(method, path, { body, token, prefer } = {}) {
    if (!apiUrl() || !apiKey()) throw new VaultError('not_configured', 'Este aplicativo ainda não foi ligado ao Supabase (arquivo config.js).');
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000);
    let res;
    try {
      res = await fetch(apiUrl() + path, {
        method, signal: ctl.signal, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', apikey: apiKey(), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(prefer ? { Prefer: prefer } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch { throw new VaultError('network', 'Sem conexão com o servidor.'); }
    finally { clearTimeout(t); }
    const text = await res.text(); let j = {}; try { j = text ? JSON.parse(text) : {}; } catch {}
    if (!res.ok) throw new VaultError(mapError(res.status, j), String(j.message || j.msg || j.error_description || ('HTTP ' + res.status)), { status: res.status, retryAfter: +res.headers.get('retry-after') || undefined });
    return j;
  }

  /* ---- contas (Supabase Auth). A "senha" enviada ao Supabase é o authSecret derivado: a senha real nunca sai do aparelho. ---- */
  const factorsOf = u => ((u && u.factors) || []).filter(f => f.factor_type === 'totp' && f.status === 'verified');
  const tokensOf = r => ({ token: r.access_token, refresh: r.refresh_token });

  async function mfaVerify(token, factorId, code) {
    const ch = await sb('POST', `/auth/v1/factors/${factorId}/challenge`, { token, body: {} });
    try { return await sb('POST', `/auth/v1/factors/${factorId}/verify`, { token, body: { challenge_id: ch.id, code: String(code || '').replace(/\s/g, '') } }); }
    catch (e) { if (e.code === 'network' || e.code === 'rate_limited') throw e; throw new VaultError('invalid_totp', 'Código inválido.'); }
  }

  async function sbSignIn(email, authSecret, totp) {
    const t = await sb('POST', '/auth/v1/token?grant_type=password', { body: { email, password: authSecret } });
    let tok = tokensOf(t);
    const user = (t.user && t.user.factors !== undefined && t.user.factors !== null) ? t.user : await sb('GET', '/auth/v1/user', { token: tok.token });
    const fs = factorsOf(user);
    if (fs.length) {
      if (!totp) throw new VaultError('need_totp', 'Digite o código do aplicativo autenticador.');
      tok = tokensOf(await mfaVerify(tok.token, fs[0].id, totp));
    }
    const rows = await sb('GET', '/rest/v1/vaults?select=wrap_pw,kdf&limit=1', { token: tok.token });
    if (!Array.isArray(rows) || !rows[0]) throw new VaultError('no_vault', 'Esta conta não tem cofre de dados. Crie a conta de novo.');
    return { ...tok, accountId: (t.user && t.user.id) || user.id, wrapPw: rows[0].wrap_pw, kdf: rows[0].kdf, totpEnabled: fs.length > 0, mode: MODE() };
  }

  /* ---------------- estado ---------------- */
  let S = null;   // sessão desbloqueada
  let L = null;   // sessão bloqueada (sem chaves na memória)
  let statusNow = { state: 'idle', detail: '' };
  const hooks = { getDb() { return null; }, defaultSettings() { return {}; }, onRemote() {}, onStatus() {}, onLock() {} };

  const storeFor = trusted => (trusted ? localStorage : sessionStorage);
  const cacheKey = email => PREFIX + 'cache:' + normEmail(email);
  function readCache(email, trusted) {
    try {
      const raw = storeFor(trusted).getItem(cacheKey(email));
      if (!raw) return null;
      const c = JSON.parse(raw);
      return c && c.v === 1 && c.records ? c : null;
    } catch { return null; }
  }
  function persist() {
    if (!S) return;
    try { storeFor(S.trusted).setItem(cacheKey(S.email), JSON.stringify(S.cache)); }
    catch { setStatus('error', 'Armazenamento local cheio ou bloqueado.'); }
  }
  function setStatus(state, detail) { statusNow = { state, detail: detail || '' }; try { hooks.onStatus(state, detail || ''); } catch {} }
  const pendingCount = () => (S ? Object.values(S.cache.records).filter(r => r.dirty).length : 0);

  function rememberLast(email, server, trusted) {
    try {
      localStorage.setItem(PREFIX + 'server', server);
      if (trusted) localStorage.setItem(PREFIX + 'last', JSON.stringify({ email: normEmail(email) }));
      else localStorage.removeItem(PREFIX + 'last');
    } catch {}
  }
  function lastKnown() {
    let email = '', server = '';
    try { email = (JSON.parse(localStorage.getItem(PREFIX + 'last')) || {}).email || ''; server = localStorage.getItem(PREFIX + 'server') || ''; } catch {}
    return { email, server };
  }

  /* ---------------- dados em memória ← registros ---------------- */
  const upsert = (arr, d) => { const i = arr.findIndex(x => x.id === d.id); if (i < 0) arr.push(d); else arr[i] = d; };
  function applyEntity(db, ent) {
    if (!ent || typeof ent !== 'object') return;
    if (ent.k === 'p') upsert(db.patients, ent.d);
    else if (ent.k === 'a') upsert(db.appointments, ent.d);
    else if (ent.k === 's') db.settings = { ...hooks.defaultSettings(), ...ent.d };
  }
  function removeEntity(db, id) {
    db.patients = db.patients.filter(p => p.id !== id);
    db.appointments = db.appointments.filter(a => a.id !== id);
  }

  async function loadFromCache() {
    const db = hooks.getDb(); let bad = 0;
    S.snap = new Map();
    for (const [id, r] of Object.entries(S.cache.records)) {
      if (r.deleted) continue;
      try { const ent = await openRecord(S.dk, S.accountId, id, r.blob); applyEntity(db, ent); S.snap.set(id, JSON.stringify(ent)); }
      catch { bad++; }
    }
    if (bad) setStatus('error', bad + ' registro(s) não puderam ser lidos neste aparelho.');
  }

  /* ---------------- gravação local (criptografa só o que mudou) ---------------- */
  let chain = Promise.resolve();
  function commit(db) {
    if (!S) return Promise.resolve();
    const p = chain.then(() => doCommit(db)).catch(e => { console.error('commit', e); setStatus('error', 'Falha ao gravar.'); });
    chain = p; return p;
  }
  async function doCommit(db) {
    if (!S) return;
    const next = new Map();
    for (const p of db.patients || []) next.set(p.id, { k: 'p', d: p });
    for (const a of db.appointments || []) next.set(a.id, { k: 'a', d: a });
    next.set('settings', { k: 's', d: db.settings });
    const now = Date.now(); let n = 0;
    const tsFor = id => Math.max(now, ((S.cache.records[id] || {}).ts || 0) + 1);
    for (const [id, ent] of next) {
      const js = JSON.stringify(ent);
      if (S.snap.get(id) === js) continue;
      const blob = await sealRecord(S.dk, S.accountId, id, ent);
      S.cache.records[id] = { blob, ts: tsFor(id), deleted: false, dirty: true };
      S.snap.set(id, js); n++;
    }
    for (const id of [...S.snap.keys()]) {
      if (next.has(id)) continue;
      S.cache.records[id] = { blob: '', ts: tsFor(id), deleted: true, dirty: true };
      S.snap.delete(id); n++;
    }
    if (n) { persist(); setStatus(S.token ? 'pending' : 'offline', ''); syncSoon(); }
  }

  /* ---------------- sincronização ---------------- */
  let syncTimer = null, syncing = false, again = false;
  function syncSoon(ms = 700) { clearTimeout(syncTimer); syncTimer = setTimeout(() => { syncNow(); }, ms); }

  async function syncNow() {
    if (!S) return;
    if (!S.token) { if (S.needLogin) { setStatus('reauth', ''); return; } await silentRelogin(); return; } // abriu offline: tenta obter sessão agora
    if (syncing) { again = true; return; }
    syncing = true; setStatus('syncing', '');
    const sess = S;
    try {
      let rounds = 0, changed = false;
      for (;;) {
        if (S !== sess) return;
        const dirty = Object.entries(S.cache.records).filter(([, r]) => r.dirty).slice(0, 100);
        const changes = dirty.map(([id, r]) => ({ id, blob: r.deleted ? '' : r.blob, deleted: !!r.deleted, ts: r.ts }));
        const res = await sb('POST', '/rest/v1/rpc/sync_records', { token: S.token, body: { p_since: S.cache.lastSeq, p_changes: changes } });
        if (S !== sess) return;
        for (const id of res.accepted) if (S.cache.records[id]) S.cache.records[id].dirty = false;
        for (const id of res.stale) if (S.cache.records[id]) S.cache.records[id].dirty = false; // a versão do servidor é mais nova
        // servidor "voltou no tempo" (restaurado de backup): reenvia tudo o que temos
        if (res.next < S.cache.lastSeq && !S.resynced) {
          S.resynced = true; S.cache.lastSeq = 0;
          for (const r of Object.values(S.cache.records)) r.dirty = true;
          continue;
        }
        const db = hooks.getDb();
        for (const r of res.records) {
          const local = S.cache.records[r.id];
          if (local && local.dirty && local.ts > r.ts) continue;                       // nossa edição é mais nova: será enviada
          if (local && local.blob === (r.deleted ? '' : r.blob) && !!local.deleted === !!r.deleted) { local.ts = r.ts; continue; }
          S.cache.records[r.id] = { blob: r.deleted ? '' : r.blob, ts: r.ts, deleted: !!r.deleted, dirty: false };
          if (r.deleted) { removeEntity(db, r.id); S.snap.delete(r.id); changed = true; continue; }
          try {
            const ent = await openRecord(S.dk, S.accountId, r.id, r.blob);
            applyEntity(db, ent); S.snap.set(r.id, JSON.stringify(ent)); changed = true;
          } catch { setStatus('error', 'Um registro recebido não pôde ser decifrado.'); }
        }
        S.cache.lastSeq = res.next;
        persist();
        rounds++;
        const left = Object.values(S.cache.records).some(r => r.dirty);
        if (!res.more && !left) break;
        if (rounds > 200) break;
      }
      S.lastSync = Date.now();
      setStatus('synced', '');
      if (changed) { try { hooks.onRemote(); } catch (e) { console.error(e); } }
    } catch (e) {
      if (e.code === 'network') setStatus('offline', '');
      else if (e.code === 'mfa_required') { S.token = null; S.needLogin = true; S.totpEnabled = true; setStatus('reauth', 'need_totp'); }
      else if (e.status === 401 || e.code === 'unauthorized') { S.token = null; S.needLogin = true; await silentRelogin(); }
      else if (e.code === 'quota_exceeded') setStatus('error', 'Limite de registros do servidor atingido.');
      else setStatus('error', e.code || 'erro');
    } finally {
      syncing = false;
      if (again) { again = false; syncSoon(200); }
    }
  }

  // sessão expirou: renova com o refresh token ou, se precisar, entra de novo com o segredo que está só na memória (2FA exige digitar o código)
  async function silentRelogin(totp) {
    if (!S) { setStatus('reauth', ''); return false; }
    try {
      if (S.refresh && !totp) {
        try {
          const r = await sb('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: S.refresh } });
          S.token = r.access_token; S.refresh = r.refresh_token; S.needLogin = false; persist(); syncSoon(100); return true;
        } catch (e) { if (e.code === 'network') throw e; S.refresh = null; }
      }
      if (!S.authSecret) { setStatus('reauth', ''); return false; }
      const r = await sbSignIn(S.email, S.authSecret, totp);
      S.token = r.token; S.refresh = r.refresh; S.needLogin = false; S.totpEnabled = !!r.totpEnabled;
      if (r.wrapPw) S.cache.wrapPw = r.wrapPw;
      persist(); syncSoon(100); return true;
    } catch (e) {
      if (e.code === 'network') { setStatus('offline', ''); return false; }
      if (e.code === 'need_totp' || e.code === 'invalid_totp') { S.needLogin = true; S.totpEnabled = true; setStatus('reauth', e.code); return false; }
      setStatus('reauth', e.code || ''); return false;
    }
  }

  /* ---------------- sessão ---------------- */
  async function startSession({ server, email, keys, dk, dkRaw, accountId, token, refresh, wrapPw, trusted, totpEnabled, mode, offline }) {
    const cache = (offline ? readCache(email, trusted) : readCache(email, trusted)) || { v: 1, email, accountId, wrapPw, lastSeq: 0, records: {} };
    if (cache.accountId && accountId && cache.accountId !== accountId) { cache.records = {}; cache.lastSeq = 0; } // outra conta com o mesmo e-mail
    cache.accountId = accountId || cache.accountId; if (wrapPw) cache.wrapPw = wrapPw;
    S = { server, email, accountId: cache.accountId, token: token || null, refresh: refresh || null, dk, dkRaw, authSecret: keys.authSecret, trusted, cache, snap: new Map(), totpEnabled: !!totpEnabled, mode: mode || '', needLogin: false, resynced: false, lastSync: 0 };
    L = null;
    rememberLast(email, server, trusted);
    persist();
    await loadFromCache();
    return S;
  }

  async function login({ server, email, password, totp, trusted = true, _keys, _pre }) {
    email = normEmail(email); server = normServer(server);
    if (!server) throw new VaultError('not_configured', 'Este aplicativo ainda não foi ligado ao Supabase (arquivo config.js).');
    const keys = _keys || await deriveKeys(password, email);
    let r = _pre;
    try {
      if (!r) r = await sbSignIn(email, keys.authSecret, totp);
    } catch (e) {
      if (e.code !== 'network') throw e;
      // sem internet: abre com o cache local, se este aparelho já tiver entrado antes
      const cache = readCache(email, trusted);
      if (!cache || !cache.wrapPw) throw new VaultError('network_first', 'Sem conexão. Na primeira vez neste aparelho é preciso estar online.');
      let dkRaw; try { dkRaw = await unwrapRaw(keys.kek, cache.wrapPw); } catch { throw new VaultError('invalid_credentials', 'E-mail ou senha incorretos.'); }
      await startSession({ server, email, keys, dk: await importDk(dkRaw), dkRaw, accountId: cache.accountId, token: null, trusted, offline: true });
      setStatus('offline', '');
      return { offline: true };
    }
    let dkRaw;
    try { dkRaw = await unwrapRaw(keys.kek, r.wrapPw); }
    catch { throw new VaultError('crypto_failed', 'Não foi possível abrir o cofre com esta senha.'); }
    await startSession({ server, email, keys, dk: await importDk(dkRaw), dkRaw, accountId: r.accountId, token: r.token, refresh: r.refresh, wrapPw: r.wrapPw, trusted, totpEnabled: r.totpEnabled, mode: r.mode });
    if (S.cache.lastSeq === 0) { await syncNow(); } else syncSoon(50);
    return { offline: false, mode: r.mode, totpEnabled: r.totpEnabled };
  }

  async function register({ server, email, password, invite, trusted = true }) {
    email = normEmail(email); server = normServer(server);
    if (!server) throw new VaultError('not_configured', 'Este aplicativo ainda não foi ligado ao Supabase (arquivo config.js).');
    const issue = pwIssue(password, email);
    if (issue) throw new VaultError('weak_password', issue);
    const keys = await deriveKeys(password, email);
    const dkRaw = rand(32), recBytes = rand(20);
    const rk = await deriveRecovery(recBytes);
    const wrapPw = await wrapRaw(keys.kek, dkRaw), wrapRec = await wrapRaw(rk.recKek, dkRaw);
    // o gatilho do banco confere o convite e cria o cofre (chaves já embrulhadas/cifradas) na mesma operação
    const r = await sb('POST', '/auth/v1/signup', { body: { email, password: keys.authSecret, data: { invite, wrap_pw: wrapPw, wrap_rec: wrapRec, kdf: KDF } } });
    if (!r || !r.access_token) {   // o projeto exige confirmar o e-mail: o Supabase enviou um código de 6 dígitos
      pendingSignup = { server, email, keys, trusted };
      return { recoveryKey: formatRecovery(recBytes), needConfirm: true };
    }
    await login({ server, email, password, trusted, _keys: keys });
    return { recoveryKey: formatRecovery(recBytes) };
  }

  let pendingSignup = null;
  async function confirmSignup(code) {
    if (!pendingSignup) throw new VaultError('no_session', 'Comece o cadastro de novo.');
    const { server, email, keys, trusted } = pendingSignup;
    try { await sb('POST', '/auth/v1/verify', { body: { type: 'signup', email, token: String(code || '').replace(/\s/g, '') } }); }
    catch (e) { if (e.code === 'network' || e.code === 'rate_limited') throw e; throw new VaultError('invalid_otp', 'Código do e-mail inválido ou expirado. Peça um novo.'); }
    await login({ server, email, password: null, trusted, _keys: keys });
    pendingSignup = null;
    return true;
  }
  // e-mail ainda não confirmado (ex.: o app foi fechado antes): refaz o estado do cadastro a partir da senha digitada e reenvia o código
  async function beginConfirm({ server, email, password, trusted = true }) {
    email = normEmail(email); server = normServer(server);
    pendingSignup = { server, email, keys: await deriveKeys(password, email), trusted };
    await sb('POST', '/auth/v1/resend', { body: { type: 'signup', email } });
    return true;
  }
  async function resendConfirm() {
    if (!pendingSignup) throw new VaultError('no_session', 'Comece o cadastro de novo.');
    await sb('POST', '/auth/v1/resend', { body: { type: 'signup', email: pendingSignup.email } });
    return true;
  }

  // 1º passo da recuperação: o Supabase envia um código de 6 dígitos para o e-mail
  async function recoverStart(email) {
    await sb('POST', '/auth/v1/recover', { body: { email: normEmail(email) } });
    return true;
  }

  // 2º passo: código do e-mail + chave de recuperação (os dois são necessários) + nova senha
  async function recover({ server, email, otp, recoveryKey, newPassword, totp, trusted = true }) {
    email = normEmail(email); server = normServer(server);
    if (!server) throw new VaultError('not_configured', 'Este aplicativo ainda não foi ligado ao Supabase (arquivo config.js).');
    const issue = pwIssue(newPassword, email);
    if (issue) throw new VaultError('weak_password', issue);
    const rk = await deriveRecovery(parseRecovery(recoveryKey));
    let v;
    try { v = await sb('POST', '/auth/v1/verify', { body: { type: 'recovery', email, token: String(otp || '').replace(/\s/g, '') } }); }
    catch (e) { if (e.code === 'network' || e.code === 'rate_limited') throw e; throw new VaultError('invalid_otp', 'Código do e-mail inválido ou expirado. Peça um novo.'); }
    let tok = tokensOf(v);
    const u = await sb('GET', '/auth/v1/user', { token: tok.token });
    const fs = factorsOf(u);
    if (fs.length) {
      if (!totp) throw new VaultError('need_totp_recovery', 'Você ativou a verificação em duas etapas: digite também o código do aplicativo e peça um novo código por e-mail.');
      tok = tokensOf(await mfaVerify(tok.token, fs[0].id, totp));
    }
    const rows = await sb('GET', '/rest/v1/vaults?select=wrap_rec&limit=1', { token: tok.token });
    if (!Array.isArray(rows) || !rows[0]) throw new VaultError('no_vault', 'Esta conta não tem cofre de dados.');
    let dkRaw;
    try { dkRaw = await unwrapRaw(rk.recKek, rows[0].wrap_rec); } catch { throw new VaultError('bad_recovery_key', 'Chave de recuperação incorreta.'); }
    const nk = await deriveKeys(newPassword, email);
    const newWrapPw = await wrapRaw(nk.kek, dkRaw);
    await sb('PATCH', `/rest/v1/vaults?user_id=eq.${u.id}`, { token: tok.token, body: { wrap_pw: newWrapPw }, prefer: 'return=minimal' });
    await sb('PUT', '/auth/v1/user', { token: tok.token, body: { password: nk.authSecret } });
    return login({ server, email, password: newPassword, trusted, _keys: nk, _pre: { ...tok, accountId: u.id, wrapPw: newWrapPw, totpEnabled: fs.length > 0, mode: MODE() } });
  }

  function lock() {
    if (!S) return;
    persist();
    clearTimeout(syncTimer);
    L = { email: S.email, server: S.server, token: S.token, refresh: S.refresh, trusted: S.trusted, cache: S.cache, accountId: S.accountId, totpEnabled: S.totpEnabled, mode: S.mode };
    S = null;
    try { hooks.onLock(); } catch {}
  }

  let unlockFails = 0;
  async function unlock(password) {
    if (!L) throw new VaultError('no_session', 'Nenhuma sessão para desbloquear.');
    if (unlockFails >= 3) await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (unlockFails - 3), 15000)));
    const keys = await deriveKeys(password, L.email);
    let dkRaw;
    try { dkRaw = await unwrapRaw(keys.kek, L.cache.wrapPw); }
    catch { unlockFails++; throw new VaultError('invalid_credentials', 'Senha incorreta.'); }
    unlockFails = 0;
    const l = L;
    S = { server: l.server, email: l.email, accountId: l.accountId, token: l.token, refresh: l.refresh, dk: await importDk(dkRaw), dkRaw, authSecret: keys.authSecret, trusted: l.trusted, cache: l.cache, snap: new Map(), totpEnabled: l.totpEnabled, mode: l.mode, needLogin: !l.token, resynced: false, lastSync: 0 };
    L = null;
    await loadFromCache();
    if (S.token) syncSoon(50); else if (!(await silentRelogin())) setStatus(statusNow.state === 'reauth' ? 'reauth' : 'offline', '');
    return true;
  }

  async function logout({ wipe = true } = {}) {
    const sess = S || L;
    if (!sess) return;
    if (sess.token) { try { await sb('POST', '/auth/v1/logout', { token: sess.token, body: {} }); } catch {} }
    if (wipe) {
      try { localStorage.removeItem(cacheKey(sess.email)); sessionStorage.removeItem(cacheKey(sess.email)); localStorage.removeItem(PREFIX + 'last'); } catch {}
    }
    clearTimeout(syncTimer); S = null; L = null;
    setStatus('idle', '');
  }

  /* ---------------- conta ---------------- */
  const need = () => { if (!S) throw new VaultError('locked', 'Sessão bloqueada.'); if (!S.token) throw new VaultError('offline', 'É preciso estar online e conectado.'); };

  // confere a senha atual (sem criar sessão útil) e devolve as chaves derivadas
  async function checkPassword(password) {
    const k = await deriveKeys(password, S.email);
    await sb('POST', '/auth/v1/token?grant_type=password', { body: { email: S.email, password: k.authSecret } });
    return k;
  }
  async function renewMfa(code) {
    const u = await sb('GET', '/auth/v1/user', { token: S.token });
    const fs = factorsOf(u);
    if (!fs.length) return fs;
    const t = await mfaVerify(S.token, fs[0].id, code);
    S.token = t.access_token; S.refresh = t.refresh_token;
    return fs;
  }

  async function changePassword(current, next) {
    need();
    const issue = pwIssue(next, S.email); if (issue) throw new VaultError('weak_password', issue);
    await checkPassword(current);
    const nk = await deriveKeys(next, S.email);
    const newWrapPw = await wrapRaw(nk.kek, S.dkRaw);
    await sb('PATCH', `/rest/v1/vaults?user_id=eq.${S.accountId}`, { token: S.token, body: { wrap_pw: newWrapPw }, prefer: 'return=minimal' });
    await sb('PUT', '/auth/v1/user', { token: S.token, body: { password: nk.authSecret } });
    S.authSecret = nk.authSecret; S.cache.wrapPw = newWrapPw; persist();
  }
  async function totpSetup() {
    need();
    const u = await sb('GET', '/auth/v1/user', { token: S.token });
    for (const f of (u.factors || [])) if (f.status !== 'verified') { try { await sb('DELETE', `/auth/v1/factors/${f.id}`, { token: S.token }); } catch {} }
    const r = await sb('POST', '/auth/v1/factors', { token: S.token, body: { factor_type: 'totp', issuer: 'Kuravo', friendly_name: 'Kuravo ' + Date.now() } });
    S.pendingFactor = r.id;
    return { secret: r.totp.secret, uri: r.totp.uri };
  }
  async function totpEnable(code) {
    need(); if (!S.pendingFactor) throw new VaultError('bad_request', 'Comece de novo a ativação.');
    const t = await mfaVerify(S.token, S.pendingFactor, code);
    S.token = t.access_token; S.refresh = t.refresh_token; S.totpEnabled = true; S.pendingFactor = null;
    return { backupCodes: [] };
  }
  async function totpDisable(password, code) {
    need(); await checkPassword(password);
    const fs = await renewMfa(code);
    for (const f of fs) await sb('DELETE', `/auth/v1/factors/${f.id}`, { token: S.token });
    S.totpEnabled = false;
  }
  async function deleteAccount(password, code) {
    need(); await checkPassword(password);
    if (S.totpEnabled) await renewMfa(code);
    await sb('POST', '/rest/v1/rpc/delete_my_account', { token: S.token, body: {} });
    try { localStorage.removeItem(cacheKey(S.email)); sessionStorage.removeItem(cacheKey(S.email)); localStorage.removeItem(PREFIX + 'last'); } catch {}
    clearTimeout(syncTimer); S = null; L = null; setStatus('idle', '');
  }

  global.Vault = {
    VaultError, init(h) { Object.assign(hooks, h); },
    register, login, recover, lock, unlock, logout, commit, syncNow, syncSoon, silentRelogin: totp => silentRelogin(totp),
    recoverStart, confirmSignup, resendConfirm, beginConfirm, changePassword, totpSetup, totpEnable, totpDisable, deleteAccount,
    pwIssue, normServer, lastKnown,
    isUnlocked: () => !!S, isLocked: () => !!L && !S,
    lockedEmail: () => (L ? L.email : ''), email: () => (S ? S.email : L ? L.email : ''),
    status: () => ({ ...statusNow, pending: pendingCount(), lastSync: S ? S.lastSync : 0, online: !!(S && S.token) }),
    session: () => (S ? { email: S.email, server: S.server, totpEnabled: S.totpEnabled, mode: S.mode, trusted: S.trusted, hasToken: !!S.token } : null),
    hasLocalCache: email => !!(readCache(email, true) || readCache(email, false)),
    _test: { deriveKeys, KDF }
  };
})(typeof window !== 'undefined' ? window : globalThis);
