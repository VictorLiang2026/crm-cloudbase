/**
 * photos — 照片存储（base64 存 photos 表，不调多模态，不开云存储匿名登录）（事件云函数，rdb() 版）
 * 入参 event: { action, ... }
 *   list:   { action:'list', customer_id } → { rows }（仅元数据，不含 base64）
 *   get:    { action:'get', id } → { photo }（含 photo_url，即 data:image/...;base64,...）
 *   create: { action:'create', data:{ customer_id, customer_name?, image_base64, file_name?, content_type? } } → { id }
 *   remove: { action:'remove', id } → { ok }（硬删除）
 *
 * photos.id 已建序列默认值 photos_id_seq（migration 20260819…），insert 省略 id 由默认值生成。
 * photo_url 存 data URL（data:${content_type};base64,${base64}），可直接 <img src>。
 * list 不返回 photo_url（避免 base64 膨胀），需单独 get 取图。
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
  const r = assertOk(await rdb.from('photos')
    .select('id, customer_id, customer_name, file_name, content_type, sort_order, created_at')
    .eq('customer_id', customerId)
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
  const contentType = data.content_type || 'image/jpeg';
  const fileName = data.file_name || 'photo.jpg';
  const dataUrl = 'data:' + contentType + ';base64,' + imageBase64;
  const payload = {
    customer_id: customerId,
    customer_name: customerName,
    photo_url: dataUrl,
    file_name: fileName,
    content_type: contentType,
    sort_order: 0,
  };
  const r = assertOk(await rdb.from('photos').insert(payload).select('id'));
  if (r.data && r.data[0]) return { id: r.data[0].id };
  // 兜底：个别网关版本不回传插入行，取该客户最新一条
  const back = assertOk(await rdb.from('photos').select('id')
    .eq('customer_id', customerId)
    .order('id', { ascending: false })
    .limit(1));
  return { id: back.data && back.data[0] ? back.data[0].id : null };
}

async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('photos').delete().eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}
