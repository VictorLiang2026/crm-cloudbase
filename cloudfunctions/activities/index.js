/**
 * activities — 轻量活动经营 CRUD（事件云函数，rdb() 版）
 * 入参 event: { action, ... }
 *   list:        { action:'list' } → { rows }（活动列表，倒序）
 *   get:         { action:'get', id } → { activity, participants }（活动详情+参与者）
 *   create:      { action:'create', data:{ name, activity_date?, activity_type?, location?, description? } } → { id }
 *   update:      { action:'update', id, data:{...} } → { ok }
 *   remove:      { action:'remove', id } → { ok }（软删除）
 *   addParticipant:     { action:'addParticipant', data:{ activity_id, person_type, person_id?, person_name?, status?, relationship_note? } }
 *                         person_id 有值=关联已有客户/增员（回填 person_name）；无值=按姓名暂存，待后续 linkParticipant 关联
 *   searchPerson:       { action:'searchPerson', person_type, keyword } → { rows:[{id, name, occupation, phone?}] }（姓名/电话模糊，上限10）
 *   linkParticipant:    { action:'linkParticipant', id（participant 记录 id）, person_id } → { ok }（暂存记录关联到已有人员，回填姓名）
 *   updateParticipant:  { action:'updateParticipant', id, data:{ status?, relationship_note?, ai_followup_suggestion? } } → { ok }
 *   removeParticipant:  { action:'removeParticipant', id } → { ok }（软删除）
 *   listByPerson: { action:'listByPerson', person_type, person_id } → { rows }（某客户/增员参加的所有活动）
 */
'use strict';

const { rdb, nowIso, normFields, assertOk } = require('./db');

const ACT_FIELDS = ['name', 'activity_date', 'activity_type', 'location', 'description',
  'status', 'goal_types', 'target_participants', 'actual_participants', 'topic_ids',
  'review_summary', 'review_notes', 'review_score', 'reviewed_at'];
const PART_FIELDS = ['activity_id', 'person_type', 'person_id', 'person_name', 'status', 'relationship_note', 'ai_followup_suggestion',
  'participant_role', 'followup_status'];
var PT_ENUM = ['customer', 'recruit', 'speaker'];
var ST_ENUM = ['invited', 'attended', 'absent'];
var ACT_STATUS_ENUM = ['idea', 'preparing', 'confirmed', 'in_progress', 'ended', 'reviewed'];
var PARTICIPANT_ROLE_ENUM = ['attendee', 'speaker', 'organizer', 'partner', 'guest'];
var FOLLOWUP_STATUS_ENUM = ['none', 'pending', 'done', 'not_needed'];

// 人员表映射：customers 主键 Id、姓名 customer_name；recruit_candidates 主键 id、姓名 name
function personTable(pt) {
  return pt === 'recruit'
    ? { table: 'recruit_candidates', idCol: 'id', nameCol: 'name' }
    : { table: 'customers', idCol: 'Id', nameCol: 'customer_name' };
}

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list':            return await list(event);
      case 'get':             return await get(event);
      case 'create':          return await create(event);
      case 'update':          return await update(event);
      case 'updateStatus':    return await updateStatus(event);
      case 'getSummary':      return await getSummary(event);
      case 'remove':          return await remove(event);
      case 'addParticipant':     return await addParticipant(event);
      case 'searchPerson':      return await searchPerson(event);
      case 'linkParticipant':   return await linkParticipant(event);
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
  const parts = await enrichParticipants(p.data || []);
  return { activity: a.data, participants: parts };
}

