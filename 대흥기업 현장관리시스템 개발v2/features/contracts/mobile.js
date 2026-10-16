/* 승인된 작업허가서의 계약 비고. 권한 판단은 기존 worker_snapshot과 동일합니다. */
(function () {
  'use strict';
  DH.contracts = DH.contracts || {};
  DH.contracts.taskNote = id => DH.ctx.contractTaskNotes?.[id]?.note || '';
  DH.contracts.orderMemo = id => DH.ctx.contractTaskNotes?.[id]?.order_memo || '';
  DH.register({ name: '계약 물량 비고', order: 20,
    sessionReset() { DH.ctx.contractTaskNotes = {}; },
    async mobileLoad(c) {
      c.contractTaskNotes = {};
      try {
        const permits = c.data.permits || [], dates = permits.map(p => p.work_date).sort();
        if (!dates.length) return;
        const result = await DH.rpc('dh_contract_task_notes', { p_from: dates[0], p_to: dates[dates.length - 1] });
        if (!Array.isArray(result)) throw Error('작업 비고 응답이 올바르지 않습니다.');
        c.contractTaskNotes = Object.fromEntries(result.map(n => [n.task_id, n]));
      } catch (e) {
        if (e.status === 404 || /PGRST202|Could not find the function/.test(e.message)) return;
        throw e;
      }
    }
  });
})();
