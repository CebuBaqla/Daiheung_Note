/* =====================================================================
 * 기능: 작업종료 및 일보 (모바일)
 *  - 하단 '작업종료' → 오늘 허가서 선택 → 실제 작업량·인원·장비·체크리스트·완료사진
 *  - 입력 중 내용은 임시저장되어 앱을 닫아도 남습니다
 *  - 타임라인의 '작업종료 · 제출 완료' 말풍선과 상세
 * 권한: owner / manager / foreman      RPC: dh_save_report, dh_submit_report
 * ===================================================================== */
(function () {
  'use strict';
  const { $, $$, esc, num } = DH;
  const ctx = () => DH.ctx;
  const REPORTERS = ['owner', 'manager', 'foreman'];
  let chosen = null; // 작성 중인 허가서

  const permitOfReport = (reportId) => ctx().data.permits.find((q) => q.report?.id === reportId);
  const workState = (id) => ctx().workPhotoStates?.[id] || null;
  const photoLabel = (kind, i) => kind === 'overview' ? '현장 전경' : `작업물 ${i}`;
  const image = (file, alt) => file ? `<img data-file="${esc(file.id)}" alt="${esc(alt)}">` : '';

  function startNotice() {
    const p = ctx().data.permits.find(x => x.id === ctx().draft.start?.permitId);
    if (!p) return;
    DH.panel('작업 시작 전 사진 안내', `<div class="work-start-notice" role="note">
      <p class="work-start-site">${esc(p.site_name)} · ${esc(p.location || '작업 현장')}</p>
      <p class="work-start-message">작업을 시작하기 전에<br><strong>현장 전경 1장</strong>과<br><strong>작업물의 작업 전 사진</strong>을<br>찍어 올려 주세요.</p>
      <p>작업을 마칠 때 같은 곳의 작업 후 사진도 찍습니다.</p>
      <button class="primary wide" data-action="work-start-confirm">확인</button>
    </div>`);
  }
  function startScreen() {
    const d = ctx().draft.start;
    if (!d?.permitId) return;
    const p = ctx().data.permits.find(x => x.id === d.permitId);
    if (!p) return;
    DH.panel('작업 시작', `<p class="intro">${esc(p.site_name)} · ${esc(p.location || '')}<br>전경과 작업물의 작업 전 사진을 촬영해 주세요. 업로드가 끝나면 작업이 시작됩니다.</p>
      <div class="work-pair-list">${d.photos.map((photo, i) => `<section class="work-photo-card"><b>${photoLabel(photo.kind, i)}</b>
        ${photo.src ? `<img src="${esc(photo.src)}" alt="${photoLabel(photo.kind, i)} 작업 전">` : '<p class="hint">사진을 찍어 주세요.</p>'}
        <button type="button" data-action="work-before-camera" data-index="${i}">📷 ${photo.src ? '다시 촬영' : '카메라 촬영'}</button>
        <input class="hidden work-before-input" id="work-before-${i}" data-index="${i}" type="file" accept="image/*" capture="environment">
        ${i > 1 ? `<button type="button" data-action="work-before-remove" data-index="${i}">이 작업물 삭제</button>` : ''}</section>`).join('')}</div>
      ${d.photos.length < 6 ? '<button class="wide" data-action="work-before-add">작업물 사진 추가</button>' : ''}
      <button class="primary wide submit" data-action="work-start-save">전 사진 업로드 후 작업 시작</button>`);
  }
  function openStart(id) {
    const c = ctx(), p = c.data.permits.find(x => x.id === id);
    if (!c.workPhotoReady) throw Error('작업 전·후 사진 기능의 DB 설치 상태를 확인해 주세요.');
    if (!p || p.work_date !== DH.mobileDay() || c.profile.role !== 'foreman' ||
      !p.workers.some(w => w.id === c.profile.employee_id) || p.report?.submitted_at)
      throw Error('오늘 작업할 반장 계정의 허가서를 선택해 주세요.');
    if (workState(id)) throw Error('이미 시작된 작업입니다. 작업 종료를 열어 주세요.');
    if (c.draft.start?.permitId !== id) c.draft.start = { permitId: id,
      photos: [{ kind: 'overview', src: '', serverId: null }, { kind: 'subject', src: '', serverId: null }] };
    startNotice();
  }
  async function saveStart() {
    const d = ctx().draft.start, p = ctx().data.permits.find(x => x.id === d?.permitId);
    if (!p || d.photos.length < 2 || d.photos.some(x => !x.src)) throw Error('전경과 작업물의 작업 전 사진을 모두 촬영해 주세요.');
    await DH.drafts.write();
    for (const photo of d.photos) await DH.media.uploadData(p.site_id, photo, 'photo');
    await DH.rpc('dh_start_work', { p_permit: p.id,
      p_photos: d.photos.map(x => ({ kind: x.kind, file_id: x.serverId })) });
    ctx().draft.start = {};
    await DH.drafts.write();
    $('#panel').close();
    await DH.mobile.reload();
    DH.toast('작업을 시작했습니다. 종료할 때 각 전 사진에 대응하는 후 사진을 올려 주세요.');
  }
  function pairInputs(state, d) {
    return `<div class="form-section"><h3>작업 전 · 후 사진 <span class="danger">* 각 1장씩</span></h3>
      <p class="hint">작업 전 사진과 같은 위치·작업물을 작업 후에 촬영해 주세요.</p>
      <div class="work-pair-list">${state.pairs.map((pair, i) => {
        const after = d.pairs?.[i]?.after;
        return `<section class="work-photo-card"><b>${photoLabel(pair.kind, i)}</b><div class="work-photo-sides"><figure><span>작업 전</span>${image(pair.before, '작업 전 사진')}</figure>
          <figure data-after-index="${i}"><span>작업 후</span>${after?.src ? `<img src="${esc(after.src)}" alt="작업 후 사진">` : image(pair.after, '작업 후 사진')}</figure></div>
          <button type="button" data-action="work-after-camera" data-index="${i}">📷 작업 후 ${after?.src || pair.after ? '다시 촬영' : '촬영'}</button>
          <input class="hidden work-after-input" id="work-after-${i}" data-index="${i}" type="file" accept="image/*" capture="environment"></section>`;
      }).join('')}</div></div>`;
  }
  function pairGallery(pairs) {
    return `<div class="work-pair-list">${pairs.map((pair, i) => `<section class="work-photo-card"><b>${photoLabel(pair.kind, i)}</b>
      <div class="work-photo-sides"><figure><span>작업 전</span>${image(pair.before, '작업 전 사진')}</figure><figure><span>작업 후</span>${image(pair.after, '작업 후 사진')}</figure></div></section>`).join('')}</div>`;
  }

  /* ---------- 허가서 선택 ---------- */
  function pick() {
    if (!DH.permits) return DH.toast('작업허가서 기능을 불러오지 못했습니다. 페이지를 다시 열어 주세요.');
    if (!ctx().reportApprovalReady) return DH.toast('작업종료 승인 기능을 DB에 먼저 설치해 주세요.');
    if (!ctx().workPhotoReady) return DH.toast('작업 전·후 사진 기능을 DB에 먼저 설치해 주세요.');
    if (!REPORTERS.includes(ctx().profile.role)) return DH.toast('작업종료 보고는 작업반장 또는 관리자 계정으로 제출할 수 있습니다');
    const permits = [...ctx().data.permits, ...(ctx().rejectedPermits || []), ...(ctx().unclosedPermits || [])]
      .filter((p) => (p.report?.review_status === 'rejected' && (!workState(p.id) || workState(p.id).started_by === ctx().profile.employee_id)) ||
        (!p.report?.submitted_at && workState(p.id)?.started_by === ctx().profile.employee_id));
    const pending = ctx().data.permits.filter((p) => p.report?.review_status === 'pending' && p.report.submitted_by === ctx().profile.employee_id);
    DH.panel(
      '작업종료',
      `${pending.length ? `<p class="hint">확인 담당자의 승인을 기다리는 보고 ${pending.length}건</p>` : ''}${permits.length ? `<p class="intro">지난 작업의 미종료 기록과 보완 요청도 원래 작업일에 보고할 수 있습니다.</p>${permits.map(p => `<button class="bubble" data-action="report-form" data-id="${p.id}" style="margin-bottom:12px"><div class="kind">${p.report?.review_status === 'rejected' ? '보완 요청' : p.work_date === DH.mobileDay() ? '오늘 작업' : '지난 작업 · 미종료'}</div><div class="message-site">${esc(p.site_name)}</div><div class="summary">${esc(p.work_date)} · ${esc(p.tasks.map(t => t.name).join(' · '))}</div></button>`).join('')}` : '<div class="empty">제출하거나 보완할 작업이 없습니다.</div>'}`
    );
  }

  /* ---------- 작성 폼 ---------- */
  function equipmentRow(id = '', quantity = 1) {
    return `<div class="grid2 equipment-row"><select class="eq-id"><option value="">장비 없음</option>${ctx()
      .data.equipment.map((e) => `<option value="${e.id}" ${e.id === id ? 'selected' : ''}>${esc(e.name)}</option>`)
      .join('')}</select><div class="row"><input class="eq-qty" type="number" min="1" step="1" value="${quantity}" aria-label="장비 대수"><button type="button" data-action="report-equipment-remove">×</button></div></div>`;
  }
  async function form(id) {
    const c = ctx(),
      p = c.data.permits.find((x) => x.id === id) || c.rejectedPermits?.find((x) => x.id === id) || c.unclosedPermits?.find((x) => x.id === id);
    if (!p) return;
    chosen = p;
    const state = workState(id);
    if (!state && p.report?.review_status !== 'rejected') throw Error('작업 시작과 전 사진 업로드를 먼저 완료해 주세요.');
    const d = c.draft.report.permitId === id ? c.draft.report : {};
    const revision = p.report?.review_status === 'rejected' ? await DH.rpc('dh_report_revision_detail', { p_id: p.report.id }) : null;
    if (revision) {
      d.reportId = revision.id;
      d.tasks ||= revision.tasks;
      d.workers ||= revision.workers;
      d.equipment ||= revision.equipment;
      d.photos ||= revision.photos.map(f => ({ serverId: f.id, src: '' }));
      d.reason ??= revision.incomplete_reason || '';
      d.notes ??= revision.notes || '';
      d.rosterConfirmed ??= Boolean(revision.roster_confirmed_at);
      d.areaCleaned ??= revision.area_cleaned;
      d.equipmentCollected ??= revision.equipment_collected;
      d.safetyChecked ??= revision.safety_checked;
    }
    const workers = d.workers || p.workers.map((w) => w.id),
      equipment = d.equipment || p.equipment.map((e) => ({ id: e.id, quantity: e.quantity }));
    c.draft.report = { ...d, permitId: id };
    if (state) {
      c.draft.report.pairs ||= state.pairs.map(pair => ({ after: pair.after ? { serverId: pair.after.id, src: '' } : null }));
      if (c.draft.report.pairs.length !== state.pairs.length)
        c.draft.report.pairs = state.pairs.map(pair => ({ after: pair.after ? { serverId: pair.after.id, src: '' } : null }));
    }
    delete c.draft.report.materials; // 이전 버전에서 임시저장한 자재 입력은 사용하지 않습니다.
    const check = (cls, on, text) => `<label class="check"><input id="${cls}" type="checkbox" ${on ? 'checked' : ''} required>${text}</label>`;
    DH.panel(
      '작업종료',
      `<form id="finishForm"><p class="intro">${revision ? `<b>보완 요청:</b> ${esc(p.report.rejection_reason || '내용을 확인해 주세요')}<br>` : ''}목표와 예정 명단을 확인하고<br>실제 작업 결과를 남겨 주세요.</p><div class="site">${esc(p.site_name)}</div>
<div class="form-section"><h3>작업별 실제 작업량 <span class="danger">*</span></h3><p class="hint">현장 폐자재 등 회사 자재 외 재료를 사용했을 때만 체크하세요.</p>${p.tasks
        .map((t) => {
          const old = d.tasks?.find((q) => q.task_id === t.id);
          return `<div class="card task-card"><b>${esc(t.name)}</b><p class="small-line">목표 ${num(t.target)}${esc(t.unit)}</p><div class="qty"><input class="actual" data-task="${t.id}" type="number" min="0" step="any" required placeholder="실제 물량" value="${esc(old?.actual ?? '')}"><strong>${esc(t.unit)}</strong></div><label class="check"><input class="external" data-task="${t.id}" type="checkbox" ${old?.external_material_used ? 'checked' : ''}>회사 자재 외 사용</label></div>`;
        })
        .join('')}</div>
<div class="form-section"><h3>실제 투입 인원 명단 <span class="danger">*</span></h3><p class="hint">예정 인원을 미리 선택했습니다. 실제 명단을 확인해 주세요.</p>${c.data.employees
        .map((e) => `<label class="check"><input class="worker-check" type="checkbox" value="${e.id}" ${workers.includes(e.id) ? 'checked' : ''}>${esc(e.name)} ${p.workers.some((w) => w.id === e.id) ? '<small>예정</small>' : ''}</label>`)
        .join('')}${check('roster-confirm', d.rosterConfirmed, '반장으로서 실제 투입 명단을 확인했습니다')}</div>
<div class="form-section"><h3>실제 투입 장비</h3><p class="hint">예정 장비가 미리 선택되어 있습니다. 변경하거나 삭제할 수 있습니다.</p><div id="equipmentRows">${(equipment.length ? equipment : [{ id: '', quantity: 1 }])
        .map((e) => equipmentRow(e.id, e.quantity))
        .join('')}</div><button type="button" data-action="report-equipment-add">장비 추가</button></div>
<div class="form-section"><h3>완료 체크리스트 <span class="danger">*</span></h3>${check('area-cleaned', d.areaCleaned, '작업구역 정리 확인')}${check('equipment-collected', d.equipmentCollected, '장비·자재 회수 확인')}${check('safety-checked', d.safetyChecked, '현장 안전상태 확인')}</div>
${state ? pairInputs(state, c.draft.report) : `<div class="form-section"><h3>기존 보고의 완료사진 <span class="danger">* 1장 이상</span></h3>${DH.media.photoInputs('report')}</div>`}
<label>미완료 사유 <small>하나라도 목표 미달 시 필수</small></label><textarea id="reason" placeholder="미완료 작업명과 사유">${esc(d.reason)}</textarea><label>특이사항 <small>(선택)</small></label><textarea id="notes" placeholder="다음 작업 시 참고할 사항">${esc(d.notes)}</textarea><button type="submit" class="primary wide submit">${revision ? '보완 보고 재제출' : '작업종료 보고 제출'}</button></form>`
    );
    if (!state) DH.media.renderPhotos('report');
    if (revision && !state) {
      for (const photo of d.photos || []) {
        if (!photo.serverId || (photo.src && !photo.src.startsWith('blob:'))) continue;
        const file = revision.photos.find(f => f.id === photo.serverId);
        if (!file) continue;
        try { photo.src = URL.createObjectURL(await c.api.blob(file)); }
        catch { DH.toast('기존 완료 사진의 미리보기를 불러오지 못했습니다.'); }
      }
      DH.media.renderPhotos('report');
    }
    const f = $('#finishForm');
    f.oninput = f.onchange = () => {
      capture();
      DH.drafts.schedule();
    };
    f.onsubmit = (e) => {
      e.preventDefault();
      DH.act(submit);
    };
  }
  /** 화면 입력값을 임시저장 객체로 옮깁니다. */
  function capture() {
    const d = ctx().draft.report;
    if (!chosen || !$('#finishForm')) return;
    Object.assign(d, {
      permitId: chosen.id,
      tasks: $$('.actual').map((el) => ({ task_id: el.dataset.task, actual: el.value, external_material_used: $(`.external[data-task="${el.dataset.task}"]`).checked })),
      workers: $$('.worker-check:checked').map((el) => el.value),
      rosterConfirmed: $('#roster-confirm').checked,
      equipment: $$('.equipment-row')
        .map((el) => ({ id: $('.eq-id', el).value, quantity: $('.eq-qty', el).value }))
        .filter((x) => x.id),
      areaCleaned: $('#area-cleaned').checked,
      equipmentCollected: $('#equipment-collected').checked,
      safetyChecked: $('#safety-checked').checked,
      reason: $('#reason').value,
      notes: $('#notes').value,
    });
  }
  async function submit() {
    capture();
    const d = ctx().draft.report,
      p = chosen,
      state = workState(p.id);
    if (state && (d.pairs?.length !== state.pairs.length || d.pairs.some(x => !x.after?.src && !x.after?.serverId)))
      throw Error('각 작업 전 사진에 대응하는 작업 후 사진을 올려 주세요.');
    if (!state && !(d.photos || []).length) throw Error('완료사진을 1장 이상 첨부해 주세요');
    if (d.tasks.some((x) => x.actual === '')) throw Error('모든 작업의 실제 작업량을 입력해 주세요');
    if (!d.workers.length) throw Error('실제 투입 인원을 1명 이상 선택해 주세요');
    if (d.tasks.some((x) => Number(x.actual) < Number(p.tasks.find((t) => t.id === x.task_id)?.target)) && !d.reason.trim())
      throw Error('목표보다 적게 작업한 사유를 입력해 주세요');
    await DH.drafts.write();
    const files = [];
    for (const photo of state ? d.pairs.map(x => x.after) : d.photos)
      files.push(await DH.media.uploadData(p.site_id, photo, 'photo'));
    d.reportId ||= p.report?.review_status === 'rejected' ? p.report.id : crypto.randomUUID();
    await DH.drafts.write();
    const payload = {
        id: d.reportId,
        permit_id: p.id,
        roster_confirmed: d.rosterConfirmed,
        area_cleaned: d.areaCleaned,
        equipment_collected: d.equipmentCollected,
        safety_checked: d.safetyChecked,
        reason: d.reason.trim(),
        notes: d.notes.trim(),
        workers: d.workers,
        files,
        tasks: d.tasks.map((x) => ({ task_id: x.task_id, actual: Number(x.actual), external_material_used: x.external_material_used })),
        equipment: d.equipment.map((x) => ({ id: x.id, quantity: Number(x.quantity) })),
        materials: [], // 기존 저장 함수가 자재 배열을 요구하더라도 빈 목록으로 전달합니다.
      };
    if (state) await DH.rpc('dh_submit_work_report', { p_data: payload,
      p_pairs: files.map((fileId, i) => ({ sort_order: i + 1, after_file_id: fileId })) });
    else if (p.report?.review_status === 'rejected') await DH.rpc('dh_resubmit_report', { p_data: payload });
    else {
      await DH.rpc('dh_save_report', { p_data: payload });
      await DH.rpc('dh_submit_report', { p_id: d.reportId });
    }
    ctx().draft.report = {};
    await DH.drafts.write();
    chosen = null;
    $('#panel').close();
    await DH.mobile.reload();
    DH.toast('작업종료 보고를 제출했습니다. 결재 요청자의 확인을 기다립니다.');
  }

  /* ---------- 타임라인 ---------- */
  DH.kind('completion', {
    label: () => '작업일보 · 승인 완료',
    summary(x) {
      const p = permitOfReport(x.message.report_id);
      return (
        p?.report?.tasks
          .map((t) => {
            const task = p.tasks.find((z) => z.id === t.task_id);
            return `${task?.name || '작업'} ${num(t.actual)}${task?.unit || ''}`;
          })
          .join(' · ') || '작업종료 보고'
      );
    },
    photo: (x) => {
      const p = permitOfReport(x.message.report_id);
      return (p && workState(p.id)?.pairs?.[0]?.after) || p?.report?.photos?.[0] || null;
    },
    detail(x) {
      const m = x.message,
        p = permitOfReport(m.report_id),
        r = p?.report,
        pairs = p && workState(p.id)?.pairs;
      DH.panel(
        '작업일보 상세',
        `<article class="card"><span class="tag">작업일보 · 승인 완료</span><div class="site">${esc(DH.siteName(m.site_id))}</div><div class="meta">${esc(m.sender_name)} · ${DH.timeLabel(m.posted_at)}</div><h3>작업별 실제 작업량</h3>${
          r?.tasks
            .map((t) => {
              const plan = p.tasks.find((q) => q.id === t.task_id);
              return `<div class="stat"><b>${esc(plan?.name)}</b><br>목표 ${num(plan?.target)}${esc(plan?.unit)} → 실제 <strong>${num(t.actual)}</strong>${esc(plan?.unit)}<br><small>${t.external_material_used ? '회사 자재 외 사용' : '회사 자재 사용'}</small></div>`;
            })
            .join('') || ''
        }<p><b>작업 위치 설명</b><br>${esc(p?.location || '—')}</p><p>실제 인원: ${r?.workers.map(esc).join(', ') || '—'}</p><p>장비: ${r?.equipment.map((e) => `${esc(e.name)} ${e.quantity}대`).join(', ') || '없음'}</p><p>미완료 사유: ${esc(r?.incomplete_reason || '—')}</p><p>특이사항: ${esc(r?.notes || '—')}</p><h3>작업 전 · 후 사진</h3>${pairs?.length ? pairGallery(pairs) : DH.share ? DH.share.filesHtml(r?.photos || []) : ''}</article>`
      );
    },
  });

  DH.register({
    name: '작업종료',
    order: 80,
    mobileNav: { order: 30, label: '작업종료', action: 'report-pick' },
    async mobileLoad(c) {
      const today = DH.mobileDay();
      c.reportApprovalReady = false;
      c.workPhotoReady = false;
      c.workPhotoStates = {};
      c.rejectedPermits = [];
      c.unclosedPermits = [];
      const [reviews, rejected, unclosed] = await Promise.all([
        DH.rpc('dh_my_report_reviews', { p_from: DH.addDay(today, -14), p_to: DH.addDay(today, 7) }),
        DH.rpc('dh_my_rejected_permits'),
        DH.rpc('dh_my_unclosed_permits'),
      ]);
      const byPermit = new Map(reviews.map(r => [r.permit_id, r]));
      c.data.permits.forEach(p => { if (p.report && byPermit.has(p.id)) Object.assign(p.report, byPermit.get(p.id)); });
      const currentIds = new Set(c.data.permits.map(p => p.id));
      c.rejectedPermits = rejected.filter(p => !currentIds.has(p.id));
      const knownIds = new Set([...c.data.permits, ...c.rejectedPermits].map(p => p.id));
      c.unclosedPermits = unclosed.filter(p => !knownIds.has(p.id));
      const photoIds = [...new Set([...c.data.permits, ...c.rejectedPermits, ...c.unclosedPermits].map(p => p.id))];
      c.workPhotoStates = photoIds.length ? await DH.rpc('dh_work_photo_state', { p_ids: photoIds }) : {};
      c.workPhotoReady = true;
      c.reportApprovalReady = true;
    },
  });
  DH.action('report-pick', pick);
  DH.action('work-start-open', (el) => DH.act(() => openStart(el.dataset.id)));
  DH.action('work-start-confirm', startScreen);
  DH.action('work-before-camera', (el) => $(`#work-before-${el.dataset.index}`)?.click());
  DH.action('work-before-add', () => {
    const d = ctx().draft.start;
    if (d?.photos.length >= 6) return;
    d.photos.push({ kind: 'subject', src: '', serverId: null });
    startScreen();
    DH.drafts.schedule();
  });
  DH.action('work-before-remove', (el) => {
    ctx().draft.start.photos.splice(Number(el.dataset.index), 1);
    startScreen();
    DH.drafts.schedule();
  });
  DH.action('work-start-save', () => DH.act(saveStart));
  DH.on('change', '.work-before-input', (input) => DH.act(async () => {
    const photo = ctx().draft.start.photos[Number(input.dataset.index)];
    if (!photo || !input.files?.[0]) return;
    photo.src = await DH.media.compressPhoto(input.files[0]);
    photo.serverId = null;
    await DH.drafts.write();
    startScreen();
  }));
  DH.action('work-after-camera', (el) => $(`#work-after-${el.dataset.index}`)?.click());
  DH.on('change', '.work-after-input', (input) => DH.act(async () => {
    const i = Number(input.dataset.index), file = input.files?.[0], d = ctx().draft.report;
    if (!file || !d.pairs?.[i]) return;
    d.pairs[i].after = { src: await DH.media.compressPhoto(file), serverId: null };
    const figure = $(`[data-after-index="${i}"]`);
    if (figure) figure.innerHTML = `<span>작업 후</span><img src="${esc(d.pairs[i].after.src)}" alt="작업 후 사진">`;
    await DH.drafts.write();
  }));
  DH.action('report-form', (el) => DH.act(() => form(el.dataset.id)));
  DH.action('report-equipment-add', () => {
    $('#equipmentRows').insertAdjacentHTML('beforeend', equipmentRow());
    capture();
    DH.drafts.schedule();
  });
  DH.action('report-equipment-remove', (el) => {
    el.closest('.equipment-row').remove();
    capture();
    DH.drafts.schedule();
  });
})();
