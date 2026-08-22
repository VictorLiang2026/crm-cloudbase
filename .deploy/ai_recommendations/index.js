/**
 * ai_recommendations — AI 建议列表（只读，事件云函数，rdb() 版）
 * 入参 event: { action, ... }
 *   list:    { action:'list', customer_id } → { rows }（单客户历史建议）
 *   listAll: { action:'listAll', page?, pageSize?, sortField?, sortDir? } → { rows, total }
 *            （全量建议，JS 端排序（null 排后）+ 分页，仿 customers list 模式）
 * 建议记录由 ai_recommend 函数写入，本函数仅读取。
 */
'use strict';

const { rdb, assertOk } = require('./db');

const SORTABLE = {
  id: 'id',
  customer_name: 'customer_name',
  recommendation_date: 'recommendation_date',
  suggested_followup_date: 'suggested_followup_date',
  suggested_customer_stage: 'suggested_customer_stage',
  suggested_followup_goal: 'suggested_followup_goal',
};

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list': return await list(event);
      case 'listAll': return await listAll(event);
      default: return { error: 'unknown action: ' + action };
    }
  } catch (e) {
    return { error: e.message };
  }
};

async function list(event) {
  const customerId = parseInt(event.customer_id, 10);
  if (!customerId) return { error: 'customer_id required' };
  const r = assertOk(await rdb.from('ai_recommendations').select()
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false }));
  return { rows: r.data || [] };
}

async function listAll(event) {
  const r = assertOk(await rdb.from('ai_recommendations')
    .select('id, customer_id, customer_name, recommendation_date, suggested_followup_date, suggested_message, suggested_strategy, suggested_customer_stage, suggested_followup_goal, created_at'));
  let rows = r.data || [];

  // JS 端排序：可排序列，null/空值始终排末尾
  const sortField = SORTABLE[event.sortField] ? event.sortField : 'id';
  const dir = event.sortDir === 'asc' ? 1 : -1;
  rows = rows.slice().sort(function (a, b) {
    const va = a[sortField], vb = b[sortField];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });

  // 分页
  const pageSize = Math.max(1, parseInt(event.pageSize, 10) || 20);
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  let page = Math.min(Math.max(1, parseInt(event.page, 10) || 1), pages);
  const start = (page - 1) * pageSize;
  return { rows: rows.slice(start, start + pageSize), total: total, page: page, pages: pages };
}
