/**
 * activity_tasks — 活动待办任务 CRUD（事件云函数，rdb() 版）
 * 任务是活动的子记录（硬删除，无 deleted_at）；不进全局 task center
 * 入参 event: { action, ... }
 *   list:     { action:'list', activity_id, status? } → { rows }（按活动查，可选状态筛选；未完成在前→due_date 升序→创建时间）
 *   get:      { action:'get', id } → { task }
 *   create:   { action:'create', data:{ activity_id, task_title, task_type?, status?, priority?, due_date?, related_type?, related_id?, note? } } → { id }
 *   update:   { action:'update', id, data:{...} } → { ok }
 *   complete: { action:'complete', id } → { ok }（status=completed + completed_at）
 *   skip:     { action:'skip', id } → { ok }（status=skipped + completed_at）
 *   remove:   { action:'remove', id } → { ok }（硬删除）
 * 关联人回填：related_type=customer → customers.customer_name；recruit → recruit_candidates.name（speaker/activity v1 不回填）
 */
'use strict';

const { rdb, nowIso, normFields, assertOk } = require('./db');

const TASK_FIELDS = ['activity_id', 'task_title', 'task_type', 'status', 'priority',
  'due_date', 'completed_at', 'related_type', 'related_id', 'note', 'source'];
var TYPE_ENUM = ['preparation', 'invitation', 'speaker', 'onsite', 'followup', 'review', 'other'];
var STATUS_ENUM = ['pending', 'in_progress', 'completed', 'skipped'];
var PRIORITY_ENUM = ['high', 'medium', 'low'];
var RELATED_ENUM = ['none', 'customer', 'recruit', 'speaker', 'activity'];
var SOURCE_ENUM = ['manual', 'ai', 'template'];
// 未完成状态（排序时排前面）
var OPEN_STATUS = ['pending', 'in_progress'];

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list':     return await list(event);
      case 'get':      return await get(event);
      case 'create':   return await create(event);
      case 'update':   return await update(event);
      case 'complete': return await complete(event, 'completed');
      case 'skip':     return await complete(event, 'skipped');
      case 'remove':   return await remove(event);
      default: return { error: 'unknown action: ' + action };
    }
  } catch (e) {
    return { error: e.message };
  }
};

// 校验活动存在且未删除
async function assertActivity(activityId) {
  const id = parseInt(activityId, 10);
  if (!id) return { error: 'activity_id required' };
  const a = assertOk(await rdb.from('activities').select('id, name')
    .eq('id', id).is('deleted_at', null).maybeSingle());
  if (!a.data) return { error: 'activity not found' };
  return { id: id };
}

// 批量回填关联人姓名（customer / recruit）
async function enrichRelated(rows) {
  const customerIds = [];
  const recruitIds = [];
  rows.forEach(function (t) {
    if (t.related_type === 'customer' && t.related_id) customerIds.push(t.related_id);
    else if (t.related_type === 'recruit' && t.related_id) recruitIds.push(t.related_id);
  });
  const nameMap = {};
  if (customerIds.length) {
    const cs = assertOk(await rdb.from('customers').select('Id, customer_name')
      .in('Id', customerIds).is('deleted_at', null)).data || [];
    cs.forEach(function (c) { nameMap['customer:' + c.Id] = c.customer_name; });
  }
  if (recruitIds.length) {
    const rs = assertOk(await rdb.from('recruit_candidates').select('id, name')
      .in('id', recruitIds).is('deleted_at', null)).data || [];
    rs.forEach(function (r) { nameMap['recruit:' + r.id] = r.name; });
  }
  return rows.map(function (t) {
    t.related_name = (t.related_type === 'customer' || t.related_type === 'recruit')
      ? (nameMap[t.related_type + ':' + t.related_id] || null)
      : null;
    return t;
  });
}

// 排序：未完成在前 → due_date 升序（null 最后）→ created_at 升序
function sortTasks(rows) {
  return rows.sort(function (a, b) {
    var aOpen = OPEN_STATUS.indexOf(a.status) >= 0 ? 0 : 1;
    var bOpen = OPEN_STATUS.indexOf(b.status) >= 0 ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    // due_date：有日期在前（升序），null 最后
    if (a.due_date && b.due_date) {
      if (a.due_date < b.due_date) return -1;
      if (a.due_date > b.due_date) return 1;
    } else if (a.due_date && !b.due_date) return -1;
    else if (!a.due_date && b.due_date) return 1;
    return (a.created_at < b.created_at ? -1 : (a.created_at > b.created_at ? 1 : 0));
  });
}

