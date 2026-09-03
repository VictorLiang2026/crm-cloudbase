/**
 * _shared/db.js — 云函数共享模块（事件函数版，node-sdk rdb() 数据访问）
 *
 * - 数据访问：@cloudbase/node-sdk@^4 `app.rdb()`（Supabase 风格链式 API，走网关，免数据库凭证/免 VPC）
 * - AI 封装：app.ai().createModel('cloudbase')，model='hy3'
 * - 工具：normFields / assertOk / nowIso / extractJson
 *
 * 部署注意：每个云函数目录需包含本文件副本，函数内 require('./db')。
 */
'use strict';

const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: process.env.TCB_ENV });
const rdb = app.rdb();

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

function nowIso() {
  return new Date().toISOString();
}

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

function assertOk(res) {
  if (res && res.error) {
    const e = res.error;
    throw new Error(e.message || (typeof e === 'string' ? e : JSON.stringify(e)));
  }
  return res;
}

module.exports = { app, rdb, getAi, AI_MODEL, generateText, extractJson, nowIso, normFields, assertOk };
