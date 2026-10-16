/* =====================================================================
 * 기능: 작업종료 및 일보 (관리자)
 *  - '작업 일보' 탭: 기간 조회, 사진 포함 엑셀 다운로드
 * RPC: dh_admin_work_log_v2 · dh_admin_work_photo_detail      필요 라이브러리: ExcelJS
 * ===================================================================== */
(function () {
  'use strict';
  const { $, esc } = DH;
  const BASE_COLUMNS = ['날짜', '현장명', '작업 위치 설명', '작업자 명단', '목표 작업량', '실제 작업량', '자재 구분'];
  const WIDTHS = [16, 25, 38, 30, 28, 28, 28];
  const photoPairsHtml = (pairs) => `<div class="report-photo-pairs">${pairs.map((pair, i) =>
    `<section><b>${pair.kind === 'overview' ? '현장 전경' : `작업물 ${i}`}</b><div class="report-photo-sides"><figure><figcaption>작업 전</figcaption><img data-share-file="${esc(pair.before.id)}" alt="작업 전"></figure><figure><figcaption>작업 후</figcaption>${pair.after ? `<img data-share-file="${esc(pair.after.id)}" alt="작업 후">` : '<span>미촬영</span>'}</figure></div></section>`
  ).join('')}</div>`;

  async function detail(permitId) {
    const [record, work] = await Promise.all([
      DH.rpc('dh_admin_report_detail', { p_permit: permitId }),
      DH.rpc('dh_admin_work_photo_detail', { p_permit: permitId }),
    ]);
    if (!record) throw Error('작업종료 보고를 찾을 수 없습니다.');
    const approved = record.review_status === 'approved';
    const status = approved ? '작업일보' : record.review_status === 'rejected' ? '종료 보완요청' : '종료 승인대기';
    const canDecide = record.review_status === 'pending' && record.requested_by === DH.ctx.profile.employee_id;
    DH.ctx.modalType = 'report';
    DH.ui.open(`${esc(record.site_name)} · ${esc(record.work_date)} ${status}`,
      `<p><span class="pill ${approved ? 'ok' : record.review_status === 'rejected' ? 'bad' : 'wait'}">${status}</span> <span class="muted">보고 ${esc(record.submitted_by_name)} · 확인 담당 ${esc(record.requested_by_name)}</span></p>
      <p style="white-space:pre-wrap"><b>작업 위치 설명</b> ${esc(work?.location || '—')}</p>${work?.started_at ? `<p><b>작업 시작</b> ${esc(new Date(work.started_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))}</p>` : ''}
      <h3 class="section">작업 결과</h3>${record.tasks.map(t => `<div class="item"><b>${esc(t.name)}</b><p>목표 ${DH.num(t.target_quantity)}${esc(t.unit)} → 실제 <strong>${DH.num(t.actual_quantity)}${esc(t.unit)}</strong></p><small>${t.external_material_used ? '회사 자재 외 사용' : '회사 자재 사용'}</small></div>`).join('')}
      <h3 class="section">실제 투입</h3><p><b>인원</b> ${esc(record.workers.join(', ') || '—')}</p><p><b>장비</b> ${esc(record.equipment.map(e => `${e.name} ${e.quantity}대`).join(', ') || '없음')}</p>
      <h3 class="section">종료 확인</h3><p>명단 확인 ${record.roster_confirmed_at ? '✓' : '—'} · 작업구역 정리 ${record.area_cleaned ? '✓' : '—'} · 장비·자재 회수 ${record.equipment_collected ? '✓' : '—'} · 안전상태 ${record.safety_checked ? '✓' : '—'}</p>
      <p><b>미완료 사유</b> ${esc(record.incomplete_reason || '—')}</p><p style="white-space:pre-wrap"><b>특이사항</b> ${esc(record.notes || '—')}</p>${record.rejection_reason && record.review_status === 'rejected' ? `<p class="banner"><b>보완 사유</b> ${esc(record.rejection_reason)}</p>` : ''}
      <h3 class="section">작업 전 · 후 사진</h3>${work?.pairs?.length ? photoPairsHtml(work.pairs) : record.photos.length ? DH.share.filesHtml(record.photos) : '<p class="muted">첨부 사진 없음</p>'}`,
      `<button class="btn" data-action="modal-close">닫기</button>${canDecide ? `<button class="btn danger" data-action="report-decide" data-id="${record.id}" data-permit="${record.permit_id}" data-decision="reject">보완 요청</button><button class="btn primary" data-action="report-decide" data-id="${record.id}" data-permit="${record.permit_id}" data-decision="approve">작업일보 승인</button>` : ''}`);
    DH.share.hydrateFiles(work?.pairs?.length ? work.pairs.flatMap(p => [p.before, p.after].filter(Boolean)) : record.photos);
  }

  function page() {
    const today = DH.today(),
      from = DH.addDay(today, -30),
      pending = DH.ctx.pendingReports || [];
    return `<div class="head"><div><h1>작업 일보</h1><p class="muted">종료 보고를 확인하고 승인된 작업일보를 조회합니다.</p></div></div>${DH.ctx.pendingReports === undefined ? '<p class="banner">작업종료 승인 기능의 DB 설치 상태를 확인해 주세요.</p>' : ''}<section class="card"><h2>내가 확인할 종료 보고 <span class="pill wait">${pending.length}</span></h2>${pending.length ? pending.map(p => `<button class="item" data-action="report-detail" data-id="${p.permit_id}"><b>${esc(p.site_name)}</b><small>${esc(p.work_date)} · ${esc(p.tasks.join(' · '))}</small></button>`).join('') : '<p class="body muted">승인 대기 중인 보고가 없습니다.</p>'}</section><div class="card body" style="margin-top:16px"><h2>지난 작업일 기록</h2><p class="muted">04:00에 마감된 허가서와 현장공유를 원래 작업일로 조회합니다. 미종료와 승인 대기도 포함합니다.</p><div class="toolbar"><label class="field">시작일<input id="archive-from" type="date" value="${DH.addDay(DH.workDay(), -7)}"></label><label class="field">종료일<input id="archive-to" type="date" value="${DH.addDay(DH.workDay(), -1)}"></label><button class="btn primary" data-action="archive-preview">지난 기록 조회</button></div><div id="archive-results"></div></div><div class="card body" style="margin-top:16px"><div class="toolbar"><label class="field">시작일<input id="report-from" type="date" value="${from}"></label><label class="field">종료일<input id="report-to" type="date" value="${today}"></label><label class="field">사진 포함<label class="row"><input id="report-photos" type="checkbox" checked> 문서용 화질로 삽입</label></label><button class="btn" data-action="report-preview">조회</button><button class="btn primary" data-action="report-export">엑셀 다운로드</button></div><p id="report-summary" class="muted">조회 버튼을 누르면 승인된 기록이 표시됩니다.</p><div id="report-table"></div></div>`;
  }

  let dayArchive = [];
  async function archivePreview() {
    dayArchive = await DH.rpc('dh_admin_day_archive', {
      p_from: $('#archive-from').value,
      p_to: $('#archive-to').value,
    });
    $('#archive-results').innerHTML = dayArchive.length
      ? `<div class="list">${dayArchive.map((entry) =>
          `<button class="item" data-action="archive-detail" data-id="${esc(entry.permit_id)}"><b>${esc(entry.work_date)} · ${esc(entry.site_name)}</b><small>${esc(entry.status)} · 현장공유 ${entry.shares.length}건 · 작업 ${entry.tasks.length}항목</small></button>`
        ).join('')}</div>`
      : '<p class="muted">이 기간에 마감된 작업허가서가 없습니다.</p>';
  }
  function archiveDetail(id) {
    const entry = dayArchive.find((x) => x.permit_id === id);
    if (!entry) return;
    const files = entry.shares.flatMap((share) => share.files);
    DH.ctx.modalType = 'archive';
    DH.ui.open(`${esc(entry.work_date)} · ${esc(entry.site_name)} 작업일보`,
      `<p><span class="pill ${entry.status === '승인완료' ? 'ok' : 'wait'}">${esc(entry.status)}</span></p>` +
      `<p><b>작업 위치</b> ${esc(entry.location || '—')}</p><p style="white-space:pre-wrap"><b>작업 지시</b> ${esc(entry.instructions || '—')}</p>` +
      `<h3 class="section">작업별 물량</h3>${entry.tasks.map((task) => `<div class="item"><b>${esc(task.name)}</b><p>목표 ${DH.num(task.target)}${esc(task.unit)} · 실제 ${task.actual == null ? '미보고' : DH.num(task.actual) + esc(task.unit)}</p></div>`).join('')}` +
      (entry.report_id ? `<button class="btn" data-action="report-detail" data-id="${esc(entry.permit_id)}">작업종료 보고 보기</button>` : '<p class="muted">작업종료 보고가 아직 없습니다.</p>') +
      `<h3 class="section">현장공유 · 대화 기록</h3>${entry.shares.length ? entry.shares.map((share) =>
        `<div class="card body"><p><b>${esc(share.sender)}</b> · ${esc(new Date(share.posted_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))}</p><p style="white-space:pre-wrap">${esc(share.body || '첨부 자료 공유')}</p>${DH.share.filesHtml(share.files)}${share.updates.map((update) =>
          `<p style="white-space:pre-wrap"><b>${esc(update.author)} · ${esc(new Date(update.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))}</b><br>${esc(update.flow)}<br>${esc(update.outcome || '')}${update.resolved ? ' · 해결' : ''}</p>`
        ).join('')}</div>`).join('') : '<p class="muted">현장공유 기록이 없습니다.</p>'}`);
    DH.share.hydrateFiles(files);
  }

  async function preview() {
    const rows = await DH.rpc('dh_admin_work_log_v2', { p_from: $('#report-from').value, p_to: $('#report-to').value });
    $('#report-summary').textContent = `${rows.length}개 작업 항목`;
    $('#report-table').innerHTML = `<div class="tablebox"><table><thead><tr>${[...BASE_COLUMNS, '작업 전·후 사진'].map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows
      .map((r) => `<tr>${BASE_COLUMNS.map((k) => `<td>${esc(r[k])}</td>`).join('')}<td><button class="btn" data-action="report-detail" data-id="${esc(r['허가서 ID'])}">${r['사진 쌍'].length ? `${r['사진 쌍'].length}쌍 보기` : `기존 완료사진 ${r['작업 사진'].length}장 보기`}</button></td></tr>`)
      .join('')}</tbody></table></div>`;
    return rows;
  }

  /** 문서용으로 축소한 JPEG(base64) */
  async function photoJpeg(photo) {
    const img = await createImageBitmap(await DH.ctx.api.blob(photo));
    const scale = Math.min(1, 1280 / img.width, 960 / img.height),
      canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    img.close();
    return canvas.toDataURL('image/jpeg', 0.72);
  }

  async function exportExcel() {
    const from = $('#report-from').value,
      to = $('#report-to').value,
      withPhotos = $('#report-photos').checked,
      rows = await preview();
    const wb = new ExcelJS.Workbook(),
      ws = wb.addWorksheet('작업 일보');
    const photoCount = withPhotos ? Math.max(1, ...rows.map((r) => r['사진 쌍'].length || r['작업 사진'].length)) : 0;
    const columns = [...BASE_COLUMNS, ...(withPhotos ? Array.from({ length: photoCount }, (_, i) => [`작업 전 ${i + 1}`, `작업 후 ${i + 1}`]).flat() : ['사진'])];
    ws.columns = columns.map((header, i) => ({ header, key: 'c' + i, width: i < BASE_COLUMNS.length ? WIDTHS[i] : 24 }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A56B2' } };
    for (const record of rows) {
      const pairs = record['사진 쌍'].length ? record['사진 쌍'] : record['작업 사진'].map(after => ({ before: null, after }));
      const row = ws.addRow([...BASE_COLUMNS.map((k) => record[k]), ...(withPhotos ? Array(photoCount * 2).fill('') : [`${record['사진 쌍'].length ? `${pairs.length}쌍` : `${pairs.length}장`}`])]);
      row.alignment = { vertical: 'middle', wrapText: true };
      if (!withPhotos || !pairs.length) continue;
      row.height = 82;
      for (let i = 0; i < pairs.length; i++) {
        for (const [side, offset] of [['before', 0], ['after', 1]]) {
          if (!pairs[i][side]) continue;
          const id = wb.addImage({ base64: await photoJpeg(pairs[i][side]), extension: 'jpeg' }),
            col = BASE_COLUMNS.length + i * 2 + offset;
          ws.addImage(id, { tl: { col: col + 0.08, row: row.number - 0.88 }, br: { col: col + 0.92, row: row.number - 0.12 } });
        }
      }
    }
    ws.autoFilter = { from: 'A1', to: { row: 1, column: columns.length } };
    const buf = await wb.xlsx.writeBuffer(),
      a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = `대흥기업_작업일보_${from}_${to}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    DH.toast('엑셀 파일을 만들었습니다');
  }

  DH.register({
    name: '작업 일보',
    order: 80,
    async adminLoad(c) { c.pendingReports = undefined; c.pendingReports = await DH.rpc('dh_admin_pending_reports'); },
    adminTabs: { id: 'reports', label: '작업 일보', order: 30, render: page },
  });
  DH.action('report-preview', () => DH.act(preview));
  DH.action('archive-preview', () => DH.act(archivePreview));
  DH.action('archive-detail', (el) => archiveDetail(el.dataset.id));
  DH.action('report-export', () => DH.act(exportExcel));
  DH.action('report-detail', (el) => DH.act(() => detail(el.dataset.id)));
  DH.action('report-decide', (el) => DH.act(async () => {
    const decision = el.dataset.decision;
    const reason = decision === 'reject' ? prompt('보완할 내용을 입력하세요') : null;
    if (decision === 'reject' && !reason?.trim()) return;
    const permitId = el.dataset.permit;
    await DH.rpc('dh_decide_report', { p_id: el.dataset.id, p_decision: decision, p_reason: reason });
    await DH.admin.reload();
    if (permitId) await detail(permitId);
  }));
})();
