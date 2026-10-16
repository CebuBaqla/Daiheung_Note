/* =====================================================================
 * 기능: 출근 및 휴가 (모바일)
 *  - 하루 첫 접속 시 출근/휴가 선택 화면. 출근 전에는 타임라인을 가립니다.
 * 데이터: dh_worker_day_state.attendance     RPC: dh_workday_attend
 * ===================================================================== */
(function () {
  'use strict';
  const { $, esc } = DH;

  function view(c) {
    c.view = 'attendance';
    const leave = c.data.attendance?.status === 'leave',
      today = DH.mobileDay();
    const count = c.data.permits.filter((p) => p.work_date === today).length;
    $('#app').innerHTML =
      DH.header() +
      `<div class="welcome"><div class="muted">${DH.dateLabel(today)}</div><h1>${esc(c.profile.name)}님,<br>${leave ? '오늘은 휴가입니다.' : '오늘도 안전하게.'}</h1><p>${leave ? '출근으로 변경하면 오늘의 메신저로 이동합니다.' : '오늘의 근무 상태를 선택해 주세요.'}</p><div class="hero"><small>오늘 공유된 작업허가서</small><h2>${count}건</h2><small>출근 후 메신저에서 바로 확인하세요.</small></div><div class="stack"><button class="primary" data-action="attend" data-status="work">${leave ? '출근으로 변경하기' : '출근 · 메신저 바로가기 →'}</button>${leave ? '' : '<button data-action="attend" data-status="leave">오늘 휴가</button>'}<button data-action="reload">새로고침</button></div><p class="footnote">매일 처음 접속할 때 근무 상태를 선택합니다.</p><button class="wide" data-action="profile">사용자 설정</button></div>`;
  }

  DH.register({
    name: '출근 및 휴가',
    order: 10,
    mobileGate(c) {
      if (c.data.attendance?.status === 'work') return false;
      view(c);
      return true;
    },
  });
  DH.action('attend', (el) =>
    DH.act(async () => {
      const status = el.dataset.status;
      await DH.rpc('dh_workday_attend', { p_status: status });
      await DH.mobile.reload();
      DH.toast(status === 'work' ? '출근이 기록되었습니다.' : '휴가가 기록되었습니다.');
    })
  );
})();
