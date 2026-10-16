/* =====================================================================
 * 기능: 작업계획 및 결재 (관리자)
 *  - 대시보드: 오늘의 작업 · 3개월 달력 · 전주/금주/차주
 *  - 작업계획서(초안) 작성·수정 → 2단계 결재 요청 → 승인/반려/결재자 변경
 *  - 최종 승인되면 '작업허가서'로 모바일에 공유됩니다
 * RPC: dh_save_permit, dh_request_permit_approval,
 *      dh_reassign_permit_approver, dh_decide_permit
 * ===================================================================== */
(function () {
  'use strict';
  const { $, $$, esc, num } = DH;
  const ctx = () => DH.ctx;
  const COLORS = ['#2e7be3', '#d88a26', '#26a686', '#ad67bd', '#df666a', '#6a80b0'];
  const PENDING = ['first_pending', 'second_pending'];
  // 월력요항에 노동절·제헌절 공휴일 지정을 반영한 날짜입니다.
  const HOLIDAYS = {
    2026: new Set([
      '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18',
      '2026-03-01', '2026-03-02', '2026-05-01', '2026-05-05',
      '2026-05-24', '2026-05-25', '2026-06-03', '2026-06-06',
      '2026-07-17', '2026-08-15', '2026-08-17', '2026-09-24',
      '2026-09-25', '2026-09-26', '2026-10-03', '2026-10-05',
      '2026-10-09', '2026-12-25',
    ]),
    2027: new Set([
      '2027-01-01', '2027-02-06', '2027-02-07', '2027-02-08',
      '2027-02-09', '2027-03-01', '2027-05-01', '2027-05-03',
      '2027-05-05', '2027-05-13', '2027-06-06', '2027-07-17',
      '2027-07-19', '2027-08-15', '2027-08-16', '2027-09-14',
      '2027-09-15', '2027-09-16', '2027-10-03', '2027-10-04',
      '2027-10-09', '2027-10-11', '2027-12-25', '2027-12-27',
    ]),
  };
  let weeklyCurrent = null;

  function status(p) {
    const a = p.approval;
    return p.report?.approved_at
      ? '작업일보'
      : p.report?.review_status === 'rejected'
        ? '종료 보완요청'
        : p.report?.submitted_at
          ? '종료 승인대기'
      : p.published_at
        ? '작업허가서'
        : a?.stage === 'first_pending'
          ? '1차 결재 대기'
          : a?.stage === 'second_pending'
            ? '2차 결재 대기'
            : a?.stage === 'rejected'
              ? '반려'
              : '초안';
  }
  const pill = (s) =>
    `<span class="pill ${s === '작업허가서' || s === '작업일보' ? 'ok' : s === '반려' || s === '종료 보완요청' ? 'bad' : s.includes('대기') ? 'wait' : ''}">${esc(s)}</span>`;
  const permitsOn = (date) => ctx().data.permits.filter((p) => p.work_date === date);
  const detailAction = (p) => p.report?.submitted_at ? 'report-detail' : 'permit-detail';

  function permitItem(p) {
    const color = COLORS[Math.max(ctx().data.sites.findIndex((x) => x.id === p.site_id) % 6, 0)];
    return `<button class="item" style="border-left-color:${color}" data-action="${detailAction(p)}" data-id="${p.id}"><b>${esc(DH.siteName(p.site_id))} ${pill(status(p))}</b><small>${esc(p.tasks.map((t) => t.name).join(' · '))}</small></button>`;
  }
  const taskNames = (p) => p.tasks.map((t) => t.name).filter(Boolean).join(' · ');
  function dashboardPermitItem(p) {
    const color = COLORS[Math.max(ctx().data.sites.findIndex((x) => x.id === p.site_id) % 6, 0)];
    const site = DH.siteName(p.site_id), names = taskNames(p);
    return `<button class="item dashboard-permit" style="border-left-color:${color}" data-action="${detailAction(p)}" data-id="${p.id}" title="${esc(site)} · ${esc(names)}"><b class="dashboard-summary-line">${esc(site)}</b><small class="dashboard-summary-line">${esc(names)}</small></button>`;
  }

  function weekDates(offset) {
    const now = new Date(),
      mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) + offset * 7);
    return Array.from({ length: 7 }, (_, i) => DH.iso(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i)));
  }

  /* ---------- 대시보드 패널 ---------- */
  function todayPanel() {
    const today = DH.workDay(),
      list = permitsOn(today);
    return `<section class="card"><h2>오늘의 작업 <button class="link" data-action="plan-new" data-date="${today}">계획 작성</button></h2><div>${list.length ? list.map(dashboardPermitItem).join('') : '<div class="empty">오늘 등록된 계획이 없습니다</div>'}</div></section>`;
  }
  function monthHtml(d, plansByDate) {
    const y = d.getFullYear(),
      m = d.getMonth(),
      first = new Date(y, m, 1).getDay(),
      last = new Date(y, m + 1, 0).getDate(),
      today = DH.workDay();
    const cells = Array(first).fill('<span class="day emptyday"></span>');
    for (let i = 1; i <= last; i++) {
      const date = `${y}-${String(m + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`,
        { planned = 0, confirmed = 0, pending = 0, rejected = 0, reported = 0 } = plansByDate.get(date) || {},
        holiday = HOLIDAYS[y]?.has(date),
        dow = new Date(y, m, i).getDay();
      cells.push(
        `<button class="day ${date === today ? 'today' : ''} ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''} ${holiday ? 'holiday' : ''}" data-action="date-detail" data-date="${date}" aria-label="${date}${holiday ? ' · 공휴일' : ''} · 계획 ${planned}건 · 허가 ${confirmed}건 · 종료 승인대기 ${pending}건 · 종료 보완요청 ${rejected}건 · 작업일보 ${reported}건"><b>${i}</b><small class="day-counts">${planned ? `<span class="day-plan-count">계획 ${planned}</span>` : ''}${confirmed ? `<span class="day-permit-count">허가 ${confirmed}</span>` : ''}${pending ? `<span class="day-pending-count">대기 ${pending}</span>` : ''}${rejected ? `<span class="day-rejected-count">보완 ${rejected}</span>` : ''}${reported ? `<span class="day-report-count">일보 ${reported}</span>` : ''}</small></button>`
      );
    }
    return `<div class="month" data-calendar-month="${y}-${String(m + 1).padStart(2, '0')}"><h3>${y}년 ${m + 1}월</h3><div class="days">${['일', '월', '화', '수', '목', '금', '토'].map((x) => `<span class="dow">${x}</span>`).join('')}${cells.join('')}</div></div>`;
  }
  function calendarPanel() {
    const today = DH.workDay(), year = Number(today.slice(0, 4)), plansByDate = new Map();
    for (const permit of ctx().data.permits) {
      const counts = plansByDate.get(permit.work_date) || { planned: 0, confirmed: 0, pending: 0, rejected: 0, reported: 0 };
      const state = status(permit);
      counts[state === '작업일보' ? 'reported' : state === '종료 승인대기' ? 'pending' : state === '종료 보완요청' ? 'rejected' : permit.published_at ? 'confirmed' : 'planned']++;
      plansByDate.set(permit.work_date, counts);
    }
    return `<section class="card" aria-label="${year}년 작업 달력">${ctx().unresolvedState === 'failed' ? '<p class="pill bad">전체 미결재 계획을 불러오지 못했습니다. 새로고침해 주세요.</p>' : ''}<div class="calendar" data-current-month="${today.slice(0, 7)}">${Array.from({ length: 12 }, (_, month) => monthHtml(new Date(year, month, 1), plansByDate)).join('')}</div></section>`;
  }
  function weekHtml(offset, label) {
    const days = weekDates(offset);
    return `<div class="week"><div class="week-head"><button class="btn tiny" data-action="week-materials" data-offset="${offset}" aria-label="${label} 예정 자재 확인 및 엑셀 다운로드">${label}</button><small class="muted">${days[0]} ~ ${days[6]}</small></div>${days
      .map((d, i) => {
        const ps = permitsOn(d);
        return `<div class="week-line"><span style="min-width:45px">${['월', '화', '수', '목', '금', '토', '일'][i]} ${d.slice(8)}</span><div>${
          ps.length
            ? ps
                .map((p) => `<div class="dashboard-week-plan"><button class="link dashboard-week-name" data-action="${detailAction(p)}" data-id="${p.id}" title="${esc(DH.siteName(p.site_id))}">${esc(DH.siteName(p.site_id))}</button><div class="dashboard-summary-line dashboard-week-tasks muted" title="${esc(taskNames(p))}">${esc(taskNames(p))}</div></div>`)
                .join('')
            : '<span class="muted">—</span>'
        }</div></div>`;
      })
      .join('')}</div>`;
  }
  const weeksPanel = () => `<section class="card"><h2>주간 작업</h2><div>${[-1, 0, 1].map((w, i) => weekHtml(w, ['전주', '금주', '차주'][i])).join('')}</div></section>`;

  function weeklyRows(offset) {
    const [from, , , , , , to] = weekDates(offset);
    return ctx().data.permits.filter(p => p.work_date >= from && p.work_date <= to)
      .flatMap(p => p.tasks.map(t => ({ work_date: p.work_date, site_id: p.site_id,
        site_name: DH.siteName(p.site_id), status: status(p), name: t.name,
        quantity: Number(t.target_quantity), unit: t.unit, memo: t.order_memo || '',
        contract_item_id: t.contract_item_id || '' })))
      .sort((a, b) => a.work_date.localeCompare(b.work_date) || a.site_name.localeCompare(b.site_name, 'ko-KR'));
  }

  function weeklyTotals(rows) {
    const totals = new Map();
    for (const row of rows) {
      const key = [row.site_id, row.contract_item_id || row.name, row.unit, row.status].join('|');
      const item = totals.get(key) || { site_name: row.site_name, name: row.name,
        unit: row.unit, status: row.status, quantity: 0 };
      item.quantity += row.quantity;
      totals.set(key, item);
    }
    return [...totals.values()];
  }

  function showWeekly(offset) {
    if (![-1, 0, 1].includes(offset)) throw Error('주간 기간을 확인하세요.');
    const dates = weekDates(offset), rows = weeklyRows(offset), totals = weeklyTotals(rows);
    weeklyCurrent = { dates, rows, totals };
    ctx().modalType = 'weekly-materials'; ctx().editId = null;
    DH.ui.open(`${dates[0]} ~ ${dates[6]} 예정 자재`,
      `<p class="small muted">결재 전 계획도 포함합니다. 발주 전에 상태와 메모를 확인하세요.</p><p>${rows.length}개 예정 항목</p>${rows.length ? `<h3 class="section">현장·자재별 합계</h3><div class="tablebox"><table><thead><tr><th>현장</th><th>자재</th><th>예정 수량</th><th>상태</th></tr></thead><tbody>${totals.map(r => `<tr><td>${esc(r.site_name)}</td><td>${esc(r.name)}</td><td>${num(r.quantity)} ${esc(r.unit)}</td><td>${esc(r.status)}</td></tr>`).join('')}</tbody></table></div><h3 class="section">계획서별 메모</h3><div class="tablebox"><table><thead><tr><th>작업일</th><th>현장</th><th>자재</th><th>예정 수량</th><th>메모</th><th>상태</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.work_date)}</td><td>${esc(r.site_name)}</td><td>${esc(r.name)}</td><td>${num(r.quantity)} ${esc(r.unit)}</td><td style="white-space:pre-wrap">${esc(r.memo)}</td><td>${esc(r.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">예정된 자재가 없습니다.</p>'}`,
      `<button class="btn" data-action="modal-close">닫기</button><button class="btn primary" data-action="week-materials-export" ${rows.length ? '' : 'disabled'}>엑셀 다운로드</button>`,
      () => { weeklyCurrent = null; });
  }

  async function exportWeekly() {
    const model = weeklyCurrent;
    if (!model || ctx().modalType !== 'weekly-materials' || !model.rows.length) throw Error('주간 자재 목록을 다시 여세요.');
    if (!globalThis.ExcelJS) throw Error('엑셀 도구를 불러오지 못했습니다.');
    const wb = new ExcelJS.Workbook(), sum = wb.addWorksheet('자재별 합계'), detail = wb.addWorksheet('계획서별 메모');
    sum.columns = [{ header: '현장', key: 'site_name', width: 28 }, { header: '자재', key: 'name', width: 48 },
      { header: '예정 수량', key: 'quantity', width: 18 }, { header: '단위', key: 'unit', width: 12 },
      { header: '결재 상태', key: 'status', width: 20 }];
    detail.columns = [{ header: '작업일', key: 'work_date', width: 16 }, { header: '현장', key: 'site_name', width: 28 },
      { header: '자재', key: 'name', width: 48 }, { header: '예정 수량', key: 'quantity', width: 18 },
      { header: '단위', key: 'unit', width: 12 }, { header: '발주 메모', key: 'memo', width: 50 },
      { header: '결재 상태', key: 'status', width: 20 }];
    model.totals.forEach(item => sum.addRow(item));
    model.rows.forEach(item => detail.addRow(item));
    for (const ws of [sum, detail]) {
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A56B2' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columnCount } };
      ws.getColumn('quantity').numFmt = '#,##0.###';
    }
    const bytes = await wb.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `대흥기업_예정자재_${model.dates[0]}_${model.dates[6]}.xlsx`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    DH.toast('주간 예정 자재 엑셀 파일을 만들었습니다.');
  }

  /* ---------- 날짜 · 작업계획서 ---------- */
  function dateDetail(date) {
    const c = ctx(),
      list = permitsOn(date);
    c.selectedDate = date;
    c.modalType = 'date';
    let stopChat = () => {};
    DH.ui.open(`${date} 작업 기록`,
      `<h3 class="section">작업허가서 · 계획서</h3>${list.length ? list.map(permitItem).join('') : '<div class="empty">등록된 작업이 없습니다.</div>'}` +
      `<section class="day-chat" data-day-chat-date="${esc(date)}"><div class="day-chat-head"><h3 class="section">${date === DH.workDay() ? '오늘의 채팅' : '그날의 채팅'}</h3><button class="btn tiny" data-action="day-chat-refresh">채팅 새로고침</button></div><p class="small muted">한국시간 오전 4시부터 다음 날 오전 4시까지의 현장공유입니다.</p><p class="small muted day-chat-status" role="status">채팅을 불러오는 중...</p><div class="day-chat-messages"></div></section>`,
      `<button class="btn primary" data-action="plan-new" data-date="${date}">이 날짜에 계획 작성</button>`,
      () => stopChat());
    stopChat = DH.share.mountDayChat(date);
  }
  function taskContracts(siteId) {
    return ctx().data.contracts.filter((x) => x.site_id === siteId && x.active);
  }
  function contractOptions(siteId, selectedId = '', query = '') {
    const contracts = taskContracts(siteId);
    const words = query.trim().toLocaleLowerCase('ko-KR').split(/\s+/).filter(Boolean);
    const matches = contracts.filter((item) => {
      const searchable = `${item.name} ${item.unit} ${DH.contracts?.noteFor(item.id) || ''}`.toLocaleLowerCase('ko-KR');
      return words.every((word) => searchable.includes(word));
    });
    const selected = contracts.find((item) => item.id === selectedId);
    const visible = selected && !matches.some((item) => item.id === selectedId) ? [selected, ...matches] : matches;
    return {
      count: matches.length,
      html: `<option value="">${words.length && !matches.length ? '검색 결과 없음' : '내역 선택(선택)'}</option>${visible
        .map((item) => `<option value="${esc(item.id)}" ${item.id === selectedId ? 'selected' : ''} data-name="${esc(item.name)}" data-unit="${esc(item.unit)}" data-note="${esc(DH.contracts?.noteFor(item.id) || '')}">${esc(item.name)} · ${esc(item.unit)}</option>`)
        .join('')}`,
    };
  }
  function taskRow(t = {}, siteId = $('#plan-site')?.value) {
    const options = contractOptions(siteId, t.contract_item_id);
    return `<div class="row taskrow"><div class="task-contract-search-wrap"><input class="task-contract-search" type="search" aria-label="계약 내역 검색" placeholder="내역명 검색 (예: 표지판 설치)" autocomplete="off"><span class="task-contract-search-count">${options.count}건</span></div><select class="task-contract" style="width:30%" aria-label="계약 내역 선택">${options.html}</select><input class="task-name" placeholder="작업명" value="${esc(t.name)}" style="width:31%"><input class="task-target" type="number" min="0.001" step="any" placeholder="예정 사용량" value="${esc(t.target_quantity ?? '')}" style="width:20%"><input class="task-unit" placeholder="단위" value="${esc(t.unit)}" style="width:13%"><button type="button" class="btn tiny" data-action="row-remove">×</button><label class="field" style="width:100%">자재별 발주 메모<textarea class="task-order-memo" maxlength="2000" placeholder="규격, 발주 시 전달할 내용 등을 입력하세요">${esc(t.order_memo || '')}</textarea></label><small class="task-contract-note muted" style="width:100%;white-space:pre-wrap">${esc(DH.contracts?.noteFor(t.contract_item_id) || '')}</small></div>`;
  }
  /** keep: 현장을 바꿔 다시 그릴 때 입력 중이던 날짜·위치·지시를 유지 */
  function planForm(date = ctx().selectedDate, id = null, siteId = null, keep = {}) {
    const c = ctx(),
      d = c.data,
      p = { ...(d.permits.find((x) => x.id === id) || {}), ...keep },
      s = siteId || p.site_id || d.sites[0]?.id,
      materialReady = keep.material_ready ?? c.permitMaterialReady?.[id] ?? false;
    c.modalType = 'plan';
    c.editId = id;
    DH.ui.open(
      id ? '작업계획서 수정' : '작업계획서 작성',
      `<form id="planform"><div class="two"><label class="field">현장<select id="plan-site" required>${d.sites
        .filter((x) => x.active)
        .map((x) => `<option value="${x.id}" ${x.id === s ? 'selected' : ''}>${esc(x.name)}</option>`)
        .join('')}</select></label><label class="field">작업일<input id="plan-date" type="date" value="${esc(p.work_date || date)}" required></label></div><label class="field">작업 위치 설명<input id="plan-location" value="${esc(p.location_description)}" required></label><label class="field">특별 작업 지시<textarea id="plan-instructions">${esc(p.special_instructions)}</textarea></label>
<h3 class="section">목표 작업 <button type="button" class="btn tiny" data-action="plan-add-task">항목 추가</button></h3><div id="taskrows">${(p.tasks?.length ? p.tasks : [{}]).map((t) => taskRow(t, s)).join('')}</div>
<h3 class="section">예정 작업자</h3><div class="checks">${d.employees
        .filter((x) => x.active)
        .map((e) => `<label><input class="worker-check" type="checkbox" value="${e.id}" ${p.workers?.some((w) => w.employee_id === e.id) ? 'checked' : ''}> ${esc(e.name)}</label>`)
        .join('')}</div>
<h3 class="section">사용 예정 장비</h3><div class="checks">${d.equipment
        .filter((x) => x.active)
        .map((e) => {
          const old = p.equipment?.find((a) => a.equipment_id === e.id);
          return `<label><input class="equip-check" type="checkbox" value="${e.id}" ${old ? 'checked' : ''}> ${esc(e.name)} <input class="equip-qty" type="number" min="1" value="${old?.quantity || 1}" style="width:60px"></label>`;
        })
        .join('')}</div>
<h3 class="section">첨부 도면</h3><div class="checks">${
        d.drawings
          .filter((x) => x.site_id === s)
          .map((x) => `<label><input class="drawing-check" type="checkbox" value="${x.id}" ${p.drawings?.some((y) => y.drawing_id === x.id) ? 'checked' : ''}> ${x.drawing_number}번 ${esc(x.title)}</label>`)
          .join('') || '<span class="muted">현장에 등록된 도면 없음</span>'
      }</div><p class="small muted">저장하면 초안입니다. 결재 요청 후 두 명이 순서대로 승인하면 작업자에게 공유됩니다.</p></form>`,
      `<button class="btn" data-action="modal-close">취소</button><button type="button" class="btn ${materialReady ? 'ready' : ''}" id="plan-ready" data-action="plan-toggle-ready" aria-pressed="${materialReady}">${materialReady ? '자재 준비 완료 ✓' : '자재 준비 완료'}</button><button class="btn primary" data-action="plan-save">초안 저장</button>`
    );
  }
  async function savePlan() {
    const tasks = $$('.taskrow')
      .map((r) => ({
        name: $('.task-name', r).value.trim(),
        target: Number($('.task-target', r).value),
        unit: $('.task-unit', r).value.trim(),
        contract_item_id: $('.task-contract', r).value || undefined,
        order_memo: $('.task-order-memo', r).value.trim(),
      }))
      .filter((x) => x.name);
    const workers = $$('.worker-check:checked').map((x) => x.value);
    const equipment = $$('.equip-check:checked').map((x) => ({ id: x.value, quantity: Number($('.equip-qty', x.parentElement).value) }));
    const drawings = $$('.drawing-check:checked').map((x) => x.value);
    if (!tasks.length || tasks.some((x) => !x.unit || x.target <= 0)) throw Error('작업 목표와 수량·단위를 입력하세요');
    const site = ctx().data.sites.find(x => x.id === $('#plan-site').value);
    if (site?.contract_type === 'unit_price' && tasks.some(x => !x.contract_item_id))
      throw Error('단가계약은 모든 항목에서 215개 자재 내역 중 하나를 선택하세요');
    if (!workers.length) throw Error('예정 작업자를 선택하세요');
    const p_data = {
        id: ctx().editId || undefined,
        site_id: $('#plan-site').value,
        work_date: $('#plan-date').value,
        location: $('#plan-location').value.trim(),
        instructions: $('#plan-instructions').value.trim(),
        tasks,
        workers,
        equipment,
        materials: [],
        material_ready: $('#plan-ready').getAttribute('aria-pressed') === 'true',
        drawings,
      };
    try {
      await DH.rpc('dh_save_permit_with_memo', { p_data });
    } catch (error) {
      if (site?.contract_type === 'unit_price' || tasks.some(task => task.order_memo) ||
        !(error.status === 404 || error.code === 'PGRST202')) throw error;
      await DH.rpc('dh_save_permit_ready', { p_data });
    }
    DH.ui.close();
    await DH.admin.reload();
    DH.toast('초안을 저장했습니다');
  }

  /* ---------- 상세 · 결재 ---------- */
  function planDetail(id) {
    const c = ctx(),
      p = c.data.permits.find((x) => x.id === id);
    if (!p) return;
    c.modalType = 'permit';
    c.editId = id;
    const a = p.approval,
      s = status(p),
      pending = a && PENDING.includes(a.stage),
      materialReady = c.permitMaterialReady?.[id] === true;
    const editable = !p.published_at && !['first_pending', 'second_pending', 'approved'].includes(a?.stage);
    const approverOptions = (withPosition) =>
      `<option value="">선택</option>${c.data.approvers.map((x) => `<option value="${x.id}">${esc(x.name)}${withPosition ? ' ' + esc(x.position) : ''}</option>`).join('')}`;
    DH.ui.open(
      `${esc(DH.siteName(p.site_id))} · ${esc(p.work_date)}`,
      `<p>${pill(s)} <span class="muted">작업자는 최종 승인 뒤에만 볼 수 있습니다.</span></p><div class="two"><div><p><b>위치</b> ${esc(p.location_description)}</p><p><b>특별 지시</b> ${esc(p.special_instructions || '—')}</p></div><div><p><b>작업자</b> ${p.workers.map((x) => esc(x.name_snapshot)).join(', ') || '—'}</p><p><b>장비</b> ${p.equipment.map((x) => `${esc(x.name_snapshot)} ${x.quantity}대`).join(', ') || '—'}</p></div></div>
<h3 class="section">목표 작업</h3>${p.tasks.map((t) => `<div class="item"><b>${esc(t.name)} · ${num(t.target_quantity)}${esc(t.unit)}</b>${t.order_memo ? `<p class="small" style="white-space:pre-wrap"><b>발주 메모</b> ${esc(t.order_memo)}</p>` : ''}<p class="small muted" style="white-space:pre-wrap">${esc(DH.contracts?.noteFor(t.contract_item_id) || '')}</p></div>`).join('')}
<p><b>자재 준비</b> ${materialReady ? '완료' : '미확인'}</p>
${!a && !materialReady ? '<p class="banner">자재 준비 완료를 체크하고 초안을 저장해야 결재를 요청할 수 있습니다.</p>' : ''}
${a ? `<div class="banner"><b>결재 순서</b> ① ${esc(DH.person(a.first_approver))} → ② ${esc(DH.person(a.second_approver))}<br>현재: ${esc(s)}${a.rejection_reason ? ` · 반려 사유: ${esc(a.rejection_reason)}` : ''}</div>` : ''}
${!a ? `<div class="two"><label class="field">1차 결재자<select id="first-approver">${approverOptions(true)}</select></label><label class="field">2차 결재자<select id="second-approver">${approverOptions(true)}</select></label></div>` : ''}
${pending ? `<div class="two"><label class="field">대체 결재자<select id="replacement">${approverOptions(false)}</select></label><label class="field">변경 사유<input id="replacement-reason" placeholder="예: 휴가"></label></div>` : ''}`,
      `<button class="btn" data-action="modal-close">닫기</button>${editable ? `<button class="btn" data-action="plan-edit" data-id="${id}">수정</button>` : ''}${
        !a ? `<button class="btn primary" data-action="permit-request" data-id="${id}" ${materialReady ? '' : 'disabled'}>결재 요청</button>` : ''
      }${
        pending
          ? `<button class="btn" data-action="permit-reassign" data-id="${id}">결재자 변경</button><button class="btn danger" data-action="permit-decide" data-decision="reject" data-id="${id}">반려</button><button class="btn primary" data-action="permit-decide" data-decision="approve" data-id="${id}">승인</button>`
          : ''
      }`
    );
  }
  /** 결재 관련 처리 후 같은 허가서 상세를 다시 엽니다. */
  async function afterDecision(id) {
    DH.ui.close();
    await DH.admin.reload();
    planDetail(id);
  }

  DH.register({
    name: '작업계획 및 결재',
    order: 30,
    async adminLoad(c) {
      const ids = c.data.permits.map((p) => p.id);
      c.permitMaterialReady = ids.length ? await DH.rpc('dh_admin_permit_material_ready', { p_ids: ids }) : {};
    },
    dashboardPanels: () => [
      { slot: 'left', order: 20, html: todayPanel() },
      { slot: 'center', order: 10, html: calendarPanel() },
      { slot: 'right', order: 10, html: weeksPanel() },
    ],
    siteDetailButtons: (c, s) => ({ order: 20, html: `<button class="btn primary" data-action="plan-new" data-site="${s.id}">작업계획서 작성</button>` }),
  });

  DH.action('permit-detail', (el) => planDetail(el.dataset.id));
  DH.action('week-materials', el => DH.act(() => showWeekly(Number(el.dataset.offset))));
  DH.action('week-materials-export', () => DH.act(exportWeekly));
  DH.action('date-detail', (el) => dateDetail(el.dataset.date));
  DH.action('plan-new', (el) => planForm(el.dataset.date || ctx().selectedDate, null, el.dataset.site || null));
  DH.action('plan-edit', (el) => planForm(ctx().selectedDate, el.dataset.id));
  DH.action('plan-save', () => DH.act(savePlan));
  DH.action('plan-add-task', () => $('#taskrows').insertAdjacentHTML('beforeend', taskRow()));
  DH.action('plan-toggle-ready', (button) => {
    const ready = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(ready));
    button.classList.toggle('ready', ready);
    button.textContent = ready ? '자재 준비 완료 ✓' : '자재 준비 완료';
  });
  DH.action('permit-request', (el) =>
    DH.act(async () => {
      if (ctx().permitMaterialReady?.[el.dataset.id] !== true) throw Error('자재 준비 완료를 체크하고 초안을 저장한 뒤 결재를 요청하세요');
      await DH.rpc('dh_request_permit_approval', { p_id: el.dataset.id, p_first: $('#first-approver').value, p_second: $('#second-approver').value });
      await afterDecision(el.dataset.id);
    })
  );
  DH.action('permit-reassign', (el) =>
    DH.act(async () => {
      await DH.rpc('dh_reassign_permit_approver', { p_id: el.dataset.id, p_new: $('#replacement').value, p_reason: $('#replacement-reason').value });
      await afterDecision(el.dataset.id);
    })
  );
  DH.action('permit-decide', (el) =>
    DH.act(async () => {
      const decision = el.dataset.decision,
        reason = decision === 'reject' ? prompt('반려 사유를 입력하세요') : null;
      if (decision === 'reject' && !reason) return;
      await DH.rpc('dh_decide_permit', { p_id: el.dataset.id, p_decision: decision, p_reason: reason });
      await afterDecision(el.dataset.id);
    })
  );
  // 현장을 바꾸면 그 현장의 계약내역·도면으로 다시 그립니다(수정 중인 허가서 ID와 입력값 유지).
  DH.on('change', '#plan-site', (sel) =>
    planForm($('#plan-date').value, ctx().editId, sel.value, {
      work_date: $('#plan-date').value,
      location_description: $('#plan-location').value,
      special_instructions: $('#plan-instructions').value,
      material_ready: $('#plan-ready').getAttribute('aria-pressed') === 'true',
      tasks: $$('.taskrow').map(row => ({
        name: $('.task-name', row).value,
        target_quantity: $('.task-target', row).value,
        unit: $('.task-unit', row).value,
        order_memo: $('.task-order-memo', row).value,
      })),
    })
  );
  DH.on('change', '.task-contract', (sel) => {
    const opt = sel.selectedOptions[0],
      row = sel.closest('.taskrow');
    $('.task-contract-note', row).textContent = opt.dataset.note || '';
    if (!opt.value) return;
    $('.task-name', row).value = opt.dataset.name;
    $('.task-unit', row).value = opt.dataset.unit;
  });
  DH.on('input', '.task-contract-search', (input) => {
    const row = input.closest('.taskrow');
    const select = $('.task-contract', row);
    const options = contractOptions($('#plan-site').value, select.value, input.value);
    select.innerHTML = options.html;
    $('.task-contract-search-count', row).textContent = `${options.count}건`;
  });

  DH.permits = { status, pill, item: permitItem, detail: planDetail };
})();
