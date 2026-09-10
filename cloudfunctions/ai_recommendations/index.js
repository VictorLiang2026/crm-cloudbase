/**
 * ai_recommendations — AI 建议（事件云函数，rdb() 版）
 * 入参 event: { action, ... }
 *   list:    { action:'list', customer_id } → { rows }（单客户历史建议）
 *   listAll: { action:'listAll', page?, pageSize?, sortField?, sortDir?,
 *              keyword?（客户姓名模糊）, dateField?('recommendation_date'|'suggested_followup_date')+startDate?/endDate?（区间，任一可空） }
 *            → { rows, total }（全量建议，JS 端筛选+排序（null 排后）+ 分页，仿 customers list 模式）
 *   get:     { action:'get', id } → { recommendation }（单条完整字段）
 *   create:  { action:'create', data:{ customer_id, suggested_message?, suggested_strategy?, suggested_followup_date?,
 *                                     suggested_customer_stage?, suggested_followup_goal?, nba? } }
 *            → { id }（用户确认后的建议落库：AI 只建议、必须用户确认，如转介绍建议确认写入 NBA；不做 AI 生成）
 *   update:  { action:'update', id, data:{ suggested_message?, suggested_strategy?, suggested_followup_date?, suggested_customer_stage?, suggested_followup_goal? } }
 *            → { ok }（人工编辑保存；空串转 null，按 id 增量更新）
 *   update_status: { action:'update_status', id, status:'completed'|'skipped', result }
 *            → { ok }（NBA 执行闭环：将 status/executed_at/result merge 进 nba jsonb，不改原始 AI 建议）
 * 建议记录由 ai_recommend / ai_referral（经本 create 确认）写入，本函数读取 + 增量编辑 + 执行状态。
 */
'use strict';

const { rdb, normFields, assertOk, nowIso } = require('./db');
const aiStd = require('./ai');

// 与 ai_recommend 一致的枚举词表（PG enum 列，超出值会插入失败）
var GOAL_ENUM = ['建立联系', '约见面', '邀请活动', '获取家庭信息', '推进签单', '推进招募', '推进转介绍'];
var STAGE_ENUM = ['新认识', '关系维护', '需求挖掘', '方案沟通', '成交推进', '转介绍经营'];
function inEnum(v, list) {
  return (typeof v === 'string' && list.indexOf(v.trim()) >= 0) ? v.trim() : null;
}
// NBA jsonb 清洗：统一 9 字段 + 兼容旧 6 字段（v1.8 Sprint9 起新建议带 channel/confidence/evidence 等）；
// 全空返回 null（与历史行为一致，避免存入只有默认枚举值的空对象）
function normNba(n) {
  var out = aiStd.normNba(n, { legacy: true });
  if (!out) return null;
  var TEXT_KEYS = ['action', 'reason', 'goal', 'suggested_date', 'script',
    'assessment', 'next_action', 'topic', 'avoid', 'success_criteria'];
  var anyText = TEXT_KEYS.some(function (k) { return !!out[k]; });
  return (anyText || out.evidence.length) ? out : null;
}
function normDate(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null;
  return v.trim();
}

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
      case 'create':  return await create(event);
      case 'update':        return await update(event);
      case 'update_status': return await updateStatus(event);
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

// 用户确认后的建议落库（AI 只建议、必须用户确认才会调用）：直接写入前端提交的内容，不做 AI 生成
async function create(event) {
  const data = Object.assign({}, event.data || {});
  const customerId = parseInt(data.customer_id, 10);
  if (!customerId) return { error: 'customer_id required' };
  const c = assertOk(await rdb.from('customers').select('Id, customer_name').eq('Id', customerId)
    .is('deleted_at', null).maybeSingle());
  if (!c.data) return { error: 'customer not found' };
  const payload = {
    customer_id: customerId,
    customer_name: c.data.customer_name || '',
    recommendation_date: normDate(data.recommendation_date) || new Date().toISOString().slice(0, 10),
    suggested_followup_date: normDate(data.suggested_followup_date),
    suggested_message: data.suggested_message ? String(data.suggested_message).slice(0, 1000) : null,
    suggested_strategy: data.suggested_strategy ? String(data.suggested_strategy).slice(0, 2000) : null,
    suggested_customer_stage: inEnum(data.suggested_customer_stage, STAGE_ENUM),
    suggested_followup_goal: inEnum(data.suggested_followup_goal, GOAL_ENUM),
    nba: normNba(data.nba),
  };
  const r = assertOk(await rdb.from('ai_recommendations').insert(payload).select('id'));
  return { id: r.data[0].id };
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

// NBA 执行闭环：将 status/executed_at/result merge 进 nba jsonb，不改原始 AI 建议字段
async function updateStatus(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const status = String(event.status || '').trim();
  if (status !== 'completed' && status !== 'skipped') return { error: 'status must be completed or skipped' };
  const result = String(event.result || '').trim();
  if (!result) return { error: 'result required' };

  // 读取现有记录
  var r = assertOk(await rdb.from('ai_recommendations').select('id, nba').eq('id', id).maybeSingle());
  if (!r.data) return { error: 'not found' };

  // merge status 进 nba jsonb（保留原有 AI 建议 6 字段不变）
  var nba = {};
  try { if (r.data.nba) nba = typeof r.data.nba === 'object' ? r.data.nba : JSON.parse(r.data.nba); } catch (e) { nba = {}; }
  nba.status = status;
  nba.executed_at = nowIso();
  nba.result = result;

  assertOk(await rdb.from('ai_recommendations').update({ nba: nba, updated_at: nowIso() }).eq('id', id).select('id'));
  return { ok: true };
}
