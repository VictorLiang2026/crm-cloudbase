/**
 * ai.js — CRM 统一 AI 建议标准（v1.8 Sprint9）
 *
 * 设计原则：
 *  - 纯函数、零 SDK 依赖；与 db.js 一样按副本分发到每个函数目录，函数内 require('./ai')。
 *  - 统一 NBA（Next Best Action）9 字段：
 *      action, reason, priority, channel, goal, suggested_date, script, confidence, evidence
 *  - 8 条统一护栏：不虚构事实/需求/联系记录/转化率/ROI；AI 只建议不改状态；
 *    数据不足降 confidence；尽量给 evidence。
 *  - 统一 Context 七段：Facts / Current Stage / Recent Interactions /
 *    Open Opportunities / Current Actions / Goal（空段自动省略，省 token）。
 *  - 兼容性：legacy 模式在 nba 内同时保留旧 6 字段
 *    （assessment/goal/next_action/topic/avoid/success_criteria），
 *    现有前端与 ai_recommendations.nba jsonb 不受影响；新消费方读统一 9 字段。
 *    映射关系：next_action=action、assessment=reason。
 */
'use strict';

var PRIORITIES = ['high', 'medium', 'low'];
var CHANNELS = ['微信', '电话', '面谈', '活动', '短信'];
var CONFIDENCES = ['high', 'medium', 'low'];

function clipText(v, n) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '';
}

// YYYY-MM-DD 且真实存在，否则返回空字符串（统一 NBA 的"无日期"表示）
function validDate(v) {
  if (typeof v !== 'string') return '';
  var m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  var y = +m[1], mo = +m[2], d = +m[3];
  var dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function oneOf(v, list, fallback) {
  return (typeof v === 'string' && list.indexOf(v.trim()) >= 0) ? v.trim() : fallback;
}

// ---------- 8 条统一护栏（拼进 system prompt） ----------
var GUARDRAILS = [
  '【统一护栏（必须遵守）】',
  '1. 只能依据输入中给出的事实作答，严禁虚构任何输入里没有的事实；',
  '2. 严禁虚构客户/候选人的需求、意向或购买意愿；',
  '3. 严禁虚构联系记录、沟通内容或对方说过的话；',
  '4. 严禁虚构转化率、成功率等统计数字；',
  '5. 严禁虚构 ROI、收益承诺，不得夸大保险条款；',
  '6. 你只输出建议，绝不直接修改任何业务状态（落库一律由用户确认后执行）；',
  '7. 数据不足的字段填“信息不足”，confidence 必须降为 low；',
  '8. 尽量通过 evidence 给出判断依据，每条必须引用输入中真实出现的事实。',
].join('\n');

// ---------- 统一 NBA 输出约定（拼进 system prompt） ----------
function nbaPromptBlock(legacy) {
  var lines = [
    '【Next Best Action（nba 对象，必须输出）— 统一 9 字段】',
    'action：下一最佳行动，1 句、拿到即可执行（≤30字）；',
    'reason：为什么现在做（≤80字），只能引用输入中给出的事实；',
    'priority：high | medium | low；',
    'channel：微信 | 电话 | 面谈 | 活动 | 短信；',
    'goal：本次行动要达成的目标（≤30字）；',
    'suggested_date：建议执行日期 YYYY-MM-DD；无法确定为空字符串；',
    'script：可直接发送的一句话术（≤100字），不得包含未经证实的客户信息或收益承诺；',
    'confidence：high | medium | low；证据不足严禁给 high；',
    'evidence：2-4 条判断依据，每条 ≤60字，必须引用输入中真实出现的事实，不得编造。',
  ];
  if (legacy) {
    lines = lines.concat([
      '同时输出以下兼容字段（供现有页面使用，与统一字段同一次给出、保持一致、不得矛盾）：',
      'assessment：当前经营判断（≤2句），与 reason 同义；',
      'next_action：下一最佳行动，与 action 同义；',
      'topic：推荐沟通主题（≤12字）；',
      'avoid：当前阶段最不建议做的事（1句）；',
      'success_criteria：可验证的成功标准（1句）；',
      'goal 即统一字段 goal，不要另造日期字段。',
    ]);
  }
  return lines.join('\n');
}

// ---------- 统一 Context 七段构造（空段省略；string 或 string[] 均可） ----------
var CONTEXT_TITLES = {
  facts: 'Facts 事实',
  stage: 'Current Stage 当前阶段',
  interactions: 'Recent Interactions 最近互动',
  opportunities: 'Open Opportunities 进行中的机会',
  actions: 'Current Actions 当前待办',
  goal: 'Goal 目标',
};

function sectionText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(function (x) { return x != null && String(x).trim(); }).map(function (x) { return String(x).trim(); }).join('\n');
  return String(v).trim();
}

function buildContext(sections) {
  sections = sections || {};
  return Object.keys(CONTEXT_TITLES).map(function (key) {
    var body = sectionText(sections[key]);
    return body ? ('## ' + CONTEXT_TITLES[key] + '\n' + body) : '';
  }).filter(Boolean).join('\n\n');
}

// ---------- NBA 输出清洗：AI 原始对象 → 统一 9 字段（legacy 时追加旧 6 字段） ----------
function normNba(raw, opts) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  opts = opts || {};
  var action = clipText(raw.action || raw.next_action, 120);
  var reason = clipText(raw.reason || raw.assessment, 160);
  var nba = {
    action: action,
    reason: reason,
    priority: oneOf(raw.priority, PRIORITIES, opts.priority || 'medium'),
    channel: oneOf(raw.channel, CHANNELS, opts.channel || '微信'),
    goal: clipText(raw.goal, 60),
    suggested_date: validDate(raw.suggested_date),
    script: clipText(raw.script, 200),
    confidence: oneOf(raw.confidence, CONFIDENCES, 'low'),
    evidence: Array.isArray(raw.evidence)
      ? raw.evidence.map(function (e) { return clipText(e, 80); }).filter(Boolean).slice(0, 4)
      : [],
  };
  if (opts.legacy) {
    // 旧字段优先取 AI 原值，缺失时用统一字段回填，保证老页面字段不空白
    nba.assessment = clipText(raw.assessment || raw.reason, 200);
    nba.next_action = clipText(raw.next_action || raw.action, 200);
    nba.topic = clipText(raw.topic, 60);
    nba.avoid = clipText(raw.avoid, 200);
    nba.success_criteria = clipText(raw.success_criteria, 200);
  }
  return nba;
}

module.exports = {
  PRIORITIES: PRIORITIES,
  CHANNELS: CHANNELS,
  CONFIDENCES: CONFIDENCES,
  clipText: clipText,
  validDate: validDate,
  oneOf: oneOf,
  GUARDRAILS: GUARDRAILS,
  nbaPromptBlock: nbaPromptBlock,
  buildContext: buildContext,
  normNba: normNba,
};
