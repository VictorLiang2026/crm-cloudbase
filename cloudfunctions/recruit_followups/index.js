/**
 * recruit_followups — 增员跟进记录 CRUD（事件云函数，rdb() 版）
 * 借鉴国际保险行业 Contact Log + Pipeline Activity 模式：
 *   每次接触 = 接触方式 + 内容 + 意向度 + 顾虑反馈 + 下一步行动
 *
 * 入参 event: { action, ... }
 *   list:   { action:'list', candidate_id } → { rows }
 *   create: { action:'create', data:{ candidate_id, contact_method?, followup_notes, followup_date, interest_level?, concern_feedback?, next_followup_date?, next_followup_goal?, operator? } } → { id }
 *   update: { action:'update', id, data:{...} } → { ok }
 *   remove: { action:'remove', id } → { ok }（硬删除）
 */
'use strict';

const { rdb, nowIso, normFields, assertOk } = require('./db');

const FIELDS = [
  'candidate_id', 'contact_method', 'followup_notes', 'followup_date',
  'interest_level', 'concern_feedback',
  'next_followup_date', 'next_followup_goal', 'operator',
];

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list':   return await list(event);
      case 'create': return await create(event);
      case 'update': return await update(event);
      case 'remove': return await remove(event);
      default: return { error: 'unknown action: ' + action };
    }
  } catch (e) {
    return { error: e.message };
  }
};

async function list(event) {
  const candidateId = parseInt(event.candidate_id, 10);
  if (!candidateId) return { error: 'candidate_id required' };
  const r = assertOk(await rdb.from('recruit_followups').select()
    .eq('candidate_id', candidateId).is('deleted_at', null)
    .order('followup_date', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false }));
  return { rows: r.data || [] };
}

async function create(event) {
  const data = Object.assign({}, event.data || {});
  const candidateId = parseInt(data.candidate_id, 10);
  if (!candidateId) return { error: 'candidate_id required' };
  if (!data.followup_date) return { error: 'followup_date required' };
  const ts = nowIso();
  data.created_at = ts;
  data.updated_at = ts;
  const payload = normFields(data, FIELDS.concat(['created_at', 'updated_at']));
  if (!Object.keys(payload).length) return { error: 'no valid fields' };
  const r = assertOk(await rdb.from('recruit_followups').insert(payload).select('id'));
  return { id: r.data[0].id };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const payload = normFields(
    Object.assign({}, event.data || {}, { updated_at: nowIso() }),
    FIELDS.concat(['updated_at'])
  );
  if (!Object.keys(payload).length) return { ok: true, updated: false };
  const r = assertOk(await rdb.from('recruit_followups').update(payload).eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}

async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('recruit_followups').delete().eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}
