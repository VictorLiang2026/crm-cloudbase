/**
 * recruit_score — AI 高潜评分（事件云函数，超时 60s，rdb() 版）
 * 入参 event: { candidate_id }
 * 流程：拉取候选人 → 构建评分 prompt → hy3 生成 → 解析 JSON
 *        → 回写 recruit_candidates.potential_score / potential_reason
 * 出参: { score, reason, risks }
 *
 * 评估维度：行业资源/学习能力/抗压能力/沟通力/创业动机/文化适配
 * AI 仅用 hy3（app.ai().createModel('cloudbase')）。
 */
'use strict';

const { rdb, generateText, extractJson, assertOk, nowIso } = require('./db');
const aiStd = require('./ai');

function buildScoringPrompt(c) {
  return [
    '你是保险增员人才评估专家。根据候选人资料评估其成为优秀代理人的潜力。',
    '【评估维度（每项 0-100，加权得出总分）】',
    '1. 行业资源(25%): 现有客户/人脉网络的质量与数量',
    '2. 学习能力(15%): 学历背景、跨界适应力',
    '3. 抗压能力(20%): 收入波动承受力、职业转型经验',
    '4. 沟通力(15%): MBTI 倾向、现职沟通场景',
    '5. 创业动机(15%): 求职动机与保险创业的契合度',
    '6. 文化适配(10%): 价值观、团队协作倾向',
    '【输出 JSON】',
    '{ "score": 0-100整数, "reason": "三大理由（60字内，每条只引用上面给出的事实）", "risks": "三大风险点（60字内）" }',
    '【统一护栏】',
    '1. 只能依据上面给出的资料打分，严禁虚构候选人的经历/资源/动机；',
    '2. 资料严重不足（大部分字段为未知/无）时 score 不得高于 60，且 reason 首句必须注明“资料不足，分数为初步判断”；',
    '3. 严禁虚构成功率、ROI 或收益承诺；只输出 JSON，不要解释。',
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
    '工作经历：' + (c.work_experience || '无'),
    '家庭情况：' + (c.family_situation || '无'),
    '性格标签：' + (c.personality_tags || '无'),
    '职业规划：' + (c.career_plan || '无'),
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

    const messages = [
      { role: 'user', content: buildScoringPrompt(candidate) },
    ];
    const { text: raw } = await generateText(messages, { timeout: 60000 });
    const parsed = extractJson(raw) || {};

    // 分数夹取 0-100 整数，非法值置 null（防 AI 输出越界/非数字污染业务字段）
    var scoreNum = Number.isFinite(parseInt(parsed.score, 10)) ? parseInt(parsed.score, 10) : null;
    if (scoreNum != null) scoreNum = Math.max(0, Math.min(100, scoreNum));
    var reasonText = aiStd.clipText(parsed.reason, 300) + (parsed.risks ? ' | 风险：' + aiStd.clipText(parsed.risks, 300) : '');

    // 回写到候选人表
    assertOk(await rdb.from('recruit_candidates').update({
      potential_score: scoreNum,
      potential_reason: reasonText || null,
      updated_at: nowIso(),
    }).eq('id', candidateId));

    return {
      score: scoreNum,
      reason: aiStd.clipText(parsed.reason, 300) || null,
      risks: aiStd.clipText(parsed.risks, 300) || null,
      raw: raw,
    };
  } catch (e) {
    return { error: e.message };
  }
};
