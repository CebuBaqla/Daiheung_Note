/* =====================================================================
 * 기능: 작업계획 및 결재 (모바일 · 승인된 작업허가서 보기)
 *  - 타임라인의 '작업허가서' 말풍선, 오늘 작업 자동 표시
 *  - 하단 '오늘 목표', 작업허가서 상세(도면·작업자·장비·자재 준비 상태)
 * 데이터: dh_worker_snapshot.permits
 * ===================================================================== */
(function () {
  'use strict';
  const { esc, num } = DH;
  const ctx = () => DH.ctx;
  const tasksText = (p) => p.tasks.map((t) => `${t.name} ${num(t.target)}${t.unit}`).join(' · ');

  function detail(id) {
    const p = ctx().data.permits.find((x) => x.id === id);
    if (!p) return;
    const drawings =
      p.drawings
        .map(
          (d) =>
            `<div class="card task-card"><b>${d.number}번 · ${esc(d.title)}</b><p class="hint">현재 등록된 최신 도면</p>${
              d.file.mime.startsWith('image/') ? `<img class="file-preview" data-file="${d.file.id}" alt="${esc(d.title)}">` : '<p>PDF 도면</p>'
            }<button class="wide" data-action="file-view" data-id="${d.file.id}">크게 보기</button></div>`
        )
        .join('') || '<p class="muted">첨부 도면 없음</p>';
    const section = (title, body) => `<section class="detail-section"><h3>${title}</h3>${body}</section>`;
    DH.panel(
      '작업허가서 상세',
      `<section class="detail-section"><span class="tag">오늘 목표 · 승인된 작업허가서</span><h2 style="margin-top:12px">${esc(p.site_name)}</h2><small>${DH.dateLabel(p.work_date)} · ${esc(p.created_by_name)} 공유</small></section>` +
        section('현장명 · 주소', `<p>${esc(p.site_name)}<br>${esc(p.address || '주소 미입력')}</p>`) +
        section('작업 위치 설명', `<p>${esc(p.location)}</p>`) +
        section('목표 작업 물량', `<div class="stat">${p.tasks.map((t) => `<div>${esc(t.name)} <strong>${num(t.target)}</strong> ${esc(t.unit)}${DH.contracts?.orderMemo(t.id) ? `<p class="hint" style="white-space:pre-wrap"><b>발주 메모</b> ${esc(DH.contracts.orderMemo(t.id))}</p>` : ''}<p class="hint" style="white-space:pre-wrap">${esc(DH.contracts?.taskNote(t.id) || '')}</p></div>`).join('')}</div>`) +
        section('자재 준비', `<p>${ctx().permitMaterialReady?.[p.id] ? '완료' : '미확인'}</p>`) +
        section('첨부 도면', drawings) +
        section('현장 담당자의 특별 작업 지시', `<p class="instructions">${esc(p.instructions || '별도 지시 없음')}</p>`) +
        section(`작업자 명단 · ${p.workers.length}명`, `<p>${p.workers.map((w) => esc(w.name)).join('<br>')}</p>`) +
        section('사용 예정 장비', `<p>${p.equipment.map((e) => `${esc(e.name)} ${num(e.quantity)}대`).join('<br>') || '없음'}</p>`) +
        (p.work_date === DH.mobileDay() && ctx().profile.role === 'foreman' && p.workers.some(w => w.id === ctx().profile.employee_id) && !p.report?.submitted_at
          ? `<section class="detail-section">${ctx().workPhotoStates?.[p.id]
              ? `<p>작업 시작 ${DH.timeLabel(ctx().workPhotoStates[p.id].started_at)} · 전 사진 ${ctx().workPhotoStates[p.id].pairs.length}장</p><button class="primary wide" data-action="report-form" data-id="${p.id}">작업 종료 작성</button>`
              : `<button class="primary wide" data-action="work-start-open" data-id="${p.id}">작업 시작 · 전 사진 촬영</button>`}</section>`
          : '')
    );
  }

  /** 허가서 선택 목록(오늘 목표·작업종료에서 사용) */
  const pickList = (permits, action) =>
    permits
      .map(
        (p) =>
          `<button class="bubble" data-action="${action}" data-id="${p.id}" style="margin-bottom:12px"><div class="kind">작업허가서</div><div class="message-site">${esc(p.site_name)}</div><div class="summary">${esc(tasksText(p))}</div></button>`
      )
      .join('');

  DH.kind('permit', {
    label: () => '작업허가서',
    sender: (x) => x.permit.created_by_name,
    time: (x) => (x.synthetic ? '오늘 작업' : null),
    summary: (x) => tasksText(x.permit),
    foot: (x) => `작업자 ${x.permit.workers.length}명 · 도면 ${x.permit.drawings.length}개`,
    photo: (x) => (x.message?.files || []).find((f) => f.mime?.startsWith('image/')) || x.permit.report?.photos?.[0] || null,
    detail: (x) => detail(x.permit.id),
  });

  DH.register({
    name: '작업허가서',
    order: 30,
    async mobileLoad(c) {
      const ids = c.data.permits.map((p) => p.id);
      c.permitMaterialReady = ids.length ? await DH.rpc('dh_worker_permit_material_ready', { p_ids: ids }) : {};
    },
    // 메시지에 허가서를 붙이고, 오늘 허가서가 타임라인에 없으면 '오늘 작업'으로 추가합니다.
    timelineItems(items, c) {
      const byId = new Map(c.data.permits.map((p) => [p.id, p])),
        today = DH.mobileDay();
      items = items
        .map((x) => ({ ...x, permit: byId.get(x.message?.permit_id) || x.permit || null }))
        .filter((x) => x.type !== 'permit' || x.permit);
      for (const p of c.data.permits.filter((p) => p.work_date === today))
        if (!items.some((x) => x.type === 'permit' && x.permit.id === p.id))
          items.push({ id: 'today-' + p.id, type: 'permit', day: today, at: today + 'T08:00:00+09:00', permit: p, synthetic: true });
      return items;
    },
    mobileNav: { order: 10, label: '오늘 목표', action: 'permit-goals' },
  });

  DH.action('permit-goals', () => {
    const list = ctx().data.permits.filter((p) => p.work_date === DH.mobileDay());
    DH.panel('오늘 목표', list.length ? pickList(list, 'permit-open') : '<div class="empty">오늘 승인된 작업허가서가 없습니다.</div>');
  });
  DH.action('permit-open', (el) => detail(el.dataset.id));

  DH.permits = { detail, tasksText, pickList };
})();
