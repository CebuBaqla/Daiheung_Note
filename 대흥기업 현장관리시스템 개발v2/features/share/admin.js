/* =====================================================================
 * 기능: 현장공유 (관리자) — 최근 현장공유와 날짜별 채팅
 * RPC: dh_admin_field_messages (최근 14일), dh_admin_day_chat (선택한 작업일)
 * ===================================================================== */
(function () {
  'use strict';
  const { $, esc } = DH;
  const urls = new Map();
  let activeDayChat = null;

  function panel(c) {
    const all = c.fieldMessages || [],
      list = all.slice(0, 8);
    return `<section class="card"><h2>최근 현장공유 <span class="pill">${all.length}</span></h2><div class="list">${
      list.length
        ? list
            .map(
              (m) =>
                `<button class="item" data-action="share-detail" data-id="${m.id}"><b>${esc(m.site_name)}</b><small>${esc(m.sender_name)} · ${new Date(m.posted_at).toLocaleString('ko-KR')} · ${m.files.length}개 첨부</small><small>${esc((m.body || '첨부 자료 공유').slice(0, 60))}</small></button>`
            )
            .join('')
        : '<div class="empty">최근 현장공유가 없습니다.</div>'
    }</div></section>`;
  }

  /** 첨부 파일 영역(이미지 미리보기 + 내려받기). 상황발생 상세에서도 재사용합니다. */
  function filesHtml(files) {
    return files
      .map((f) =>
        f.mime?.startsWith('image/')
          ? `<div class="card body"><img data-share-file="${f.id}" style="width:100%;max-height:500px;object-fit:contain" alt="${esc(f.filename)}"><p class="small">${esc(f.filename)}</p></div>`
          : `<p><a data-share-file="${f.id}" download="${esc(f.filename)}">${esc(f.filename)} 내려받기</a></p>`
      )
      .join('');
  }
  function hydrateFiles(files) {
    files.forEach(async (f) => {
      try {
        let u = urls.get(f.id);
        if (!u) {
          u = URL.createObjectURL(await DH.ctx.api.blob(f));
          urls.set(f.id, u);
        }
        const el = $(`#overlay [data-share-file="${f.id}"]`);
        if (el) el.tagName === 'IMG' ? (el.src = u) : (el.href = u);
      } catch {
        DH.toast('첨부 파일을 열지 못했습니다');
      }
    });
  }

  function detail(id) {
    const m = (DH.ctx.fieldMessages || []).find((x) => x.id === id);
    if (!m) return;
    DH.ctx.modalType = 'share';
    DH.ui.open(
      '현장공유 상세',
      `<p><b>${esc(m.site_name)}</b> · ${esc(m.sender_name)} · ${new Date(m.posted_at).toLocaleString('ko-KR')}</p><p style="white-space:pre-wrap">${esc(m.body || '메모 없음')}</p>${filesHtml(m.files)}`
    );
    hydrateFiles(m.files);
  }

  function dayChatHtml(messages) {
    if (!messages.length) return '<div class="empty">이 작업일에 남긴 채팅이 없습니다.</div>';
    return messages.map((m) => {
      const files = Array.isArray(m.files) ? m.files : [];
      const replyText = m.reply_to_body?.trim() || (m.reply_to_has_photo ? '📷 사진' : '첨부 자료');
      return `<article class="day-chat-message"><div class="day-chat-meta"><b>${esc(m.sender_name)}</b><time datetime="${esc(m.posted_at)}">${esc(DH.timeLabel(m.posted_at))}</time>${m.is_situation ? '<span class="day-chat-situation">🚩 상황발생</span>' : ''}</div>` +
        `<p class="day-chat-site">${esc(m.site_name)}${m.location ? ` · ${esc(m.location)}` : ''}</p>` +
        (m.reply_to_id ? `<div class="day-chat-reply">↪ ${esc(m.reply_to_sender || '이전 글')} · ${esc(replyText.slice(0, 120))}</div>` : '') +
        (m.body ? `<p class="day-chat-text">${esc(m.body)}</p>` : '') +
        filesHtml(files) + '</article>';
    }).join('');
  }

  async function loadDayChat(session) {
    if (!session || session.stopped || session.loading) return;
    const currentRoot = () => $('#overlay .day-chat');
    const root = currentRoot();
    if (!root || root.dataset.dayChatDate !== session.date) return;
    session.loading = true;
    if (!session.loaded) $('.day-chat-status', root).textContent = '채팅을 불러오는 중...';
    try {
      const result = await DH.rpc('dh_admin_day_chat', { p_day: session.date });
      if (session.stopped || activeDayChat !== session) return;
      const visible = currentRoot();
      if (!visible || visible.dataset.dayChatDate !== session.date) return;
      if (!Array.isArray(result)) throw Error('채팅 조회 결과를 확인하지 못했습니다');
      const signature = JSON.stringify(result);
      if (signature !== session.signature) {
        $('.day-chat-messages', visible).innerHTML = dayChatHtml(result);
        hydrateFiles(result.flatMap((m) => Array.isArray(m.files) ? m.files : []));
        session.signature = signature;
      }
      session.loaded = true;
      $('.day-chat-status', visible).textContent = `${result.length}건 · ${DH.timeLabel(new Date())}에 확인`;
    } catch (error) {
      if (session.stopped || activeDayChat !== session) return;
      if (error.authRequired) return DH.onAuthRequired?.();
      const visible = currentRoot();
      if (!visible || visible.dataset.dayChatDate !== session.date) return;
      $('.day-chat-status', visible).textContent =
        error.status === 404 || error.code === 'PGRST202'
          ? '날짜별 채팅 SQL을 Supabase에 적용해야 합니다.'
          : `채팅을 불러오지 못했습니다: ${error.message}`;
    } finally {
      session.loading = false;
    }
  }

  function stopDayChat(session) {
    session.stopped = true;
    clearInterval(session.timer);
    if (activeDayChat === session) activeDayChat = null;
  }

  function mountDayChat(date) {
    if (activeDayChat) stopDayChat(activeDayChat);
    const session = { date, stopped: false, loading: false, loaded: false, signature: null, timer: null };
    activeDayChat = session;
    void loadDayChat(session);
    if (date === DH.workDay()) session.timer = setInterval(() => {
      if (date !== DH.workDay()) {
        clearInterval(session.timer);
        session.timer = null;
        const root = $('#overlay .day-chat');
        if (root?.dataset.dayChatDate === date) {
          $('.day-chat-head h3', root).textContent = '그날의 채팅';
          $('.day-chat-status', root).textContent = '작업일이 바뀌었습니다. 새 날짜를 선택하면 현재 채팅을 볼 수 있습니다.';
        }
        return;
      }
      void loadDayChat(session);
    }, 15000);
    return () => stopDayChat(session);
  }

  DH.register({
    name: '현장공유',
    order: 60,
    sessionReset() {
      if (activeDayChat) stopDayChat(activeDayChat);
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
    async adminLoad(c) {
      const today = DH.today();
      c.fieldMessages = [];
      c.fieldMessages = await DH.rpc('dh_admin_field_messages', { p_from: DH.addDay(today, -14), p_to: today });
    },
    dashboardPanels: (c) => ({ slot: 'left', order: 40, html: panel(c) }),
  });
  DH.action('share-detail', (el) => detail(el.dataset.id));
  DH.action('day-chat-refresh', () => void loadDayChat(activeDayChat));
  DH.share = { filesHtml, hydrateFiles, mountDayChat };
})();
