/* =====================================================================
 * 기능: 현장공유 (모바일)
 *  - 모든 공유는 승인된 작업허가서 하나에 연결됩니다
 *  - 사진 · 등록 도면(표시본) · 메모 중 하나 이상
 *  - 다른 기능이 폼에 항목을 추가할 수 있는 훅 제공(상황발생 체크 등)
 *      shareFormFields(ctx, draft) → html     shareFormMount(ctx, draft)
 *      shareValidate(ctx, draft)  (throw)     sharePayload(ctx, draft) → {}
 *      shareDoneMessage(payload)  → '알림 문구'
 * RPC: dh_save_share, dh_post_share
 * ===================================================================== */
(function () {
  'use strict';
  const { $, esc } = DH;
  const ctx = () => DH.ctx;

  /** 현장공유는 현재 작업일의 승인된 허가서에만 게시합니다. */
  const sharablePermits = () => ctx().data.permits.filter((p) => p.work_date === DH.mobileDay() && !p.report?.submitted_at);

  function form() {
    const c = ctx(),
      d = c.draft.share,
      permits = sharablePermits();
    if (!permits.some((p) => p.id === d.permitId)) d.permitId = permits[0]?.id || null;
    DH.panel(
      '현장공유',
      `<p class="intro">사진, 도면, 메모 중 하나만 있어도<br>공유할 수 있습니다.</p><form id="shareForm"><label for="share-permit">연결할 작업허가서</label><select id="share-permit" required><option value="">작업허가서 선택</option>${permits
        .map((p) => `<option value="${p.id}" ${p.id === d.permitId ? 'selected' : ''}>${esc(p.work_date)} · ${esc(p.site_name)} · ${esc(p.location || '작업')}</option>`)
        .join('')}</select><p class="hint">모든 현장공유는 승인된 작업허가서 하나에 연결됩니다.</p><label>현장 사진 <small>(선택)</small></label>${DH.media.photoInputs('share')}<label>도면 <small>(선택)</small></label><button type="button" class="wide" data-action="share-pick-drawing">등록 도면 선택 / 표시하기</button><div id="drawingPreview"></div>${DH.collect('shareFormFields', c, d).join('')}<label>메모 <small>(선택)</small></label><textarea id="memo" placeholder="현장 상황을 적어 주세요.">${esc(d.memo)}</textarea>${
        permits.length ? '' : '<p class="hint">승인된 작업허가서가 있어야 현장공유를 올릴 수 있습니다.</p>'
      }<button class="primary wide submit" type="submit" ${permits.length ? '' : 'disabled'}>현장공유 전송</button></form>`
    );
    choosePermit(false);
    DH.media.renderPhotos('share');
    renderDrawing();
    DH.collect('shareFormMount', c, d);
    $('#memo').oninput = () => {
      d.memo = $('#memo').value;
      DH.drafts.schedule();
    };
    $('#shareForm').onsubmit = (e) => {
      e.preventDefault();
      DH.act(submit);
    };
  }
  function choosePermit(resetDrawing = true) {
    const d = ctx().draft.share,
      p = ctx().data.permits.find((x) => x.id === $('#share-permit').value);
    if (resetDrawing && d.siteId !== p?.site_id) d.drawing = null;
    d.permitId = p?.id || null;
    d.siteId = p?.site_id || null;
    renderDrawing();
    DH.drafts.schedule();
  }
  function renderDrawing() {
    const el = $('#drawingPreview'),
      dr = ctx().draft.share.drawing;
    if (!el) return;
    el.innerHTML = dr
      ? `<p class="hint">${esc(dr.title)} ${dr.src ? '· 표시본' : '· 원본 첨부'}</p>${dr.src ? `<img class="drawing" src="${dr.src}" alt="표시한 도면">` : ''}<button class="wide" type="button" data-action="share-remove-drawing">도면 첨부 취소</button>`
      : '';
  }

  async function submit() {
    const c = ctx(),
      d = c.draft.share,
      p = c.data.permits.find((x) => x.id === $('#share-permit')?.value);
    const memo = $('#memo').value.trim(),
      photos = d.photos || [],
      drawing = d.drawing;
    if (!p || !sharablePermits().some((x) => x.id === p.id)) throw Error('현재 작업일의 작업허가서를 선택하세요');
    if (!memo && !photos.length && !drawing) throw Error('사진, 도면, 메모 중 하나를 추가해 주세요');
    Object.assign(d, { permitId: p.id, siteId: p.site_id, memo });
    DH.collect('shareValidate', c, d);
    await DH.drafts.write();
    const files = [];
    for (const photo of photos) files.push(await DH.media.uploadData(p.site_id, photo, 'photo'));
    if (drawing) files.push(drawing.src ? await DH.media.uploadData(p.site_id, drawing, 'markup', drawing.fileId, drawing.revisionId) : drawing.fileId);
    d.messageId ||= crypto.randomUUID(); // 재시도해도 같은 공유로 저장됩니다.
    await DH.drafts.write();
    const payload = Object.assign({ id: d.messageId, site_id: p.site_id, permit_id: p.id, body: memo, files }, ...DH.collect('sharePayload', c, d));
    await DH.rpc('dh_save_share', { p_data: payload });
    await DH.rpc('dh_post_share', { p_id: d.messageId });
    c.draft.share = {};
    await DH.drafts.write();
    $('#panel').close();
    await DH.mobile.reload();
    DH.toast(DH.collect('shareDoneMessage', payload)[0] || '현장공유를 전송했습니다');
  }

  DH.kind('share', {
    label: () => '현장공유',
    summary: (x) => x.message.body || '첨부 자료를 공유했습니다.',
    detail(x) {
      const m = x.message,
        files = m.files || [];
      DH.panel(
        '현장공유 상세',
        `<article class="card"><span class="tag">현장공유</span><div class="site">${esc(x.permit?.site_name || DH.siteName(m.site_id))}</div><div class="meta">${esc(m.sender_name)} · ${DH.timeLabel(m.posted_at)}${x.permit ? ` · ${esc(x.permit.work_date)} 작업허가서` : ''}</div>${DH.chatReplyPreview(m.id)}<p>${esc(m.body || '')}</p>${filesHtml(files)}</article>`
      );
    },
  });
  /** 사진은 격자로, 그 밖의 파일은 열기 버튼으로 */
  function filesHtml(files) {
    return `<div class="photos">${files
      .filter((f) => f.mime?.startsWith('image/'))
      .map((f) => `<figure><img data-file="${f.id}" data-action="file-view" data-id="${f.id}" alt="첨부 사진"></figure>`)
      .join('')}</div>${files
      .filter((f) => !f.mime?.startsWith('image/'))
      .map((f) => `<button class="wide" data-action="file-view" data-id="${f.id}">${esc(f.filename)} 열기</button>`)
      .join('')}`;
  }

  DH.register({
    name: '현장공유',
    order: 60,
    async mobileLoad(c) {
      c.chatReplyReady = false;
      c.shareReplyLinks = {};
      const ids = c.data.messages.filter((m) => m.kind === 'share' && DH.workDay(m.posted_at) === c.workDay).map((m) => m.id);
      try {
        c.shareReplyLinks = ids.length ? await DH.rpc('dh_share_reply_links', { p_ids: ids }) : {};
        c.chatReplyReady = true;
      } catch (error) {
        if (!(error.status === 404 || error.code === 'PGRST202')) throw error;
      }
    },
    // 공유 메시지에 연결된 허가서를 붙입니다(연결 정보는 상황발생 기능이 불러오는 스냅샷에 포함).
    timelineItems(items, c) {
      const links = c.data.situationData?.share_links || [];
      return items.map((x) => {
        if (x.type !== 'share') return x;
        const link = links.find((l) => l.message_id === x.id);
        return link ? { ...x, permit: c.data.permits.find((p) => p.id === link.permit_id) || x.permit } : x;
      });
    },
    mobileNav: { order: 20, label: '현장공유 ＋', action: 'share-new', primary: true },
  });

  DH.action('share-new', form);
  DH.on('change', '#share-permit', () => choosePermit(true));
  DH.action('share-pick-drawing', () => {
    const siteId = ctx().draft.share.siteId;
    if (!siteId) return DH.toast('작업허가서를 먼저 선택하세요.');
    if (!DH.drawings) return DH.toast('도면 기능을 불러오지 못했습니다. 페이지를 다시 열어 주세요.');
    DH.drawings.pick(siteId, async (picked) => {
      ctx().draft.share.drawing = picked;
      renderDrawing();
      await DH.drafts.write();
    });
  });
  DH.action('share-remove-drawing', () => {
    ctx().draft.share.drawing = null;
    renderDrawing();
    DH.drafts.schedule();
  });

  DH.share = { form, filesHtml };
})();
