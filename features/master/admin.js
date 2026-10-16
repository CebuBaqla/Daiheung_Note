/* =====================================================================
 * 기능: 기본 정보 (관리자) — 직원 · 장비
 * RPC: dh_admin_save_master('employee' | 'equipment', ...)
 * ===================================================================== */
(function () {
  'use strict';
  const { $, esc } = DH;
  const KINDS = { employee: '직원', equipment: '장비' };

  function page(c) {
    const list = (rows, withPosition) =>
      rows.map((e) => `<div class="item"><b>${esc(e.name)} ${!e.active ? '<span class="pill">비활성</span>' : ''}</b>${withPosition ? `<small>${esc(e.position)}</small>` : ''}</div>`).join('');
    return `<div class="head"><div><h1>기본 정보</h1><p class="muted">작업자와 장비. 로그인 계정 생성은 Supabase 관리자 설정에서 연결합니다.</p></div></div><div class="two"><section class="card"><h2>직원 <button class="link" data-action="master-new" data-kind="employee">추가</button></h2><div>${list(c.data.employees, true)}</div></section><section class="card"><h2>장비 <button class="link" data-action="master-new" data-kind="equipment">추가</button></h2><div>${list(c.data.equipment, false)}</div></section></div>`;
  }

  DH.register({
    name: '기본 정보',
    order: 90,
    adminTabs: { id: 'master', label: '기본 정보', order: 40, render: page },
  });
  DH.action('master-new', (el) => {
    const kind = el.dataset.kind;
    DH.ctx.modalType = kind;
    DH.ui.open(
      `${KINDS[kind]} 추가`,
      `<label class="field">명칭<input id="master-name"></label>${kind === 'employee' ? '<label class="field">직책<input id="master-position"></label>' : ''}`,
      `<button class="btn primary" data-action="master-save" data-kind="${kind}">저장</button>`
    );
  });
  DH.action('master-save', (el) =>
    DH.act(async () => {
      const name = $('#master-name').value.trim();
      if (!name) throw Error('명칭을 입력하세요');
      await DH.rpc('dh_admin_save_master', { p_kind: el.dataset.kind, p_data: { name, position: $('#master-position')?.value.trim() } });
      DH.ui.close();
      await DH.admin.reload();
      DH.toast('저장했습니다');
    })
  );
})();
