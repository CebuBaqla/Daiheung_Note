/* =====================================================================
 * 기능: 도면 (모바일)
 *  - 등록 도면 선택 → 원본 첨부 또는 크롭/그리기 표시본 만들기
 *  - PDF는 첫 페이지를 이미지로 바꿔 표시 (pdf.js는 필요할 때만 불러옴)
 * 데이터: dh_worker_snapshot.drawings
 * 사용처: 현장공유 폼 → DH.drawings.pick(siteId, onPicked)
 * ===================================================================== */
(function () {
  'use strict';
  const { esc } = DH;
  const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.6.205/build/';
  let pdfjs = null;

  async function loadPdfJs() {
    if (pdfjs) return pdfjs;
    try {
      pdfjs = await import(PDFJS + 'pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
      return pdfjs;
    } catch {
      throw Error('PDF 표시에 필요한 도구를 불러오지 못했습니다. 원본 도면을 첨부할 수 있습니다.');
    }
  }
  async function pdfFirstPage(url) {
    const lib = await loadPdfJs();
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const page = await (await lib.getDocument({ data: bytes }).promise).getPage(1);
    const view = page.getViewport({ scale: 1.7 }),
      c = document.createElement('canvas');
    c.width = Math.ceil(view.width);
    c.height = Math.ceil(view.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: view }).promise;
    return c.toDataURL('image/png');
  }

  /** onPicked({ drawingId, fileId, revisionId, title, src|null, serverId:null }) */
  function pick(siteId, onPicked) {
    const available = DH.ctx.data.drawings.filter((x) => x.site_id === siteId);
    if (!available.length) return DH.toast('이 현장에 등록된 도면이 없습니다.');
    const dlg = DH.media.openDialog(
      '등록 도면 선택',
      available
        .map((d) => {
          const pdf = d.file.mime === 'application/pdf';
          return `<div class="card task-card"><b>${d.number}번 · ${esc(d.title)}</b><p class="hint">${pdf ? 'PDF' : '이미지'} · 최신 파일</p>${
            d.file.mime.startsWith('image/') ? `<img class="file-preview" data-file="${d.file.id}" alt="${esc(d.title)}">` : ''
          }<div class="stack"><button data-attach="${d.id}">원본 도면 첨부</button><button class="primary" data-mark="${d.id}">${pdf ? 'PDF 첫 페이지 표시하기' : '크롭 / 그리기 / 되돌리기'}</button></div></div>`;
        })
        .join('')
    );
    const base = (d) => ({ drawingId: d.id, fileId: d.file.id, revisionId: d.revision_id, title: d.title, src: null, serverId: null });
    dlg.querySelectorAll('[data-attach]').forEach(
      (b) =>
        (b.onclick = () => {
          onPicked(base(available.find((x) => x.id === b.dataset.attach)));
          dlg.close();
        })
    );
    dlg.querySelectorAll('[data-mark]').forEach(
      (b) =>
        (b.onclick = () =>
          DH.act(async () => {
            const d = available.find((x) => x.id === b.dataset.mark),
              url = await DH.media.fileUrl(d.file);
            const source = d.file.mime === 'application/pdf' ? await pdfFirstPage(url) : url;
            dlg.close();
            DH.media.openEditor(source, 'drawing', async (result) => onPicked({ ...base(d), src: result }));
          }))
    );
  }

  DH.register({ name: '도면', order: 40 });
  DH.drawings = { pick, pdfFirstPage };
})();
