/* =====================================================================
 * 모바일 현장노트 셸: 로그인 · 타임라인(메신저) · 하단 메뉴 · 전체화면 패널 · 임시저장
 * 실제 내용은 features/<기능>/mobile.js 가 훅으로 채웁니다.
 *
 * 모바일 훅 (DH.register 객체에 넣는 이름)
 *   mobileLoad(ctx)            async · 새로고침 때 기능별 데이터 불러오기
 *   mobileGate(ctx)            true를 돌려주면 타임라인 대신 그 화면을 보여줌(출근 확인)
 *   timelineItems(items, ctx)  타임라인 항목 가공(연결 허가서 붙이기, 오늘 작업 추가 등)
 *   itemLabel(item, ctx)       말풍선 위 종류 글자 덮어쓰기(🚩 상황발생 등)
 *   mobileDetail(item, ctx)    true를 돌려주면 기본 상세 대신 그 화면 사용
 *   timelineBanners(ctx)       타임라인 상단 안내 버튼 html
 *   mobileNav(ctx)             [{ order, label, action, primary }] 하단 메뉴
 *
 * 메시지 종류는 DH.kind('permit' | 'share' | 'completion', { ... })로 등록합니다.
 * ===================================================================== */
(function () {
  'use strict';
  const { $, esc } = DH;
  const api = DH.createApi({ configKey: 'dh_worker_config_v1', sessionKey: 'dh_worker_session_v1' });
  const ctx = (DH.ctx = { app: 'mobile', api, profile: null, data: null, workDay: null, view: 'login', draft: { share: {}, report: {}, chat: {} } });
  DH.rpc = (...args) => api.rpc(...args);
  DH.mobileDay = () => ctx.workDay || DH.workDay();

  /* ---------- 메시지 종류 등록 ---------- */
  DH.kinds = {};
  /** def: { label(item), summary(item), detail(item), site?, sender?, time?, foot?, photo? } */
  DH.kind = (name, def) => (DH.kinds[name] = def);

  /* ---------- 데이터 ---------- */
  async function reload() {
    const state = await api.rpc('dh_worker_day_state');
    const today = state.work_date;
    if (ctx.workDay && ctx.workDay !== today) expireCurrentDay();
    const [profile, data] = await Promise.all([
      api.rpc('dh_my_profile'),
      api.rpc('dh_worker_snapshot', { p_from: DH.addDay(today, -14), p_to: DH.addDay(today, 7) }),
    ]);
    const latestState = await api.rpc('dh_worker_day_state');
    if (latestState.work_date !== today) return reload();
    if (!profile) throw Object.assign(Error('등록된 계정으로 다시 로그인해 주세요.'), { authRequired: true });
    ctx.profile = profile;
    ctx.data = data;
    ctx.workDay = today;
    ctx.data.attendance = state.attendance;
    await DH.loadAll('mobileLoad', ctx);
    await drafts.load();
    render();
    scheduleDayChange(state.ms_until_change);
  }
  DH.siteName = (id) => ctx.data?.sites.find((s) => s.id === id)?.name || '현장';

  /* ---------- 공통 화면 조각 ---------- */
  DH.header = () =>
    `<header><div class="row"><div class="brand"><span>DAEHEUNG · FIELD NOTE</span>대흥기업 현장노트</div><span class="tag">${ctx.data ? 'DB 연결됨' : '로그인 필요'}</span></div></header>`;

  function render() {
    if (!api.session || !ctx.data) return loginView();
    if (DH.first('mobileGate', ctx)) return;
    timelineView();
  }
  function loginView() {
    ctx.view = 'login';
    $('#app').innerHTML =
      DH.header() +
      `<div class="welcome"><span class="tag">작업반용 모바일</span><h1>현장의 하루를<br>한곳에서 함께.</h1><p class="muted">처음 로그인한 뒤에는 자동으로 연결됩니다.</p><div class="hero"><h2>현장노트 로그인</h2><small>회사에서 등록한 계정으로 로그인하세요.</small></div><form id="login"><label>Supabase 프로젝트 주소<input name="url" type="url" required value="${esc(api.conf.url)}"></label><label>Publishable 키<input name="key" required value="${esc(api.conf.key)}" autocomplete="off"></label><label>이메일<input name="email" type="email" required autocomplete="username"></label><label>비밀번호<input name="password" type="password" required autocomplete="current-password"></label><button class="primary wide submit">로그인</button></form><p class="footnote">비밀번호는 이 파일에 저장하지 않습니다.</p></div>`;
    $('#login').insertAdjacentHTML('afterend', '<button class="wide" type="button" data-action="connection-check" data-form="login">서버 연결 확인</button><p class="hint" id="connection-result" role="status"></p>');
    $('#login').onsubmit = (e) => {
      e.preventDefault();
      DH.act(async () => {
        await api.signIn(Object.fromEntries(new FormData(e.target)));
        const profile = await api.rpc('dh_my_profile');
        if (!profile) {
          api.clearSession();
          throw Error('이 로그인 계정은 현장노트에 등록되지 않았습니다');
        }
        api.saveSession();
        await reload();
      });
    };
  }

  /* ---------- 타임라인 ---------- */
  function timelineItems() {
    const items = ctx.data.messages.map((m) => ({ id: m.id, type: m.kind, day: DH.kstDate(m.posted_at), at: m.posted_at, message: m }));
    const reports = new Map(ctx.data.permits.filter((p) => p.report?.id).map((p) => [p.report.id, p]));
    return DH.pipe('timelineItems', items, ctx)
      .map((x) => ({ ...x, permit: x.permit || reports.get(x.message?.report_id) || null, day: ctx.workDay }))
      .filter((x) => x.permit?.work_date === ctx.workDay)
      .filter((x) => DH.kinds[x.type])
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  }
  function chatPermits() {
    return ctx.data.permits.filter((p) => p.work_date === DH.mobileDay() && !p.report?.submitted_at);
  }
  function replyPreview(messageId) {
    const parentId = ctx.shareReplyLinks?.[messageId];
    const parent = ctx.data.messages.find((m) => m.id === parentId);
    if (!parent) return '';
    const summary = parent.body?.trim() || (parent.files?.some((f) => f.mime?.startsWith('image/')) ? '📷 사진' : '첨부 자료');
    return `<div class="reply-preview"><b>↪ ${esc(parent.sender_name)}</b><span>${esc(summary.slice(0, 100))}</span></div>`;
  }
  DH.chatReplyPreview = replyPreview;
  function messageHtml(x) {
    const k = DH.kinds[x.type],
      m = x.message;
    const label = DH.first('itemLabel', x, ctx) || k.label(x);
    const sender = k.sender?.(x) ?? m?.sender_name;
    const site = k.site?.(x) || x.permit?.site_name || DH.siteName(m?.site_id);
    const files = m?.files || [];
    const photo = k.photo?.(x) ?? files.find((f) => f.mime?.startsWith('image/'));
    const foot = k.foot?.(x) ?? (files.length ? `첨부 ${files.length}개` : '');
    const mine = m?.sender_id === ctx.profile.employee_id;
    return `<article class="message ${mine ? 'mine' : ''}"><div class="sender">${esc(sender)} · ${k.time?.(x) ?? DH.timeLabel(x.at)}</div><button class="bubble" data-action="timeline-open" data-id="${esc(x.id)}"><div class="kind">${esc(label)}</div>${x.type === 'share' ? replyPreview(x.id) : ''}${
      photo ? `<img class="mini-photo" data-file="${photo.id}" alt="첨부 사진">` : ''
    }<div class="message-site">${esc(site)}</div><div class="summary">${esc(k.summary(x))}</div><div class="message-foot"><span>${esc(foot)}</span><span>상세 보기 ›</span></div></button>${x.type === 'share' && ctx.chatReplyReady ? `<button class="message-reply" data-action="chat-reply" data-id="${esc(x.id)}">↪ 답장</button>` : ''}</article>`;
  }
  function timelineHtml(items) {
    if (!items.length) return '<div class="empty">아직 공유된 내용이 없습니다.</div>';
    let day = '';
    const today = DH.mobileDay();
    return items
      .map((x) => {
        let sep = '';
        if (x.day !== day) {
          day = x.day;
          sep = `<div class="date">${DH.dateLabel(day)}${day === today ? ' · 오늘' : ''}</div>`;
        }
        return sep + messageHtml(x);
      })
      .join('');
  }
  function timelineView() {
    ctx.view = 'timeline';
    const nav = DH.collect('mobileNav', ctx).sort(DH.byOrder);
    const permits = chatPermits(), draft = (ctx.draft.chat ||= {});
    if (!permits.some((p) => p.id === draft.permitId)) draft.permitId = permits.length === 1 ? permits[0].id : '';
    if (draft.replyTo && !timelineItems().some((x) => x.id === draft.replyTo && x.type === 'share' && x.permit?.id === draft.permitId)) {
      draft.replyTo = null;
      draft.messageId = null;
    }
    const replyTo = ctx.data.messages.find((m) => m.id === draft.replyTo);
    const replyText = replyTo?.body?.trim() || (replyTo?.files?.some((f) => f.mime?.startsWith('image/')) ? '📷 사진' : '첨부 자료');
    $('#app').innerHTML =
      DH.header() +
      `<main class="chat-main"><div class="row"><span class="tag">● 출근 완료 · ${esc(ctx.profile.name)}님</span><button data-action="reload" style="font-size:15px;min-height:45px">새로고침 ↻</button></div><div class="sync">${DH.dateLabel(DH.mobileDay())} 작업 · 회사 전체 현장 기록</div>${DH.collect('timelineBanners', ctx).join('')}<div id="timeline">${timelineHtml(timelineItems())}</div><p class="footnote">새 소식은 새로고침하면 표시됩니다.</p></main><nav class="bottom" aria-label="작업 메뉴" style="${nav.length === 3 ? '' : `grid-template-columns:repeat(${nav.length},1fr)`}"><form id="chat-form" class="chat-composer"><div class="chat-composer-top"><label for="chat-permit">현장</label><select id="chat-permit" ${replyTo ? 'disabled' : ''}><option value="">허가서 선택</option>${permits.map((p) => `<option value="${esc(p.id)}" ${p.id === draft.permitId ? 'selected' : ''}>${esc(p.site_name)} · ${esc(p.location || '작업')}</option>`).join('')}</select></div>${replyTo ? `<div class="chat-reply-target"><span>↪ ${esc(replyTo.sender_name)} · ${esc(replyText.slice(0, 70))}</span><button type="button" data-action="chat-reply-cancel" aria-label="답장 취소">×</button></div>` : ''}<div class="chat-compose-row"><textarea id="chat-text" rows="1" placeholder="현장에 전할 글을 쓰세요" aria-label="채팅 글 입력">${esc(draft.text || '')}</textarea><button class="primary" type="submit">전송</button></div></form>${nav
        .map((n) => `<button class="${n.primary ? 'primary' : ''}" data-action="${n.action}">${esc(n.label)}</button>`)
        .join('')}</nav>`;
    $('#chat-form').onsubmit = (event) => { event.preventDefault(); DH.act(sendChat); };
    DH.media.hydrateImages();
  }

  async function sendChat() {
    const draft = (ctx.draft.chat ||= {});
    const permitId = $('#chat-permit').value || draft.permitId;
    const permit = chatPermits().find((p) => p.id === permitId);
    const body = $('#chat-text').value.trim();
    if (!permit) throw Error('작업허가서를 선택하세요');
    if (!body) throw Error('전송할 글을 입력하세요');
    if (draft.replyTo) {
      const parent = timelineItems().find((x) => x.id === draft.replyTo && x.type === 'share');
      if (!ctx.chatReplyReady || parent?.permit?.id !== permit.id) throw Error('답장할 현장공유를 다시 선택하세요');
    }
    Object.assign(draft, { permitId: permit.id, text: body });
    draft.messageId ||= crypto.randomUUID();
    await drafts.write();
    await api.rpc('dh_save_share', { p_data: { id: draft.messageId, site_id: permit.site_id, permit_id: permit.id, body, files: [] } });
    if (draft.replyTo) await api.rpc('dh_link_share_reply', { p_child: draft.messageId, p_parent: draft.replyTo });
    await api.rpc('dh_post_share', { p_id: draft.messageId });
    ctx.draft.chat = { permitId: permit.id };
    await drafts.write();
    await reload();
    DH.toast('글을 전송했습니다');
  }

  /* ---------- 전체화면 패널 ---------- */
  DH.panel = (title, html) => {
    $('#panelTitle').textContent = title;
    $('#panelBody').innerHTML = html;
    if (!$('#panel').open) $('#panel').showModal();
    $('#panel').scrollTop = 0;
    DH.media.hydrateImages();
    return $('#panelBody');
  };
  DH.closePanel = () => {
    if (DH.media.editorOpen()) return;
    $('#panel').close();
    $('#panelBody').innerHTML = '';
  };
  $('#closePanel').onclick = DH.closePanel;
  $('#panel').addEventListener('cancel', (e) => {
    e.preventDefault();
    DH.closePanel();
  });

  /* ---------- 임시저장 (IndexedDB, 실패 시 localStorage) ---------- */
  let db = null;
  const openDb = async () =>
    (db ||= await new Promise((resolve, reject) => {
      const r = indexedDB.open('dh-worker-drafts-v1', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('drafts');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  const drafts = (DH.drafts = {
    async read() {
      const key = ctx.profile.employee_id;
      try {
        const store = (await openDb()).transaction('drafts').objectStore('drafts');
        return await new Promise((resolve, reject) => {
          const r = store.get(key);
          r.onsuccess = () => resolve(r.result || null);
          r.onerror = () => reject(r.error);
        });
      } catch {
        return JSON.parse(localStorage.getItem('dh_draft_' + key) || 'null');
      }
    },
    async write() {
      const key = ctx.profile.employee_id;
      try {
        const t = (await openDb()).transaction('drafts', 'readwrite');
        t.objectStore('drafts').put(ctx.draft, key);
        await new Promise((resolve, reject) => {
          t.oncomplete = resolve;
          t.onerror = () => reject(t.error);
        });
      } catch {
        localStorage.setItem('dh_draft_' + key, JSON.stringify(ctx.draft));
      }
    },
    async load() {
      ctx.draft = (await drafts.read()) || { share: {}, report: {}, chat: {} };
      ctx.draft.share ||= {};
      ctx.draft.report ||= {};
      ctx.draft.chat ||= {};
    },
    schedule() {
      clearTimeout(drafts.timer);
      drafts.timer = setTimeout(() => drafts.write().catch(() => DH.toast('임시저장 공간을 확인해 주세요')), 350);
    },
  });

  /* ---------- 공통 버튼 ---------- */
  DH.onAuthRequired = async () => {
    clearTimeout(dayTimer);
    clearTimeout(drafts.timer);
    if (ctx.profile) await drafts.write().catch(() => DH.toast('입력 내용의 임시저장을 확인해 주세요.'));
    api.clearSession();
    ctx.profile = ctx.data = ctx.workDay = null;
    ctx.draft = { share: {}, report: {}, chat: {} };
    DH.media.revokeAll();
    document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    $('#panelBody').innerHTML = '';
    loginView();
  };
  DH.onLoadError = () => {
    if (ctx.data) return;
    $('#app').innerHTML = DH.header() + '<div class="welcome"><h1>연결을 확인해 주세요</h1><p>데이터를 불러오지 못했습니다. 잠시 후 다시 시도할 수 있습니다.</p><button class="primary wide" data-action="reload">다시 연결</button><button class="wide" data-action="login-reset">로그인 화면</button></div>';
  };
  DH.action('login-reset', () => DH.act(DH.onAuthRequired));
  DH.action('reload', () => DH.act(reload));
  DH.action('timeline-open', (el) => {
    const item = timelineItems().find((v) => v.id === el.dataset.id);
    if (!item || DH.first('mobileDetail', item, ctx)) return;
    DH.kinds[item.type].detail(item);
  });
  DH.on('input', '#chat-text', (input) => {
    (ctx.draft.chat ||= {}).text = input.value;
    drafts.schedule();
  });
  DH.on('change', '#chat-permit', (select) => {
    (ctx.draft.chat ||= {}).permitId = select.value;
    ctx.draft.chat.messageId = null;
    drafts.schedule();
  });
  DH.action('chat-reply', (el) => {
    const item = timelineItems().find((x) => x.id === el.dataset.id && x.type === 'share');
    if (!item?.permit || !chatPermits().some((p) => p.id === item.permit.id)) return DH.toast('오늘 진행 중인 현장공유에만 답장할 수 있습니다');
    Object.assign((ctx.draft.chat ||= {}), { replyTo: item.id, permitId: item.permit.id, messageId: null });
    drafts.schedule();
    timelineView();
    $('#chat-text').focus();
  });
  DH.action('chat-reply-cancel', () => {
    ctx.draft.chat.replyTo = null;
    ctx.draft.chat.messageId = null;
    drafts.schedule();
    timelineView();
    $('#chat-text').focus();
  });
  DH.action('profile', () =>
    DH.panel('사용자 설정', `<p><b>${esc(ctx.profile.name)}</b> · ${esc(ctx.profile.role)}</p><p class="hint">같은 프로젝트의 현장 기록을 보고 있습니다.</p><button class="wide" data-action="logout">로그아웃</button>`)
  );
  DH.action('logout', () =>
    DH.act(async () => {
      await api.signOut();
      await DH.onAuthRequired();
    })
  );

  /* ---------- 자동 새로고침 ---------- */
  let dayTimer;
  function expireCurrentDay() {
    document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    $('#panelBody').innerHTML = '';
    ctx.data = null;
    $('#app').innerHTML = DH.header() + '<div class="welcome"><h1>새 작업일을 불러오는 중</h1><button class="primary wide" data-action="reload">다시 연결</button></div>';
  }
  function forceDayReload() {
    reload().catch((error) => {
      DH.onLoadError?.(error);
      DH.toast('새 작업일을 불러오지 못했습니다: ' + error.message);
    });
  }
  function scheduleDayChange(serverDelay) {
    clearTimeout(dayTimer);
    const next = Date.parse(DH.addDay(DH.workDay(), 1) + 'T04:00:00+09:00');
    dayTimer = setTimeout(() => {
      if (!api.session) return;
      expireCurrentDay();
      forceDayReload();
    }, Math.max(1, serverDelay ?? (next - Date.now())));
  }
  const canAutoReload = () => api.session && ctx.data && !$('#panel').open && !document.activeElement?.closest?.('#chat-form');
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !api.session) return;
    if (ctx.workDay && DH.workDay() !== ctx.workDay) {
      expireCurrentDay();
      forceDayReload();
    } else if (canAutoReload()) DH.act(reload);
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && canAutoReload() && ctx.view === 'timeline') DH.act(reload);
  }, 90000);

  DH.mobile = { ctx, reload, render };
  DH.mobileStart = () => { scheduleDayChange(); return api.session ? DH.act(reload) : loginView(); };
})();
