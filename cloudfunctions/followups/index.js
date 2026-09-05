/**
 * followups — 跟进记录 CRUD（事件云函数，rdb() 版）
 * 入参 event: { action, ... }
 *   list:   { action:'list', customer_id } → { rows }
 *   create: { action:'create', data:{ customer_id, customer_name?, followup_notes, followup_date, next_followup_date, next_followup_goal } } → { id }
 *   update: { action:'update', id, data:{...} } → { ok }
 *   remove: { action:'remove', id } → { ok }（硬删除）
 * 注意：followups.created_at / updated_at 无默认值，create 时手动写入。
 */
'use strict';

const { rdb, nowIso, normFields, assertOk } = require('./db');

const FIELDS = [
  'customer_id', 'customer_name', 'followup_notes', 'followup_date',
  'next_followup_date', 'next_followup_goal',
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
  const customerId = parseInt(event.customer_id, 10);
  if (!customerId) return { error: 'customer_id required' };
  const r = assertOk(await rdb.from('followups').select().eq('customer_id', customerId).is('deleted_at', null)
    .order('followup_date', { ascending: false, nullsFirst: false })
    .order('Id', { ascending: false }));
  return { rows: r.data || [] };
}

async function create(event) {
  const data = Object.assign({}, event.data || {});
  const customerId = parseInt(data.customer_id, 10);
  if (!customerId) return { error: 'customer_id required' };
  if (!data.customer_name) {
    const c = assertOk(await rdb.from('customers').select('customer_name').eq('Id', customerId).maybeSingle());
    if (!c.data) return { error: 'customer not found' };
    data.customer_name = c.data.customer_name;
  }
  data.created_at = nowIso();
  data.updated_at = nowIso();
  const payload = normFields(data, FIELDS.concat(['created_at', 'updated_at']));
  if (!Object.keys(payload).length) return { error: 'no valid fields' };
  const r = assertOk(await rdb.from('followups').insert(payload).select('Id'));
  return { id: r.data[0].Id };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const payload = normFields(
    Object.assign({}, event.data || {}, { updated_at: nowIso() }),
    FIELDS.concat(['updated_at'])
  );
  if (!Object.keys(payload).length) return { ok: true, updated: false };
  const r = assertOk(await rdb.from('followups').update(payload).eq('Id', id).select('Id'));
  return { ok: (r.data || []).length === 1 };
}

async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('followups').delete().eq('Id', id).select('Id'));
  return { ok: (r.data || []).length === 1 };
}
