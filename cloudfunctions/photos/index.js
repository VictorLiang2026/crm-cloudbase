/**
 * photos — 照片/附件存储（base64 存 photos 表）（事件云函数，rdb() 版）
 * 入参 event: { action, ... }
 *   list:   { action:'list', customer_id, category? } → { rows }（仅元数据，不含 base64；category 可选过滤 'photo'|'attachment'）
 *   get:    { action:'get', id } → { photo }（含 photo_url，即 data:...;base64,...）
 *   create: { action:'create', data:{ customer_id, customer_name?, image_base64, file_name?, content_type?, photo_notes?, category? } } → { id }
 *   update: { action:'update', id, data:{ photo_notes? } } → { ok }
 *   remove: { action:'remove', id } → { ok }（硬删除）
 *
 * category: 'photo'（默认，照片）| 'attachment'（附件）。照片与附件共用本表，靠 category 区分。
 */
'use strict';

const { rdb, assertOk } = require('./db');

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list':   return await list(event);
      case 'get':    return await get(event);
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
  let q = rdb.from('photos')
    .select('id, customer_id, customer_name, file_name, content_type, sort_order, created_at, photo_notes, category')
    .eq('customer_id', customerId).is('deleted_at', null);
  const category = event.category;
  if (category === 'photo' || category === 'attachment') {
    q = q.eq('category', category);
  }
  const r = assertOk(await q
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true }));
  return { rows: r.data || [] };
}

async function get(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('photos').select().eq('id', id).maybeSingle());
  if (!r.data) return { error: 'not found' };
  return { photo: r.data };
}

async function create(event) {
  const data = event.data || {};
  const customerId = parseInt(data.customer_id, 10);
  if (!customerId) return { error: 'customer_id required' };
  const imageBase64 = data.image_base64;
  if (!imageBase64) return { error: 'image_base64 required' };
  let customerName = data.customer_name;
  if (!customerName) {
    const c = assertOk(await rdb.from('customers').select('customer_name').eq('Id', customerId).maybeSingle());
    if (!c.data) return { error: 'customer not found' };
    customerName = c.data.customer_name;
  }
  const category = data.category === 'attachment' ? 'attachment' : 'photo';
  const contentType = data.content_type || (category === 'photo' ? 'image/jpeg' : 'application/octet-stream');
  const fileName = data.file_name || (category === 'photo' ? 'photo.jpg' : 'file');
  const dataUrl = 'data:' + contentType + ';base64,' + imageBase64;
  const payload = {
    customer_id: customerId,
    customer_name: customerName,
    photo_url: dataUrl,
    file_name: fileName,
    content_type: contentType,
    sort_order: 0,
    photo_notes: data.photo_notes || null,
    category: category,
  };
  const r = assertOk(await rdb.from('photos').insert(payload).select('id'));
  if (r.data && r.data[0]) return { id: r.data[0].id };
  const back = assertOk(await rdb.from('photos').select('id')
    .eq('customer_id', customerId)
    .order('id', { ascending: false })
    .limit(1));
  return { id: back.data && back.data[0] ? back.data[0].id : null };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const data = event.data || {};
  const payload = {};
  if (Object.prototype.hasOwnProperty.call(data, 'photo_notes')) {
    payload.photo_notes = data.photo_notes || null;
  }
  if (!Object.keys(payload).length) return { error: 'no fields to update' };
  const r = assertOk(await rdb.from('photos').update(payload).eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}

async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('photos').delete().eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}
