/**
 * activity_speakers — 活动嘉宾资源池（v1.7.3 Activity Speaker Pool）
 *
 * actions:
 *   list    {keyword?, status?, stage?}                        → { rows:[嘉宾全字段] }   （姓名/机构/专业/主题 模糊 + 状态/阶段筛选）
 *   get     {id}                                               → { speaker }
 *   create  {data:{name, ...}}                                 → { id }
 *   update  {id, data:{...}}                                   → { ok:true }
 *   remove  {id}                                               → { ok:true }  （软删除：置 deleted_at）
 *   search  {keyword}                                          → { rows:[{id,name,organization,position,phone,expertise,topic_summary}] }
 *                                                                   （活动添加嘉宾时的联想：姓名/机构/专业/主题）
 *
 * 约束：relationship_stage/status 枚举校验；cooperation_count 非负整数；本版本 cooperation_count 仅手动维护。
 */
'use strict';

const { rdb, normFields, assertOk, nowIso } = require('./db');

const SP_FIELDS = ['name', 'phone', 'wechat', 'organization', 'position', 'relationship_stage',
  'expertise', 'topic_summary', 'source', 'last_contact_date', 'next_contact_date', 'last_contact_note',
  'cooperation_count', 'preferred_format', 'status', 'customer_id', 'recruit_candidate_id', 'notes'];
const STAGE_ENUM = ['new', 'contacted', 'cooperated', 'stable', 'deep', 'inactive'];
const STATUS_ENUM = ['active', 'inactive'];

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list':    return await list(event);
      case 'get':     return await get(event);
      case 'create':  return await create(event);
      case 'update':  return await update(event);
      case 'remove':  return await remove(event);
      case 'search':  return await search(event);
      default: return { error: 'unknown action: ' + action };
    }
  } catch (e) {
    return { error: e.message };
  }
};

// 枚举/数值校验（create/update 共用）
function normSpeaker(data) {
  const d = Object.assign({}, data || {});
  if (d.relationship_stage && STAGE_ENUM.indexOf(d.relationship_stage) < 0) {
    return { error: '无效 relationship_stage，允许: ' + STAGE_ENUM.join('/') };
  }
  if (d.status && STATUS_ENUM.indexOf(d.status) < 0) {
    return { error: '无效 status，允许: ' + STATUS_ENUM.join('/') };
  }
  if (d.cooperation_count != null) {
    d.cooperation_count = parseInt(d.cooperation_count, 10);
    if (isNaN(d.cooperation_count) || d.cooperation_count < 0) return { error: 'cooperation_count 必须是非负整数' };
  }
  if (d.customer_id != null) d.customer_id = parseInt(d.customer_id, 10) || null;
  if (d.recruit_candidate_id != null) d.recruit_candidate_id = parseInt(d.recruit_candidate_id, 10) || null;
  return { data: d };
}

// 转义 postgrest ilike 保留字符（与 activities.searchPerson 同款）
function safeKw(s) {
  return String(s || '').replace(/[%,_()\\]/g, function (c) { return '\\' + c; });
}

function kwOrCond(kw) {
  const s = safeKw(kw);
  return ['name', 'organization', 'expertise', 'topic_summary']
    .map(function (c) { return c + '.ilike.%' + s + '%'; }).join(',');
}

async function list(event) {
  let q = rdb.from('activity_speakers').select().is('deleted_at', null);
  const kw = String(event.keyword || '').trim();
  if (kw) q = q.or(kwOrCond(kw));
  if (event.status) q = q.eq('status', event.status);
  if (event.stage) q = q.eq('relationship_stage', event.stage);
  const r = assertOk(await q.order('updated_at', { ascending: false }).limit(100));
  return { rows: r.data || [] };
}

async function get(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('activity_speakers').select()
    .eq('id', id).is('deleted_at', null).maybeSingle());
  if (!r.data) return { error: 'speaker not found' };
  return { speaker: r.data };
}

async function create(event) {
  const n = normSpeaker(event.data);
  if (n.error) return n;
  const d = n.data;
  if (!d.name || !String(d.name).trim()) return { error: 'name required' };
  d.created_at = nowIso();
  d.updated_at = nowIso();
  const payload = normFields(d, SP_FIELDS.concat(['created_at', 'updated_at']));
  const r = assertOk(await rdb.from('activity_speakers').insert(payload).select('id'));
  return { id: r.data[0].id };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const n = normSpeaker(event.data);
  if (n.error) return n;
  n.data.updated_at = nowIso();
  const payload = normFields(n.data, SP_FIELDS.concat(['updated_at']));
  const r = assertOk(await rdb.from('activity_speakers').update(payload)
    .eq('id', id).is('deleted_at', null).select('id'));
  if (!r.data || !r.data.length) return { error: 'speaker not found' };
  return { ok: true };
}

// 软删除（资源池数据可复用，不物理删除）
async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  assertOk(await rdb.from('activity_speakers')
    .update({ deleted_at: nowIso(), updated_at: nowIso() })
    .eq('id', id));
  return { ok: true };
}

// 联想搜索（供 openPersonPickerModal 下拉）：姓名/机构/专业/主题
async function search(event) {
  const kw = String(event.keyword || '').trim();
  if (kw.length < 1) return { rows: [] };
  // 供添加参与者联想：仅返回启用中的嘉宾（停用嘉宾不在管理页 list 过滤，但不可加入活动）
  const r = assertOk(await rdb.from('activity_speakers')
    .select('id, name, organization, position, phone, expertise, topic_summary')
    .or(kwOrCond(kw))
    .is('deleted_at', null)
    .eq('status', 'active')
    .limit(10));
  return { rows: r.data || [] };
}
