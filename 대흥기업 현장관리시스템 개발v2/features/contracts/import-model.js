/* 계약내역 가져오기: 파일의 텍스트 행만 보존하고 열의 의미는 추정하지 않습니다. */
(function () {
  'use strict';
  const C = DH.contracts = DH.contracts || {};
  const text = value => String(value ?? '').trim();
  const quantity = value => {
    if (typeof value === 'boolean' || !text(value)) return null;
    const number = Number(text(value).replace(/,/g, ''));
    return Number.isFinite(number) ? number : null;
  };

  function csv(value) {
    const rows = []; let row = [], cell = '', quoted = false, rowNumber = 1;
    value = value.replace(/^\uFEFF/, '');
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (ch === '"' && quoted && value[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { row.push(cell); cell = ''; }
      else if (/[\r\n]/.test(ch) && !quoted) {
        if (ch === '\r' && value[i + 1] === '\n') i++;
        row.push(cell); rows.push({ row: rowNumber++, cells: row }); row = []; cell = '';
      } else cell += ch;
    }
    if (quoted) throw Error('CSV의 따옴표가 닫히지 않았습니다. 파일을 확인하세요.');
    row.push(cell);
    if (row.some(text)) rows.push({ row: rowNumber, cells: row });
    return rows;
  }

  function jsonRows(obj) {
    if (Array.isArray(obj?.rawRows)) return obj.rawRows.map(row => ({ ...row, sheet: row.sheet || obj.source?.sheet }));
    if (Array.isArray(obj?.rawItems)) return obj.rawItems;
    const rows = Array.isArray(obj) ? obj : obj?.items;
    if (!Array.isArray(rows)) throw Error('JSON에는 행 배열이 필요합니다.');
    return rows.map((row, index) => {
      if (Array.isArray(row)) return { row: index + 1, cells: row };
      if (!row || typeof row !== 'object') throw Error('JSON 행 형식을 확인하세요.');
      return { row: row.rowIdx || row.row || index + 1,
        page: row.page || row.source?.page,
        sheet: row.sheet || row.source?.sheet,
        cells: row.cells || row.original?.cells || Object.values(row) };
    });
  }

  function rawItems(rows, prefix, source = {}) {
    if (!Array.isArray(rows)) throw Error('원본 행 목록을 읽지 못했습니다.');
    if (rows.length > 20000) throw Error('내역은 20,000행 이내로 나누어 주세요.');
    return rows.flatMap((row, index) => {
      if (!Array.isArray(row.cells)) throw Error('원본 셀 배열을 읽지 못했습니다.');
      const cells = row.cells.map(text);
      if (!cells.some(Boolean)) return [];
      const rowIdx = row.rowIdx || row.row || index + 1;
      const sheet = row.sheet || source.sheet || '';
      const page = row.page || null;
      return [{ id: `${prefix}${source.sheetId ? '-s' + source.sheetId : ''}${page ? '-p' + page : ''}-r${rowIdx}-i${index}`,
        rowIdx, rawText: cells.filter(Boolean).join(' '), cells,
        source: { sheet, page, row: rowIdx, ocr: !!row.ocr } }];
    });
  }

  function filterRows(rows, query) {
    const terms = text(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return rows;
    return rows.filter(row => {
      const content = row.rawText.toLocaleLowerCase();
      return terms.every(term => content.includes(term));
    });
  }

  function validateCart(cart, unitPrice = false) {
    if (!cart.size) throw Error('시공 관리 리스트에서 등록할 품목을 선택하세요.');
    return [...cart.values()].map(({ row, name, target, unit }) => {
      const amount = unitPrice ? 0 : quantity(target);
      if (!text(name) || !text(unit) || amount === null || amount <= 0 && !unitPrice)
        throw Error(`${row.source.page ? row.source.page + '쪽 ' : ''}${row.rowIdx}행의 품명·수량·단위를 확인하세요.`);
      return { code: row.id, name: text(name), unit: text(unit), target: amount, weight: 1 };
    });
  }

  Object.assign(C, { text, quantity, csv, jsonRows, rawItems, filterRows, validateCart });
})();
