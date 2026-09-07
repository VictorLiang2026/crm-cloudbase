/**
 * activities — 轻量活动经营 CRUD（事件云函数，rdb() 版）
 * 入参 event: { action, ... }
 *   list:        { action:'list' } → { rows }（活动列表，倒序）
 *   get:         { action:'get', id } → { activity, participants }（活动详情+参与者）
 *   create:      { action:'create', data:{ name, activity_date?, activity_type?, location?, description? } } → { id }
 *   update:      { action:'update', id, data:{...} } → { ok }
 *   remove:      { action:'remove', id } → { ok }（软删除）
 *   addParticipant:     { action:'addParticipant', data:{ activity_id, person_type, person_id, status?, relationship_note? } } → { id }
 *   updateParticipant:  { action:'updateParticipant', id, data:{ status?, relationship_note?, ai_followup_suggestion? } } → { ok }
 *   removeParticipant:  { action:'removeParticipant', id } → { ok }（软删除）
 *   listByPerson: { action:'listByPerson', person_type, person_id } → { rows }（某客户/增员参加的所有活动）
 */
'use strict';

const { rdb, nowIso, normFields, assertOk } = require('./db');

const ACT_FIELDS = ['name', 'activity_date', 'activity_type', 'location', 'description'];
const PART_FIELDS = ['activity_id', 'person_type', 'person_id', 'status', 'relationship_note', 'ai_followup_suggestion'];
var PT_ENUM = ['customer', 'recruit'];
var ST_ENUM = ['invited', 'attended', 'absent'];

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list':            return await list(event);
      case 'get':             return await get(event);
      case 'create':          return await create(event);
      case 'update':          return await update(event);
      case 'remove':          return await remove(event);
      case 'addParticipant':     return await addParticipant(event);
      case 'updateParticipant':  return await updateParticipant(event);
      case 'removeParticipant':  return await removeParticipant(event);
      case 'listByPerson':        return await listByPerson(event);
      default: return { error: 'unknown action: ' + action };
    }
  } catch (e) {
    return { error: e.message };
  }
};

async function list(event) {
  const r = assertOk(await rdb.from('activities').select()
    .is('deleted_at', null)
    .order('activity_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(100));
  return { rows: r.data || [] };
}

async function get(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const a = assertOk(await rdb.from('activities').select()
    .eq('id', id).is('deleted_at', null).maybeSingle());
  if (!a.data) return { error: 'activity not found' };
  const p = assertOk(await rdb.from('activity_participants').select()
    .eq('activity_id', id).is('deleted_at', null)
    .order('created_at', { ascending: true }));
  return { activity: a.data, participants: p.data || [] };
}

async function create(event) {
  const data = Object.assign({}, event.data || {});
  if (!data.name) return { error: 'name required' };
  data.created_at = nowIso();
  data.updated_at = nowIso();
  const payload = normFields(data, ACT_FIELDS.concat(['created_at', 'updated_at']));
  const r = assertOk(await rdb.from('activities').insert(payload).select('id'));
  return { id: r.data[0].id };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const payload = normFields(
    Object.assign({}, event.data || {}, { updated_at: nowIso() }),
    ACT_FIELDS.concat(['updated_at'])
  );
  if (!Object.keys(payload).length) return { ok: true, updated: false };
  const r = assertOk(await rdb.from('activities').update(payload).eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}

async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('activities')
    .update({ deleted_at: nowIso(), updated_at: nowIso() }).eq('id', id).select('id'));
  // 软删除参与者
  await rdb.from('activity_participants')
    .update({ deleted_at: nowIso() }).eq('activity_id', id);
  return { ok: (r.data || []).length === 1 };
}

async function addParticipant(event) {
  const data = Object.assign({}, event.data || {});
  if (PT_ENUM.indexOf(data.person_type) < 0) return { error: '无效的 person_type' };
  if (!data.activity_id || !data.person_id) return { error: 'activity_id and person_id required' };
  // 检查活动存在
  const a = assertOk(await rdb.from('activities').select('id').eq('id', data.activity_id).is('deleted_at', null).maybeSingle());
  if (!a.data) return { error: 'activity not found' };
  // 检查人员存在
  var table = data.person_type === 'customer' ? 'customers' : 'recruit_candidates';
  var idCol = data.person_type === 'customer' ? 'Id' : 'id';
  const p = assertOk(await rdb.from(table).select(idCol).eq(idCol, parseInt(data.person_id, 10)).is('deleted_at', null).maybeSingle());
  if (!p.data) return { error: data.person_type + ' not found' };
  // 去重：同一活动同一人不重复添加
  const dup = assertOk(await rdb.from('activity_participants').select('id')
    .eq('activity_id', data.activity_id).eq('person_type', data.person_type)
    .eq('person_id', data.person_id).is('deleted_at', null));
  if (dup.data && dup.data.length) return { error: '已添加该参与者', id: dup.data[0].id };
  if (!data.status) data.status = 'invited';
  data.created_at = nowIso();
  const payload = normFields(data, PART_FIELDS.concat(['created_at']));
  const r = assertOk(await rdb.from('activity_participants').insert(payload).select('id'));
  return { id: r.data[0].id };
}

async function updateParticipant(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const data = Object.assign({}, event.data || {});
  if (data.status && ST_ENUM.indexOf(data.status) < 0) return { error: '无效 status' };
  const payload = normFields(data, ['status', 'relationship_note', 'ai_followup_suggestion']);
  if (!Object.keys(payload).length) return { ok: true, updated: false };
  const r = assertOk(await rdb.from('activity_participants').update(payload).eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}

async function removeParticipant(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('activity_participants')
    .update({ deleted_at: nowIso() }).eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}

async function listByPerson(event) {
  const pt = event.person_type;
  const pid = parseInt(event.person_id, 10);
  if (PT_ENUM.indexOf(pt) < 0 || !pid) return { error: 'person_type and person_id required' };
  const r = assertOk(await rdb.from('activity_participants').select('activity_id, status, relationship_note, ai_followup_suggestion, created_at')
    .eq('person_type', pt).eq('person_id', pid).is('deleted_at', null)
    .order('created_at', { ascending: false }));
  var rows = r.data || [];
  // 批量查活动信息
  if (rows.length) {
    var ids = rows.map(function(r){ return r.activity_id; });
    var acts = assertOk(await rdb.from('activities').select('id, name, activity_date, activity_type, location')
      .in('id', ids).is('deleted_at', null));
    var map = {};
    (acts.data || []).forEach(function(a){ map[a.id] = a; });
    rows.forEach(function(r){ r.activity = map[r.activity_id] || null; });
  }
  return { rows: rows };
}
