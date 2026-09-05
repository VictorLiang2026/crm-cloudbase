/**
 * ai_recommendations — AI 建议（事件云函数，rdb() 版）
 * 入参 event: { action, ... }
 *   list:    { action:'list', customer_id } → { rows }（单客户历史建议）
 *   listAll: { action:'listAll', page?, pageSize?, sortField?, sortDir?,
 *              keyword?（客户姓名模糊）, dateField?('recommendation_date'|'suggested_followup_date')+startDate?/endDate?（区间，任一可空） }
 *            → { rows, total }（全量建议，JS 端筛选+排序（null 排后）+ 分页，仿 customers list 模式）
 *   get:     { action:'get', id } → { recommendation }（单条完整字段）
 *   update:  { action:'update', id, data:{ suggested_message?, suggested_strategy?, suggested_followup_date?, suggested_customer_stage?, suggested_followup_goal? } }
 *            → { ok }（人工编辑保存；空串转 null，按 id 增量更新）
 * 建议记录由 ai_recommend 函数写入，本函数读取 + 增量编辑。
 */
'use strict';

const { rdb, normFields, assertOk, nowIso } = require('./db');

const SORTABLE = {
  id: 'id',
  customer_name: 'customer_name',
  recommendation_date: 'recommendation_date',
  suggested_followup_date: 'suggested_followup_date',
  suggested_customer_stage: 'suggested_customer_stage',
  suggested_followup_goal: 'suggested_followup_goal',
};

// 允许人工编辑覆盖的字段（不含 id/customer_id/customer_name/recommendation_date/created_at 元数据）
const EDIT_FIELDS = [
  'suggested_message', 'suggested_strategy', 'suggested_followup_date',
  'suggested_customer_stage', 'suggested_followup_goal',
];

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list':    return await list(event);
      case 'listAll': return await listAll(event);
      case 'get':     return await get(event);
      case 'update':  return await update(event);
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

  // 筛选：三种互斥方式（前端保证互斥；后端按传入参数独立生效）
  // 1) 客户姓名模糊匹配（不区分大小写）
  const keyword = (event.keyword == null ? '' : String(event.keyword)).trim().toLowerCase();
  if (keyword) {
    rows = rows.filter(function (a) {
      return a.customer_name && String(a.customer_name).toLowerCase().indexOf(keyword) !== -1;
    });
  }
  // 2/3) 日期区间：dateField=recommendation_date（给出建议日期）或 suggested_followup_date（建议跟进日期）
  //      startDate/endDate 任一可空（开区间）；启用时空日期行排除；纯日期串比较 slice(0,10)
  const DATE_FIELDS = { recommendation_date: 1, suggested_followup_date: 1 };
  if (event.dateField && DATE_FIELDS[event.dateField]) {
    const start = event.startDate ? String(event.startDate).slice(0, 10) : '';
    const end = event.endDate ? String(event.endDate).slice(0, 10) : '';
    if (start && end && start > end) return { error: '开始日期不能晚于结束日期' };
    const field = event.dateField;
    rows = rows.filter(function (a) {
      const d = a[field] ? String(a[field]).slice(0, 10) : '';
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }

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

async function get(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('ai_recommendations').select().eq('id', id).maybeSingle());
  if (!r.data) return { error: 'not found' };
  return { recommendation: r.data };
}

// 增量更新：仅写入 EDIT_FIELDS 内的非 undefined 字段；自动更新 updated_at
async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const payload = normFields(Object.assign({}, event.data || {}), EDIT_FIELDS);
  payload.updated_at = nowIso();
  if (!Object.keys(payload).length) return { error: 'no valid fields' };
  assertOk(await rdb.from('ai_recommendations').update(payload).eq('id', id).select('id'));
  return { ok: true };
}
