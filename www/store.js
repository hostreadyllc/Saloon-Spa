/* Salon & Spa Ledger — sync layer.
   Keeps every record in one Supabase table ("records"), mirrors it on the device
   so the app opens and works offline, and queues changes until the connection returns. */
(function () {
  const $ = id => document.getElementById(id);
  const LS = k => "ssl:" + k;
  const load = k => { try { return JSON.parse(localStorage.getItem(LS(k))); } catch { return null; } };
  const keep = (k, v) => { try { localStorage.setItem(LS(k), JSON.stringify(v)); } catch {} };
  const drop = k => { try { localStorage.removeItem(LS(k)); } catch {} };

  /* ---------- configuration ---------- */
  function decodeCode(text) {
    const m = text.match(/(?:#setup=|SL1-)?([A-Za-z0-9+/=]{20,})\s*$/);
    if (!m) return null;
    try { const c = JSON.parse(decodeURIComponent(escape(atob(m[1])))); return c.url && c.key ? c : null; } catch { return null; }
  }
  function readConfig() {
    const m = location.hash.match(/^#setup=(.+)$/);
    if (m) {
      try { const c = JSON.parse(decodeURIComponent(escape(atob(m[1])))); if (c.url && c.key) keep("config", c); } catch {}
      history.replaceState(null, "", location.pathname + location.search);
    }
    const f = window.SALON_CONFIG || {};
    if (f.supabaseUrl && f.supabaseAnonKey) return { url: f.supabaseUrl.trim(), key: f.supabaseAnonKey.trim(), fixed: true };
    return load("config");
  }

  /* ---------- screens ---------- */
  function gate(which) {
    ["gateSetup", "gateLogin", "gateReset"].forEach(id => $(id).hidden = id !== which);
    $("gate").hidden = !which;
    $("appShell").hidden = !!which;
  }
  const gateMsg = (id, msg, ok) => { const el = $(id); el.textContent = msg || ""; el.hidden = !msg; el.style.color = ok ? "var(--income)" : "var(--danger)"; };

  /* ---------- store ---------- */
  const cache = {};          // col -> Map(id -> data)
  const listeners = {};      // col -> [fn]
  let outbox = load("outbox") || [];
  let sb = null, user = null, flushing = false, channel = null, lastError = "";
  const saved = load("cache") || {};
  for (const [col, obj] of Object.entries(saved)) cache[col] = new Map(Object.entries(obj));

  let persistTimer = null;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const out = {}; for (const [c, m] of Object.entries(cache)) out[c] = Object.fromEntries(m);
      keep("cache", out);
    }, 400);
  }
  function emit(col) { const m = cache[col] || new Map(); (listeners[col] || []).forEach(f => f(m)); }
  function emitAll() { Object.keys(listeners).forEach(emit); persist(); }
  function listen(col, fn) { (listeners[col] ||= []).push(fn); fn(cache[col] || new Map()); }

  function applyOutbox() {
    for (const w of outbox) {
      const m = (cache[w.col] ||= new Map());
      w.op === "set" ? m.set(w.id, w.data) : m.delete(w.id);
    }
  }

  function status() {
    const el = $("syncStatus"); if (!el) return;
    const n = outbox.length;
    let txt, cls;
    if (lastError) { txt = "Not saving"; cls = "bad"; }
    else if (!navigator.onLine) { txt = n ? `Offline · ${n} waiting` : "Offline"; cls = "warn"; }
    else if (n) { txt = `Saving ${n}…`; cls = "warn"; }
    else { txt = "Synced"; cls = "ok"; }
    el.textContent = txt; el.className = "sync " + cls;
    el.title = lastError || (n ? `${n} change(s) will upload when the connection is back` : "All changes are saved to the cloud");
    const note = $("offline");
    if (note) { note.hidden = !lastError; note.textContent = lastError; }
  }

  async function flush() {
    if (flushing || !sb || !user || !navigator.onLine) { status(); return; }
    flushing = true; status();
    while (outbox.length) {
      const w = outbox[0];
      const q = w.op === "set"
        ? sb.from("records").upsert({ col: w.col, id: w.id, data: w.data, updated_at: new Date().toISOString(), updated_by: user.email })
        : sb.from("records").delete().match({ col: w.col, id: w.id });
      const { error } = await q;
      if (error) {
        const net = /fetch|network|Failed/i.test(error.message || "");
        lastError = net ? "" : `Changes are not being saved: ${error.message}. Sign out and in again, or check the database setup.`;
        break;
      }
      lastError = "";
      outbox.shift(); keep("outbox", outbox);
    }
    flushing = false; status();
  }

  function queue(op, col, id, data) {
    outbox = outbox.filter((w, i) => i === 0 && flushing ? true : !(w.col === col && w.id === id));
    outbox.push({ op, col, id, data });
    keep("outbox", outbox);
    const m = (cache[col] ||= new Map());
    op === "set" ? m.set(id, data) : m.delete(id);
    emit(col); persist(); flush();
  }

  async function loadAll() {
    if (!sb || !navigator.onLine) return;
    const fresh = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("records").select("col,id,data").range(from, from + 999);
      if (error) { if (!/fetch|network/i.test(error.message)) { lastError = `Could not load records: ${error.message}`; status(); } return; }
      for (const r of data) (fresh[r.col] ||= new Map()).set(r.id, r.data);
      if (data.length < 1000) break;
    }
    for (const k of Object.keys(cache)) delete cache[k];
    Object.assign(cache, fresh);
    applyOutbox();
    lastError = ""; emitAll(); status();
  }

  function subscribe() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("records-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "records" }, p => {
        const pending = (col, id) => outbox.some(w => w.col === col && w.id === id);
        if (p.eventType === "DELETE") { const { col, id } = p.old || {}; if (col && !pending(col, id)) { cache[col]?.delete(id); emit(col); persist(); } }
        else { const r = p.new; if (r && !pending(r.col, r.id)) { (cache[r.col] ||= new Map()).set(r.id, r.data); emit(r.col); persist(); } }
      })
      .subscribe(s => { if (s === "SUBSCRIBED") loadAll(); });
  }

  /* ---------- the db interface the app uses ---------- */
  const snapOf = m => ({ docs: [...m].map(([id, d]) => ({ id, data: () => d })) });
  window.LedgerDB = {
    collection: col => ({
      doc: id => ({ set: async d => queue("set", col, id, d), delete: async () => queue("del", col, id) }),
      onSnapshot: next => listen(col, m => next(snapOf(m))),
    }),
    doc: path => { const [col, id] = path.split("/"); return {
      set: async d => queue("set", col, id, d),
      onSnapshot: next => listen(col, m => next({ exists: m.has(id), data: () => m.get(id) })),
    }; },
  };
  window.LedgerSync = {
    user: () => user,
    pending: () => outbox.length,
    exportAll: () => { const out = {}; for (const [c, m] of Object.entries(cache)) out[c] = Object.fromEntries(m); return out; },
    importAll: (data) => { let n = 0; for (const [col, docs] of Object.entries(data)) for (const [id, d] of Object.entries(docs)) { queue("set", col, id, d); n++; } return n; },
    setupLink: () => {
      const c = readConfig(); if (!c) return "";
      const code = btoa(unescape(encodeURIComponent(JSON.stringify({ url: c.url, key: c.key }))));
      const hosted = location.protocol === "https:" && !/^(localhost|127\.)/.test(location.hostname);
      return hosted ? location.origin + location.pathname + "#setup=" + code : "SL1-" + code;
    },
    signOut: async () => {
      if (outbox.length && !confirmSignOut()) return;
      await sb.auth.signOut();
    },
    forgetDevice: () => { drop("config"); drop("cache"); drop("outbox"); location.reload(); },
  };
  let signOutArmed = false;
  function confirmSignOut() { if (signOutArmed) return true; signOutArmed = true; window.toast?.(`${outbox.length} changes haven't uploaded yet. Press Sign out again to sign out anyway.`); setTimeout(() => signOutArmed = false, 4000); return false; }

  /* ---------- boot ---------- */
  async function connect(cfg) {
    sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "ssl-auth" } });
    sb.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") { gate("gateReset"); return; }
      const was = user; user = session?.user || null;
      if (user) {
        gate(null);
        $("whoami") && ($("whoami").textContent = user.email);
        if (!was) { window.startLedger?.(); subscribe(); flush(); }
      } else { if (channel) { sb.removeChannel(channel); channel = null; } gate("gateLogin"); }
    });
    const { data } = await sb.auth.getSession();
    if (!data.session) gate("gateLogin");
  }

  window.addEventListener("online", () => { flush(); loadAll(); });
  window.addEventListener("offline", status);
  setInterval(flush, 30000);

  document.addEventListener("DOMContentLoaded", () => {
    $("setupForm").addEventListener("submit", async e => {
      e.preventDefault();
      let url = $("suUrl").value.trim().replace(/\/+$/, ""); let key = $("suKey").value.trim();
      const code = $("suCode").value.trim();
      if (code) {
        const c = decodeCode(code);
        if (!c) { gateMsg("suMsg", "That setup code is not complete. Copy it again from Settings on the other device."); return; }
        url = c.url.replace(/\/+$/, ""); key = c.key;
      }
      if (!/^https:\/\/.+\.supabase\.co$/.test(url)) { gateMsg("suMsg", "The Project URL should look like https://abcdxyz.supabase.co"); return; }
      if (key.length < 30) { gateMsg("suMsg", "Paste the full anon public key (a long code starting with eyJ or sb_publishable_)."); return; }
      gateMsg("suMsg", "Checking…", true);
      try {
        const test = window.supabase.createClient(url, key, { auth: { persistSession: false } });
        const { error } = await test.from("records").select("id").limit(1);
        if (error && /does not exist|schema cache/i.test(error.message)) { gateMsg("suMsg", "Connected, but the records table is missing. Run supabase-setup.sql in the SQL Editor first."); return; }
        if (error && !/permission|JWT|policy/i.test(error.message)) { gateMsg("suMsg", "Could not connect: " + error.message); return; }
      } catch { gateMsg("suMsg", "Could not reach that address. Check the URL and your internet connection."); return; }
      keep("config", { url, key });
      location.reload();
    });
    $("loginForm").addEventListener("submit", async e => {
      e.preventDefault();
      gateMsg("liMsg", "Signing in…", true);
      const { error } = await sb.auth.signInWithPassword({ email: $("liEmail").value.trim(), password: $("liPass").value });
      if (error) gateMsg("liMsg", /invalid/i.test(error.message) ? "Wrong email or password." : error.message);
      else { gateMsg("liMsg", ""); $("liPass").value = ""; }
    });
    $("liForgot").addEventListener("click", async () => {
      const email = $("liEmail").value.trim();
      if (!email) { gateMsg("liMsg", "Type your email first, then press Forgot password."); return; }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      gateMsg("liMsg", error ? error.message : "Check your email for a link to set a new password.", !error);
    });
    $("liChange").addEventListener("click", () => { drop("config"); location.reload(); });
    $("resetForm").addEventListener("submit", async e => {
      e.preventDefault();
      const p = $("rpPass").value;
      if (p.length < 8) { gateMsg("rpMsg", "Use at least 8 characters."); return; }
      const { error } = await sb.auth.updateUser({ password: p });
      if (error) gateMsg("rpMsg", error.message); else { gateMsg("rpMsg", ""); gate(null); window.toast?.("Password updated"); }
    });

    const cfg = readConfig();
    if (!cfg) { gate("gateSetup"); return; }
    if (cfg.fixed) $("liChange").hidden = true;
    // show cached data straight away while the session is checked
    connect(cfg).catch(() => gate("gateLogin"));
    status();
  });
})();
