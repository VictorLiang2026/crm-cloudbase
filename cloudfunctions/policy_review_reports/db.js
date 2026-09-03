/**
 * _shared/db.js — 云函数共享模块（事件函数版，node-sdk rdb() 数据访问 + AI）
 *
 * 说明：这是 customers/products/ai_recommend 等所有云函数共用的 db.js 副本。
 * 如需修改共享逻辑，请确保所有依赖云函数目录内的 db.js 同步更新。
 */
'use strict';

const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: process.env.TCB_ENV });
const rdb = app.rdb();

// ---------- AI（hy3，cloudbase 组）----------
const AI_MODEL = process.env.AI_MODEL || 'hy3';
let _ai = null;

function getAi() {
  if (!_ai) {
    _ai = app.ai().createModel('cloudbase');
  }
  return _ai;
}

async function generateText(messages, opts) {
  const ai = getAi();
  const res = await ai.generateText(Object.assign({ model: AI_MODEL, messages }, opts || {}));
  const text = (res && (res.text || res.result || res.content)) || (typeof res === 'string' ? res : '');
  return { text, raw: res };
}

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

// ---------- 工具 ----------
function nowIso() {
  return new Date().toISOString();
}

// 从 data 中挑出 allowedFields 内的字段；空串统一转 null
function normFields(data, allowedFields) {
  const out = {};
  for (const f of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(data, f)) {
      let v = data[f];
      if (v === '') v = null;
      out[f] = v;
    }
  }
  return out;
}

// rdb() 返回 { data, error }；有 error 时抛异常
function assertOk(res) {
  if (res && res.error) {
    const e = res.error;
    throw new Error(e.message || (typeof e === 'string' ? e : JSON.stringify(e)));
  }
  return res;
}

module.exports = { app, rdb, getAi, AI_MODEL, generateText, extractJson, nowIso, normFields, assertOk };
