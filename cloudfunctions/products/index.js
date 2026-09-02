/**
 * products — 保险额度（每客户一行，upsert）（事件云函数，rdb() 版）
 * 入参 event: { action, ... }
 *   list:   { action:'list', customer_id } → { rows }（通常 0 或 1 行）
 *   upsert: { action:'upsert', data:{ customer_id, customer_name?, items?, ap_ipa, ap_ppa, ap_ltc, ap_ann, ap_life, ap_term, ap_wl, ap_pa, ap_ci, ap_hi, ap_all } } → { id }
 *   remove: { action:'remove', id } → { ok }（硬删除）
 * ap_* 均为 bigint，空串转 null；items 为 text（11 个险种类别的二维明细 JSON：
 *   [{key,label,amount,premium,pay_years,paid_years,update_date}, ...]），
 *   ap_* 扁平保额列与 items.amount 保持同步，供 AI 建议等旧逻辑继续使用。
 */
'use strict';

const { rdb, normFields, assertOk } = require('./db');

const FIELDS = [
  'customer_id', 'customer_name', 'items',
  'ap_ipa', 'ap_ppa', 'ap_ltc', 'ap_ann', 'ap_life', 'ap_term',
  'ap_wl', 'ap_pa', 'ap_ci', 'ap_hi', 'ap_all',
];

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list':   return await list(event);
      case 'upsert': return await upsert(event);
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
  const r = assertOk(await rdb.from('products').select().eq('customer_id', customerId));
  return { rows: r.data || [] };
}

async function upsert(event) {
  const data = Object.assign({}, event.data || {});
  const customerId = parseInt(data.customer_id, 10);
  if (!customerId) return { error: 'customer_id required' };
  if (!data.customer_name) {
    const c = assertOk(await rdb.from('customers').select('customer_name').eq('Id', customerId).maybeSingle());
    if (!c.data) return { error: 'customer not found' };
    data.customer_name = c.data.customer_name;
  }
  const payload = normFields(data, FIELDS);
  const existing = assertOk(await rdb.from('products').select('id').eq('customer_id', customerId).maybeSingle());
  if (existing.data) {
    const id = existing.data.id;
    if (Object.keys(payload).length) {
      assertOk(await rdb.from('products').update(payload).eq('id', id).select('id'));
    }
    return { id: id };
  }
  if (!Object.keys(payload).length) return { error: 'no valid fields' };
  const r = assertOk(await rdb.from('products').insert(payload).select('id'));
  return { id: r.data[0].id };
}

async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('products').delete().eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}
