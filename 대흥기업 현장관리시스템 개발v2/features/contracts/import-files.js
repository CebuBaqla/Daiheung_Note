/* 파일을 공통 행 모델로 변환합니다. PDF/OCR는 브라우저 안에서 처리합니다. */
(function () {
  'use strict';
  const C = DH.contracts;
  const PDF_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.6.205/';
  let pdfLibrary, ocrLibrary, xlsLibrary;
  function excelValue(cell) {
    const v = cell?.value;
    if (v && typeof v === 'object') {
      if ('result' in v) return v.result;
      if ('richText' in v) return v.richText.map(p => p.text).join('');
      if ('text' in v) return v.text;
      return ''; // 계산 결과가 없는 수식은 임의로 계산하지 않습니다.
    }
    return v ?? '';
  }
  async function fingerprint(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('');
  }
  function sheetRows(sheet) {
    if (sheet.rowCount > 20000 || sheet.columnCount > 300) throw Error('내역 시트는 20,000행·300열 이내로 나누어 주세요.');
    return Array.from({ length: sheet.rowCount }, (_, n) => {
      const excelRow = sheet.getRow(n + 1);
      return { row: n + 1,
      cells: Array.from({ length: excelRow.cellCount }, (_, c) => {
        const cell = excelRow.getCell(c + 1);
        // 병합 영역은 시작 셀만 읽어 제목을 여러 열/행에 중복시키지 않습니다.
        return cell.isMerged && cell.master.address !== cell.address ? '' : excelValue(cell);
      }) };
    });
  }
  function legacyWorkbook(bytes, lib) {
    const source = lib.read(new Uint8Array(bytes), { type: 'array', cellDates: false });
    const worksheets = source.SheetNames.map((name, index) => {
      const sheet = source.Sheets[name], populated = new Map();
      let rowCount = 0, columnCount = 0;
      for (const [address, cell] of Object.entries(sheet)) {
        if (address[0] === '!' || cell?.v === undefined || cell.v === null) continue;
        const { r, c } = lib.utils.decode_cell(address);
        rowCount = Math.max(rowCount, r + 1);
        columnCount = Math.max(columnCount, c + 1);
        populated.set(r, Math.max(populated.get(r) || 0, c + 1));
      }
      return { id: index + 1, name, rowCount, columnCount,
        getRow(number) {
          const r = number - 1;
          return { cellCount: populated.get(r) || 0,
            getCell(column) {
              const cell = sheet[lib.utils.encode_cell({ r, c: column - 1 })];
              return { value: cell?.t === 'e' ? (cell.w || '#오류') : cell?.v ?? '' };
            } };
        } };
    });
    return { worksheets, getWorksheet(id) { return worksheets[Number(id) - 1]; } };
  }
  function linesFromTokens(tokens) {
    const lines = [];
    for (const token of tokens.filter(t => C.text(t.text)).sort((a, b) => a.y - b.y || a.x - b.x)) {
      let line = lines.find(l => Math.abs(l.y - token.y) <= Math.max(2, Math.max(l.height, token.height) * .4));
      if (!line) { line = { y: token.y, height: token.height, tokens: [] }; lines.push(line); }
      line.tokens.push(token);
    }
    return lines.sort((a, b) => a.y - b.y).map(l => l.tokens.sort((a, b) => a.x - b.x));
  }
  // GS 사내 견적서는 칸 너비가 고정되어 있습니다. 빈 규격 칸도 유지해야
  // 뒤의 수량·단위·단가·금액이 왼쪽으로 당겨지지 않습니다.
  function roadEstimateLayout(pages) {
    const first = pages[0];
    if (!first?.width || Math.abs(first.width - 595.22) > 4 || first.ocr) return null;
    const quantity = first.tokens.find(token => C.text(token.text).replace(/\s/g, '') === '數量' &&
      Math.abs(token.x - 263.6) < 10);
    if (!quantity) return null;
    const header = first.tokens.filter(token => Math.abs(token.y - quantity.y) < 8);
    const at = (label, expectedX) => header.some(token =>
      C.text(token.text).replace(/\s/g, '') === label && Math.abs(token.x - expectedX) < 10);
    if (!at('規', 166.4) || !at('數量', 263.6) || !at('單位', 311.2) || !at('備考', 539.3)) return null;
    return { headerY: quantity.y, stops: [135.4, 248.5, 297.5, 343.5, 436.4, 528.5] };
  }
  function roadEstimateRows(pages, layout) {
    const rows = [];
    for (const page of pages) {
      if (!page.width || Math.abs(page.width - pages[0].width) > 4)
        throw Error('견적서의 쪽마다 표 너비가 달라 원본 칸을 확인해야 합니다.');
      const scale = page.width / 595.22;
      for (const [index, tokens] of linesFromTokens(page.tokens).entries()) {
        const cells = Array(7).fill('');
        if (page === pages[0] && tokens[0].y < layout.headerY - 8) {
          // 견적서 제목과 발주·회사 정보도 원문 행으로 남깁니다.
          cells[0] = tokens.map(token => C.text(token.text)).join(' ');
          rows.push({ row: index + 1, page: page.page, cells, ocr: page.ocr });
          continue;
        }
        for (const token of tokens) {
          if (token.x < 18 * scale || token.x > 575 * scale) continue;
          const column = layout.stops.findIndex(stop => token.x < stop * scale);
          const i = column < 0 ? 6 : column;
          cells[i] += (cells[i] ? ' ' : '') + C.text(token.text);
        }
        if (cells.some(Boolean)) rows.push({ row: index + 1, page: page.page, cells, ocr: page.ocr });
      }
    }
    return rows;
  }
  function pdfRows(pages) {
    const estimate = roadEstimateLayout(pages);
    if (estimate) return roadEstimateRows(pages, estimate);
    const rows = [];
    for (const page of pages) {
      for (const [index, tokens] of linesFromTokens(page.tokens).entries()) {
        // PDF 텍스트 조각은 원래 순서대로만 보존합니다. 표의 열은 추정하지 않습니다.
        rows.push({ row: index + 1, page: page.page,
          cells: tokens.map(token => token.text), ocr: page.ocr });
      }
    }
    return rows;
  }
  async function loadPdf() {
    if (!pdfLibrary) pdfLibrary = (async () => {
      const lib = await import(PDF_BASE + 'build/pdf.mjs');
      // 로컬 HTML(file://)에서도 동작하도록 동일 버전 worker를 직접 로드합니다.
      globalThis.pdfjsWorker = await import(PDF_BASE + 'build/pdf.worker.mjs');
      lib.GlobalWorkerOptions.workerSrc = PDF_BASE + 'build/pdf.worker.mjs';
      return lib;
    })().catch(e => { pdfLibrary = null; throw Error('PDF 읽기 도구를 불러오지 못했습니다. 인터넷 연결을 확인하세요. ' + e.message); });
    return pdfLibrary;
  }
  async function loadOcr() {
    if (!ocrLibrary) ocrLibrary = new Promise((resolve, reject) => {
      if (globalThis.Tesseract) return resolve(globalThis.Tesseract);
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
      script.onload = () => resolve(globalThis.Tesseract);
      script.onerror = () => { ocrLibrary = null; script.remove(); reject(Error('스캔 문자 인식 도구를 불러오지 못했습니다. 인터넷 연결을 확인하세요.')); };
      document.head.appendChild(script);
    });
    return ocrLibrary;
  }
  async function loadXls() {
    if (globalThis.XLSX?.read) return globalThis.XLSX;
    if (!xlsLibrary) xlsLibrary = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('../features/contracts/xlsx.min.js', document.baseURI).href;
      script.onload = () => {
        if (globalThis.XLSX?.read) resolve(globalThis.XLSX);
        else { xlsLibrary = null; reject(Error('XLS 읽기 도구를 시작하지 못했습니다.')); }
      };
      script.onerror = () => { xlsLibrary = null; script.remove(); reject(Error('XLS 읽기 도구를 불러오지 못했습니다.')); };
      document.head.appendChild(script);
    });
    return xlsLibrary;
  }
  async function readPdf(bytes, report, cancelled, forceOcr) {
    const lib = await loadPdf();
    const pdf = await lib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false,
      cMapUrl: PDF_BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDF_BASE + 'standard_fonts/',
      wasmUrl: PDF_BASE + 'wasm/' }).promise;
    let worker, roadEstimate = false; const pages = [];
    try {
      if (pdf.numPages > 100) throw Error('PDF는 100쪽 이내로 나누어 주세요.');
      for (let p = 1; p <= pdf.numPages; p++) {
        if (cancelled()) throw Error('파일 읽기를 취소했습니다.');
        report(`PDF ${p}/${pdf.numPages}쪽 읽는 중`);
        const page = await pdf.getPage(p), viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        let tokens = content.items.filter(t => t.str?.trim()).map(t => ({ text: t.str,
          x: t.transform[4], y: viewport.height - t.transform[5], width: t.width, height: t.height || 10 }));
        if (p === 1) roadEstimate = !!roadEstimateLayout([{ page: p, width: viewport.width, tokens, ocr: false }]);
        let ocr = false;
        // 이 견적서는 PDF 글자와 칸 위치가 살아 있으므로 OCR 선택 여부와 관계없이 원문을 사용합니다.
        if (!tokens.length || (forceOcr && !roadEstimate)) {
          report(`PDF ${p}/${pdf.numPages}쪽 스캔 문자 인식 중 (첫 실행은 시간이 걸립니다)`);
          if (!worker) { const engine = await loadOcr(); worker = await engine.createWorker(['kor', 'eng']); }
          const scaled = page.getViewport({ scale: 2 }), canvas = document.createElement('canvas');
          canvas.width = Math.ceil(scaled.width); canvas.height = Math.ceil(scaled.height);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaled }).promise;
          const { data } = await worker.recognize(canvas, {}, { tsv: true });
          tokens = (data.tsv || '').split('\n').slice(1).map(line => line.split('\t')).filter(v => v[0] === '5' && v[11]?.trim())
            .map(v => ({ text: v.slice(11).join('\t'), x: Number(v[6]) / 2, y: (Number(v[7]) + Number(v[9])) / 2,
              width: Number(v[8]) / 2, height: Number(v[9]) / 2 }));
          canvas.width = canvas.height = 0; ocr = true;
        }
        // 읽지 못한 쪽도 표에 표시하여 조용히 누락시키지 않습니다.
        if (!tokens.length) tokens = [{ text: `[${p}쪽 내용을 읽지 못했습니다. 원본 확인 필요]`, x: 0, y: 0, width: 1, height: 10 }];
        pages.push({ page: p, width: viewport.width, tokens, ocr }); page.cleanup();
      }
      return pdfRows(pages);
    } finally { if (worker) await worker.terminate(); await pdf.destroy(); }
  }
  async function openFile(file, report = () => {}, cancelled = () => false, options = {}) {
    if (!/\.(xlsx|xls|csv|json|pdf)$/i.test(file.name)) throw Error('XLSX, XLS, CSV, JSON, PDF 파일을 선택하세요.');
    if (file.size > 25 * 1024 * 1024) throw Error('파일은 25MB 이내로 나누어 주세요.');
    const bytes = await file.arrayBuffer(), hash = await fingerprint(bytes);
    const source = { fileName: file.name, sha256: hash, size: file.size };
    const prefix = 'R' + hash.slice(0, 12);
    if (/\.xlsx$/i.test(file.name)) {
      if (!globalThis.ExcelJS) throw Error('엑셀 읽기 도구를 불러오지 못했습니다. 인터넷 연결을 확인하세요.');
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes);
      return { source, prefix, workbook, sheets: workbook.worksheets.map(s => ({ id: String(s.id), name: s.name })) };
    }
    if (/\.xls$/i.test(file.name)) {
      const workbook = legacyWorkbook(bytes, await loadXls());
      return { source, prefix, workbook, sheets: workbook.worksheets.map(s => ({ id: String(s.id), name: s.name })) };
    }
    const rawRows = /\.pdf$/i.test(file.name)
      ? await readPdf(bytes, report, cancelled, options.forceOcr)
      : /\.json$/i.test(file.name)
        ? C.jsonRows(JSON.parse(new TextDecoder().decode(bytes)))
        : C.csv(new TextDecoder().decode(bytes));
    return { source, prefix, sheets: [], rawItems: C.rawItems(rawRows, prefix) };
  }
  Object.assign(C, { excelValue, sheetRows, pdfRows, openFile });
})();
