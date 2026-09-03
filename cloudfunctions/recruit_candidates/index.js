/**
 * recruit_candidates — 增员候选人 CRUD（事件云函数，rdb() 版）
 * 20260905 重构：候选人不存基础信息（归 customers），只存增员专属字段
 *   customer_id NOT NULL：增员对象必须先是客户对象
 *   list/get 查询走视图 v_recruit_candidates（JOIN customers）
 *
 * 入参 event: { action, ... }
 *   list:    { action:'list', keyword?, stage?, page?, pageSize? } → { rows, total, page, pageSize }
 *   get:     { action:'get', id } → { candidate, milestones }
 *   create:  { action:'create', data:{customer_id, ...} } → { id }
 *   update:  { action:'update', id, data:{...} } → { ok }
 *   remove:  { action:'remove', id } → { ok }（软删除 deleted_at）
 *   funnel:  { action:'funnel' } → { funnel, total }
 */
'use strict';

const { rdb, nowIso, normFields, assertOk } = require('./db');

// recruit_candidates 表只保留增员专属字段（基础信息在 customers 表）
const FIELDS = [
  'customer_id', 'recommender_id', 'stage', 'stage_changed_at',
  'potential_score', 'potential_reason', 'motivation', 'concerns',
  'work_experience', 'family_situation', 'personality_tags',
  'career_plan', 'next_action_date', 'next_action', 'activity_history',
  'operator',
];

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list':   return await list(event);
      case 'get':    return await get(event);
      case 'create': return await create(event);
      case 'update': return await update(event);
      case 'remove': return await remove(event);
      case 'funnel': return await funnel(event);
      default: return { error: 'unknown action: ' + action };
    }
  } catch (e) {
    return { error: e.message };
  }
};

// list 走视图 v_recruit_candidates（已 JOIN customers，含基础信息+idle_days）
async function list(event) {
  const page = Math.max(1, parseInt(event.page || 1, 10));
  const pageSize = Math.min(1000, Math.max(1, parseInt(event.pageSize || 1000, 10)));
  const keyword = (event.keyword || '').trim();
  const stage = (event.stage || '').trim();

  const res = assertOk(await rdb.from('v_recruit_candidates')
    .select('*')
    .order('updated_at', { ascending: false, nullsFirst: false })
    .order('candidate_id', { ascending: false }));
  let rows = res.data || [];

  // 阶段过滤
  if (stage) rows = rows.filter(r => r.stage === stage);

  // 关键词过滤（姓名/电话/职业/来源，不区分大小写）
  if (keyword) {
    const kw = keyword.toLowerCase();
    rows = rows.filter(r =>
      (r.customer_name && r.customer_name.toLowerCase().indexOf(kw) !== -1) ||
      (r.phone && String(r.phone).indexOf(kw) !== -1) ||
      (r.occupation && r.occupation.toLowerCase().indexOf(kw) !== -1) ||
      (r.source && r.source.toLowerCase().indexOf(kw) !== -1)
    );
  }

  const total = rows.length;
  const offset = (page - 1) * pageSize;
  const pageRows = rows.slice(offset, offset + pageSize);

  return { rows: pageRows, total, page, pageSize };
}

// get 走视图获取候选人完整信息 + 里程碑
async function get(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };

  // 从视图查（含 customers 基础信息）
  const c = assertOk(await rdb.from('v_recruit_candidates')
    .select('*').eq('candidate_id', id).maybeSingle());
  if (!c.data) return { error: 'not found' };

  const m = assertOk(await rdb.from('recruit_milestones')
    .select('*').eq('candidate_id', id).order('happened_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false }));
  return { candidate: c.data, milestones: m.data || [] };
}

async function create(event) {
  const data = event.data || {};
  if (!data.customer_id) return { error: 'customer_id required（增员对象必须先是客户）' };
  const payload = normFields(data, FIELDS);
  const ts = nowIso();
  payload.created_at = ts;
  payload.updated_at = ts;
  if (!payload.stage) payload.stage = '名单';
  payload.stage_changed_at = ts;
  const r = assertOk(await rdb.from('recruit_candidates').insert(payload).select('id').single());
  // 记录首个里程碑
  assertOk(await rdb.from('recruit_milestones').insert({
    candidate_id: r.data.id, from_stage: null, to_stage: payload.stage,
    note: '创建候选人', operator: payload.operator || null,
  }));
  return { id: r.data.id };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const data = event.data || {};
  const payload = normFields(data, FIELDS);
  payload.updated_at = nowIso();

  // 若阶段变更，记录里程碑 + 更新 stage_changed_at
  if (data.stage) {
    const old = assertOk(await rdb.from('recruit_candidates').select('stage').eq('id', id).maybeSingle());
    const oldStage = old.data ? old.data.stage : null;
    if (oldStage !== data.stage) {
      payload.stage_changed_at = payload.updated_at;
      assertOk(await rdb.from('recruit_milestones').insert({
        candidate_id: id, from_stage: oldStage, to_stage: data.stage,
        note: data.stage_note || '', operator: payload.operator || null,
      }));
    }
  }

  const r = assertOk(await rdb.from('recruit_candidates').update(payload).eq('id', id).select('id'));
  const n = (r.data || []).length;
  return { ok: n === 1, updated: n };
}

async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('recruit_candidates')
    .update({ deleted_at: nowIso() }).eq('id', id).is('deleted_at', null).select('id'));
  return { ok: (r.data || []).length === 1 };
}

async function funnel(event) {
  const res = assertOk(await rdb.from('recruit_candidates')
    .select('stage').is('deleted_at', null));
  const funnel = {};
  for (const r of (res.data || [])) funnel[r.stage] = (funnel[r.stage] || 0) + 1;
  return { funnel, total: (res.data || []).length };
}