async function list(event) {
  const activityId = parseInt(event.activity_id, 10);
  if (!activityId) return { error: 'activity_id required' };
  let q = rdb.from('activity_tasks').select()
    .eq('activity_id', activityId)
    .order('created_at', { ascending: true });
  if (event.status) {
    if (STATUS_ENUM.indexOf(event.status) < 0) return { error: '无效 status' };
    q = q.eq('status', event.status);
  }
  const r = assertOk(await q);
  let rows = r.data || [];
  rows = await enrichRelated(rows);
  // 状态筛选时保持筛选集；不筛选时全量排序
  if (!event.status) rows = sortTasks(rows);
  return { rows: rows };
}

async function get(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('activity_tasks').select()
    .eq('id', id).maybeSingle());
  if (!r.data) return { error: 'task not found' };
  const rows = await enrichRelated([r.data]);
  return { task: rows[0] };
}

async function create(event) {
  const data = Object.assign({}, event.data || {});
  if (!data.task_title || !String(data.task_title).trim()) return { error: 'task_title required' };
  const chk = await assertActivity(data.activity_id);
  if (chk.error) return chk;
  data.activity_id = chk.id;
  // 枚举校验
  if (data.task_type && TYPE_ENUM.indexOf(data.task_type) < 0) return { error: '无效 task_type' };
  if (data.status && STATUS_ENUM.indexOf(data.status) < 0) return { error: '无效 status' };
  if (data.priority && PRIORITY_ENUM.indexOf(data.priority) < 0) return { error: '无效 priority' };
  if (data.related_type) {
    if (RELATED_ENUM.indexOf(data.related_type) < 0) return { error: '无效 related_type' };
  } else {
    data.related_type = 'none';
  }
  if (data.source && SOURCE_ENUM.indexOf(data.source) < 0) return { error: '无效 source' };
  // related_type=none 时 related_id 置空
  if (data.related_type === 'none') data.related_id = null;
  // related_id 转整数
  if (data.related_id != null && data.related_id !== '') {
    data.related_id = parseInt(data.related_id, 10);
    if (isNaN(data.related_id)) return { error: 'related_id 必须是整数' };
  } else {
    data.related_id = null;
  }
  data.created_at = nowIso();
  data.updated_at = nowIso();
  const payload = normFields(data, TASK_FIELDS.concat(['created_at', 'updated_at']));
  const r = assertOk(await rdb.from('activity_tasks').insert(payload).select('id'));
  return { id: r.data[0].id };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const data = Object.assign({}, event.data || {});
  // 不允许通过 update 改 activity_id（任务归属活动不可变）
  delete data.activity_id;
  if (data.task_type && TYPE_ENUM.indexOf(data.task_type) < 0) return { error: '无效 task_type' };
  if (data.status && STATUS_ENUM.indexOf(data.status) < 0) return { error: '无效 status' };
  if (data.priority && PRIORITY_ENUM.indexOf(data.priority) < 0) return { error: '无效 priority' };
  if (data.related_type) {
    if (RELATED_ENUM.indexOf(data.related_type) < 0) return { error: '无效 related_type' };
    if (data.related_type === 'none') data.related_id = null;
  }
  if (data.source && SOURCE_ENUM.indexOf(data.source) < 0) return { error: '无效 source' };
  if (data.related_id != null && data.related_id !== '') {
    data.related_id = parseInt(data.related_id, 10);
    if (isNaN(data.related_id)) return { error: 'related_id 必须是整数' };
  } else if (data.related_id === '') {
    data.related_id = null;
  }
  // 改为未完成状态时清空 completed_at
  if (data.status && OPEN_STATUS.indexOf(data.status) >= 0) data.completed_at = null;
  data.updated_at = nowIso();
  const payload = normFields(data, TASK_FIELDS.concat(['updated_at']));
  if (!Object.keys(payload).length) return { ok: true, updated: false };
  const r = assertOk(await rdb.from('activity_tasks').update(payload).eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}

// complete / skip 共用
async function complete(event, newStatus) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const payload = { status: newStatus, completed_at: nowIso(), updated_at: nowIso() };
  const r = assertOk(await rdb.from('activity_tasks').update(payload).eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}

async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('activity_tasks').delete().eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}
