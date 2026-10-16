/* =====================================================================
 * 기능: 현장 및 영업 관리 (관리자)
 *  - 현장 목록 탭, 대시보드 '진행 중인 현장', 현장 등록·수정
 *  - 발주처/원도급 회사와 담당자(이력 보존)
 *  - 현장 상세 모달의 틀 → 다른 기능(계약내역·도면·작업계획)이 섹션을 끼워 넣습니다
 * RPC: dh_contract_progress_snapshot, dh_sales_snapshot, dh_save_sales_site
 * ===================================================================== */
(function () {
  'use strict';
  const { $, $$, esc, num } = DH;
  const ctx = () => DH.ctx;
  const ROLES = { client: { label: '발주처', field: 'client_name' }, prime: { label: '원도급', field: 'prime_contractor' } };
  let ongoingSiteId = null;
  const percent = (value) => `${Number(value).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  const isUnit = site => site?.contract_type === 'unit_price';

  function progressOf(id) {
    if (isUnit(ctx().data?.sites.find(site => site.id === id))) return null;
    if (ctx().progressState !== 'ready') return null;
    const rows = ctx().progressRows.filter((item) => item.site_id === id);
    if (!rows.length) return null;
    if (rows.some(item => Number(item.target_quantity) <= 0)) return null;
    const completion = rows.reduce((sum, item) => sum + Math.min(1, Number(item.actual_quantity) / Number(item.target_quantity)), 0);
    return Math.round(completion / rows.length * 10000) / 100;
  }
  const progressLabel = (id) => isUnit(ctx().data?.sites.find(site => site.id === id)) ? '작업 내역' :
    ctx().progressState !== 'ready' ? '조회 실패' :
    progressOf(id) === null ? '계약 내역 없음' : percent(progressOf(id));
  const stateOf = (s) => (s.completed_on ? '완료' : s.started_on ? '진행 중' : '계약');
  const bar = (q) => `<div class="bar"><i style="width:${Math.min(100, Number(q))}%"></i></div>`;

  /* ---------- 현장 상세 (다른 기능이 섹션 추가) ---------- */
  function detail(id) {
    const c = ctx(),
      s = c.data.sites.find((x) => x.id === id);
    if (!s) return;
    c.modalType = 'site-detail';
    c.editId = id;
    const sections = DH.collect('siteDetailSections', c, s).sort(DH.byOrder);
    const buttons = DH.collect('siteDetailButtons', c, s).sort(DH.byOrder);
    const body = DH.ui.open(esc(s.name), sections.map((x) => x.html).join(''), buttons.map((b) => b.html).join(''));
    sections.forEach((x) => x.mount?.(body, s));
  }
  /** 저장 후: 모달 닫기 → 전체 새로고침 → 같은 현장 상세 다시 열기 */
  async function reloadDetail(id) {
    DH.ui.close();
    await DH.admin.reload();
    detail(id);
  }

  /* ---------- 영업: 회사·담당자 ---------- */
  function party(siteId, role) {
    const s = ctx().sales || {};
    const p = s.parties?.find((x) => x.site_id === siteId && x.party_role === role);
    const org = s.organizations?.find((x) => x.id === p?.organization_id);
    const active = (s.assignments || []).filter((x) => x.site_id === siteId && x.party_role === role && !x.ended_on);
    return { org, contacts: active.map((x) => s.contacts?.find((c) => c.id === x.contact_id)).filter(Boolean) };
  }
  function contactHistoryHtml(siteId, role) {
    const sales = ctx().sales || {},
      { org } = party(siteId, role);
    const rows = (sales.assignments || []).filter((x) => x.site_id === siteId && x.party_role === role);
    return `<h3 class="section">${ROLES[role].label} 담당자 · ${esc(org?.name || '미등록')}</h3>${
      rows.length
        ? rows
            .map((a) => {
              const c = sales.contacts?.find((x) => x.id === a.contact_id);
              return `<div class="item"><b>${esc(c?.name || '담당자')} ${esc(c?.position || '')}</b><small>${esc(c?.phone || '전화번호 없음')} · ${esc(c?.email || '메일주소 없음')}<br>${esc(a.assigned_on)} ~ ${esc(a.ended_on || '현재')}</small></div>`;
            })
            .join('')
        : '<p class="muted">등록된 담당자 없음</p>'
    }`;
  }
  function contactRow(role, c = {}) {
    return `<div class="row dh-contact" data-role="${role}" style="align-items:end;flex-wrap:wrap;border-bottom:1px solid #e3e8ef;padding:8px 0">
    <input class="dh-contact-id" type="hidden" value="${esc(c.id || '')}">
    <label class="field" style="min-width:125px;flex:1">이름<input class="dh-contact-name" value="${esc(c.name || '')}" required></label>
    <label class="field" style="min-width:105px;flex:1">직위<input class="dh-contact-position" value="${esc(c.position || '')}"></label>
    <label class="field" style="min-width:125px;flex:1">전화번호<input class="dh-contact-phone" type="tel" value="${esc(c.phone || '')}"></label>
    <label class="field" style="min-width:160px;flex:1">메일주소<input class="dh-contact-email" type="email" value="${esc(c.email || '')}"></label>
    <button class="btn tiny" type="button" data-action="contact-remove">제외</button>
  </div>`;
  }
  function roleEditor(siteId, role) {
    const { contacts } = party(siteId, role),
      orgs = ctx().sales?.organizations || [],
      all = ctx().sales?.contacts || [];
    return `<h3 class="section">${ROLES[role].label} 담당자</h3>
    <p class="small muted">회사를 입력한 뒤 담당자를 등록하세요. 기존 담당자를 선택하면 이전 현장 이력이 이어집니다.</p>
    <datalist id="dh-${role}-orgs">${orgs.map((o) => `<option value="${esc(o.name)}">`).join('')}</datalist>
    <label class="field">기존 담당자 연결<select class="dh-existing" data-role="${role}"><option value="">선택해서 추가</option>${all
      .map((c) => {
        const o = orgs.find((x) => x.id === c.organization_id);
        return `<option value="${c.id}">${esc(o?.name || '')} · ${esc(c.name)} ${esc(c.position || '')}</option>`;
      })
      .join('')}</select></label>
    <div id="dh-${role}-rows">${contacts.map((c) => contactRow(role, c)).join('')}</div>
    <button class="btn tiny" type="button" data-action="contact-add" data-role="${role}">담당자 추가</button>`;
  }

  /* ---------- 현장 등록 · 수정 ---------- */
  function siteForm(id) {
    const c = ctx(),
      s = c.data.sites.find((x) => x.id === id) || {};
    if (c.salesState !== 'ready') {
      DH.ui.open('담당자 정보 확인 필요', '<p>담당자 정보를 불러오지 못해 현장을 저장할 수 없습니다. 다시 불러온 뒤 수정해 주세요.</p>', '<button class="btn primary" data-action="site-retry" data-id="' + esc(id || '') + '">다시 불러오기</button>');
      return;
    }
    c.modalType = 'site';
    c.editId = id || null;
    DH.ui.open(
      id ? '현장 정보 수정' : '현장 등록',
      `<form id="siteform"><div class="two"><label class="field">현장명<input name="name" value="${esc(s.name)}" required></label><label class="field">주소<input name="address" value="${esc(s.address)}"></label><label class="field">발주처<input name="client_name" list="dh-client-orgs" value="${esc(s.client_name)}"></label><label class="field">원도급<input name="prime_contractor" list="dh-prime-orgs" value="${esc(s.prime_contractor)}"></label><label class="field">계약 유형<select name="contract_type"><option value="standard" ${isUnit(s) ? '' : 'selected'}>일반 공사</option><option value="unit_price" ${isUnit(s) ? 'selected' : ''}>단가계약</option></select></label><label class="field">준공일<input name="completion_due" type="date" value="${esc(s.completion_due)}"></label><label class="field">완료일<input name="completed_on" type="date" value="${esc(s.completed_on)}"></label></div>${roleEditor(id, 'client')}${roleEditor(id, 'prime')}</form>`,
      `<button class="btn" data-action="modal-close">취소</button><button class="btn primary" data-action="site-save">저장</button>`
    );
  }
  async function saveSite() {
    if (ctx().salesState !== 'ready') throw Error('담당자 정보를 다시 불러온 뒤 저장해 주세요.');
    const form = $('#siteform'),
      v = Object.fromEntries(new FormData(form));
    const collect = (role) =>
      $$(`.dh-contact[data-role="${role}"]`, form).map((row) => ({
        id: $('.dh-contact-id', row).value || undefined,
        name: $('.dh-contact-name', row).value.trim(),
        position: $('.dh-contact-position', row).value.trim(),
        phone: $('.dh-contact-phone', row).value.trim(),
        email: $('.dh-contact-email', row).value.trim(),
      }));
    if (!v.name.trim()) throw Error('현장명을 입력하세요');
    if (!v.client_name.trim() && collect('client').length) throw Error('발주처 회사를 입력하세요');
    if (!v.prime_contractor.trim() && collect('prime').length) throw Error('원도급 회사를 입력하세요');
    if ([...collect('client'), ...collect('prime')].some((x) => !x.name)) throw Error('담당자 이름을 입력하세요');
    const p_data = { ...v, id: ctx().editId || undefined,
      client_contacts: collect('client'), prime_contacts: collect('prime') };
    try {
      await DH.rpc('dh_save_sales_site_with_type', { p_data });
    } catch (error) {
      if (v.contract_type !== 'standard' ||
        !(error.status === 404 || error.code === 'PGRST202')) throw error;
      const { contract_type, ...legacyData } = p_data;
      await DH.rpc('dh_save_sales_site', { p_data: legacyData });
    }
    DH.ui.close();
    await DH.admin.reload();
    DH.toast('현장과 담당자를 저장했습니다');
  }

  /* ---------- 탭 · 패널 ---------- */
  function sitesPage(c) {
    return `<div class="head"><div><h1>현장 현황 · 관리</h1><p class="muted">계약 현장, 준공일, 실제 작업량 기준 진행률</p></div><button class="btn primary" data-action="site-new">현장 등록</button></div>${c.progressState === 'failed' ? '<p class="contract-warning" role="status">계약 진행률을 불러오지 못했습니다. 새로고침 후에도 같으면 서버의 진행현황 조회 설정을 확인해 주세요.</p>' : ''}<div class="tablebox"><table><thead><tr><th>현장명</th><th>발주처</th><th>원도급</th><th>준공일</th><th>상태</th><th>진행률 / 작업 내역</th><th></th></tr></thead><tbody>${c.data.sites
      .map((s) => {
        const q = progressOf(s.id);
        return `<tr><td><b>${esc(s.name)}</b><div class="small muted">${esc(s.address)}</div></td><td>${esc(s.client_name)}</td><td>${esc(s.prime_contractor)}</td><td>${esc(s.completion_due || '미입력')}</td><td>${stateOf(s)}</td><td>${isUnit(s) ? `<button class="site-progress-button" type="button" data-action="unit-log-open" data-id="${esc(s.id)}">작업 내역</button>` : q === null ? `<span class="${c.progressState === 'ready' ? 'muted' : 'pill bad'}">${progressLabel(s.id)}</span>` : `<button class="site-progress-button" type="button" data-action="site-progress" data-id="${esc(s.id)}" aria-label="${esc(s.name)} 계약 진행현황 보기">${percent(q)}</button>${bar(q)}`}</td><td><button class="btn tiny" data-action="site-detail" data-id="${s.id}">상세</button></td></tr>`;
      })
      .join('')}</tbody></table></div>`;
  }
  function ongoingPanel(c) {
    const ongoing = c.data.sites.filter((s) => s.started_on && !s.completed_on);
    const index = Math.max(ongoing.findIndex((s) => s.id === ongoingSiteId), 0);
    ongoingSiteId = ongoing[index]?.id || null;
    return `<section class="card ongoing-card"><h2><button class="ongoing-heading" data-action="tab" data-tab="sites">현재 진행 중인 현장</button><span class="pill">${ongoing.length}</span></h2><div id="ongoing-slide">${ongoing.length ? ongoingItem(ongoing[index]) : '<div class="empty">진행 중인 현장이 없습니다</div>'}</div>${ongoing.length > 1 ? `<div class="ongoing-nav"><button class="btn tiny" data-action="ongoing-prev" aria-label="이전 현장">‹</button><span id="ongoing-position" aria-live="polite">${index + 1} / ${ongoing.length}</span><button class="btn tiny" data-action="ongoing-next" aria-label="다음 현장">›</button></div>` : ''}</section>`;
  }
  function ongoingItem(s) {
    const q = progressOf(s.id);
    return `<button class="item ongoing-site" data-action="tab" data-tab="sites" aria-label="${esc(s.name)} · 현장 현황·관리로 이동"><b><span class="ongoing-site-name">${esc(s.name)}</span><span class="ongoing-progress">${progressLabel(s.id)}</span></b><small>준공일 ${esc(s.completion_due || '미입력')}</small>${q === null ? '' : bar(q)}</button>`;
  }
  function moveOngoing(step) {
    const ongoing = ctx().data?.sites.filter((s) => s.started_on && !s.completed_on) || [];
    const slide = $('#ongoing-slide'), position = $('#ongoing-position');
    if (ongoing.length < 2 || !slide || !position) return;
    const index = Math.max(ongoing.findIndex((s) => s.id === ongoingSiteId), 0);
    const next = (index + step + ongoing.length) % ongoing.length;
    ongoingSiteId = ongoing[next].id;
    slide.innerHTML = ongoingItem(ongoing[next]);
    position.textContent = `${next + 1} / ${ongoing.length}`;
  }

  DH.register({
    name: '현장 및 영업 관리',
    order: 10,
    async adminLoad(c) {
      c.salesState = 'loading'; c.sales = null; c.progressRows = []; c.progressState = 'loading';
      const [progress, sales] = await Promise.allSettled([DH.rpc('dh_contract_progress_snapshot'), DH.rpc('dh_sales_snapshot')]);
      if (progress.status === 'fulfilled' && Array.isArray(progress.value) && progress.value.every((row) =>
        row.id && row.site_id && Number.isFinite(Number(row.target_quantity)) && Number(row.target_quantity) >= 0 &&
        Number.isFinite(Number(row.actual_quantity)) && Number(row.actual_quantity) >= 0)) {
        const expected = c.data.contracts.filter((item) => item.active).map((item) => item.id);
        const received = progress.value.map((item) => item.id);
        if (expected.length === received.length && expected.every((id) => received.includes(id)) && new Set(received).size === received.length) {
          c.progressRows = progress.value; c.progressState = 'ready';
        }
      }
      if (c.progressState !== 'ready') c.progressState = 'failed';
      if (sales.status === 'fulfilled' && sales.value && ['organizations', 'contacts', 'parties', 'assignments'].every((key) => Array.isArray(sales.value[key]))) {
        c.sales = sales.value; c.salesState = 'ready';
      } else c.salesState = 'failed';
      const auth = [progress, sales].find((r) => r.status === 'rejected' && r.reason.authRequired);
      if (auth) throw auth.reason;
      if (c.salesState !== 'ready') throw Error('담당자 조회 실패: 현장 저장이 잠겼습니다.');
      if (c.progressState !== 'ready') console.warn('계약 진행률 조회 실패', progress.status === 'rejected' ? progress.reason : '조회 결과가 계약 내역과 일치하지 않습니다.');
    },
    adminTabs: { id: 'sites', label: '현장 현황 · 관리', order: 20, render: sitesPage },
    dashboardPanels: (c) => ({ slot: 'left', order: 10, html: ongoingPanel(c) }),
    siteDetailSections: (c, s) => {
      const q = progressOf(s.id);
      return [
        { order: 10, html: contactHistoryHtml(s.id, 'client') + contactHistoryHtml(s.id, 'prime') },
        {
          order: 20,
          html: `<div class="two"><div><p><b>발주처</b> ${esc(s.client_name || '—')}</p><p><b>원도급</b> ${esc(s.prime_contractor || '—')}</p><p><b>주소</b> ${esc(s.address || '—')}</p></div><div><p><b>준공일</b> ${esc(s.completion_due || '미입력')}</p><p><b>상태</b> ${stateOf(s)}</p><p><b>${isUnit(s) ? '단가계약' : '진행률'}</b> ${isUnit(s) ? '기간별 작업 내역으로 확인' : progressLabel(s.id)}</p></div></div>`,
        },
      ];
    },
    siteDetailButtons: (c, s) => ({ order: 10, html: `<button class="btn" data-action="site-edit" data-id="${s.id}">기본 정보 수정</button>${isUnit(s) ? `<button class="btn" data-action="unit-log-open" data-id="${s.id}">작업 내역</button>` : ''}` }),
  });

  DH.action('site-detail', (el) => detail(el.dataset.id));
  DH.action('ongoing-prev', () => moveOngoing(-1));
  DH.action('ongoing-next', () => moveOngoing(1));
  setInterval(() => {
    if (ctx().tab === 'dashboard' && !ctx().modalType && document.visibilityState === 'visible') moveOngoing(1);
  }, 8000);
  DH.action('site-new', () => siteForm());
  DH.action('site-edit', (el) => siteForm(el.dataset.id));
  DH.action('site-save', () => DH.act(saveSite));
  DH.action('site-retry', (el) => DH.act(async () => { await DH.admin.reload(); siteForm(el.dataset.id || undefined); }));
  DH.action('contact-add', (el) => $(`#dh-${el.dataset.role}-rows`).insertAdjacentHTML('beforeend', contactRow(el.dataset.role)));
  DH.action('contact-remove', (el) => el.closest('.dh-contact').remove());
  DH.on('change', '.dh-existing', (select) => {
    if (!select.value) return;
    const sales = ctx().sales,
      role = select.dataset.role;
    const contact = sales.contacts.find((x) => x.id === select.value),
      org = sales.organizations.find((x) => x.id === contact?.organization_id);
    const company = $(`#siteform [name="${ROLES[role].field}"]`);
    select.value = '';
    if (company.value.trim() && company.value.trim() !== org?.name) return DH.toast('선택한 담당자의 회사가 입력한 회사와 다릅니다');
    company.value = org.name;
    const rows = $(`#dh-${role}-rows`);
    if (!$$('.dh-contact-id', rows).some((x) => x.value === contact.id)) rows.insertAdjacentHTML('beforeend', contactRow(role, contact));
  });

  DH.sites = { detail, reloadDetail, form: siteForm, progress: progressOf };
})();
