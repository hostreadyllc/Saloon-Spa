// Test double for the Supabase client, mirroring the v2 database rules (for local UI tests only).
(function () {
  const K = "fakeDB2";
  const today = () => { const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }); return f.format(new Date()); };
  const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  function seed() {
    const s1 = { id: "salon1", code: "SALON-0001", name: "My Salon", plan: "Premium", device_limit: 3, status: "active", trial_ends: null, paid_until: addDays(today(), 365), contact_name: "", contact_phone: "", contact_email: "", notes: "" };
    return { salons: [s1], users: { "owner@test.ae": { id: "u1", pw: "secret123" } }, admins: ["u1"], members: [{ user_id: "u1", salon_id: "salon1", role: "owner", name: "Owner", email: "owner@test.ae", active: true }],
      invites: [], devices: [], records: [], payments: [], settings: { support_name: "Hostready LLC", support_phone: "+971 50 000 0000", support_email: "", bank_details: "", company_trn: "", company_address: "" }, seq: 0 };
  }
  const db = () => JSON.parse(localStorage.getItem(K) || "null") || seed();
  const save = d => localStorage.setItem(K, JSON.stringify(d));
  if (!localStorage.getItem(K)) save(seed());
  window.__fake = { db, save, today, addDays };

  window.supabase = { createClient() {
    let session = JSON.parse(localStorage.getItem("fakeSess") || "null");
    const cbs = [];
    const fire = ev => cbs.forEach(f => f(ev, session));
    const me = () => session?.user;
    const member = d => d.members.find(m => m.user_id === me()?.id && m.active);
    const isAdmin = d => d.admins.includes(me()?.id);
    const until = s => { const a = [s.trial_ends, s.paid_until].filter(Boolean).sort(); return a.length ? a[a.length - 1] : null; };
    const writable = s => s.status === "active" && until(s) && until(s) >= today();
    const devOk = (d, dv) => dv && (dv.status === "approved" || (dv.status === "pending" && new Date(dv.temp_until) > new Date()));
    const myDev = d => { const m = member(d); return m && d.devices.find(x => x.salon_id === m.salon_id && x.session_id === session?.sid); };
    function status(d) {
      const m = member(d);
      if (!m) return { admin: isAdmin(d), member: false, support: d.settings };
      const s = d.salons.find(x => x.id === m.salon_id), dv = myDev(d), u = until(s);
      const days = u ? Math.round((new Date(u) - new Date(today())) / 864e5) : -1;
      return { admin: isAdmin(d), member: true, role: m.role, name: m.name, today: today(), support: d.settings,
        salon: { id: s.id, code: s.code, name: s.name, plan: s.plan, status: s.status, trial_ends: s.trial_ends, paid_until: s.paid_until, active_until: u, on_trial: !!s.trial_ends && (!s.paid_until || s.paid_until < s.trial_ends), days_left: days, writable: !!writable(s), device_limit: s.device_limit, devices_approved: d.devices.filter(x => x.salon_id === s.id && x.status === "approved").length },
        device: dv ? { id: dv.id, name: dv.name, status: dv.status, temp_until: dv.temp_until, ok: devOk(d, dv) } : null };
    }
    const err = m => ({ data: null, error: { message: m } });
    function invite(d, salon, email, name, role) {
      email = email.trim().toLowerCase();
      const u = d.users[email];
      if (u) { const ex = d.members.find(m => m.user_id === u.id); if (ex) Object.assign(ex, { salon_id: salon, role, active: true }); else d.members.push({ user_id: u.id, salon_id: salon, role, name, email, active: true }); return "linked"; }
      d.invites = d.invites.filter(i => i.email !== email); d.invites.push({ email, salon_id: salon, role, name, created_at: new Date().toISOString() }); return "invited";
    }
    const rpcs = {
      check_salon_code: (d, a) => { const s = d.salons.find(x => x.code.toUpperCase() === a.p_code.trim().toUpperCase()); return s ? { ok: true, name: s.name, code: s.code } : { ok: false }; },
      my_status: d => status(d),
      touch_device: () => null,
      register_device: (d, a) => {
        const m = member(d); if (!m) return status(d);
        let dv = d.devices.find(x => x.salon_id === m.salon_id && x.device_key === a.p_key);
        if (!dv) { const open = d.devices.filter(x => x.salon_id === m.salon_id && x.status === "pending" && new Date(x.temp_until) > new Date()).length;
          dv = { id: uid(), salon_id: m.salon_id, device_key: a.p_key, name: a.p_name, platform: a.p_platform, status: "pending", temp_until: new Date(Date.now() + (open < 2 ? 2 * 864e5 : 0)).toISOString(), first_seen: new Date().toISOString() }; d.devices.push(dv); }
        d.devices.forEach(x => { if (x.session_id === session.sid) x.session_id = null; });
        dv.session_id = session.sid; dv.last_seen = new Date().toISOString(); dv.user_email = me().email;
        return status(d);
      },
      approve_device: (d, a) => { const dv = d.devices.find(x => x.id === a.p_id); const s = d.salons.find(x => x.id === dv.salon_id);
        if (!isAdmin(d)) { const m = member(d); if (!m || m.role !== "owner" || m.salon_id !== dv.salon_id) throw "Only the salon owner can approve devices";
          if (d.devices.filter(x => x.salon_id === s.id && x.status === "approved" && x.id !== dv.id).length >= s.device_limit) throw `PLAN_LIMIT: Your plan includes ${s.device_limit} devices. Contact Hostready to add more.`; }
        dv.status = "approved"; return null; },
      revoke_device: (d, a) => { const dv = d.devices.find(x => x.id === a.p_id); dv.status = "revoked"; dv.session_id = null; return null; },
      rename_device: (d, a) => { d.devices.find(x => x.id === a.p_id).name = a.p_name; return null; },
      invite_member: (d, a) => { if (!isAdmin(d) && member(d)?.role !== "owner") throw "Only the salon owner can add logins"; return invite(d, a.p_salon, a.p_email, a.p_name, a.p_role); },
      set_member: (d, a) => { const m = d.members.find(x => x.user_id === a.p_user); m.role = a.p_role; m.active = a.p_active; return null; },
      cancel_invite: (d, a) => { d.invites = d.invites.filter(i => i.email !== a.p_email); return null; },
      admin_overview: d => { if (!isAdmin(d)) throw "Admins only"; return d.salons.map(s => ({ ...s, active_until: until(s), days_left: until(s) ? Math.round((new Date(until(s)) - new Date(today())) / 864e5) : null, devices_approved: d.devices.filter(x => x.salon_id === s.id && x.status === "approved").length, devices_pending: d.devices.filter(x => x.salon_id === s.id && x.status === "pending").length, logins: d.members.filter(m => m.salon_id === s.id && m.active).length, invites: d.invites.filter(i => i.salon_id === s.id).length ? d.invites.filter(i => i.salon_id === s.id) : null })); },
      admin_create_salon: (d, a) => { const code = (a.p_code || "SAL-" + (1000 + Math.floor(Math.random() * 9000))).toUpperCase();
        if (d.salons.some(s => s.code === code)) throw "That salon code is already used";
        const s = { id: uid(), code, name: a.p_name, plan: a.p_plan, device_limit: a.p_device_limit, status: "active", trial_ends: addDays(today(), a.p_trial_days), paid_until: null, contact_name: a.p_owner_name, contact_phone: a.p_phone, contact_email: a.p_owner_email };
        d.salons.push(s); if (a.p_owner_email) invite(d, s.id, a.p_owner_email, a.p_owner_name, "owner"); return s; },
      admin_update_salon: (d, a) => { const s = d.salons.find(x => x.id === a.p_id); Object.assign(s, { name: a.p_name, plan: a.p_plan, device_limit: a.p_device_limit, status: a.p_status, contact_name: a.p_contact_name, contact_phone: a.p_contact_phone, contact_email: a.p_contact_email, notes: a.p_notes }); return null; },
      admin_record_payment: (d, a) => { if (![90, 180, 270, 365].includes(a.p_days)) throw "Subscription must be 90, 180, 270 or 365 days";
        const s = d.salons.find(x => x.id === a.p_salon); const start = [today(), s.paid_until ? addDays(s.paid_until, 1) : today()].sort().pop();
        const p = { id: uid(), salon_id: s.id, invoice_no: "HR-" + today().slice(2, 7).replace("-", "") + "-" + String(++d.seq).padStart(4, "0"), days: a.p_days, period_from: start, period_to: addDays(start, a.p_days - 1), amount: a.p_amount, vat: Math.round(a.p_amount * 5) / 100, method: a.p_method, created_at: new Date().toISOString() };
        d.payments.push(p); s.paid_until = p.period_to; s.status = "active"; return { payment: p, salon: s }; },
      admin_salon_detail: (d, a) => ({ devices: d.devices.filter(x => x.salon_id === a.p_salon), members: d.members.filter(x => x.salon_id === a.p_salon), invites: d.invites.filter(x => x.salon_id === a.p_salon), payments: d.payments.filter(x => x.salon_id === a.p_salon) }),
    };
    function q(table) {
      const st = { filters: [], range: null };
      const rows = d => {
        if (table === "records") { const m = member(d); if (!m || !devOk(d, myDev(d))) return []; return d.records.filter(r => r.salon_id === m.salon_id); }
        if (table === "devices") return isAdmin(d) ? d.devices : d.devices.filter(x => x.salon_id === member(d)?.salon_id);
        if (table === "members") return d.members.filter(x => isAdmin(d) || x.salon_id === member(d)?.salon_id);
        if (table === "invites") return d.invites.filter(x => isAdmin(d) || x.salon_id === member(d)?.salon_id);
        if (table === "app_settings") return Object.entries(d.settings).map(([key, value]) => ({ key, value }));
        return [];
      };
      const run = () => { const d = db(); let r = rows(d); st.filters.forEach(([k, v]) => r = r.filter(x => x[k] === v)); if (st.range) r = r.slice(st.range[0], st.range[1] + 1); return Promise.resolve({ data: r, error: null }); };
      const api = {
        select() { return api; }, eq(k, v) { st.filters.push([k, v]); return api; }, order() { return api; },
        range(a, b) { st.range = [a, b]; return run(); }, then(res, rej) { return run().then(res, rej); },
        upsert(r) {
          const d = db();
          if (table === "app_settings") { (Array.isArray(r) ? r : [r]).forEach(x => d.settings[x.key] = x.value); save(d); return Promise.resolve({ error: null }); }
          const m = member(d), s = d.salons.find(x => x.id === m?.salon_id);
          if (!m || r.salon_id !== m.salon_id || !devOk(d, myDev(d)) || !writable(s) || (m.role === "staff" && ["staff", "services", "settings"].includes(r.col))) return Promise.resolve({ error: { message: 'new row violates row-level security policy for table "records"' } });
          d.records = d.records.filter(x => !(x.salon_id === r.salon_id && x.col === r.col && x.id === r.id)); d.records.push(r); save(d); return Promise.resolve({ error: null });
        },
        delete() { return { match: mt => { const d = db(); d.records = d.records.filter(x => !(x.salon_id === mt.salon_id && x.col === mt.col && x.id === mt.id)); save(d); return Promise.resolve({ error: null }); } }; },
      };
      return api;
    }
    return {
      auth: {
        onAuthStateChange(f) { cbs.push(f); setTimeout(() => f("INITIAL_SESSION", session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
        async getSession() { return { data: { session } }; },
        async signInWithPassword({ email, password }) { const u = db().users[email.toLowerCase()]; if (!u || u.pw !== password) return { error: { message: "Invalid login credentials" } };
          session = { user: { id: u.id, email: email.toLowerCase() }, sid: uid() }; localStorage.setItem("fakeSess", JSON.stringify(session)); fire("SIGNED_IN"); return { data: { session } }; },
        async signUp({ email, password }) { const d = db(); email = email.toLowerCase(); if (d.users[email]) return { error: { message: "User already registered" } };
          const inv = d.invites.find(i => i.email === email); if (!inv) return { error: { message: "Database error saving new user" } };
          const id = uid(); d.users[email] = { id, pw: password }; d.members.push({ user_id: id, salon_id: inv.salon_id, role: inv.role, name: inv.name, email, active: true }); d.invites = d.invites.filter(i => i !== inv); save(d);
          session = { user: { id, email }, sid: uid() }; localStorage.setItem("fakeSess", JSON.stringify(session)); fire("SIGNED_IN"); return { data: { session } }; },
        async signOut() { session = null; localStorage.removeItem("fakeSess"); fire("SIGNED_OUT"); return {}; },
        async resetPasswordForEmail() { return {}; }, async updateUser() { return {}; },
      },
      async rpc(name, args) { const d = db(); try { const out = rpcs[name](d, args || {}); save(d); return { data: out, error: null }; } catch (e) { return err(String(e)); } },
      from: q,
      channel() { const ch = { on() { return ch; }, subscribe(cb) { setTimeout(() => cb && cb("SUBSCRIBED"), 10); return ch; } }; return ch; },
      removeChannel() {},
    };
  } };
})();
