/* 단가계약: 기간별 제출 완료 작업 실적. */
(function () {
  'use strict';
  const { $, esc, num } = DH;
  let current = null;

  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    DH.iso(new Date(`${value}T12:00:00`)) === value;
  const active = model => current === model && DH.ctx.modalType === 'unit-log' &&
    DH.ctx.editId === model.siteId && model.body?.isConnected;

  function totals(rows) {
    const byItem = new Map();
    for (const row of rows) {
      const key = row.contract_item_id;
      const item = byItem.get(key) || { code: row.item_code, name: row.name,
        unit: row.unit, quantity: 0 };
      item.quantity += Number(row.actual_quantity);
      byItem.set(key, item);
    }
    return [...byItem.values()].sort((a, b) => a.code.localeCompare(b.code, 'ko-KR'));
  }

  function render(model) {
    if (!active(model)) return;
    const rows = model.rows || [], summary = totals(rows);
    $('#unit-log-summary', model.body).textContent =
      `${rows.length}개 작업 항목 · 사용 자재 ${summary.length}종`;
    $('#unit-log-rows', model.body).innerHTML = rows.length
      ? `<h3 class="section">자재별 실제 사용량</h3><div class="tablebox"><table><thead><tr><th>자재 코드</th><th>자재명</th><th>실제 사용량</th></tr></thead><tbody>${summary.map(row =>
          `<tr><td>${esc(row.code)}</td><td>${esc(row.name)}</td><td>${num(row.quantity)} ${esc(row.unit)}</td></tr>`
        ).join('')}</tbody></table></div><h3 class="section">작업 내역</h3><div class="tablebox"><table><thead><tr><th>작업일</th><th>자재</th><th>계획</th><th>실제</th><th>발주 메모</th></tr></thead><tbody>${rows.map(row =>
          `<tr><td>${esc(row.work_date)}</td><td>${esc(row.name)}</td><td>${num(row.planned_quantity)} ${esc(row.unit)}</td><td>${num(row.actual_quantity)} ${esc(row.unit)}</td><td style="white-space:pre-wrap">${esc(row.order_memo || '')}</td></tr>`
        ).join('')}</tbody></table></div>`
      : '<p class="muted">선택한 기간에 제출 완료된 작업 내역이 없습니다.</p>';
    $('[data-action="unit-log-export"]', $('#overlay')).disabled = !rows.length;
  }

  function open(siteId) {
    const site = DH.ctx.data.sites.find(row => row.id === siteId);
    if (!site || site.contract_type !== 'unit_price') throw Error('단가계약 현장을 찾을 수 없습니다.');
    const today = DH.today(), from = `${today.slice(0, 4)}-01-01`;
    const model = { siteId, siteName: site.name, rows: null, from, to: today };
    current = model;
    DH.ctx.modalType = 'unit-log'; DH.ctx.editId = siteId;
    model.body = DH.ui.open(`${esc(site.name)} · 작업 내역`,
      `<section class="unit-log"><p class="small muted">선택한 작업일의 제출 완료된 작업종료만 청구용 실적에 포함합니다.</p><div class="toolbar"><label class="field">시작일<input id="unit-log-from" type="date" value="${from}"></label><label class="field">종료일<input id="unit-log-to" type="date" value="${today}"></label><button class="btn" data-action="unit-log-preview">조회</button></div><p id="unit-log-summary" class="muted">기간을 정하고 조회해 주세요.</p><div id="unit-log-rows"></div></section>`,
      '<button class="btn" data-action="modal-close">닫기</button><button class="btn primary" data-action="unit-log-export" disabled>엑셀 다운로드</button>',
      () => { if (current === model) current = null; });
  }

  async function preview() {
    const model = current;
    if (!model || !active(model)) return;
    const from = $('#unit-log-from', model.body).value, to = $('#unit-log-to', model.body).value;
    if (!validDate(from) || !validDate(to) || to < from) throw Error('조회 시작일과 종료일을 확인하세요.');
    model.rows = null;
    $('#unit-log-summary', model.body).textContent = '작업 내역을 불러오는 중입니다.';
    $('[data-action="unit-log-export"]', $('#overlay')).disabled = true;
    const rows = await DH.rpc('dh_unit_contract_work_log', { p_site: model.siteId, p_from: from, p_to: to });
    if (!active(model)) return;
    if (!Array.isArray(rows) || rows.some(row => !row.contract_item_id || !Number.isFinite(Number(row.actual_quantity))))
      throw Error('작업 내역 응답을 확인하지 못했습니다.');
    model.from = from; model.to = to; model.rows = rows;
    render(model);
  }

  async function exportExcel() {
    const model = current;
    if (!model || !active(model) || !model.rows?.length) throw Error('작업 내역을 먼저 조회하세요.');
    if (!globalThis.ExcelJS) throw Error('엑셀 도구를 불러오지 못했습니다.');
    const wb = new ExcelJS.Workbook();
    const sum = wb.addWorksheet('자재별 합계'), detail = wb.addWorksheet('작업별 내역');
    sum.columns = [
      { header: '자재 코드', key: 'code', width: 24 },
      { header: '자재명', key: 'name', width: 50 },
      { header: '실제 사용량', key: 'quantity', width: 18 },
      { header: '단위', key: 'unit', width: 14 },
    ];
    detail.columns = [
      { header: '작업일', key: 'date', width: 16 },
      { header: '현장명', key: 'site', width: 28 },
      { header: '자재 코드', key: 'code', width: 24 },
      { header: '자재명', key: 'name', width: 50 },
      { header: '계획 수량', key: 'planned', width: 17 },
      { header: '실제 수량', key: 'actual', width: 17 },
      { header: '단위', key: 'unit', width: 14 },
      { header: '발주 메모', key: 'memo', width: 50 },
    ];
    for (const item of totals(model.rows)) sum.addRow(item);
    for (const row of model.rows) detail.addRow({ date: row.work_date, site: row.site_name,
      code: row.item_code, name: row.name, planned: Number(row.planned_quantity),
      actual: Number(row.actual_quantity), unit: row.unit, memo: row.order_memo || '' });
    for (const ws of [sum, detail]) {
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A56B2' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columnCount } };
    }
    sum.getColumn('quantity').numFmt = '#,##0.###';
    detail.getColumn('planned').numFmt = '#,##0.###';
    detail.getColumn('actual').numFmt = '#,##0.###';
    const bytes = await wb.xlsx.writeBuffer();
    if (!active(model)) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `대흥기업_${model.siteName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}_작업내역_${model.from}_${model.to}.xlsx`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    DH.toast('작업 내역 엑셀 파일을 만들었습니다.');
  }

  DH.action('unit-log-open', element => DH.act(() => open(element.dataset.id)));
  DH.action('unit-log-preview', () => DH.act(preview));
  DH.action('unit-log-export', () => DH.act(exportExcel));
  DH.on('change', '#unit-log-from, #unit-log-to', () => {
    if (!current || !active(current)) return;
    current.rows = null;
    $('#unit-log-summary', current.body).textContent = '기간이 바뀌었습니다. 다시 조회해 주세요.';
    $('#unit-log-rows', current.body).innerHTML = '';
    $('[data-action="unit-log-export"]', $('#overlay')).disabled = true;
  });
})();
