/**
 * ocr_records — 客户 OCR 识别记录（事件云函数，rdb() 版）
 * 入参 event: { action, ... }
 *   list:   { action:'list', customer_id } → { rows }（按 created_at 倒序，不含大文本截断）
 *   create: { action:'create', data:{ customer_id, summary?, raw_text?, file_ids?, file_names? } } → { id }
 *           file_ids / file_names 为 JSON 数组字符串（关联 photos 表 id 与原始文件名）
 *   update: { action:'update', id, data:{ summary?, raw_text? } } → { ok }（同时刷新 updated_at）
 *
 * 用途：AI 解析客户资料时，前端本地识别出的完整文字与本函数无关；
 * 前端在客户确认并保存文件到 photos 后，将识别摘要与原文、关联文件 id 一次性写入本表，
 * 供客户详情"OCR 记录"页签展示、编辑，并可基于记录重新发起 AI 匹配更新客户信息。
 */
'use strict';

const { rdb, assertOk } = require('./db');

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || '';
    switch (action) {
      case 'list':   return await list(event);
      case 'create': return await create(event);
      case 'update': return await update(event);
      default: return { error: 'unknown action: ' + action };
    }
  } catch (e) {
    return { error: e.message };
  }
};

async function list(event) {
  const customerId = parseInt(event.customer_id, 10);
  if (!customerId) return { error: 'customer_id required' };
  const r = assertOk(await rdb.from('ocr_records')
    .select('id, customer_id, summary, raw_text, file_ids, file_names, created_at, updated_at')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false }));
  return { rows: r.data || [] };
}

async function create(event) {
  const data = event.data || {};
  const customerId = parseInt(data.customer_id, 10);
  if (!customerId) return { error: 'customer_id required' };
  const payload = {
    customer_id: customerId,
    summary: data.summary || null,
    raw_text: data.raw_text || null,
    file_ids: data.file_ids || null,
    file_names: data.file_names || null,
  };
  const r = assertOk(await rdb.from('ocr_records').insert(payload).select('id'));
  if (r.data && r.data[0]) return { id: r.data[0].id };
  return { id: null };
}

async function update(event) {
  const id = parseInt(event.id, 10);
  if (!id) return { error: 'id required' };
  const data = event.data || {};
  const payload = { updated_at: new Date().toISOString() };
  if (Object.prototype.hasOwnProperty.call(data, 'summary')) payload.summary = data.summary || null;
  if (Object.prototype.hasOwnProperty.call(data, 'raw_text')) payload.raw_text = data.raw_text || null;
  const r = assertOk(await rdb.from('ocr_records').update(payload).eq('id', id).select('id'));
  return { ok: (r.data || []).length === 1 };
}
