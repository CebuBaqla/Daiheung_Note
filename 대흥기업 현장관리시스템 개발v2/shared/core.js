/* =====================================================================
 * 대흥기업 현장관리 · 공통 코어
 * 관리자 PC(admin/)와 모바일 현장노트(mobile/)가 함께 사용합니다.
 *
 *  - 기능 등록:   DH.register({ name, order, ...hooks })
 *  - 훅 호출:     DH.collect / DH.first / DH.pipe / DH.loadAll
 *  - 버튼 연결:   <button data-action="이름"> + DH.action('이름', fn)
 *  - 이벤트 위임: DH.on('change', '.selector', fn)
 *  - Supabase:    DH.createApi(...) → raw / rpc / upload / blob
 * ===================================================================== */
(function () {
  'use strict';
  const DH = (window.DH = window.DH || {});

  /* ---------- 기능 등록과 훅 ---------- */
  DH.features = [];
  DH.register = (feature) => {
    DH.features.push(feature);
    DH.features.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    return feature;
  };
  /** 모든 기능의 훅 결과를 배열로 모읍니다. 훅은 값 또는 함수일 수 있습니다. */
  DH.collect = (hook, ...args) =>
    DH.features.flatMap((f) => {
      const h = f[hook];
      if (h == null) return [];
      const v = typeof h === 'function' ? h.apply(f, args) : h;
      return v == null ? [] : Array.isArray(v) ? v : [v];
    });
  /** 처음으로 값을 돌려준 기능의 결과를 사용합니다(덮어쓰기용 훅). */
  DH.first = (hook, ...args) => {
    for (const f of DH.features) {
      if (typeof f[hook] !== 'function') continue;
      const v = f[hook](...args);
      if (v != null && v !== false) return v;
    }
    return null;
  };
  /** 값을 기능 순서대로 가공합니다(타임라인 항목 등). */
  DH.pipe = (hook, value, ...args) => {
    for (const f of DH.features) if (typeof f[hook] === 'function') value = f[hook](value, ...args) ?? value;
    return value;
  };
  /** 기능별 데이터 불러오기. 한 기능이 실패해도 나머지 화면은 계속 동작합니다. */
  DH.loadAll = async (hook, ...args) => {
    const list = DH.features.filter((f) => typeof f[hook] === 'function');
    const results = await Promise.allSettled(list.map((f) => f[hook](...args)));
    const failed = results.map((r, i) => (r.status === 'rejected' ? [list[i].name, r.reason] : null)).filter(Boolean);
    const authFailure = failed.find(([, error]) => error.authRequired);
    if (authFailure) throw authFailure[1];
    failed.forEach(([name, err]) => console.warn(`[${name}] 불러오기 실패`, err));
    if (failed.length) DH.toast(`일부 기능을 불러오지 못했습니다: ${failed.map((x) => x[0]).join(', ')}`);
  };
  DH.byOrder = (a, b) => (a.order ?? 50) - (b.order ?? 50);

  /* ---------- 버튼 · 이벤트 연결 ---------- */
  const actions = Object.create(null);
  DH.action = (name, fn) => {
    if (actions[name]) console.warn('같은 이름의 action이 두 번 등록되었습니다:', name);
    actions[name] = fn;
  };
  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || !actions[el.dataset.action]) return;
    if (el.tagName === 'A' || el.type === 'submit') event.preventDefault();
    actions[el.dataset.action](el, event);
  });
  DH.on = (type, selector, fn) =>
    document.addEventListener(type, (event) => {
      const el = event.target.closest?.(selector);
      if (el) fn(el, event);
    });

  let busy = false;
  /** 버튼 연타 방지 + 오류 알림을 한곳에서 처리합니다. */
  DH.act = async (fn) => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      console.error(e);
      if (e.authRequired) await DH.onAuthRequired?.();
      else DH.onLoadError?.(e);
      DH.toast('오류: ' + e.message);
    } finally {
      busy = false;
    }
  };

  /* ---------- 공통 유틸 ---------- */
  DH.$ = (s, root = document) => root.querySelector(s);
  DH.$$ = (s, root = document) => [...root.querySelectorAll(s)];
  DH.esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  DH.num = (v) => Number(v || 0).toLocaleString('ko-KR', { maximumFractionDigits: 3 });
  DH.kstDate = (value) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(value))
        .map((x) => [x.type, x.value])
    );
    return `${p.year}-${p.month}-${p.day}`;
  };
  DH.today = () => DH.kstDate(new Date());
  /** 한국시간 04:00에 바뀌는 현장 작업일. 일반 달력 날짜와 구분합니다. */
  DH.workDay = (value = new Date()) => DH.kstDate(new Date(new Date(value).getTime() - 4 * 60 * 60 * 1000));
  /** Date 객체를 브라우저 기준 YYYY-MM-DD로 바꿉니다(달력 계산용). */
  DH.iso = (d) => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  DH.addDay = (date, n) => {
    const d = new Date(date + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return DH.iso(d);
  };
  DH.dateLabel = (date) =>
    new Date(date + 'T12:00:00').toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });
  DH.timeLabel = (value) =>
    value
      ? new Date(value).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false })
      : '';
  DH.toast = (msg) => {
    const el = DH.$('#toast');
    if (!el) return alert(msg);
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(DH.toast.timer);
    DH.toast.timer = setTimeout(() => el.classList.add('hidden'), 4500);
  };

  /* ---------- Supabase 연결 ---------- */
  DH.DEFAULT_CONF = {
    url: 'https://awanldljuzwutkbnimcc.supabase.co',
    key: 'sb_publishable_OyA-45aSG4MHHlf94iZBmg_9cw_Kn01',
  };
  DH.BUCKET = 'dh-field-files';
  const readJson = (key) => {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch {
      return null;
    }
  };

  DH.authError = () => Object.assign(Error('로그인이 만료되었습니다. 다시 로그인해 주세요.'), { authRequired: true });
  // 응답 유실 뒤 수동 재시도와 재접속에도 같은 기록 ID/내용을 유지합니다.
  const updateKey = (id) => 'dh_situation_pending_v1:' + DH.ctx.api.base() + ':' + DH.ctx.profile.employee_id + ':' + id;
  DH.pendingSituation = (id, updates = []) => {
    const key = updateKey(id), pending = readJson(key);
    if (pending && updates.some((update) => update.id === pending.id)) { localStorage.removeItem(key); return null; }
    return pending;
  };
  DH.saveSituationUpdate = async (situationId, values) => {
    const key = updateKey(situationId), old = readJson(key);
    if (old && ['flow', 'outcome', 'resolved'].some((field) => old[field] !== values[field]))
      throw Error('이전 기록의 전송 결과가 아직 확인되지 않았습니다. 상세를 다시 열어 이전 내용으로 재시도해 주세요.');
    const payload = old || { id: crypto.randomUUID(), situation_id: situationId, ...values };
    localStorage.setItem(key, JSON.stringify(payload));
    try { await DH.rpc('dh_add_situation_update', { p_data: payload }); }
    catch (error) {
      // 서버가 명시적으로 거절한 요청은 수정할 수 있습니다. 응답 유실/서버 오류는 ID를 보존합니다.
      if ([400, 403, 404, 422].includes(error.status)) localStorage.removeItem(key);
      throw error;
    }
    localStorage.removeItem(key);
  };

  /** 관리자/모바일이 서로 다른 저장 키로 로그인 상태를 유지합니다. */
  DH.createApi = ({ configKey, sessionKey }) => {
    let refreshing = null;
    const api = {
      conf: readJson(configKey) || { ...DH.DEFAULT_CONF },
      session: readJson(sessionKey),
      base: () => api.conf.url.replace(/\/$/, ''),
      authHeaders: () => ({ apikey: api.conf.key, Authorization: 'Bearer ' + api.session.access_token }),

      async request(path, opts = {}) {
        const r = await fetch(api.base() + path, opts);
        if (!r.ok) {
          const text = await r.text();
          let value; try { value = JSON.parse(text); } catch { value = null; }
          throw Object.assign(Error(value?.message || value?.error_description || value?.error || text || `HTTP ${r.status}`), { status: r.status, code: value?.code });
        }
        return r;
      },
      async raw(path, opts = {}) {
        const text = await (await api.request(path, opts)).text();
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
      },
      setSession(next) {
        api.session = { ...next, expires_at: Math.floor(Date.now() / 1000) + next.expires_in };
      },
      saveSession() {
        localStorage.setItem(sessionKey, JSON.stringify(api.session));
      },
      clearSession() {
        api.session = null;
        localStorage.removeItem(sessionKey);
      },
      async refresh() {
        if (refreshing) return refreshing;
        refreshing = (async () => {
          if (!api.session?.refresh_token) throw DH.authError();
          let next;
          try { next = await api.raw('/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            headers: { apikey: api.conf.key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: api.session.refresh_token }),
          }); } catch (error) {
            if ([400, 401, 403].includes(error.status)) throw DH.authError();
            throw error;
          }
          api.setSession(next);
          api.saveSession();
        })();
        try {
          return await refreshing;
        } finally {
          refreshing = null;
        }
      },
      async authenticated(path, opts = {}, retry = true) {
        if (!api.session) throw DH.authError();
        if (Date.now() / 1000 > (api.session.expires_at || 0) - 60) await api.refresh();
        const token = api.session.access_token;
        try {
          return await api.request(path, { ...opts, headers: { ...opts.headers, ...api.authHeaders() } });
        } catch (e) {
          if (e.status === 401) {
            if (!retry) throw DH.authError();
            if (api.session?.access_token === token) await api.refresh();
            return api.authenticated(path, opts, false);
          }
          throw e;
        }
      },
      async rpc(name, payload = {}) {
        const r = await api.authenticated('/rest/v1/rpc/' + name, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        const text = await r.text();
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
      },
      async checkConnection() {
        await api.raw('/auth/v1/settings', { headers: { apikey: api.conf.key } });
        return true;
      },
      /** 로그인 정보 확인만 하고, 저장(saveSession)은 화면 쪽에서 권한 확인 뒤에 합니다. */
      async signIn({ url, key, email, password }) {
        api.clearSession();
        api.conf = { url: url.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/$/, ''), key: key.trim() };
        localStorage.setItem(configKey, JSON.stringify(api.conf));
        const next = await api.raw('/auth/v1/token?grant_type=password', {
          method: 'POST',
          headers: { apikey: api.conf.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        api.setSession(next);
      },
      async signOut() {
        try {
          await api.raw('/auth/v1/logout', { method: 'POST', headers: api.authHeaders() });
        } catch {}
        api.clearSession();
      },
      storagePath: (path) => path.split('/').map(encodeURIComponent).join('/'),
      /** Storage 업로드. 경로는 ASCII로 만드세요(원래 파일명은 file_asset.filename에 보관). */
      async upload(path, body, contentType) {
        await api.authenticated(`/storage/v1/object/${DH.BUCKET}/${api.storagePath(path)}`, {
          method: 'POST',
          headers: { 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'false' },
          body,
        });
      },
      /** 로그인 사용자 권한으로 파일을 내려받습니다. file = { bucket, path } */
      async blob(file) {
        const r = await api.authenticated(`/storage/v1/object/authenticated/${encodeURIComponent(file.bucket)}/${api.storagePath(file.path)}`);
        return r.blob();
      },
    };
    return api;
  };
  DH.action('connection-check', (el) => DH.act(async () => {
    const form = document.getElementById(el.dataset.form), fields = new FormData(form);
    const probe = DH.createApi({ configKey: 'dh_connection_probe_config', sessionKey: 'dh_connection_probe_session' });
    probe.conf = { url: String(fields.get('url')).trim().replace(/\/rest\/v1\/?$/, '').replace(/\/$/, ''), key: String(fields.get('key')).trim() };
    const result = DH.$('#connection-result');
    result.textContent = '서버 연결 확인 중…';
    try {
      await probe.checkConnection();
      result.textContent = '서버 주소와 공개 키가 확인되었습니다. 로그인하면 현장 데이터를 조회합니다.';
    } catch (error) { result.textContent = '연결 실패: ' + error.message; throw error; }
  }));
})();
