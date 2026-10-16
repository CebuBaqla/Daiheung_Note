/* =====================================================================
 * 모바일 공용 미디어 도구 — 현장공유·작업종료·도면이 함께 사용
 *  - 사진 촬영/앨범 선택, 자동 축소(최대 6장)
 *  - 펜 표시 · 영역 자르기 · 되돌리기 편집기
 *  - Storage 업로드 + dh_register_file 등록
 *  - 첨부 파일 표시(이미지 미리보기, PDF 보기)
 * ===================================================================== */
(function () {
  'use strict';
  const { $, $$, esc } = DH;
  const ctx = () => DH.ctx;
  const MAX_PHOTOS = 6;
  const objectUrls = new Map();
  let currentEditor = null;

  /* ---------- 파일 찾기 · 열기 ---------- */
  function fileById(id) {
    const d = ctx().data;
    for (const x of d?.drawings || []) if (x.file.id === id) return x.file;
    for (const p of d?.permits || []) {
      for (const x of p.drawings) if (x.file.id === id) return x.file;
      for (const f of p.report?.photos || []) if (f.id === id) return f;
    }
    for (const state of Object.values(ctx().workPhotoStates || {}))
      for (const pair of state.pairs || [])
        for (const file of [pair.before, pair.after]) if (file?.id === id) return file;
    for (const m of d?.messages || []) for (const f of m.files) if (f.id === id) return f;
    return null;
  }
  async function fileUrl(file) {
    if (!file) throw Error('파일 정보를 찾을 수 없습니다');
    if (!objectUrls.has(file.id)) objectUrls.set(file.id, URL.createObjectURL(await ctx().api.blob(file)));
    return objectUrls.get(file.id);
  }
  function hydrateImages() {
    for (const el of $$('img[data-file]')) {
      const file = fileById(el.dataset.file);
      if (file?.mime?.startsWith('image/'))
        fileUrl(file)
          .then((u) => el.isConnected && (el.src = u))
          .catch(() => {});
    }
  }
  async function viewFile(id) {
    const f = fileById(id);
    if (!f) return DH.toast('파일을 찾지 못했습니다');
    try {
      const u = await fileUrl(f);
      openDialog(
        esc(f.filename || '첨부 파일'),
        f.mime?.startsWith('image/')
          ? `<img class="drawing" src="${u}" alt="첨부 파일">`
          : `<iframe class="pdf-frame" src="${u}" title="도면 PDF"></iframe><p><a href="${u}" target="_blank" rel="noopener">PDF 별도 열기</a></p>`
      );
    } catch (e) {
      DH.toast(e.message);
    }
  }
  /** 패널 위에 한 겹 더 뜨는 대화상자. 닫으면 DOM에서 제거됩니다. */
  function openDialog(titleHtml, bodyHtml, { show = true } = {}) {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<div class="dialoghead row"><h2>${titleHtml}</h2><button data-close>닫기 ✕</button></div><div class="dialogbody">${bodyHtml}</div>`;
    document.body.append(dlg);
    dlg.querySelector('[data-close]').onclick = () => dlg.close();
    dlg.addEventListener('close', () => dlg.remove());
    if (show) dlg.showModal();
    hydrateImages();
    return dlg;
  }

  /* ---------- 사진 첨부 ---------- */
  const photoInputs = (kind) =>
    `<div class="grid2"><button type="button" data-action="photo-camera">📷 카메라 촬영</button><button type="button" data-action="photo-album">▧ 앨범 선택</button></div><input class="hidden photo-input" id="camera" data-kind="${kind}" type="file" accept="image/*" capture="environment"><input class="hidden photo-input" id="album" data-kind="${kind}" type="file" accept="image/*" multiple><p class="hint">최대 ${MAX_PHOTOS}장 · 전송 전 자동 축소 · 사진에 그리기와 되돌리기 가능</p><div id="photoList" class="photos" data-kind="${kind}"></div>`;
  async function compress(file) {
    const image = await createImageBitmap(file),
      scale = Math.min(1, 1400 / Math.max(image.width, image.height)),
      c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(image.width * scale));
    c.height = Math.max(1, Math.round(image.height * scale));
    c.getContext('2d').drawImage(image, 0, 0, c.width, c.height);
    image.close();
    return c.toDataURL('image/jpeg', 0.78);
  }
  async function addPhotos(input) {
    const kind = input.dataset.kind,
      photos = (ctx().draft[kind].photos ||= []);
    for (const f of [...input.files]) {
      if (photos.length >= MAX_PHOTOS) {
        DH.toast(`사진은 최대 ${MAX_PHOTOS}장까지 첨부할 수 있습니다.`);
        break;
      }
      photos.push({ src: await compress(f), serverId: null });
    }
    input.value = '';
    renderPhotos(kind);
    await DH.drafts.write();
  }
  function renderPhotos(kind) {
    const box = $('#photoList');
    if (!box) return;
    box.innerHTML = (ctx().draft[kind].photos || [])
      .map(
        (p, i) =>
          `<figure><img src="${p.src}" alt="첨부 사진 ${i + 1}"><button type="button" data-action="photo-edit" data-i="${i}">사진에 그리기 ✎</button><button type="button" data-action="photo-remove" data-i="${i}">삭제</button></figure>`
      )
      .join('');
  }

  /* ---------- 그림 편집기 ---------- */
  function openEditor(source, kind, onSave) {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<div class="dialoghead row"><h2>${kind === 'photo' ? '사진에 그리기' : '도면 표시'}</h2><button data-cancel>취소 ✕</button></div><div class="dialogbody"><p class="hint">손가락으로 표시하거나 영역을 선택해 자르세요.</p><div class="tools"><button data-mode="mark" class="primary">펜 표시</button><button data-mode="crop">영역 선택</button><button data-crop>선택 영역 자르기</button><button data-undo disabled>↶ 되돌리기</button><button data-reset>처음으로</button></div><canvas aria-label="그림 편집 영역"></canvas><div class="editor-actions"><button class="primary wide" data-save>표시한 ${kind === 'photo' ? '사진' : '도면'} 첨부</button></div></div>`;
    document.body.append(dlg);
    currentEditor = dlg;
    const canvas = dlg.querySelector('canvas'),
      g = canvas.getContext('2d'),
      history = [];
    let mode = 'mark',
      start = null,
      crop = null,
      cropPixels = null,
      pointer = null,
      initial = null;
    const coords = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) * canvas.width) / r.width, y: ((e.clientY - r.top) * canvas.height) / r.height };
    };
    const buttons = () => {
      dlg.querySelector('[data-undo]').disabled = !history.length;
      dlg.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('primary', b.dataset.mode === mode));
    };
    const restore = (src) =>
      new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => {
          canvas.width = im.width;
          canvas.height = im.height;
          g.drawImage(im, 0, 0);
          resolve();
        };
        im.onerror = reject;
        im.src = src;
      });
    const remember = () => {
      history.push(canvas.toDataURL('image/png'));
      if (history.length > 25) history.shift();
      buttons();
    };
    const dropCrop = () => {
      if (cropPixels) g.putImageData(cropPixels, 0, 0);
      crop = cropPixels = null;
    };
    const im = new Image();
    im.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(im.width, im.height));
      canvas.width = Math.max(1, Math.round(im.width * scale));
      canvas.height = Math.max(1, Math.round(im.height * scale));
      g.drawImage(im, 0, 0, canvas.width, canvas.height);
      initial = canvas.toDataURL('image/png');
      dlg.showModal();
    };
    im.onerror = () => {
      dlg.remove();
      currentEditor = null;
      DH.toast('이미지를 열 수 없습니다');
    };
    im.src = source;

    canvas.onpointerdown = (e) => {
      if (pointer !== null) return;
      pointer = e.pointerId;
      canvas.setPointerCapture(pointer);
      start = coords(e);
      if (mode === 'mark') {
        remember();
        Object.assign(g, { strokeStyle: '#dc352b', lineWidth: Math.max(4, canvas.width / 180), lineCap: 'round', lineJoin: 'round' });
        g.beginPath();
        g.moveTo(start.x, start.y);
        g.lineTo(start.x + 0.01, start.y + 0.01);
        g.stroke();
      } else {
        if (cropPixels) g.putImageData(cropPixels, 0, 0);
        cropPixels = g.getImageData(0, 0, canvas.width, canvas.height);
        crop = null;
      }
    };
    canvas.onpointermove = (e) => {
      if (pointer !== e.pointerId) return;
      const p = coords(e);
      if (mode === 'mark') {
        g.lineTo(p.x, p.y);
        g.stroke();
        return;
      }
      crop = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      g.putImageData(cropPixels, 0, 0);
      Object.assign(g, { fillStyle: '#1575c333', strokeStyle: '#1575c3', lineWidth: Math.max(2, canvas.width / 500) });
      g.fillRect(crop.x, crop.y, crop.w, crop.h);
      g.strokeRect(crop.x, crop.y, crop.w, crop.h);
    };
    canvas.onpointerup = canvas.onpointercancel = () => (pointer = null);
    dlg.querySelectorAll('[data-mode]').forEach(
      (b) =>
        (b.onclick = () => {
          dropCrop();
          mode = b.dataset.mode;
          buttons();
        })
    );
    dlg.querySelector('[data-crop]').onclick = () => {
      if (!crop || crop.w < 20 || crop.h < 20) return DH.toast('자를 영역을 먼저 선택해 주세요.');
      g.putImageData(cropPixels, 0, 0);
      remember();
      const out = document.createElement('canvas');
      out.width = Math.round(crop.w);
      out.height = Math.round(crop.h);
      out.getContext('2d').drawImage(canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, out.width, out.height);
      canvas.width = out.width;
      canvas.height = out.height;
      g.drawImage(out, 0, 0);
      crop = cropPixels = null;
      mode = 'mark';
      buttons();
    };
    dlg.querySelector('[data-undo]').onclick = () => {
      dropCrop();
      const old = history.pop();
      if (old) restore(old).then(buttons);
    };
    dlg.querySelector('[data-reset]').onclick = () => {
      dropCrop();
      remember();
      restore(initial).then(buttons);
    };
    dlg.querySelector('[data-cancel]').onclick = () => dlg.close();
    dlg.addEventListener('close', () => {
      currentEditor = null;
      dlg.remove();
    });
    dlg.querySelector('[data-save]').onclick = () =>
      DH.act(async () => {
        if (cropPixels) g.putImageData(cropPixels, 0, 0);
        await onSave(canvas.toDataURL('image/jpeg', 0.86));
        dlg.close();
        DH.toast('표시본을 저장했습니다');
      });
  }

  /* ---------- 업로드 ---------- */
  /** item = { src(dataURL), serverId } · 이미 올린 파일은 다시 올리지 않습니다(재시도 안전). */
  async function uploadData(siteId, item, kind, source = null, revision = null) {
    if (item.serverId) return item.serverId;
    const api = ctx().api,
      blob = await (await fetch(item.src)).blob(),
      ext = blob.type === 'image/png' ? 'png' : 'jpg';
    const path = `${siteId}/${api.session.user.id}/${crypto.randomUUID()}.${ext}`;
    await api.upload(path, blob, blob.type || 'image/jpeg');
    item.serverId = await DH.rpc('dh_register_file', {
      p_site: siteId,
      p_path: path,
      p_kind: kind,
      p_filename: kind === 'photo' ? '현장사진.' + ext : '도면표시본.' + ext,
      p_source: source,
      p_revision: revision,
    });
    await DH.drafts.write();
    return item.serverId;
  }

  /* ---------- 연결 ---------- */
  DH.action('photo-camera', () => $('#camera').click());
  DH.action('photo-album', () => $('#album').click());
  DH.on('change', '.photo-input', (input) => DH.act(() => addPhotos(input)));
  DH.action('photo-edit', (el) => {
    const kind = el.closest('#photoList').dataset.kind,
      entry = ctx().draft[kind].photos[Number(el.dataset.i)];
    if (!entry) return;
    openEditor(entry.src, 'photo', async (result) => {
      entry.src = result;
      entry.serverId = null;
      renderPhotos(kind);
      await DH.drafts.write();
    });
  });
  DH.action('photo-remove', (el) => {
    const kind = el.closest('#photoList').dataset.kind;
    ctx().draft[kind].photos.splice(Number(el.dataset.i), 1);
    renderPhotos(kind);
    DH.drafts.schedule();
  });
  DH.action('file-view', (el) => viewFile(el.dataset.id));

  DH.media = {
    fileById,
    fileUrl,
    hydrateImages,
    viewFile,
    openDialog,
    photoInputs,
    compressPhoto: compress,
    renderPhotos,
    openEditor,
    uploadData,
    editorOpen: () => !!currentEditor,
    revokeAll() {
      for (const u of objectUrls.values()) URL.revokeObjectURL(u);
      objectUrls.clear();
    },
  };
})();
