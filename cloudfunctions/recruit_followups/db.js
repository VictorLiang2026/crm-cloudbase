/**
 * _shared/db.js — 云函数共享模块（事件函数版，node-sdk rdb() 数据访问）
 *
 * - 数据访问：@cloudbase/node-sdk@^4 `app.rdb()`（Supabase 风格链式 API，走网关，免数据库凭证/免 VPC）
 * - 工具：normFields / assertOk / nowIso
 * - 注意：PG 模式个人版（共享集群）不提供 PG 协议直连凭证，必须走 rdb()/REST/云API 三条官方通道之一
 *
 * 部署注意：每个云函数目录需包含本文件副本，函数内 require('./db')。
 */
'use strict';

const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: process.env.TCB_ENV });
const rdb = app.rdb();

// ---------- 工具 ----------
function nowIso() {
  return new Date().toISOString();
}

// 从 data 中挑出 allowedFields 内的字段；空串统一转 null（避免 date/enum 报错）
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

module.exports = { app, rdb, nowIso, normFields, assertOk };
