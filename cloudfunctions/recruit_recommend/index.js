/**
 * recruit_recommend — AI 增员话术生成（事件云函数，超时 120s，rdb() 版）
 * 入参 event: { candidate_id, operator? }
 *   - operator: { name, gender, birthday } 操作员信息（前端传入，用于称呼规则）
 * 流程：拉取候选人资料 → 构建 prompt（含增员五步法/STAR异议处理/称呼规则）
 *        → hy3 生成 → 解析 JSON → 实时返回（不持久化，前端按需展示）
 * 出参: { recommendation, raw }
 *   - recommendation: { suggested_approach, suggested_message, suggested_objection_handling[],
 *                       suggested_next_stage_goal, suggested_followup_date }
 *   - raw: 模型原始输出文本
 *
 * AI 仅用 hy3（app.ai().createModel('cloudbase')）。
 */
'use strict';

const { rdb, generateText, extractJson, assertOk } = require('./db');

const OPERATOR_DEFAULT = { name: 'Victor', gender: '男', birthday: '1976-10' };

function buildSystem(op) {
  return [
    '你是资深保险增员顾问。根据候选人资料为操作员生成下一次接触建议。',
    '【操作员】' + op.name + '，性别：' + op.gender + '，出生年月：' + op.birthday + '。与候选人沟通时的称呼必须符合双方长幼与关系（见称呼规则）。',
    '【称呼规则（suggested_message 中对候选人的称呼必须严格遵守）】',
    '1. 知道候选人出生/年龄，且与操作员有学校校友、同门等关系：候选人比操作员年长，男称"姓+师兄"、女称"姓+师姐"；候选人更年轻或同龄，男称"姓+师弟"、女称"姓+师妹"。',
    '2. 知道候选人出生/年龄但无学校校友关系：男称"姓+先生"、女称"姓+女士"。',
    '3. 不知道候选人年龄，但资料中有学校/校友信息：男称"姓+师弟"、女称"姓+师妹"。',
    '4. 不知道年龄也无学校信息：男称"姓+先生"、女称"姓+女士"。',
    '5. 不确定候选人性别：禁止使用性别化称呼，用"您"或候选人姓名。',
    '6. 严禁性别错称。',
    '【增员五步法（必须体现在 suggested_next_stage_goal 中）】',
    '接触 → 唤醒 → 面谈 → 促成 → 入司。当前阶段决定下一步目标。',
    '【异议处理 STAR 框架（suggested_objection_handling 中每条话术的结构）】',
    'S(认同情境): 共情候选人的顾虑 → T(共情想法): 理解其担忧 → A(给出方案): 提供解决路径 → R(描绘结果): 展示改变后的美好图景。',
    '【输出 JSON，字段】',
    'suggested_approach(接触方式建议：微信/电话/面谈/创说会邀约，10字内),',
    'suggested_message(个性化开场白，50-150字，称呼正确),',
    'suggested_objection_handling(针对候选人顾虑的3条异议处理话术，数组，每条80字内),',
    'suggested_next_stage_goal(下一步推进目标：约面谈/邀创说会/促报考/其他，20字内),',
    'suggested_followup_date(建议下次跟进日期 YYYY-MM-DD)。',
    '只输出 JSON，不要解释。',
  ].join('\n');
}

function buildUser(c) {
  return [
    '【候选人资料】',
    '姓名：' + (c.customer_name || c.name || '未知'),
    '性别：' + (c.gender || '未知'),
    '出生：' + (c.birthday || '未知'),
    '现职/行业：' + (c.occupation || '未知'),
    '年收入：' + (c.annual_income || '未知'),
    '学历：' + (c.education || '未知'),
    'MBTI：' + (c.mbti || '未知'),
    '求职动机：' + (c.motivation || '未知'),
    '顾虑点：' + (c.concerns || '未知'),
    '来源：' + (c.source || '未知'),
    '当前阶段：' + (c.stage || '名单'),
    '工作经历：' + (c.work_experience || '无'),
    '家庭情况：' + (c.family_situation || '无'),
    '性格标签：' + (c.personality_tags || '无'),
    '职业规划：' + (c.career_plan || '无'),
    '请生成下一步接触建议。',
  ].join('\n');
}

exports.main = async (event, context) => {
  try {
    const candidateId = parseInt(event && event.candidate_id, 10);
    if (!candidateId) return { error: 'candidate_id required' };

    const c = assertOk(await rdb.from('v_recruit_candidates')
      .select('*').eq('candidate_id', candidateId).maybeSingle());
    if (!c.data) return { error: 'candidate not found' };
    const candidate = c.data;

    const opIn = (event && event.operator) || {};
    const operator = {
      name: opIn.name || OPERATOR_DEFAULT.name,
      gender: opIn.gender || OPERATOR_DEFAULT.gender,
      birthday: opIn.birthday || OPERATOR_DEFAULT.birthday,
    };

    const messages = [
      { role: 'system', content: buildSystem(operator) },
      { role: 'user', content: buildUser(candidate) },
    ];
    const { text: raw } = await generateText(messages, { timeout: 120000 });
    const parsed = extractJson(raw) || {};

    return { recommendation: parsed, raw: raw };
  } catch (e) {
    return { error: e.message };
  }
};
