/* 현재 계약 내역의 수량 진행현황: 현장 목록의 진행률과 같은 조회 결과를 사용합니다. */
(function () {
  'use strict';
  const { $, esc, num } = DH;
  const ctx = () => DH.ctx;
  const percent = (value) => `${Number(value).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  let current = null;

  function validRows(rows, siteId) {
    return Array.isArray(rows) && rows.every((row) => row.id && row.site_id === siteId &&
      Number.isFinite(Number(row.target_quantity)) && Number(row.target_quantity) > 0 &&
      Number.isFinite(Number(row.actual_quantity)) && Number(row.actual_quantity) >= 0) &&
      new Set(rows.map((row) => row.id)).size === rows.length;
  }
  function active(model) {
    return current === model && ctx().modalType === 'contract-progress' && ctx().editId === model.siteId &&
      model.body?.isConnected && DH.ui.body() === model.body;
  }
  function quantities(row) {
    const target = Number(row.target_quantity), actual = Number(row.actual_quantity);
    return { target, actual, remaining: Math.max(0, target - actual), excess: Math.max(0, actual - target),
      ratio: Math.min(1, actual / target) };
  }
  function table(rows) {
    if (!rows.length) return '<p class="muted">현재 계약 내역에 등록된 품목이 없습니다.</p>';
    return `<p class="small muted">현재 계약 내역에 등록된 ${rows.length}개 품목 · 제출 완료된 작업종료 보고의 실제 수량 기준 · 품목별 진행률은 100%까지 표시</p>
      <div class="tablebox"><table><thead><tr><th>작업·자재명</th><th>단위</th><th>계약 수량</th><th>진행 수량</th><th>잔여 수량</th><th>초과 수량</th><th>진행률</th></tr></thead><tbody>${rows.map((row) => {
        const q = quantities(row);
        return `<tr><td>${esc(row.name)}</td><td>${esc(row.unit)}</td><td>${num(q.target)}</td><td>${num(q.actual)}</td><td>${num(q.remaining)}</td><td>${num(q.excess)}</td><td>${percent(q.ratio * 100)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  async function open(siteId) {
    const site = ctx().data?.sites.find((row) => row.id === siteId);
    if (!site) throw Error('현장을 찾을 수 없습니다. 새로고침 후 다시 시도하세요.');
    const model = { siteId, siteName: site.name, rows: null, body: null };
    current = model;
    ctx().modalType = 'contract-progress'; ctx().editId = siteId;
    model.body = DH.ui.open(`${esc(site.name)} · 계약 진행현황`,
      '<section class="contract-progress"><p role="status">진행 수량을 불러오는 중입니다.</p></section>',
      '<button class="btn" data-action="modal-close">닫기</button><button class="btn primary" data-action="contract-progress-export" disabled>엑셀 다운로드</button>',
      () => { if (current === model) current = null; });
    try {
      const rows = await DH.rpc('dh_contract_progress_snapshot', { p_site: siteId });
      if (!active(model)) return;
      if (!validRows(rows, siteId)) throw Error('진행 수량 조회 결과가 올바르지 않습니다.');
      model.rows = rows;
      $('.contract-progress', model.body).innerHTML = table(rows);
      $('[data-action="contract-progress-export"]', $('#overlay')).disabled = !rows.length;
      if (ctx().progressState === 'ready') {
        ctx().progressRows = [...ctx().progressRows.filter((row) => row.site_id !== siteId), ...rows];
        DH.admin.render();
      }
    } catch (error) {
      if (!active(model)) return;
      $('.contract-progress', model.body).innerHTML = `<p class="pill bad">진행 수량 조회 실패</p><p>${esc(error.message)}</p><button class="btn tiny" data-action="contract-progress-retry" data-id="${esc(siteId)}">다시 조회</button>`;
    }
  }

  async function exportExcel() {
    const model = current;
    if (!model || !active(model) || !model.rows?.length) throw Error('진행현황을 먼저 조회하세요.');
    if (!globalThis.ExcelJS) throw Error('엑셀 도구를 불러오지 못했습니다. 인터넷 연결을 확인하세요.');
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('계약 진행현황');
    ws.columns = [
      { header: '작업·자재명', key: 'name', width: 50 },
      { header: '단위', key: 'unit', width: 14 },
      { header: '계약 수량', key: 'target', width: 17 },
      { header: '진행 수량', key: 'actual', width: 17 },
      { header: '잔여 수량', key: 'remaining', width: 17 },
      { header: '초과 수량', key: 'excess', width: 17 },
      { header: '진행률', key: 'ratio', width: 14 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A56B2' } };
    for (const item of model.rows) {
      const q = quantities(item);
      ws.addRow({ name: item.name, unit: item.unit, target: q.target, actual: q.actual,
        remaining: q.remaining, excess: q.excess, ratio: q.ratio });
    }
    for (const key of ['target', 'actual', 'remaining', 'excess']) ws.getColumn(key).numFmt = '#,##0.###';
    ws.getColumn('ratio').numFmt = '0.00%';
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = 'A1:G1';
    const bytes = await wb.xlsx.writeBuffer();
    if (!active(model)) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `대흥기업_${model.siteName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}_계약진행현황_${DH.today()}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    DH.toast('계약 진행현황 엑셀 파일을 만들었습니다.');
  }

  DH.action('site-progress', (element) => DH.act(() => open(element.dataset.id)));
  DH.action('contract-progress-retry', (element) => DH.act(() => open(element.dataset.id)));
  DH.action('contract-progress-export', () => DH.act(exportExcel));
})();
