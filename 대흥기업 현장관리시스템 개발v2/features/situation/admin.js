/* =====================================================================
 * 기능: 상황발생 (관리자) — 새로 연결한 화면
 *  - 대시보드 '상황발생' 패널: 진행 중 상황을 위에, 최근 해결 건을 아래에
 *  - 상세에서 확인·해결 기록 열람
 *  - 허가서 작성자(현장 담당자)는 PC에서도 후속 기록 작성 가능
 * RPC: dh_situation_snapshot, dh_add_situation_update
 * ===================================================================== */
(function () {
  'use strict';
  const { $, esc } = DH;
  const ctx = () => DH.ctx;
  const list = () => ctx().situations?.situations || [];
  const stateTag = (s) => `<span class="pill ${s.status === 'resolved' ? 'ok' : 'bad'}">${s.status === 'resolved' ? '해결' : '진행 중'}</span>`;

  function panel() {
    const items = [...list()].sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1)).slice(0, 8);
    const open = list().filter((s) => s.status === 'open').length;
    return `<section class="card"><h2>🚩 상황발생 <span class="pill ${open ? 'bad' : ''}">진행 중 ${open}</span></h2><div class="list">${
      items.length
        ? items
            .map(
              (s) =>
                `<button class="item" data-action="situation-detail" data-id="${s.id}"><b>${esc(s.site_name)} ${stateTag(s)}</b><small>${esc(s.work_date)} · 담당 ${esc(s.owner_name)} · 공유 ${esc(s.reporter_name)}</small><small>${esc(s.description.slice(0, 60))}</small></button>`
            )
            .join('')
        : '<div class="empty">기록된 상황발생이 없습니다.</div>'
    }</div></section>`;
  }

  function detail(id) {
    const c = ctx(),
      s = list().find((x) => x.id === id);
    if (!s) return;
    c.modalType = 'situation';
    c.editId = id;
    const files = (c.fieldMessages || []).find((m) => m.id === id)?.files || [];
    const canWrite = s.owner_id === c.profile?.employee_id && s.status === 'open';
    DH.ui.open(
      '상황발생 상세',
      `<p>${stateTag(s)} <b>${esc(s.site_name)}</b> · ${esc(s.work_date)}</p><p class="small muted">허가서 작성자 · ${esc(s.owner_name)} / 공유 · ${esc(s.reporter_name)} / ${new Date(s.created_at).toLocaleString('ko-KR')}</p><p style="white-space:pre-wrap">${esc(s.description)}</p>
${files.length && DH.share ? `<h3 class="section">첨부</h3>${DH.share.filesHtml(files)}` : ''}
<h3 class="section">확인·해결 기록</h3>${
        s.updates.length
          ? s.updates
              .map(
                (u) =>
                  `<div class="item"><b>${esc(u.author_name)} · ${new Date(u.created_at).toLocaleString('ko-KR')} ${u.resolved ? '<span class="pill ok">해결 완료</span>' : ''}</b><small style="white-space:pre-wrap">확인·판단 흐름: ${esc(u.flow)}</small><small style="white-space:pre-wrap">조치·결과: ${esc(u.outcome || '진행 중')}</small></div>`
              )
              .join('')
          : '<p class="muted">아직 후속 기록이 없습니다.</p>'
      }
${
  canWrite
    ? `<h3 class="section">현장 담당자 후속 기록</h3><label class="field">무엇을 확인했고, 다음에 무엇을 판단했나요?<textarea id="situation-flow" placeholder="예: 도면 확인 → 현장 치수 재측정 → 전무님과 대안 검토"></textarea></label><label class="field">실제 조치와 결과 (진행 중이면 비워도 됩니다)<textarea id="situation-outcome"></textarea></label><label class="row"><input id="situation-resolved" type="checkbox"> 이 상황 해결 완료</label>`
    : ''
}`,
      `<button class="btn" data-action="modal-close">닫기</button>${canWrite ? `<button class="btn primary" data-action="situation-save" data-id="${id}">기록 저장</button>` : ''}`
    );
    const pending = DH.pendingSituation(id, s.updates);
    if (pending && canWrite) {
      $('#situation-flow').value = pending.flow;
      $('#situation-outcome').value = pending.outcome;
      $('#situation-resolved').checked = pending.resolved;
    }
    if (files.length && DH.share) DH.share.hydrateFiles(files);
  }

  DH.register({
    name: '상황발생',
    order: 70,
    async adminLoad(c) {
      const today = DH.today();
      c.situations = null;
      c.situations = await DH.rpc('dh_situation_snapshot', { p_from: DH.addDay(today, -30), p_to: DH.addDay(today, 7) });
    },
    dashboardPanels: () => ({ slot: 'left', order: 30, html: panel() }),
  });
  DH.action('situation-detail', (el) => detail(el.dataset.id));
  DH.action('situation-save', (el) =>
    DH.act(async () => {
      const flow = $('#situation-flow').value.trim(),
        outcome = $('#situation-outcome').value.trim(),
        resolved = $('#situation-resolved').checked;
      if (!flow) throw Error('확인·판단 흐름을 입력하세요');
      if (resolved && !outcome) throw Error('해결 결과를 입력하세요');
      await DH.saveSituationUpdate(el.dataset.id, { flow, outcome, resolved });
      DH.ui.close();
      await DH.admin.reload();
      detail(el.dataset.id);
      DH.toast('후속 기록을 저장했습니다');
    })
  );
})();
