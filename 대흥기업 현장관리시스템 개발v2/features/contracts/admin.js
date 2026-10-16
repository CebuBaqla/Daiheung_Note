/* 계약내역 관리자: 원본 행 검색 → 열 역할 지정 → 시공 관리 리스트 확정. */
(function () {
  'use strict';
  const { $, $$, esc, num } = DH, C = DH.contracts, ctx = () => DH.ctx;
  const PAGE_SIZE = 100;
  let preview = null, sequence = 0;
  const missingRpc = error => error?.status === 404 || /PGRST202|Could not find the function/.test(error?.message || '');
  const metadata = id => ctx().contractMetadata?.[id] || {};
  C.noteFor = id => metadata(id).note || '';
  const unitPrice = siteId => ctx().data.sites.find(site => site.id === siteId)?.contract_type === 'unit_price';

  function position(row) {
    return [row.source?.sheet, row.source?.page ? `${row.source.page}쪽` : '',
      `${row.source?.row ?? row.rowIdx ?? '?'}행`].filter(Boolean).join(' · ');
  }
  function download(doc) {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = (doc.source?.fileName || '계약내역').replace(/\.[^.]+$/, '') + '-검토.json';
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function loadMetadata(c) {
    c.contractMetadata = {}; c.contractReviewState = 'loading';
    try {
      const data = await DH.rpc('dh_contract_review_snapshot');
      if (!Array.isArray(data)) throw Error('계약 비고 응답을 확인하지 못했습니다.');
      c.contractMetadata = Object.fromEntries(data.map(item => [item.contract_item_id, item]));
      c.contractReviewState = 'ready';
    } catch (error) {
      c.contractReviewState = missingRpc(error) ? 'missing' : 'failed';
      if (error.authRequired) throw error;
    }
  }

  function sectionHtml(siteId) {
    const all = ctx().data.contracts.filter(item => item.site_id === siteId);
    const active = all.filter(item => item.active), inactive = all.filter(item => !item.active);
    const ready = ctx().contractReviewState === 'ready', unit = unitPrice(siteId);
    return `<section class="contract-review"><h3 class="section">계약 내역</h3>
      ${!ready ? `<p class="contract-warning">기존 검토 이력·비고 연결을 사용할 수 없습니다. 계약 물량 가져오기는 계속 사용할 수 있습니다. <button class="btn tiny" data-action="contract-retry">다시 연결</button></p>` : ''}
      <div class="tablebox"><table><thead><tr><th>작업·자재명</th><th>물량</th><th>단위</th><th>비고</th><th>관리</th></tr></thead><tbody>${active.map(item => {
        const m = metadata(item.id);
        const groupLabel = C.text(m.group_label);
        return `<tr data-contract-item="${esc(item.id)}"><td>${groupLabel ? `<small class="muted">${esc(groupLabel)}</small>` : ''}${esc(item.name)}${m.original ? `<details><summary>원본</summary>${esc(m.original.name)} ${esc(m.original.spec)} · ${esc(m.original.target)} ${esc(m.original.unit)}<br>${esc(position(m))}</details>` : ''}</td><td><input aria-label="관리 수량" class="dh-saved-quantity" type="number" step="any" value="${esc(item.target_quantity)}" ${unit ? 'readonly' : ''}></td><td><input aria-label="관리 단위" class="dh-saved-unit" value="${esc(item.unit)}"></td><td><textarea aria-label="계약 비고" class="dh-saved-note" ${ready ? '' : 'disabled'}>${esc(m.note || '')}</textarea></td><td><button class="btn tiny" data-action="contract-item-save" data-id="${esc(item.id)}" ${ready ? '' : 'disabled'}>저장</button> <button class="btn tiny danger" data-action="contract-item-delete" data-id="${esc(item.id)}">삭제</button></td></tr>`;
      }).join('') || '<tr><td colspan="5">등록된 내역이 없습니다.</td></tr>'}</tbody></table></div>
      <p class="small muted">현재 ${active.length}개 · 이전 제외 ${inactive.length}개</p>
      ${inactive.length ? `<details><summary>이전 제외 내역 보기</summary>${inactive.map(item => `<p>${esc(item.name)} · ${num(item.target_quantity)} ${esc(item.unit)} · ${esc(C.noteFor(item.id))}</p>`).join('')}</details>` : ''}
      <details><summary>기존 내역 관리</summary><button class="btn tiny danger" data-action="contract-clear" data-site="${esc(siteId)}" ${all.length ? '' : 'disabled'}>기존 내역 전체 삭제</button></details>
      <div class="contract-import"><b>새 내역 가져오기</b><p class="small muted">원본 행을 검색하고 필요한 열의 역할을 지정한 뒤 시공 관리 품목을 선택하세요. 확정 등록하면 기존 계약 물량 목록을 선택한 품목으로 교체합니다.${unit ? ' 단가계약은 선택한 품목의 계약 수량을 모두 0으로 등록합니다.' : ''}</p>
      <input id="contract-file" aria-label="내역 파일" type="file" accept=".xlsx,.xls,.csv,.json,.pdf"><button class="btn" data-action="contract-preview">파일 열기</button>
      <label id="contract-ocr-option" class="small" hidden><input id="contract-force-ocr" type="checkbox">PDF 글자가 빠지거나 깨지면 스캔 문자 인식으로 읽기</label>
      <p id="contract-read-status" class="small" role="status"></p><div id="dh-contract-preview"></div></div>
      ${ready ? `<details><summary>이전 검토 방식으로 등록한 원본·검토 이력</summary><button class="btn tiny" data-action="contract-history" data-site="${esc(siteId)}">이력 불러오기</button><div id="contract-history"></div></details>` : ''}
      </section>`;
  }

  function invalidate() {
    sequence++; preview = null;
    if ($('#dh-contract-preview')) $('#dh-contract-preview').innerHTML = '';
  }
  function alive(p) {
    return p && preview === p && ctx().editId === p.siteId &&
      ctx().modalType === 'site-detail' && $('#contract-file')?.files[0] === p.file;
  }
  function report(message) {
    if ($('#contract-read-status')) $('#contract-read-status').textContent = message;
  }
  function columnCount(rows) {
    return rows.reduce((width, row) => Math.max(width, row.cells.length), 0);
  }
  function mappedName(row, roles) {
    const nameColumn = roles.indexOf('name'), specColumn = roles.indexOf('spec');
    if (nameColumn < 0 && specColumn < 0) return row.rawText;
    const name = nameColumn < 0 ? '' : C.text(row.cells[nameColumn]);
    const spec = specColumn < 0 ? '' : C.text(row.cells[specColumn]);
    return [name, spec].filter(Boolean).join(' · ');
  }
  function mappedValue(row, field, roles) {
    if (field === 'name') return mappedName(row, roles);
    const index = roles.indexOf(field);
    if (index < 0) return '';
    const value = C.text(row.cells[index]);
    if (field !== 'target') return value;
    // 수량 셀 안의 숫자가 하나일 때만 사용합니다. 여러 숫자 중 하나를 추정하지 않습니다.
    const numbers = value.match(/-?\d[\d,]*(?:\.\d+)?/g) || [];
    if (numbers.length !== 1) return '';
    const amount = C.quantity(numbers[0]);
    return amount === null ? '' : String(amount);
  }
  function draftFor(p, row) {
    return { row, name: mappedValue(row, 'name', p.colRoles),
      unit: mappedValue(row, 'unit', p.colRoles),
      target: unitPrice(p.siteId) ? '0' : mappedValue(row, 'target', p.colRoles) };
  }
  function changeRole(p, column, role) {
    if (!Number.isInteger(column) || column < 0 || column >= p.colRoles.length ||
      !['none', 'name', 'spec', 'unit', 'target', 'hidden'].includes(role)) return;
    const previous = [...p.colRoles];
    if (['name', 'spec', 'unit', 'target'].includes(role)) {
      const oldColumn = p.colRoles.indexOf(role);
      if (oldColumn >= 0 && oldColumn !== column) p.colRoles[oldColumn] = 'none';
    }
    p.colRoles[column] = role;
    const nameChanged = ['name', 'spec'].some(field => previous.indexOf(field) !== p.colRoles.indexOf(field));
    const changed = [...(nameChanged ? ['name'] : []),
      ...['unit', 'target'].filter(field => previous.indexOf(field) !== p.colRoles.indexOf(field))];
    if (changed.length) {
      const currentIds = new Set(p.rawItems.map(row => row.id));
      for (const draft of p.cart.values()) {
        if (!currentIds.has(draft.row.id)) continue;
        for (const field of changed) draft[field] = field === 'target' && unitPrice(p.siteId)
          ? '0' : mappedValue(draft.row, field, p.colRoles);
      }
    }
    redrawResults(); redrawCart();
  }
  async function openFile() {
    const file = $('#contract-file')?.files[0], siteId = ctx().editId;
    if (!file) throw Error('내역 파일을 선택하세요.');
    invalidate(); const run = sequence; report('파일을 읽는 중입니다.');
    try {
      const result = await C.openFile(file, message => { if (run === sequence) report(message); },
        () => run !== sequence, { forceOcr: !!$('#contract-force-ocr')?.checked });
      if (run !== sequence || ctx().editId !== siteId || $('#contract-file')?.files[0] !== file) return;
      const rawItems = result.rawItems || [];
      preview = { ...result, file, siteId, sheetId: '', cache: new Map(), colRolesBySheet: new Map(),
        rawItems, colRoles: Array(columnCount(rawItems)).fill('none'),
        search: '', cart: new Map(), visibleLimit: PAGE_SIZE, busy: false };
      render(); report('');
    } catch (error) {
      if (run === sequence) { report('파일을 열지 못했습니다. ' + error.message); throw error; }
    }
  }
  function selectSheet(id) {
    const p = preview;
    if (!alive(p) || p.busy) return;
    p.sheetId = id; p.visibleLimit = PAGE_SIZE;
    if (!id) { p.rawItems = []; p.colRoles = []; }
    else if (p.cache.has(id)) {
      p.rawItems = p.cache.get(id);
      p.colRoles = p.colRolesBySheet.get(id);
    }
    else {
      const sheet = p.workbook.getWorksheet(Number(id));
      if (!sheet) throw Error('시트를 찾지 못했습니다.');
      p.rawItems = C.rawItems(C.sheetRows(sheet), p.prefix, { sheet: sheet.name, sheetId: id });
      p.cache.set(id, p.rawItems);
      p.colRoles = Array(columnCount(p.rawItems)).fill('none');
      p.colRolesBySheet.set(id, p.colRoles);
    }
    render();
  }

  function render() {
    const p = preview; if (!alive(p)) return;
    const needsSheet = p.sheets.length && !p.sheetId;
    $('#dh-contract-preview').innerHTML = `${p.sheets.length ? `<label class="field">내역 시트 선택<select id="contract-sheet"><option value="">시트를 선택하세요</option>${p.sheets.map(sheet => `<option value="${esc(sheet.id)}" ${p.sheetId === sheet.id ? 'selected' : ''}>${esc(sheet.name)}</option>`).join('')}</select></label>` : ''}
      ${needsSheet ? '<p class="muted">시트를 선택하면 원본 행이 표시됩니다.</p>' : `<div class="contract-results"><h4>검색 및 결과</h4>
        <input id="contract-search" aria-label="원본 행 검색" placeholder="예: 표지판 철거 변경" value="${esc(p.search)}">
        <p class="small muted">띄어쓴 단어가 모두 포함된 행을 찾습니다. 각 칸은 원본 셀 순서입니다.${/\.pdf$/i.test(p.file.name) ? ' PDF의 칸은 추출된 텍스트 조각이며 정확한 열 구분은 아닙니다.' : ''}</p>
        <div class="contract-grid-toolbar"><p id="contract-result-count" class="small"></p><button class="btn tiny" data-action="contract-reset-hidden" id="contract-reset-hidden">숨긴 열 초기화</button></div>
        <div class="tablebox"><table class="contract-raw-grid"><thead id="contract-result-head"></thead><tbody id="contract-result-body"></tbody></table></div>
        <button class="btn tiny" data-action="contract-more" id="contract-more" hidden>결과 더 보기</button></div>`}
      <div class="contract-cart"><h4>시공 관리 리스트 <span id="contract-cart-count"></span></h4>
        <p class="small muted">선택한 품목은 검색어와 시트를 바꿔도 유지됩니다. 품명·수량·단위를 확인하세요.</p>
        <div class="tablebox"><table><thead><tr><th>작업·자재명</th><th>수량</th><th>단위</th><th>관리</th></tr></thead><tbody id="contract-cart-body"></tbody></table></div>
        <div class="contract-footer"><button class="btn primary" data-action="contract-confirm">시공 관리 대상 품목으로 확정 등록</button></div></div>`;
    if (!needsSheet) redrawResults();
    redrawCart();
  }
  function redrawResults() {
    const p = preview, body = $('#contract-result-body');
    if (!alive(p) || !body) return;
    const matches = C.filterRows(p.rawItems, p.search);
    const shown = matches.slice(0, p.visibleLimit);
    const width = Math.max(1, p.colRoles.length);
    $('#contract-result-count').textContent = `검색 결과 ${matches.length}행 / 현재 시트 ${p.rawItems.length}행 · 표시 ${shown.length}행`;
    const allSelected = shown.length > 0 && shown.every(row => p.cart.has(row.id));
    $('#contract-result-head').innerHTML = `<tr><th class="contract-select-head"><input type="checkbox" id="contract-check-all" title="전체 선택/해제" aria-label="표시된 행 전체 선택/해제" ${allSelected ? 'checked' : ''} ${!shown.length || p.busy ? 'disabled' : ''}><span>선택</span></th>${Array.from({ length: width }, (_, index) => {
      const role = p.colRoles[index] || 'none';
      return `<th class="${role === 'hidden' ? 'col-hidden' : ''}"><span>${index + 1}열</span><select class="contract-col-role" data-col="${index}" aria-label="${index + 1}열 역할" ${p.busy ? 'disabled' : ''}>${[['none','일반'],['name','품명'],['spec','규격'],['unit','단위'],['target','수량'],['hidden','✕ 숨김']].map(([value, label]) => `<option value="${value}" ${role === value ? 'selected' : ''}>${label}</option>`).join('')}</select></th>`;
    }).join('')}</tr>`;
    const checkAll = $('#contract-check-all');
    checkAll.indeterminate = !allSelected && shown.some(row => p.cart.has(row.id));
    body.innerHTML = shown.map(row => `<tr><td class="contract-select-cell"><input class="contract-pick" type="checkbox" data-id="${esc(row.id)}" title="시공 관리 품목 선택 · ${esc(position(row))}" aria-label="시공 관리 품목 선택" ${p.cart.has(row.id) ? 'checked' : ''} ${p.busy ? 'disabled' : ''}></td>${Array.from({ length: width }, (_, index) => `<td class="${p.colRoles[index] === 'hidden' ? 'col-hidden' : ''}">${esc(row.cells[index] || '')}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${width + 1}" class="muted">검색 결과가 없습니다.</td></tr>`;
    const resetHidden = $('#contract-reset-hidden');
    resetHidden.disabled = p.busy || !p.colRoles.includes('hidden');
    const more = $('#contract-more'); more.hidden = shown.length >= matches.length; more.disabled = p.busy;
  }
  function redrawCart() {
    const p = preview, body = $('#contract-cart-body');
    if (!alive(p) || !body) return;
    body.innerHTML = [...p.cart.values()].map(({ row, name, target, unit }) => `<tr data-cart-id="${esc(row.id)}">
      <td class="contract-cart-name"><input class="contract-cart-input" data-field="name" aria-label="작업·자재명" title="원본 ${esc(position(row))}" value="${esc(name)}" ${p.busy ? 'disabled' : ''}></td>
       <td><input class="contract-cart-input" data-field="target" aria-label="등록 수량" inputmode="decimal" value="${esc(target)}" ${unitPrice(p.siteId) ? 'readonly' : ''} ${p.busy ? 'disabled' : ''}></td>
      <td><input class="contract-cart-input" data-field="unit" aria-label="등록 단위" value="${esc(unit)}" ${p.busy ? 'disabled' : ''}></td>
      <td><button class="btn tiny" data-action="contract-remove" data-id="${esc(row.id)}" ${p.busy ? 'disabled' : ''}>제외</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">선택한 품목이 없습니다.</td></tr>';
    $('#contract-cart-count').textContent = `${p.cart.size}개`;
    $('[data-action="contract-confirm"]').disabled = !p.cart.size || p.busy;
    $$('#contract-file, #contract-force-ocr, #contract-sheet, #contract-search, [data-action="contract-preview"]').forEach(element => {
      element.disabled = p.busy;
    });
  }
  async function confirmImport() {
    const p = preview;
    if (!alive(p) || p.busy) throw Error('현장 또는 파일이 바뀌었습니다. 파일을 다시 열어주세요.');
    const unit = unitPrice(p.siteId), items = C.validateCart(p.cart, unit);
    if (!confirm(`선택한 ${items.length}개 항목을 시공 관리 대상 품목으로 확정할까요? (현장의 기존 계약 내역이 이 목록으로 교체됩니다)`)) return;
    p.busy = true; redrawResults(); redrawCart();
    try {
      await DH.rpc(unit ? 'dh_import_unit_contract' : 'dh_import_contract', { p_site: p.siteId, p_items: items });
    } catch (error) {
      p.busy = false; redrawResults(); redrawCart(); throw error;
    }
    preview = null; sequence++;
    DH.toast(`${items.length}개 계약 내역을 등록했습니다.`);
    await DH.sites.reloadDetail(p.siteId);
  }

  DH.register({ name: '계약내역', order: 20, adminLoad: loadMetadata,
    sessionReset() { invalidate(); ctx().contractMetadata = {}; ctx().contractReviewState = 'idle'; },
    siteDetailSections: (c, site) => ({ order: 30, html: sectionHtml(site.id), mount: invalidate }) });
  DH.action('contract-preview', () => DH.act(openFile));
  DH.action('contract-confirm', () => DH.act(confirmImport));
  DH.action('contract-more', () => { if (preview && !preview.busy) { preview.visibleLimit += PAGE_SIZE; redrawResults(); } });
  DH.action('contract-reset-hidden', () => {
    const p = preview; if (!alive(p) || p.busy) return;
    p.colRoles.forEach((role, index) => { if (role === 'hidden') p.colRoles[index] = 'none'; });
    redrawResults();
  });
  DH.action('contract-remove', element => {
    if (!preview || preview.busy) return;
    preview.cart.delete(element.dataset.id); redrawResults(); redrawCart();
  });
  DH.action('contract-retry', () => DH.act(async () => {
    await loadMetadata(ctx()); DH.sites.detail(ctx().editId);
  }));
  DH.action('contract-item-save', element => DH.act(async () => {
    if (ctx().contractReviewState !== 'ready') throw Error('비고를 다시 불러온 후 저장하세요.');
    const row = element.closest('[data-contract-item]');
    const amount = C.quantity($('.dh-saved-quantity', row).value);
    const unit = $('.dh-saved-unit', row).value.trim(), note = $('.dh-saved-note', row).value;
    const isUnit = unitPrice(ctx().editId);
    if (amount === null || (isUnit ? amount !== 0 : amount <= 0) || !unit) throw Error('물량과 단위를 확인하세요.');
    const siteId = ctx().editId;
    if (isUnit) await DH.rpc('dh_admin_edit_unit_contract_item', { p_item: element.dataset.id, p_unit: unit, p_note: note });
    else await DH.rpc('dh_admin_edit_contract_reviewed', { p_item: element.dataset.id,
      p_target: amount, p_unit: unit, p_note: note });
    await DH.sites.reloadDetail(siteId); DH.toast('물량과 비고를 저장했습니다.');
  }));
  DH.action('contract-item-delete', element => DH.act(async () => {
    const item = ctx().data.contracts.find(row => row.id === element.dataset.id);
    if (!item || !confirm(`${item.name} 내역을 삭제할까요? 작업허가서에 사용된 기록은 보존됩니다.`)) return;
    const site = ctx().editId;
    await DH.rpc('dh_admin_delete_contract_item', { p_item: item.id });
    await DH.sites.reloadDetail(site);
  }));
  DH.action('contract-clear', element => DH.act(async () => {
    if (!confirm('기존 내역을 모두 삭제할까요? 작업 기록과 이전 검토 이력은 보존됩니다.')) return;
    await DH.rpc('dh_admin_clear_contract_items', { p_site: element.dataset.site });
    await DH.sites.reloadDetail(element.dataset.site);
  }));
  DH.action('contract-history', element => DH.act(async () => {
    const site = element.dataset.site;
    const rows = await DH.rpc('dh_contract_review_history', { p_site: site });
    if (ctx().editId !== site || !$('#contract-history')) return;
    $('#contract-history').innerHTML = rows.map(row => `<p>${esc(row.file_name)} · ${esc(row.created_at)} <button class="btn tiny" data-action="contract-history-export" data-id="${esc(row.id)}">원본·검토 JSON</button></p>`).join('') || '<p>이전 검토 이력이 없습니다.</p>';
  }));
  DH.action('contract-history-export', element => DH.act(async () => {
    download(await DH.rpc('dh_contract_review_document', { p_request: element.dataset.id }));
  }));
  DH.on('change', '#contract-file', element => {
    invalidate(); if ($('#contract-ocr-option')) $('#contract-ocr-option').hidden = !/\.pdf$/i.test(element.files[0]?.name || '');
  });
  DH.on('change', '#contract-force-ocr', invalidate);
  DH.on('change', '#contract-sheet', element => DH.act(async () => selectSheet(element.value)));
  DH.on('input', '#contract-search', element => {
    if (!preview) return;
    preview.search = element.value; preview.visibleLimit = PAGE_SIZE; redrawResults();
  });
  DH.on('change', '.contract-col-role', element => {
    const p = preview; if (!alive(p) || p.busy) return;
    changeRole(p, Number(element.dataset.col), element.value);
  });
  DH.on('change', '#contract-check-all', element => {
    const p = preview; if (!alive(p) || p.busy) return;
    const shown = C.filterRows(p.rawItems, p.search).slice(0, p.visibleLimit);
    for (const row of shown) {
      if (element.checked) {
        if (!p.cart.has(row.id)) p.cart.set(row.id, draftFor(p, row));
      } else p.cart.delete(row.id);
    }
    redrawResults(); redrawCart();
  });
  DH.on('change', '.contract-pick', element => {
    const p = preview; if (!alive(p) || p.busy) return;
    const row = p.rawItems.find(item => item.id === element.dataset.id);
    if (!row) return;
    if (element.checked) {
      if (!p.cart.has(row.id)) p.cart.set(row.id, draftFor(p, row));
    }
    else p.cart.delete(row.id);
    redrawResults(); redrawCart();
  });
  DH.on('input', '.contract-cart-input', element => {
    const p = preview; if (!alive(p) || p.busy) return;
    const draft = p.cart.get(element.closest('[data-cart-id]')?.dataset.cartId);
    if (draft && ['name', 'target', 'unit'].includes(element.dataset.field)) draft[element.dataset.field] = element.value;
  });
})();
