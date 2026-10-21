// ══════════════════════════════════════════════════════════
//  LeadSync – Abgleich Mac · Windows · iPhone über Supabase (EU)
//  Ein Datensatz je Lead/Aufgabe, „neuere Änderung gewinnt“.
//  Wird von der Computer-App und der iPhone-App gleich genutzt.
// ══════════════════════════════════════════════════════════
(function (root) {
  'use strict';
  const CONFIG_URL = 'https://darkmayhemhdx.github.io/lead-system/sync-config.json';
  const LS = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem('lsync:' + k) || 'null'); if (v === null) localStorage.removeItem('lsync:' + k); else localStorage.setItem('lsync:' + k, JSON.stringify(v)); } catch (e) { return null; } };
  // Felder, die nur auf dem jeweiligen Gerät gelten (Dateien, alte Fotos)
  const LOCAL_ONLY = ['fotos', 'files', 'akteDir', '_mt', '_fotosOmitted'];

  function stable(o) {
    if (Array.isArray(o)) return '[' + o.map(stable).join(',') + ']';
    if (o && typeof o === 'object') return '{' + Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
    return JSON.stringify(o === undefined ? null : o);
  }
  function hash(o) { const s = stable(o); let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h + ':' + s.length; }
  function strip(kind, r) {
    if (kind === 'meta') return r;
    const c = {}; Object.keys(r).forEach(k => { if (!LOCAL_ONLY.includes(k) && r[k] !== undefined) c[k] = r[k]; });
    return c;
  }

  // Geräte-Kennung (bleibt auf diesem Gerät gleich)
  let DEV = LS('dev'); if (!DEV) { DEV = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); LS('dev', DEV); }
  function fingerprint(pairs) { pairs.sort(); return hash(pairs.join('|')) + '#' + pairs.length; }

  const S = {
    host: null,                       // {getState, applyRemote, onStatus}
    cfg: LS('cfg'), sess: LS('sess'), known: LS('known') || {}, cursor: LS('cursor') || null,
    lastSync: LS('last') || null, busy: false, again: false, timer: null, state: 'off', msg: '',
  };

  function status(state, msg) { S.state = state; S.msg = msg || ''; try { S.host && S.host.onStatus && S.host.onStatus(state, msg); } catch (e) {} }
  function configured() { return !!(S.cfg && S.cfg.url && S.cfg.key); }
  function loggedIn() { return !!(S.sess && S.sess.refresh_token); }

  async function loadConfig(force) {
    const manual = LS('cfgManual');
    if (manual && manual.url && manual.key) { S.cfg = manual; return S.cfg; }
    if (S.cfg && !force) { fetchConfig().catch(() => {}); return S.cfg; }
    return fetchConfig();
  }
  async function fetchConfig() {
    const r = await fetch(CONFIG_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('Verbindungsdatei nicht gefunden');
    const j = await r.json();
    if (j && j.url && j.key && !/DEIN|xxxx/i.test(j.url + j.key)) { S.cfg = { url: String(j.url).replace(/\/+$/, ''), key: j.key }; LS('cfg', S.cfg); }
    return S.cfg;
  }
  function setManualConfig(url, key) { if (url && key) { S.cfg = { url: url.trim().replace(/\/+$/, ''), key: key.trim() }; LS('cfgManual', S.cfg); LS('cfg', S.cfg); } else { LS('cfgManual', null); } }

  async function auth(body, grant) {
    const r = await fetch(S.cfg.url + '/auth/v1/token?grant_type=' + grant, { method: 'POST', headers: { apikey: S.cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error_description || j.msg || j.message || ('Fehler ' + r.status)); e.status = r.status; throw e; }
    S.sess = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, email: (j.user && j.user.email) || (S.sess && S.sess.email) || '', uid: (j.user && j.user.id) || (S.sess && S.sess.uid) };
    LS('sess', S.sess); return S.sess;
  }
  async function login(email, password) {
    await loadConfig(true).catch(() => {});
    if (!configured()) throw new Error('Keine Verbindungsdaten. Bitte die Datei sync-config.json auf GitHub ausfüllen.');
    const prevUid = S.sess && S.sess.uid;
    await auth({ email: String(email).trim(), password }, 'password');
    if (prevUid && prevUid !== S.sess.uid) { S.known = {}; S.cursor = null; LS('known', S.known); LS('cursor', null); LS('wipeAt', null); }
    status('ok', 'Angemeldet'); return sync();
  }
  function logout() { S.sess = null; LS('sess', null); S.known = {}; S.cursor = null; LS('known', {}); LS('cursor', null); status('off', ''); }
  async function token() {
    if (!loggedIn()) throw new Error('nicht angemeldet');
    if (Date.now() > (S.sess.expires_at || 0) - 60000) {
      try { await auth({ refresh_token: S.sess.refresh_token }, 'refresh_token'); }
      catch (e) { if (e.status === 400 || e.status === 401) { logout(); status('err', 'Bitte erneut anmelden'); } throw e; }
    }
    return S.sess.access_token;
  }
  async function api(path, opt) {
    opt = opt || {};
    const t = await token();
    const r = await fetch(S.cfg.url + '/rest/v1/' + path, { ...opt, headers: { apikey: S.cfg.key, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
    if (!r.ok) { const txt = await r.text().catch(() => ''); const e = new Error('Server ' + r.status + (txt ? ': ' + txt.slice(0, 160) : '')); e.status = r.status; throw e; }
    return r.status === 204 ? null : r.json().catch(() => null);
  }

  // Roh-Anfrage mit Anmeldung (z. B. Supabase Storage für App-Pakete)
  async function authFetch(path, opt) {
    opt = opt || {};
    const t = await token();
    return fetch(S.cfg.url + '/' + path.replace(/^\//, ''), { ...opt, headers: { apikey: S.cfg.key, Authorization: 'Bearer ' + t, ...(opt.headers || {}) } });
  }

  function localItems() {
    const st = S.host.getState(); const m = new Map();
    (st.leads || []).forEach(l => m.set('lead:' + l.id, { kind: 'lead', id: String(l.id), rec: l }));
    (st.tasks || []).forEach(t => m.set('task:' + t.id, { kind: 'task', id: String(t.id), rec: t }));
    if (st.meta) m.set('meta:main', { kind: 'meta', id: 'main', rec: st.meta });
    return m;
  }

  // Lokale Änderungen mit Zeitstempel versehen (bei jedem Speichern aufrufen)
  const seen = {};
  function stamp() {
    if (!S.host || !loggedIn()) return;
    const now = Date.now();
    localItems().forEach((it, key) => {
      if (it.kind === 'meta') return;
      const h = hash(strip(it.kind, it.rec)), k = S.known[key];
      if ((k && k.h === h) || seen[key] === h) return;
      seen[key] = h;
      if (!it.rec._mt || !k || it.rec._mt <= k.mt) it.rec._mt = now;
    });
  }

  async function pull() {
    const changes = []; let more = true, rounds = 0;
    // 2 Minuten Überlappung, damit gleichzeitig geschriebene Datensätze nicht verloren gehen
    const since = S.cursor ? new Date(new Date(S.cursor).getTime() - 120000).toISOString() : null;
    let after = since;
    while (more && rounds++ < 50) {
      const q = 'ls_items?select=kind,id,data,updated_at,deleted,srv&order=srv.asc&limit=1000' + (after ? '&srv=gt.' + encodeURIComponent(after) : '');
      const rows = await api(q) || [];
      rows.forEach(r => changes.push(r));
      more = rows.length === 1000; if (rows.length) after = rows[rows.length - 1].srv;
    }
    if (!changes.length) return 0;
    // „Alles löschen“ aus dem Monitor: zuerst ausführen, danach die übrigen Zeilen (z. B. Wiederherstellung)
    const wipe = changes.filter(r => r.kind === 'wipe' && !r.deleted && r.data && r.data.at).sort((a, b) => b.data.at - a.data.at)[0];
    if (wipe && wipe.data.at > (+LS('wipeAt') || 0)) {
      const at = wipe.data.at;
      if (S.host.wipe) await S.host.wipe(wipe.data);
      Object.keys(S.known).forEach(key => { if (!key.startsWith('meta:') && S.known[key].mt <= at) delete S.known[key]; });
      Object.keys(seen).forEach(key => delete seen[key]);
      LS('known', S.known); LS('wipeAt', at);
    }
    // Update-Steuerung aus dem Monitor
    const ro = changes.filter(r => r.kind === 'rollout' && r.id === 'current' && !r.deleted && r.data).pop();
    if (ro) { LS('rollout', ro.data); if (S.host.rollout) { try { S.host.rollout(ro.data); } catch (e) {} } }
    const local = localItems(); const apply = [];
    changes.forEach(row => {
      if (row.kind !== 'lead' && row.kind !== 'task' && row.kind !== 'meta') return;   // Geräte-Meldungen u. Ä.
      const key = row.kind + ':' + row.id, k = S.known[key], loc = local.get(key);
      const rh = row.deleted ? 'del' : hash(row.data);
      if (k && k.h === rh) return;                                           // kennen wir schon
      const lh = loc ? hash(strip(row.kind, loc.rec)) : 'del';
      const localChanged = loc ? (!k || k.h !== lh) : (k && k.h !== 'del');
      const localMt = loc ? (loc.rec._mt || (k && k.mt) || 0) : (k ? k.mt : 0);
      if (localChanged && lh !== rh && localMt > (row.updated_at || 0)) return;   // eigene neuere Änderung behalten
      apply.push({ kind: row.kind, id: row.id, deleted: row.deleted, data: row.data, mt: row.updated_at });
      S.known[key] = { h: rh, mt: row.updated_at };
    });
    S.cursor = changes[changes.length - 1].srv; LS('cursor', S.cursor);
    if (apply.length) S.host.applyRemote(apply);
    LS('known', S.known);
    return apply.length;
  }

  async function push() {
    const local = localItems(), rows = [], now = Date.now();
    local.forEach((it, key) => {
      const data = strip(it.kind, it.rec), h = hash(data), k = S.known[key];
      if (k && k.h === h) return;
      const mt = (it.rec._mt && (!k || it.rec._mt > k.mt)) ? it.rec._mt : now;
      if (it.kind !== 'meta') it.rec._mt = mt;
      rows.push({ kind: it.kind, id: it.id, data, updated_at: mt, deleted: false, device: DEV, _key: key, _h: h });
    });
    Object.keys(S.known).forEach(key => {
      if (local.has(key) || S.known[key].h === 'del') return;
      const [kind, ...rest] = key.split(':');
      rows.push({ kind, id: rest.join(':'), data: {}, updated_at: now, deleted: true, device: DEV, _key: key, _h: 'del' });
    });
    for (let i = 0; i < rows.length; i += 200) {
      const part = rows.slice(i, i + 200);
      await api('ls_items?on_conflict=user_id,kind,id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(part.map(({ _key, _h, ...r }) => r)) });
      part.forEach(r => { S.known[r._key] = { h: r._h, mt: r.updated_at }; });
      LS('known', S.known);
    }
    return rows.length;
  }

  async function sync() {
    if (!S.host || !loggedIn()) return;
    if (S.busy) { S.again = true; return; }
    S.busy = true; status('busy', 'Gleicht ab…');
    try {
      await loadConfig().catch(() => {});
      if (!configured()) { status('err', 'Keine Verbindungsdaten'); return; }
      const got = await pull();
      const sent = await push();
      S.lastSync = new Date().toISOString(); LS('last', S.lastSync);
      status('ok', got || sent ? `${got} empfangen · ${sent} gesendet` : 'Aktuell');
      S.stats = { got, sent }; await heartbeat().catch(() => {});
    } catch (e) {
      const off = e instanceof TypeError || /fetch|network/i.test(e.message);
      status('err', off ? 'Offline – wird nachgeholt' : e.message);
      if (!off) heartbeat().catch(() => {});
    } finally {
      S.busy = false;
      if (S.again) { S.again = false; setTimeout(sync, 300); }
    }
  }
  async function rpc(name, args) { return api('rpc/' + name, { method: 'POST', body: JSON.stringify(args || {}) }); }
  // Lebenszeichen dieses Geräts für den Monitor
  function localFingerprint() {
    const pairs = []; let leads = 0, tasks = 0;
    localItems().forEach((it, key) => { if (it.kind === 'meta') return; if (it.kind === 'lead') leads++; else tasks++; pairs.push(key + '=' + hash(strip(it.kind, it.rec))); });
    return { fp: fingerprint(pairs), leads, tasks };
  }
  async function heartbeat() {
    if (!S.host || !loggedIn() || !configured()) return;
    let info = {}; try { info = (S.host.deviceInfo && await S.host.deviceInfo()) || {}; } catch (e) {}
    const f = localFingerprint();
    const data = { name: info.name || 'Gerät', platform: info.platform || '', version: info.version || '', user: info.user || '',
      lastSync: S.lastSync, state: S.state, msg: S.msg, ...(info.extra || {}), fp: f.fp, leads: f.leads, tasks: f.tasks, stats: S.stats || null, seen: new Date().toISOString() };
    await api('ls_items?on_conflict=user_id,kind,id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ kind: 'device', id: DEV, data, updated_at: Date.now(), deleted: false, device: DEV }]) });
  }
  function soon(ms) { clearTimeout(S.timer); S.timer = setTimeout(sync, ms == null ? 2500 : ms); }

  function start(host) {
    S.host = host;
    loadConfig().catch(() => {});
    if (loggedIn()) setTimeout(sync, 1200);
    if (host.rollout && LS('rollout')) setTimeout(() => { try { host.rollout(LS('rollout')); } catch (e) {} }, 2500);
    setInterval(() => { if (loggedIn() && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) sync(); }, 30000);
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => soon(300));
      window.addEventListener('online', () => soon(300));
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') soon(300); else if (loggedIn()) sync(); });
    }
  }
  // Hilfe für die App: ein entfernter Lead/Task in den lokalen Datensatz übernehmen
  function mergeLead(local, remote) {
    const out = { ...remote };
    if (local) LOCAL_ONLY.forEach(k => { if (k !== '_mt' && local[k] !== undefined) out[k] = local[k]; });
    if (local && local.geo && !remote.geo) out.geo = local.geo;
    return out;
  }

  root.LeadSync = {
    start, sync, soon, stamp, authFetch, heartbeat: () => heartbeat().catch(() => {}), login, logout, mergeLead, setManualConfig, loadConfig, api, rpc, hash, fingerprint, deviceId: DEV,
    get info() { return { configured: configured(), loggedIn: loggedIn(), email: S.sess && S.sess.email, uid: S.sess && S.sess.uid, last: S.lastSync, state: S.state, msg: S.msg, manual: !!LS('cfgManual'), cfg: S.cfg }; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
