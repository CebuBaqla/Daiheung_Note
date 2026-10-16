/* =====================================================================
 * 관리자 PC 셸: 로그인 · 상단 탭 · 대시보드 틀 · 모달
 * 실제 화면 내용은 features/<기능>/admin.js 가 훅으로 채웁니다.
 *
 * 관리자 훅 (DH.register 객체에 넣는 이름)
 *   adminLoad(ctx)                  async · 새로고침 때 기능별 데이터 불러오기
 *   adminTabs(ctx)                  [{ id, label, order, render(ctx) → html }]
 *   dashboardPanels(ctx)            [{ slot:'left'|'center'|'right', order, html }]
 *   siteDetailSections(ctx, site)   [{ order, html, mount?(rootEl, site) }]
 *   siteDetailButtons(ctx, site)    [{ order, html }]
 * ===================================================================== */
(function () {
  'use strict';
  const { $, esc } = DH;
  const DEFAULT_ADMIN_EMAIL = 'spaceaids8637@gmail.com';
  const api = DH.createApi({ configKey: 'dh_sb_config', sessionKey: 'dh_sb_session' });
  const ctx = (DH.ctx = {
    app: 'admin',
    api,
    profile: null,
    data: null, // dh_admin_snapshot 결과 (sites, permits, employees, equipment, contracts, drawings, approvers)
    tab: 'dashboard',
    selectedDate: DH.today(),
    editId: null,
    modalType: '',
  });
  DH.rpc = (...args) => api.rpc(...args);

  /* ---------- 공통 조회 도우미 ---------- */
  DH.siteName = (id) => ctx.data?.sites.find((s) => s.id === id)?.name || '현장';
  DH.person = (id) => ctx.data?.employees.find((e) => e.id === id)?.name || '미지정';

  /* ---------- 데이터 ---------- */
  function monthRange() {
    const year = DH.workDay().slice(0, 4);
    // 전주·차주가 연도를 넘는 경우까지 포함합니다. 최대 394일로 두 RPC의 400일 제한 이내입니다.
    return [DH.addDay(`${year}-01-01`, -14), DH.addDay(`${year}-12-31`, 14)];
  }
  async function reload() {
    const [from, to] = monthRange();
    const [profile, data] = await Promise.all([
      api.rpc('dh_my_profile'),
      api.rpc('dh_admin_snapshot', { p_from: from, p_to: to }),
    ]);
    if (!profile || !['owner', 'manager'].includes(profile.role))
      throw Object.assign(Error('관리자 계정으로 다시 로그인해 주세요.'), { authRequired: true });
    ctx.profile = profile;
    ctx.data = data;
    try {
      const extra = await api.rpc('dh_admin_unit_context', { p_from: from, p_to: to });
      const types = new Map((extra.sites || []).map(site => [site.id, site.contract_type]));
      const memos = new Map((extra.task_memos || []).map(task => [task.id, task.order_memo]));
      data.sites.forEach(site => { site.contract_type = types.get(site.id) || 'standard'; });
      data.permits.forEach(permit => permit.tasks.forEach(task => {
        task.order_memo = memos.get(task.id) || '';
      }));
    } catch (error) {
      if (error.authRequired) throw error;
      if (!(error.status === 404 || error.code === 'PGRST202'))
        console.warn('단가계약 추가 정보 조회 실패', error);
    }
    ctx.unresolvedState = 'loading';
    try {
      const unpublished = await api.rpc('dh_admin_unpublished_permits');
      if (!Array.isArray(unpublished)) throw Error('미결재 계획서 응답을 확인하지 못했습니다.');
      const byId = new Map(data.permits.map(permit => [permit.id, permit]));
      unpublished.forEach(permit => byId.set(permit.id, permit));
      data.permits = [...byId.values()];
      ctx.unresolvedState = 'ready';
    } catch (error) {
      if (error.authRequired) throw error;
      ctx.unresolvedState = 'failed';
      console.warn('전체 미결재 작업계획서 조회 실패', error);
    }
    await DH.loadAll('adminLoad', ctx);
    render();
  }

  /* ---------- 모달 ---------- */
  let modalCleanup = null;
  DH.ui = {
    open(title, body, foot = '', cleanup = null) {
      modalCleanup?.();
      modalCleanup = cleanup;
      $('#overlay').innerHTML = `<div class="modalback"><div class="modal"><div class="modalhead"><h2>${title}</h2><button class="btn tiny" data-action="modal-close">닫기</button></div><div class="modalbody">${body}</div>${foot ? `<div class="modalfoot">${foot}</div>` : ''}</div></div>`;
      return DH.ui.body();
    },
    body: () => $('#overlay .modalbody'),
    close() {
      modalCleanup?.();
      modalCleanup = null;
      $('#overlay').innerHTML = '';
      ctx.modalType = '';
      ctx.editId = null;
    },
  };

  /* ---------- 화면 ---------- */
  function tabs() {
    return [{ id: 'dashboard', label: '대시보드', order: 0, render: dashboard }, ...DH.collect('adminTabs', ctx)].sort(DH.byOrder);
  }
  function render() {
    if (!api.session || !ctx.data) return showLogin();
    const oldCalendar = $('.calendar');
    const oldCalendarState = oldCalendar && { month: oldCalendar.dataset.currentMonth, scrollTop: oldCalendar.scrollTop };
    const list = tabs();
    const current = list.find((t) => t.id === ctx.tab) || list[0];
    $('#root').innerHTML = `<header><strong>대흥기업 현장관리</strong><nav class="tabs">${list
      .map((t) => `<button data-action="tab" data-tab="${t.id}" class="${t === current ? 'on' : ''}">${esc(t.label)}</button>`)
      .join('')}</nav><div class="right"><small>${esc(ctx.profile?.name)} · ${ctx.profile?.role === 'owner' ? '총괄 관리자' : '현장 담당자'}</small><button class="btn tiny" data-action="reload">새로고침</button><button class="btn tiny" data-action="logout">로그아웃</button></div></header><main class="page">${current.render(ctx)}</main>`;
    if (current.id === 'dashboard') requestAnimationFrame(() => {
      const calendar = $('.calendar');
      if (!calendar) return;
      const currentMonth = DH.workDay().slice(0, 7);
      if (oldCalendarState?.month === currentMonth) {
        calendar.scrollTop = oldCalendarState.scrollTop;
        return;
      }
      const month = calendar.querySelector(`[data-calendar-month="${currentMonth}"]`);
      if (month) calendar.scrollTop += month.getBoundingClientRect().top - calendar.getBoundingClientRect().top;
    });
  }
  function dashboard() {
    const slots = { left: [], center: [], right: [] };
    DH.collect('dashboardPanels', ctx)
      .sort(DH.byOrder)
      .forEach((p) => slots[p.slot || 'left'].push(p.html));
    return `<div class="grid">${['left', 'center', 'right'].map((s) => `<div class="col">${slots[s].join('')}</div>`).join('')}</div>`;
  }
  function login() {
    $('#root').innerHTML = `<div class="login"><div class="card"><h1>대흥기업 현장관리</h1><p>관리자용 Supabase 연결판입니다. 프로젝트 주소와 공개 키가 입력되어 있습니다.</p><form id="loginform"><label class="field">Supabase 프로젝트 URL<input name="url" type="url" placeholder="https://xxxx.supabase.co" value="${esc(api.conf.url)}" required></label><label class="field">Publishable 또는 anon 키<input name="key" value="${esc(api.conf.key)}" required autocomplete="off"></label><label class="field">관리자 이메일<input name="email" type="email" value="${esc(DEFAULT_ADMIN_EMAIL)}" required autocomplete="username"></label><label class="field">비밀번호<input name="password" type="password" required autocomplete="current-password"></label><button class="btn primary" type="submit">로그인</button><p class="small">service_role 키는 입력하지 마세요. 관리자 계정은 Supabase Auth와 V6 app_account에 등록되어 있어야 합니다.</p></form></div></div>`;
  }
  const baseLogin = login;
  function showLogin() {
    baseLogin();
    $('#loginform').insertAdjacentHTML('afterend', '<button class="btn" type="button" data-action="connection-check" data-form="loginform">서버 연결 확인</button><p class="small" id="connection-result" role="status"></p>');
  }
  DH.onAuthRequired = () => {
    api.clearSession();
    ctx.profile = ctx.data = ctx.sales = ctx.situations = null;
    ctx.progressRows = []; ctx.progressState = 'idle'; ctx.fieldMessages = []; ctx.salesState = 'idle';
    DH.collect('sessionReset');
    DH.ui.close();
    showLogin();
  };
  DH.onLoadError = () => {
    if (ctx.data) return;
    $('#root').innerHTML = '<div class="login"><div class="card"><h1>연결을 확인해 주세요</h1><p>데이터를 불러오지 못했습니다. 잠시 후 다시 시도할 수 있습니다.</p><button class="btn primary" data-action="reload">다시 연결</button> <button class="btn" data-action="login-reset">로그인 화면</button></div></div>';
  };
  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'loginform') return;
    e.preventDefault();
    DH.act(async () => {
      await api.signIn(Object.fromEntries(new FormData(e.target)));
      const profile = await api.rpc('dh_my_profile');
      if (!profile || !['owner', 'manager'].includes(profile.role)) {
        api.clearSession();
        throw Error('관리자 계정 등록이 필요합니다');
      }
      api.saveSession();
      await reload();
    });
  });

  /* ---------- 공통 버튼 ---------- */
  DH.action('tab', (el) => {
    ctx.tab = el.dataset.tab;
    render();
  });
  DH.action('reload', () => DH.act(reload));
  DH.action('modal-close', () => DH.ui.close());
  DH.action('logout', () => DH.act(async () => { await api.signOut(); DH.onAuthRequired(); }));
  DH.action('login-reset', () => DH.onAuthRequired());
  DH.action('row-remove', (el) => el.closest('.row').remove());

  DH.admin = { ctx, reload, render };
  DH.adminStart = () => (api.session ? DH.act(reload) : showLogin());
  let autoRefreshing = false;
  setInterval(async () => {
    if (autoRefreshing || !ctx.data || ctx.tab !== 'dashboard' || ctx.modalType || document.visibilityState !== 'visible') return;
    autoRefreshing = true;
    try { await reload(); }
    catch (error) {
      if (error.authRequired) DH.onAuthRequired();
      else console.warn('대시보드 자동 갱신 실패', error);
    } finally { autoRefreshing = false; }
  }, 15000);
})();
