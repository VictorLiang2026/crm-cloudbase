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
 *   remove:  { action:'remove', id } → { ok, cascaded }（软删除 deleted_at，级联标记增员跟进）
 *   trashList: { action:'trashList', page?, pageSize?, keyword?, sortDir? } → { rows, total, ... }
 *              （增员回收站：软删除候选人走视图 v_recruit_candidates_trash，默认按删除时间倒序）
 *   restore: { action:'restore', ids:[...] } → { ok, restored, cascaded }（恢复候选人及其跟进；客户已删除时报错）
 *   funnel:  { action:'funnel' } → { funnel, total }
 *   rcMap:   { action:'rcMap' } → { rows:[{id, customer_id, deleted_at}] }
 *            （客户列表「增员状态」列映射：含已删除记录用于「曾增员」标识）
 */
'use strict';

const { rdb, nowIso, normFields, assertOk } = require('./db');

// recruit_candidates 表只保留增员专属字段（基础信息在 customers 表）
const FIELDS = [
  'customer_id', 'recommender_id', 'stage', 'stage_changed_at',
  'potential_score', 'potential_reason', 'motivation', 'concerns',
  'work_experience', 'family_situation', 'personality_tags',
  'career_plan', 'next_action_date', 'next_action', 'activity_history',
  'radar_image_file_id', 'radar_image_name',
  'winner_report_file_id', 'winner_report_name',
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
      case 'remove':  return await remove(event);
      case 'trashList': return await trashList(event);
      case 'restore': return await restore(event);
      case 'funnel': return await funnel(event);
      case 'rcMap':  return await rcMap();
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
  // 防重：同一客户至多一条未删除的候选人记录（与 uq_recruit_candidates_customer_active 一致）
  const dup = assertOk(await rdb.from('recruit_candidates')
    .select('id').eq('customer_id', data.customer_id).is('deleted_at', null).limit(1).maybeSingle());
  if (dup.data) return { error: '该客户已在增员列表中', existing_id: dup.data.id };
  const payload = normFields(data, FIELDS);
  const ts = nowIso();
  payload.created_at = ts;
  payload.updated_at = ts;
  if (!payload.stage) payload.stage = '新增人才';
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
  const ts = nowIso();
  const r = assertOk(await rdb.from('recruit_candidates')
    .update({ deleted_at: ts }).eq('id', id).is('deleted_at', null).select('id'));
  if (!(r.data || []).length) return { ok: false, error: 'not found or already deleted' };
  // 级联标记增员跟进（同一时间戳，恢复用）
  const cf = assertOk(await rdb.from('recruit_followups')
    .update({ deleted_at: ts }).eq('candidate_id', id).is('deleted_at', null).select('id'));
  return { ok: true, deleted_at: ts, cascaded: { recruit_followups: (cf.data || []).length } };
}

// 增员回收站列表：走 v_recruit_candidates_trash 视图（含客户基础信息与删除时间）
async function trashList(event) {
  const page = Math.max(1, parseInt(event.page || 1, 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(event.pageSize || 50, 10)));
  const keyword = (event.keyword || '').trim();
  const sortDir = event.sortDir === 'asc' ? 'asc' : 'desc';

  const res = assertOk(await rdb.from('v_recruit_candidates_trash').select('*'));
  let rows = res.data || [];

  if (keyword) {
    const kw = keyword.toLowerCase();
    rows = rows.filter(r =>
      (r.customer_name && r.customer_name.toLowerCase().indexOf(kw) !== -1) ||
      (r.phone && String(r.phone).indexOf(kw) !== -1) ||
      (r.occupation && r.occupation.toLowerCase().indexOf(kw) !== -1)
    );
  }

  // 默认按删除时间倒序（candidate_deleted_at）
  rows.sort((a, b) => {
    const va = a.candidate_deleted_at || '', vb = b.candidate_deleted_at || '';
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return (b.candidate_id || 0) - (a.candidate_id || 0);
  });

  const total = rows.length;
  const offset = (page - 1) * pageSize;
  const pageRows = rows.slice(offset, offset + pageSize);

  // 页内候选人的跟进计数（被级联标记的）
  const counts = {};
  if (pageRows.length) {
    const ids = pageRows.map(r => r.candidate_id);
    const set = new Set(ids);
    const cf = assertOk(await rdb.from('recruit_followups').select('candidate_id, deleted_at'));
    for (const cid of ids) counts[cid] = { followups: 0 };
    for (const f of (cf.data || [])) {
      if (f.deleted_at && set.has(f.candidate_id)) counts[f.candidate_id].followups++;
    }
  }

  return { rows: pageRows, total, page, pageSize, counts };
}

// 恢复候选人及其级联标记的跟进；客户仍处于删除状态时要求先恢复客户
async function restore(event) {
  const ids = Array.isArray(event.ids)
    ? event.ids.map(x => parseInt(x, 10)).filter(Boolean)
    : (event.id ? [parseInt(event.id, 10)] : []);
  if (!ids.length) return { error: 'ids required' };

  let restored = 0;
  let cascadedFollowups = 0;
  const skipped = [];
  for (const id of ids) {
    const c = assertOk(await rdb.from('recruit_candidates')
      .select('id, customer_id').eq('id', id).maybeSingle());
    if (!c.data) continue;
    // 客户已删除 → 先恢复客户
    const cust = assertOk(await rdb.from('customers')
      .select('Id, deleted_at').eq('Id', c.data.customer_id).maybeSingle());
    if (cust.data && cust.data.deleted_at) {
      skipped.push({ id, reason: '客户仍在回收站，请先恢复客户' });
      continue;
    }
    const u = assertOk(await rdb.from('recruit_candidates')
      .update({ deleted_at: null }).eq('id', id).select('id'));
    if (!(u.data || []).length) continue;
    restored++;
    const uf = assertOk(await rdb.from('recruit_followups')
      .update({ deleted_at: null }).eq('candidate_id', id).select('id'));
    cascadedFollowups += (uf.data || []).length;
  }
  return { ok: true, restored, cascaded: { recruit_followups: cascadedFollowups }, skipped };
}

async function funnel(event) {
  const res = assertOk(await rdb.from('recruit_candidates')
    .select('stage').is('deleted_at', null));
  const funnel = {};
  for (const r of (res.data || [])) funnel[r.stage] = (funnel[r.stage] || 0) + 1;
  return { funnel, total: (res.data || []).length };
}

// rcMap：客户列表「增员状态」列映射（含已删除记录 → 曾增员标识）
async function rcMap(event) {
  const res = assertOk(await rdb.from('recruit_candidates')
    .select('id, customer_id, deleted_at'));
  return { rows: res.data || [] };
}