// 老记录 person_name 为空但已关联 person_id 时，批量从客户/增员表回填姓名
async function enrichParticipants(parts) {
  const needByType = { customer: [], recruit: [] };
  parts.forEach(function (it) {
    if (it.person_id && !it.person_name && needByType[it.person_type]) {
      needByType[it.person_type].push(it.person_id);
    }
  });
  const nameMap = {};
  for (const pt of PT_ENUM) {
    const ids = needByType[pt];
    if (!ids || !ids.length) continue;
    const cfg = personTable(pt);
    const q = await rdb.from(cfg.table).select(cfg.idCol + ',' + cfg.nameCol)
      .in(cfg.idCol, ids).is('deleted_at', null);
    (q.data || []).forEach(function (row) { nameMap[pt + ':' + row[cfg.idCol]] = row[cfg.nameCol]; });
  }
  if (Object.keys(nameMap).length) {
    // 回填内存对象，并顺手补写数据库（fire-and-forget）
    parts.forEach(function (it) {
      const nm = nameMap[it.person_type + ':' + it.person_id];
      if (nm) {
        it.person_name = nm;
        rdb.from('activity_participants').update({ person_name: nm }).eq('id', it.id);
      }
    });
  }
  return parts;
}

async function create(event) {
  const data = Object.assign({}, event.data || {});
  if (!data.name) return { error: 'name required' };
  // 校验 status
  if (data.status && ACT_STATUS_ENUM.indexOf(data.status) < 0) return { error: '无效 status，允许: ' + ACT_STATUS_ENUM.join('/') };
  // goal_types 字符串 → 数组
  if (typeof data.goal_types === 'string') {
    data.goal_types = data.goal_types.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  }
  // 校验 target/actual participants
  if (data.target_participants != null) {
    data.target_participants = parseInt(data.target_participants, 10);
    if (isNaN(data.target_participants) || data.target_participants < 0) return { error: 'target_participants 必须是非负整数' };
  }
  data.created_at = nowIso();
  data.updated_at = nowIso();
  const payload = normFields(data, ACT_FIELDS.concat(['created_at', 'updated_at']));
  const r = assertOk(await rdb.from('activities').insert(payload).select('id'));
  return { id: r.data[0].id };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const data = Object.assign({}, event.data || {});
  // 校验 status
  if (data.status && ACT_STATUS_ENUM.indexOf(data.status) < 0) return { error: '无效 status，允许: ' + ACT_STATUS_ENUM.join('/') };
  // 校验 goal_types（字符串 → 数组）
  if (typeof data.goal_types === 'string') {
    data.goal_types = data.goal_types.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  }
  if (Array.isArray(data.goal_types) && !data.goal_types.every(function(g){ return typeof g === 'string'; })) {
    return { error: 'goal_types 必须是字符串数组' };
  }
  // 校验 target/actual participants
  if (data.target_participants != null) {
    data.target_participants = parseInt(data.target_participants, 10);
    if (isNaN(data.target_participants) || data.target_participants < 0) return { error: 'target_participants 必须是非负整数' };
  }
  if (data.actual_participants != null) {
    data.actual_participants = parseInt(data.actual_participants, 10);
    if (isNaN(data.actual_participants) || data.actual_participants < 0) return { error: 'actual_participants 必须是非负整数' };
  }
  // 校验 review_score
  if (data.review_score != null) {
    data.review_score = parseInt(data.review_score, 10);
    if (isNaN(data.review_score) || data.review_score < 1 || data.review_score > 5) return { error: 'review_score 必须是 1-5' };
  }
  const payload = normFields(
    Object.assign({}, data, { updated_at: nowIso() }),
    ACT_FIELDS.concat(['updated_at'])
  );
  if (!Object.keys(payload).length) return { ok: true, updated: false };
  const r = assertOk(await rdb.from('activities').update(payload).eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}

// 更新活动状态（切到 reviewed 时自动记录 reviewed_at）
async function updateStatus(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const status = event.status;
  if (!status || ACT_STATUS_ENUM.indexOf(status) < 0) return { error: '无效的 status，允许: ' + ACT_STATUS_ENUM.join('/') };
  const payload = { status: status, updated_at: nowIso() };
  if (status === 'reviewed') payload.reviewed_at = nowIso();
  const r = assertOk(await rdb.from('activities').update(payload).eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}

// 活动摘要：基础信息 + 参与者人数统计（按角色/按跟进状态）
async function getSummary(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const a = assertOk(await rdb.from('activities').select()
    .eq('id', id).is('deleted_at', null).maybeSingle());
  if (!a.data) return { error: 'activity not found' };
  const activity = a.data;
  // 统计参与者人数
  const p = assertOk(await rdb.from('activity_participants').select('id, participant_role, followup_status')
    .eq('activity_id', id).is('deleted_at', null));
  const parts = p.data || [];
  const participant_counts = {
    total: parts.length,
    by_role: {},
    by_followup_status: {},
  };
  PARTICIPANT_ROLE_ENUM.forEach(function (r) { participant_counts.by_role[r] = 0; });
  FOLLOWUP_STATUS_ENUM.forEach(function (r) { participant_counts.by_followup_status[r] = 0; });
  parts.forEach(function (it) {
    if (it.participant_role && participant_counts.by_role[it.participant_role] !== undefined) {
      participant_counts.by_role[it.participant_role]++;
    } else if (!it.participant_role) {
      participant_counts.by_role.attendee++;
    }
    if (it.followup_status && participant_counts.by_followup_status[it.followup_status] !== undefined) {
      participant_counts.by_followup_status[it.followup_status]++;
    } else if (!it.followup_status) {
      participant_counts.by_followup_status.none++;
    }
  });
  return { activity: activity, participant_counts: participant_counts };
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

// 搜索人员（姓名/电话模糊），供前端添加参与者时联想
async function searchPerson(event) {
  const pt = event.person_type;
  if (PT_ENUM.indexOf(pt) < 0) return { error: '无效的 person_type' };
  const kw = String(event.keyword || '').trim();
  if (kw.length < 1) return { rows: [] };
  const cfg = personTable(pt);
  // 转义 postgrest 保留字符
  const safeKw = kw.replace(/[%,_()\\]/g, function (c) { return '\\' + c; });
  let q = rdb.from(cfg.table)
    .select(cfg.idCol + ', ' + cfg.nameCol + (pt === 'customer' ? ', occupation, phone' : ', occupation'))
    .is('deleted_at', null);
  // 姓名模糊；客户额外支持电话匹配（仅当关键词含数字时才加电话条件，避免 ilike '%%' 匹配全部）
  let orCond = cfg.nameCol + '.ilike.%' + safeKw + '%';
  if (pt === 'customer') {
    const digits = kw.replace(/[^0-9]/g, '');
    if (digits) orCond += ',phone.ilike.%' + digits + '%';
  }
  q = q.or(orCond);
  const r = assertOk(await q.limit(10));
  const rows = (r.data || []).map(function (row) {
    return {
      id: row[cfg.idCol],
      name: row[cfg.nameCol],
      occupation: row.occupation || '',
      phone: row.phone || '',
    };
  });
  return { rows: rows };
}

async function addParticipant(event) {
  const data = Object.assign({}, event.data || {});
  if (PT_ENUM.indexOf(data.person_type) < 0) return { error: '无效的 person_type' };
  if (!data.activity_id) return { error: 'activity_id required' };
  // 检查活动存在
  const a = assertOk(await rdb.from('activities').select('id').eq('id', data.activity_id).is('deleted_at', null).maybeSingle());
  if (!a.data) return { error: 'activity not found' };

  const cfg = personTable(data.person_type);
  var pid = parseInt(data.person_id, 10);
  if (pid) {
    // 关联已有人员：校验存在并回填姓名
    const p = assertOk(await rdb.from(cfg.table).select(cfg.idCol + ', ' + cfg.nameCol)
      .eq(cfg.idCol, pid).is('deleted_at', null).maybeSingle());
    if (!p.data) return { error: '未找到该' + (data.person_type === 'customer' ? '客户' : '增员对象') };
    data.person_id = pid;
    data.person_name = p.data[cfg.nameCol];
    // 去重：同一活动同一人不重复添加
    const dup = assertOk(await rdb.from('activity_participants').select('id')
      .eq('activity_id', data.activity_id).eq('person_type', data.person_type)
      .eq('person_id', pid).is('deleted_at', null));
    if (dup.data && dup.data.length) return { error: '已添加该参与者', id: dup.data[0].id };
  } else {
    // 未关联：按姓名暂存，待后续 linkParticipant 关联
    data.person_id = null;
    data.person_name = String(data.person_name || '').trim();
    if (!data.person_name) return { error: '请填写姓名，或从搜索结果中选择已有客户/增员对象' };
    // 去重：同活动同类型同名暂存记录不重复
    const dup = assertOk(await rdb.from('activity_participants').select('id')
      .eq('activity_id', data.activity_id).eq('person_type', data.person_type)
      .is('person_id', null).eq('person_name', data.person_name).is('deleted_at', null));
    if (dup.data && dup.data.length) return { error: '已添加该参与者（待关联）', id: dup.data[0].id };
  }
  if (!data.status) data.status = 'invited';
  if (data.participant_role && PARTICIPANT_ROLE_ENUM.indexOf(data.participant_role) < 0) return { error: '无效 participant_role' };
  if (!data.participant_role) data.participant_role = 'attendee';
  if (!data.followup_status) data.followup_status = 'none';
  data.created_at = nowIso();
  const payload = normFields(data, PART_FIELDS.concat(['created_at']));
  const r = assertOk(await rdb.from('activity_participants').insert(payload).select('id'));
  return { id: r.data[0].id, linked: !!pid };
}

// 暂存参与者关联到已有人员
async function linkParticipant(event) {
  const id = parseInt(event.id, 10);
  const pid = parseInt(event.person_id, 10);
  if (!id || !pid) return { error: 'id 和 person_id 必填' };
  const rec = assertOk(await rdb.from('activity_participants').select()
    .eq('id', id).is('deleted_at', null).maybeSingle());
  if (!rec.data) return { error: '参与者记录不存在' };
  if (rec.data.person_id) return { error: '该参与者已关联' };
  if (PT_ENUM.indexOf(rec.data.person_type) < 0) return { error: '参与者类型无效' };
  const cfg = personTable(rec.data.person_type);
  const p = assertOk(await rdb.from(cfg.table).select(cfg.idCol + ', ' + cfg.nameCol)
    .eq(cfg.idCol, pid).is('deleted_at', null).maybeSingle());
  if (!p.data) return { error: '未找到该' + (rec.data.person_type === 'customer' ? '客户' : '增员对象') };
  // 同活动同人已关联则不重复
  const dup = assertOk(await rdb.from('activity_participants').select('id')
    .eq('activity_id', rec.data.activity_id).eq('person_type', rec.data.person_type)
    .eq('person_id', pid).is('deleted_at', null));
  if (dup.data && dup.data.length) return { error: '该人员已在活动参与者中' };
  const r = assertOk(await rdb.from('activity_participants')
    .update({ person_id: pid, person_name: p.data[cfg.nameCol] })
    .eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1, name: p.data[cfg.nameCol] };
}

async function updateParticipant(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const data = Object.assign({}, event.data || {});
  if (data.status && ST_ENUM.indexOf(data.status) < 0) return { error: '无效 status' };
  if (data.participant_role && PARTICIPANT_ROLE_ENUM.indexOf(data.participant_role) < 0) return { error: '无效 participant_role' };
  if (data.followup_status && FOLLOWUP_STATUS_ENUM.indexOf(data.followup_status) < 0) return { error: '无效 followup_status' };
  const payload = normFields(
    Object.assign({}, data, { updated_at: nowIso() }),
    ['status', 'relationship_note', 'ai_followup_suggestion', 'participant_role', 'followup_status', 'updated_at']
  );
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
