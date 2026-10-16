/* =====================================================================
 * 기능: 도면 (관리자 · 현장 상세 모달 안의 섹션)
 *  - 여러 파일 한 번에 등록, 파일마다 번호/제목 지정
 *  - 같은 번호로 등록하면 새 버전으로 교체
 *  - 실패 시 다시 누르면 실패한 파일부터 재시도
 * RPC: dh_register_file, dh_replace_drawing   Storage: dh-field-files
 * ===================================================================== */
(function () {
  'use strict';
  const { $, $$, esc } = DH;
  const ctx = () => DH.ctx;
  const MAX_BYTES = 20 * 1024 * 1024;
  const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
  const extOf = (file) => file.name.split('.').pop().toLowerCase();
  const typeOf = (file) => MIME[extOf(file)] || null;
  let batch = [];

  function sectionHtml(siteId) {
    const drawings = ctx().data.drawings.filter((d) => d.site_id === siteId);
    return `<h3 class="section">현장 도면</h3>${
      drawings.length ? drawings.map((d) => `<p>${d.drawing_number}번 · ${esc(d.title)} ${d.file ? '(등록됨)' : ''}</p>`).join('') : '<p class="muted">등록 도면 없음</p>'
    }<label class="field">도면 파일 여러 개 선택 · 파일당 최대 20MB<input id="drawing-file" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif"></label><p class="small muted">선택한 파일마다 도면 번호와 제목을 수정할 수 있습니다. 기존 번호를 쓰면 새 버전으로 등록됩니다.</p><div id="dh-drawing-rows"></div><p id="dh-drawing-progress" class="small muted"></p><button class="btn tiny" data-action="drawing-upload">도면 등록 · 새 버전으로 교체</button>`;
  }

  function prepare(input) {
    const files = [...input.files],
      existing = ctx().data.drawings.filter((x) => x.site_id === ctx().editId);
    const start = Math.max(0, ...existing.map((x) => Number(x.drawing_number) || 0)) + 1;
    batch = files.map((file, i) => ({ file, number: start + i, title: file.name.replace(/\.[^.]+$/, '').trim(), done: false }));
    $('#dh-drawing-rows').innerHTML = batch
      .map(
        (e, i) => `<div class="row dh-drawing-row" data-index="${i}" style="align-items:end;flex-wrap:wrap;border-bottom:1px solid #e3e8ef;padding:8px 0">
    <label class="field" style="width:90px">번호<input class="dh-drawing-number" type="number" min="1" step="1" value="${e.number}"></label>
    <label class="field" style="min-width:170px;flex:1">제목<input class="dh-drawing-title" value="${esc(e.title)}"></label>
    <span class="small muted" style="min-width:140px">${esc(e.file.name)}<br><span class="dh-drawing-status">등록 대기</span></span></div>`
      )
      .join('');
    $('#dh-drawing-progress').textContent = files.length ? `${files.length}개 선택 · 번호와 제목을 확인한 뒤 등록하세요.` : '도면 파일을 선택하세요.';
  }

  async function upload() {
    const siteId = ctx().editId,
      rows = $$('.dh-drawing-row');
    if (!batch.length) throw Error('도면 파일을 선택하세요');
    const numbers = new Set();
    batch.forEach((entry, i) => {
      const number = Number($('.dh-drawing-number', rows[i]).value),
        title = $('.dh-drawing-title', rows[i]).value.trim();
      if (!Number.isSafeInteger(number) || number < 1) throw Error(`${i + 1}번째 도면 번호를 확인하세요`);
      if (numbers.has(number)) throw Error(`도면 번호 ${number}가 선택한 파일 안에서 중복됩니다`);
      if (!title) throw Error(`${i + 1}번째 도면 제목을 입력하세요`);
      if (!typeOf(entry.file)) throw Error(`${entry.file.name}: PDF·JPG·PNG·WebP·HEIC 파일만 등록할 수 있습니다`);
      if (entry.file.size > MAX_BYTES) throw Error(`${entry.file.name}: 파일당 20MB를 넘을 수 없습니다`);
      numbers.add(number);
      Object.assign(entry, { number, title });
    });
    const progress = $('#dh-drawing-progress'),
      total = batch.length,
      api = ctx().api;
    for (let i = 0; i < total; i++) {
      const entry = batch[i],
        status = $('.dh-drawing-status', rows[i]);
      if (entry.done) continue;
      try {
        progress.textContent = `${total}개 중 ${i + 1}번째 등록 중 · ${entry.file.name}`;
        status.textContent = '업로드 중';
        // Storage 키는 ASCII로 유지하고, 한글 원본 파일명은 file_asset.filename에 남깁니다.
        entry.path ||= `${siteId}/${api.session.user.id}/${crypto.randomUUID()}.${extOf(entry.file)}`;
        if (!entry.uploaded) {
          await api.upload(entry.path, entry.file, typeOf(entry.file));
          entry.uploaded = true;
        }
        entry.fileId ||= await DH.rpc('dh_register_file', { p_site: siteId, p_path: entry.path, p_kind: 'drawing', p_filename: entry.file.name });
        await DH.rpc('dh_replace_drawing', { p_site: siteId, p_number: entry.number, p_title: entry.title, p_file: entry.fileId });
        entry.done = true;
        status.textContent = '등록 완료';
        $$('input', rows[i]).forEach((x) => (x.disabled = true));
      } catch (error) {
        status.textContent = '오류 · 다시 누르면 이 파일부터 재시도';
        progress.textContent = `${batch.filter((x) => x.done).length}/${total}개 완료`;
        throw Error(`${i + 1}번째 도면(${entry.file.name}) 등록 실패: ${error.message}`);
      }
    }
    await DH.sites.reloadDetail(siteId);
    DH.toast(`도면 ${total}개를 등록했습니다`);
  }

  DH.register({
    name: '도면',
    order: 40,
    siteDetailSections: (c, s) => ({ order: 40, html: sectionHtml(s.id), mount: () => (batch = []) }),
  });
  DH.action('drawing-upload', () => DH.act(upload));
  DH.on('change', '#drawing-file', prepare);
})();
