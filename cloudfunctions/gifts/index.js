/**
 * gifts — 伴手礼 CRUD（事件云函数，rdb() 版）
 * 入参 event: { action, ... }
 *   list:   { action:'list', customer_id } → { rows }
 *   create: { action:'create', data:{ customer_id, customer_name?, gift_name, quantity, notes, given_date } } → { id }
 *   update: { action:'update', id, data:{...} } → { ok }
 *   remove: { action:'remove', id } → { ok }（硬删除）
 * gifts.created_at 有默认 now()；无 updated_at 列。
 */
'use strict';

const { rdb, normFields, assertOk } = require('./db');

const FIELDS = ['customer_id', 'customer_name', 'gift_name', 'quantity', 'notes', 'given_date'];

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
  const r = assertOk(await rdb.from('gifts').select().eq('customer_id', customerId).is('deleted_at', null)
    .order('given_date', { ascending: false, nullsFirst: false })
    .order('Id', { ascending: false }));
  return { rows: r.data || [] };
}

async function create(event) {
  const data = Object.assign({}, event.data || {});
  const customerId = parseInt(data.customer_id, 10);
  if (!customerId) return { error: 'customer_id required' };
  if (!data.gift_name) return { error: 'gift_name required' };
  if (!data.customer_name) {
    const c = assertOk(await rdb.from('customers').select('customer_name').eq('Id', customerId).maybeSingle());
    if (!c.data) return { error: 'customer not found' };
    data.customer_name = c.data.customer_name;
  }
  const payload = normFields(data, FIELDS);
  if (!Object.keys(payload).length) return { error: 'no valid fields' };
  const r = assertOk(await rdb.from('gifts').insert(payload).select('Id'));
  return { id: r.data[0].Id };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const payload = normFields(event.data || {}, FIELDS);
  if (!Object.keys(payload).length) return { ok: true, updated: false };
  const r = assertOk(await rdb.from('gifts').update(payload).eq('Id', id).select('Id'));
  return { ok: (r.data || []).length === 1 };
}

async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('gifts').delete().eq('Id', id).select('Id'));
  return { ok: (r.data || []).length === 1 };
}
