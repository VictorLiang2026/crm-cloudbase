/**
 * customers — 客户 CRUD（事件云函数，rdb() 版）
 * 入参 event: { action, ... }
 *   list:   { action:'list', page?, pageSize?, keyword? } → { rows, total, page, pageSize }
 *   get:    { action:'get', id } → { customer, followups, products, gifts, photos, recommendations }
 *   create: { action:'create', data:{...} } → { id }
 *   update: { action:'update', id, data:{...} } → { ok }
 *   remove: { action:'remove', id } → { ok }（软删除 deleted_at）
 * photos 仅返回元数据（不含 base64），需单独调 photos.get 取图。
 */
'use strict';

const { rdb, nowIso, normFields, assertOk } = require('./db');

const FIELDS = [
  'customer_name', 'sales_priority', 'recruitment_priority', 'referral_priority',
  'hobbies', 'additional_info', 'gender', 'source', 'tags', 'marital_status',
  'properties_info', 'occupation', 'annual_income', 'household_income',
  'first_contact_date', 'birthday', 'customer_stage', 'phone',
];

const LIST_COLS = 'Id, customer_name, phone, occupation, customer_stage, sales_priority, recruitment_priority, referral_priority, birthday, first_contact_date, created_at, updated_at';

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
  const page = Math.max(1, parseInt(event.page || 1, 10));
  const pageSize = Math.min(1000, Math.max(1, parseInt(event.pageSize || 20, 10)));
  const keyword = (event.keyword || '').trim();
  const sortField = event.sortField || 'Id';
  const sortDir = event.sortDir || 'desc';

  // 查全部未删除客户
  const custRes = assertOk(await rdb.from('customers')
    .select(LIST_COLS)
    .is('deleted_at', null));
  let rows = custRes.data || [];

  // 查全部跟进记录，取每个客户最新一条
  let followups = [];
  try {
    const folRes = assertOk(await rdb.from('followups')
      .select('customer_id, followup_date, next_followup_date')
      .order('followup_date', { ascending: false, nullsFirst: false })
      .order('Id', { ascending: false }));
    followups = folRes.data || [];
  } catch(e) { /* followups 查询失败不阻塞客户列表 */ }

  const latestFol = {};
  for (const f of followups) {
    if (!latestFol[f.customer_id]) latestFol[f.customer_id] = f;
  }

  // 合并最新跟进日期到客户行
  for (const r of rows) {
    const fol = latestFol[r.Id];
    r.latest_followup_date = fol ? fol.followup_date : null;
    r.next_followup_date = fol ? fol.next_followup_date : null;
  }

  // 关键词过滤（部分匹配，不区分大小写）
  if (keyword) {
    const kw = keyword.toLowerCase();
    rows = rows.filter(r =>
      (r.customer_name && r.customer_name.toLowerCase().includes(kw)) ||
      (r.phone && r.phone.includes(kw)) ||
      (r.occupation && r.occupation.toLowerCase().includes(kw))
    );
  }

  // 排序
  const ascending = sortDir !== 'desc';
  rows.sort((a, b) => {
    let va = a[sortField], vb = b[sortField];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return ascending ? -1 : 1;
    if (va > vb) return ascending ? 1 : -1;
    return 0;
  });

  // 分页
  const total = rows.length;
  const offset = (page - 1) * pageSize;
  const pageRows = rows.slice(offset, offset + pageSize);

  return { rows: pageRows, total, page, pageSize };
}

async function get(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const c = assertOk(await rdb.from('customers').select().eq('Id', id).is('deleted_at', null).maybeSingle());
  if (!c.data) return { error: 'not found' };
  const [fol, prod, gif, pho, ai] = await Promise.all([
    rdb.from('followups').select().eq('customer_id', id)
      .order('followup_date', { ascending: false, nullsFirst: false })
      .order('Id', { ascending: false }),
    rdb.from('products').select().eq('customer_id', id),
    rdb.from('gifts').select().eq('customer_id', id)
      .order('given_date', { ascending: false, nullsFirst: false })
      .order('Id', { ascending: false }),
    rdb.from('photos').select('id, customer_id, customer_name, file_name, content_type, sort_order, created_at, photo_notes, category')
      .eq('customer_id', id)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
    rdb.from('ai_recommendations').select().eq('customer_id', id)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);
  return {
    customer: c.data,
    followups: assertOk(fol).data || [],
    products: assertOk(prod).data || [],
    gifts: assertOk(gif).data || [],
    photos: assertOk(pho).data || [],
    recommendations: assertOk(ai).data || [],
  };
}

async function create(event) {
  const data = event.data || {};
  if (!data.customer_name) return { error: 'customer_name required' };
  const payload = normFields(data, FIELDS);
  if (!Object.keys(payload).length) return { error: 'no valid fields' };
  const r = assertOk(await rdb.from('customers').insert(payload).select('Id'));
  return { id: r.data[0].Id };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const payload = normFields(
    Object.assign({}, event.data, { updated_at: nowIso() }),
    FIELDS.concat(['updated_at'])
  );
  if (!Object.keys(payload).length) return { ok: true, updated: false };
  const r = assertOk(await rdb.from('customers').update(payload).eq('Id', id).select('Id'));
  const n = (r.data || []).length;
  return { ok: n === 1, updated: n };
}

async function remove(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const r = assertOk(await rdb.from('customers')
    .update({ deleted_at: nowIso() })
    .eq('Id', id)
    .is('deleted_at', null)
    .select('Id'));
  return { ok: (r.data || []).length === 1 };
}
