/* =====================================================================
 * 기능: 상황발생 (모바일)
 *  - 현장공유 폼에 '🚩 상황발생으로 기록' 체크 추가
 *  - 타임라인 말풍선에 진행 중/해결 표시, 상단 '내 상황발생 기록' · '상황 기록 검색'
 *  - 허가서 작성자(현장 담당자)가 확인 흐름 · 조치 · 해결을 이어서 기록
 * RPC: dh_situation_snapshot (share_links 포함), dh_add_situation_update
 * ===================================================================== */
(function () {
  'use strict';
  const { $, esc } = DH;
  const ctx = () => DH.ctx;
  const all = () => ctx().data.situationData?.situations || [];
  const find = (id) => all().find((x) => x.id === id);
  const stateText = (s) => (s.status === 'resolved' ? '해결' : '진행 중');

  function list(mine) {
    const items = mine ? all().filter((x) => x.owner_id === ctx().profile.employee_id) : all();
    DH.panel(
      mine ? '내 상황발생 기록' : '상황 기록 검색',
      `<p class="hint">문제와 확인 과정, 해결 결과를 함께 검색합니다. 작업종료 뒤에도 진행 중인 상황을 계속 기록할 수 있습니다.</p><input id="situation-search" type="search" placeholder="문제·확인 과정·해결 결과 검색"><div id="situation-results"></div>`
    );
    const draw = () => {
      const term = $('#situation-search').value.trim().toLocaleLowerCase();
      const filtered = items.filter((s) =>
        [s.site_name, s.description, s.owner_name, ...(s.updates || []).flatMap((u) => [u.flow, u.outcome])].join(' ').toLocaleLowerCase().includes(term)
      );
      $('#situation-results').innerHTML = filtered.length
        ? filtered
            .map(
              (s) =>
                `<button class="bubble" data-action="situation-open" data-id="${s.id}" style="margin:12px 0"><div class="kind">🚩 ${stateText(s)}</div><div class="message-site">${esc(s.site_name)}</div><div class="summary">${esc(s.description)}</div><div class="message-foot">${esc(s.owner_name)} · ${esc(s.work_date)}</div></button>`
            )
            .join('')
        : '<div class="empty">검색된 기록이 없습니다.</div>';
    };
    $('#situation-search').oninput = draw;
    draw();
  }

  function detail(id) {
    const s = find(id);
    if (!s) return;
    const canWrite = s.owner_id === ctx().profile.employee_id && s.status === 'open';
    const files = ctx().data.messages.find((x) => x.id === id)?.files || [];
    DH.panel(
      '상황발생 상세',
      `<section class="detail-section"><span class="tag">${stateText(s)}</span><h2>${esc(s.site_name)}</h2><small>허가서 작성자 · ${esc(s.owner_name)} / 공유 · ${esc(s.reporter_name)}</small><p style="white-space:pre-wrap">${esc(s.description)}</p></section>
${files.length ? `<section class="detail-section"><h3>첨부</h3>${DH.share ? DH.share.filesHtml(files) : ''}</section>` : ''}
<section class="detail-section"><h3>확인·해결 기록</h3>${
        (s.updates || []).length
          ? s.updates
              .map(
                (u) =>
                  `<div class="card task-card"><b>${esc(u.author_name)} · ${new Date(u.created_at).toLocaleString('ko-KR')}</b><p style="white-space:pre-wrap">확인·판단 흐름: ${esc(u.flow)}</p><p style="white-space:pre-wrap">조치·결과: ${esc(u.outcome || '진행 중')}</p>${u.resolved ? '<span class="tag">해결 완료</span>' : ''}</div>`
              )
              .join('')
          : '<p class="hint">아직 후속 기록이 없습니다.</p>'
      }</section>
${
  canWrite
    ? `<form id="situation-update" data-id="${id}"><h3>현장 담당자 후속 기록</h3><label>무엇을 확인했고, 다음에 무엇을 판단했나요?<textarea id="situation-flow" required placeholder="예: 도면 확인 → 현장 치수 재측정 → 전무님과 대안 검토"></textarea></label><label>실제 조치와 결과 <small>(진행 중이면 비워도 됩니다)</small><textarea id="situation-outcome" placeholder="실제로 한 조치와 결과"></textarea></label><label class="row"><input id="situation-resolved" type="checkbox"> 이 상황 해결 완료</label><button class="primary wide submit" type="submit">기록 저장</button></form>`
    : ''
}`
    );
    const pending = DH.pendingSituation(id, s.updates);
    if (pending && canWrite) {
      $('#situation-flow').value = pending.flow;
      $('#situation-outcome').value = pending.outcome;
      $('#situation-resolved').checked = pending.resolved;
    }
    if ($('#situation-update'))
      $('#situation-update').onsubmit = (e) => {
        e.preventDefault();
        DH.act(() => saveUpdate(id));
      };
  }
  async function saveUpdate(id) {
    const flow = $('#situation-flow').value.trim(),
      outcome = $('#situation-outcome').value.trim(),
      resolved = $('#situation-resolved').checked;
    if (!flow) throw Error('확인·판단 흐름을 입력하세요');
    if (resolved && !outcome) throw Error('해결 결과를 입력하세요');
    await DH.saveSituationUpdate(id, { flow, outcome, resolved });
    $('#panel').close();
    await DH.mobile.reload();
    detail(id);
    DH.toast('후속 기록을 저장했습니다');
  }

  DH.register({
    name: '상황발생',
    order: 70,
    async mobileLoad(c) {
      const today = DH.today();
      c.data.situationData = await DH.rpc('dh_situation_snapshot', { p_from: DH.addDay(today, -14), p_to: DH.addDay(today, 7) });
    },
    itemLabel: (x) => {
      const s = x.type === 'share' && find(x.id);
      return s ? `🚩 상황발생 · ${stateText(s)}` : null;
    },
    mobileDetail(x) {
      if (!find(x.id)) return false;
      detail(x.id);
      return true;
    },
    timelineBanners(c) {
      const authored = c.data.situationData?.authored_permits || [];
      const open = all().filter((x) => x.owner_id === c.profile.employee_id && x.status === 'open').length;
      return (
        (authored.length
          ? `<button data-action="situation-list" data-mine="1" class="wide" style="margin-top:12px;text-align:left;background:#fff2e8;color:#813c16;border:1px solid #efb48b">🚩 상황발생 기록 · 진행 중 ${open}건</button>`
          : '') + '<button data-action="situation-list" class="wide" style="margin-top:8px">상황 기록 검색</button>'
      );
    },
    /* --- 현장공유 폼 확장 --- */
    shareFormFields: (c, d) =>
      `<label class="row" style="padding:12px;background:#fff2e8;border-radius:12px"><input id="share-is-situation" type="checkbox" ${d.isSituation ? 'checked' : ''}> 🚩 상황발생으로 기록</label><p class="hint">상황발생은 허가서 작성자인 현장 담당자에게 후속 기록으로 남습니다.</p>`,
    shareFormMount(c, d) {
      const box = $('#share-is-situation');
      $('#memo').required = !!d.isSituation;
      box.onchange = () => {
        d.isSituation = box.checked;
        $('#memo').required = box.checked;
        DH.drafts.schedule();
      };
    },
    shareValidate(c, d) {
      d.isSituation = !!$('#share-is-situation')?.checked;
      if (d.isSituation && !d.memo) throw Error('발생한 문제를 입력하세요');
    },
    sharePayload: (c, d) => ({ is_situation: !!d.isSituation }),
    shareDoneMessage: (payload) => (payload.is_situation ? '상황발생을 기록했습니다' : null),
  });

  DH.action('situation-list', (el) => list(!!el.dataset.mine));
  DH.action('situation-open', (el) => detail(el.dataset.id));
})();
