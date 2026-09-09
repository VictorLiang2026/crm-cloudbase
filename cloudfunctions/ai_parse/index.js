/**
 * ai_parse — AI 文本/照片解析（事件云函数，超时 120s，rdb() 版）
 * 入参 event: { action?, text?, images?, image_base64?, content_type?, file_name? }
 *
 * action 省略/'parse'（默认，v1.0 起）：文本/照片 → 客户资料
 *   - text: 待解析的自然语言文本（与图片至少提供一个）；可包含附件文件名/文本文件内容等上下文
 *   - images: 可选，多图数组 [{ base64, content_type?, file_name? }]（不含 data: 前缀），多模态识别
 *   - image_base64: 可选，单图 base64（向后兼容旧入参，等价 images:[{base64}]）
 *   出参: { parsed, raw }
 *
 * action='quick_capture'（v1.8 Sprint4：AI Quick Capture，纯只读解析，不写任何业务数据）：
 *   入参: { action:'quick_capture', text }
 *   读取现有客户/增员名单（仅名字）做人物匹配，把一句自然语言拆解为：
 *     parsed: {
 *       person_name, person_type_hint(customer|recruit|unknown),
 *       interaction_type(见面/吃饭/电话/微信/活动/其他), interaction_date(YYYY-MM-DD|null),
 *       activity(活动名|null),
 *       facts[](事实FACT), needs[](事实FACT·明确需求), interests[](事实FACT·兴趣),
 *       customer_stage(判断INFERENCE 阶段|null),
 *       opportunity(判断INFERENCE {has,type,note}|null),
 *       recruit_signal(判断INFERENCE {has,note}|null),
 *       referral_signal(判断INFERENCE {has,note}|null),
 *       next_action(建议RECOMMENDATION), next_action_date(建议RECOMMENDATION YYYY-MM-DD|null),
 *       followup_goal(建议RECOMMENDATION),
 *       confidence(high|medium|low), evidence[](原文片段)
 *     }
 *     match: { status:'matched'|'ambiguous'|'none', person_type, person_id, person_name, cid?, candidates[] }
 *   分层纪律：facts/needs/interests/interaction_type/interaction_date/activity/person_name=事实；
 *     customer_stage/opportunity/recruit_signal/referral_signal=判断；next_action/next_action_date/
 *     followup_goal=建议。严禁虚构需求/购买意愿/成功率/ROI；信息不足
 *     对应字段置 null/false 并降低 confidence。写入由前端用户点【确认并保存】后调 followups/
 *     recruit_followups/customers 的 create 完成，本函数不落库、不改阶段、不建机会。
 */
'use strict';

const { rdb, generateText, extractJson, assertOk } = require('./db');

const AI_MODEL = process.env.AI_MODEL || 'hy3';
// 视觉模型：官方文档确认 hy3/hy3-preview 不支持多模态（图片会被静默忽略），
// glm-5v-turbo 支持图片 Base64 输入与 PDF/TXT/DOC 文件理解（文件仅限 URL 方式）
const VISION_MODEL = process.env.VISION_MODEL || 'glm-5v-turbo';

const FIELD_SPEC = [
  'customer_name(姓名), gender(性别:男/女/未知), phone(电话),',
  'birthday(生日 YYYY-MM-DD), occupation(职业),',
  'marital_status(婚况:未婚/已婚/未知),',
  'customer_stage(客户经营阶段:新认识/关系维护/需求挖掘/方案沟通/成交推进/转介绍经营),',
  'sales_priority(签单优先级:A/B/C/D/E), recruitment_priority(招募优先级:A/B/C/D/E),',
  'referral_priority(转介绍优先级:A/B/C/D/E),',
  'hobbies(爱好), source(来源),',
  'additional_info(附加信息：只提炼与客户经营相关的结论性要点，如家庭成员构成、工作单位与职务、收入水平、咨询的问题、对当前职业的满意或不满意及其看法、购买意向、可转介绍的资源、可招募的潜质等；分条简述，不要复述原文全文)。',
  '无法判断的字段设为 null。只输出 JSON，不要解释。',
].join('\n');

const SYSTEM = '你是一个客户信息解析助手。从用户提供的文本中提取客户资料，输出 JSON。\n字段：\n' + FIELD_SPEC;

const SYSTEM_VISION = [
  '你是一个客户信息解析助手。用户会提供一张或多张图片（以及可能的补充文本/附件说明）。',
  '第一步：完整识别每张图片中的所有文字（OCR），并在 ocr_text 中按【照片N：文件名】的格式分段拼接各图识别结果。',
  '第二步：综合所有图片和文本内容提取同一位客户的资料；信息冲突时以更明确的一处为准。',
  '输出 JSON，字段：',
  'ocr_text(所有图片中识别出的全部原始文字，按图片顺序分段拼接),',
].join('\n') + FIELD_SPEC;

exports.main = async (event, context) => {
  try {
    const action = (event && event.action) || 'parse';
    if (action === 'quick_capture') return await quickCapture(event);

    const text = ((event && event.text) || '').trim();
    // 组装多图数组：优先 images，兼容旧的单图入参
    let images = (event && Array.isArray(event.images)) ? event.images : [];
    if (!images.length && event && event.image_base64) {
      images = [{ base64: event.image_base64, content_type: event.content_type, file_name: event.file_name }];
    }
    images = images.filter(function (im) { return im && im.base64; });
    if (!text && !images.length) return { error: 'text or image required' };

    let raw = '';
    if (images.length) {
      // 多模态：多图（+可选补充文本）→ 识别文字 + 结构化提取
      const content = [{ type: 'text', text: text || '请识别图片中的客户资料。' }];
      images.forEach(function (im, idx) {
        const contentType = im.content_type || 'image/jpeg';
        const label = im.file_name ? ('（文件名：' + im.file_name + '）') : '';
        if (images.length > 1 || label) {
          content.push({ type: 'text', text: '照片' + (idx + 1) + label + '：' });
        }
        content.push({ type: 'image_url', image_url: { url: 'data:' + contentType + ';base64,' + im.base64 } });
      });
      const messages = [
        { role: 'system', content: SYSTEM_VISION },
        { role: 'user', content: content },
      ];
      const res = await generateText(messages, { timeout: 120000, model: VISION_MODEL });
      raw = res.text;
    } else {
      const messages = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: text },
      ];
      const res = await generateText(messages, { timeout: 120000 });
      raw = res.text;
    }

    const parsed = extractJson(raw) || {};

    return { parsed: parsed, raw: raw };
  } catch (e) {
    return { error: e.message };
  }
};

// ==================== v1.8 Sprint4：AI Quick Capture（快速记录） ====================

// 北京时区今天日期 YYYY-MM-DD（北京时间 = UTC+8）
function qcBjToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function qcNorm(s) { return (s == null ? '' : String(s)).replace(/\s+/g, '').trim(); }

// 人物匹配：AI 给称呼/名字，JS 在现有客户/增员名单里精确→模糊匹配，不依赖 AI 报 id
function qcResolve(personName, hint, customers, recruits) {
  const raw = qcNorm(personName);
  if (!raw) return { status: 'none', candidates: [] };
  const pools = (hint === 'recruit')
    ? [['recruit', recruits], ['customer', customers]]
    : [['customer', customers], ['recruit', recruits]];
  const toCand = (type, p) => ({ type: type, id: p.id, name: p.name, cid: p.cid, stage: p.stage || null });
  const matched = (type, p) => ({ status: 'matched', person_type: type, person_id: p.id, person_name: p.name, cid: p.cid, stage: p.stage || null, candidates: [] });
  // 1) 精确匹配
  for (const pp of pools) {
    const type = pp[0], list = pp[1];
    const ex = list.filter(p => qcNorm(p.name) === raw);
    if (ex.length === 1) {
      return matched(type, ex[0]);
    }
    if (ex.length > 1) {
      return { status: 'ambiguous', candidates: ex.slice(0, 8).map(p => toCand(type, p)) };
    }
  }
  // 2) 模糊匹配（互相包含 / 姓氏相同且末字相同，如“王总”→“王寻寻”仅靠王字太宽，故要求末字或全名包含）
  const fuzzy = list => list.filter(p => {
    const n = qcNorm(p.name);
    if (!n) return false;
    if (n.indexOf(raw) >= 0 || raw.indexOf(n) >= 0) return true;
    // 称呼类（X总/X姐/X哥/X老师）：取首字姓匹配，且名单内同姓不超过 6 个才算高置信
    return false;
  });
  const out = [];
  const seen = {};
  pools.forEach(pp => {
    fuzzy(pp[1]).forEach(p => {
      const c = toCand(pp[0], p);
      const k = c.type + '-' + c.id;
      if (!seen[k]) { seen[k] = 1; out.push(c); }
    });
  });
  // 姓氏匹配（仅对“X总/X姐/X哥/X经理/X老师”这类称呼），同姓候选 ≤6 时给出
  if (!out.length && /^[\u4e00-\u9fa5](总|姐|哥|经理|老师|主任|董|处)$/.test(raw)) {
    const surname = raw.slice(0, 1);
    pools.forEach(pp => {
      pp[1].forEach(p => {
        if (qcNorm(p.name).slice(0, 1) === surname) {
          const c = toCand(pp[0], p);
          const k = c.type + '-' + c.id;
          if (!seen[k]) { seen[k] = 1; out.push(c); }
        }
      });
    });
  }
  if (out.length === 1) return matched(out[0].type, out[0]);
  if (out.length > 1) return { status: 'ambiguous', candidates: out.slice(0, 8) };
  return { status: 'none', candidates: [] };
}

function qcSystem(today, custNames, recNames, actNames) {
  return [
    '你是保险代理人的 CRM 记录助手。把用户口述的一次客户交流，拆解成结构化记录。今天是 ' + today + '（北京时间）。',
    '',
    '【三层纪律 —— 必须严格区分】',
    '1. 事实 FACT：只有用户原话明确说出的内容才算事实（发生了什么、对方明确表达的需求/兴趣、时间、人物、活动）。不得添加原话没有的信息。',
    '2. 判断 INFERENCE：客户阶段、机会、增员/转介绍信号，是你的推断；必须基于原话，证据不足就置 null 或 has:false，绝不能编造。',
    '3. 建议 RECOMMENDATION：下一步行动、建议日期、跟进目标，是你的建议。',
    '',
    '【严禁】虚构客户需求、购买意愿、成功率、ROI、联系记录、客户没说过的事实。信息不足时对应字段置 null/false/空数组，并把 confidence 设为 low。',
    '',
    '【人物匹配】下面是系统里已有的名单。person_name 请填原话里的称呼（如“王总”）；person_type_hint 填 customer（客户/潜在客户）、recruit（增员对象）或 unknown。',
    '现有客户：' + (custNames || '（无）'),
    '现有增员对象：' + (recNames || '（无）'),
    '近期活动：' + (actNames || '（无）'),
    '',
    '【相对日期换算】把“今天/昨天/上周/十月以后”等换算成 YYYY-MM-DD（今天=' + today + '）。“十月以后再联系”这类，next_action_date 给十月第一个合适工作日附近的日期即可，作为建议；无法判断给 null。',
    '',
    '只输出一个 JSON 对象，不要解释、不要 markdown：',
    '{',
    '  "person_name": "原话中的称呼/姓名，没有则 null",',
    '  "person_type_hint": "customer|recruit|unknown",',
    '  "interaction_type": "见面|吃饭|电话|微信|活动|其他|null",',
    '  "interaction_date": "YYYY-MM-DD|null（这次交流发生的日期）",',
    '  "activity": "提到的活动名称|null（尽量用上面近期活动里的名字）",',
    '  "facts": ["客观事实，逐条，只写原话明确有的"],',
    '  "needs": ["对方明确表达的需求/关心的问题"],',
    '  "interests": ["对方的兴趣/关注点"],',
    '  "customer_stage": "新认识|关系维护|需求挖掘|方案沟通|成交推进|转介绍经营|null（你的判断）",',
    '  "opportunity": {"has": true, "type": "教育金|养老|重疾|医疗|寿险|年金|其他|null", "note": "一句话依据"} ,',
    '  "recruit_signal": {"has": false, "note": "增员潜质依据或空串"},',
    '  "referral_signal": {"has": false, "note": "转介绍线索依据或空串"},',
    '  "next_action": "建议的下一步具体行动（一句话，可执行）",',
    '  "next_action_date": "YYYY-MM-DD|null（建议行动日期）",',
    '  "followup_goal": "下次跟进要达成的目标",',
    '  "confidence": "high|medium|low",',
    '  "evidence": ["支撑关键判断的原话片段，逐条加引号"]',
    '}',
    '注意：opportunity/recruit_signal/referral_signal 即使没有也要返回对象（has:false, note:""），不要省略键。',
  ].join('\n');
}

async function quickCapture(event) {
  const text = ((event && event.text) || '').trim();
  if (!text) return { error: 'text required' };
  const today = qcBjToday();

  // 名单（仅取名字，用于人物匹配与活动关联；只读）
  let customers = [], recruits = [], actNames = '';
  try {
    const cr = assertOk(await rdb.from('customers')
      .select('Id, customer_name').is('deleted_at', null)
      .order('Id', { ascending: false }).limit(3000));
    customers = (cr.data || []).map(r => ({ id: r.Id, name: r.customer_name, cid: r.Id })).filter(r => r.name);
  } catch (e) { /* 名单读取失败不阻塞解析 */ }
  try {
    const rr = await rdb.from('v_recruit_candidates').select('candidate_id, customer_id, customer_name, stage').limit(3000);
    recruits = (rr.data || []).map(r => ({ id: r.candidate_id, name: r.customer_name, cid: r.customer_id, stage: r.stage }))
      .filter(r => r.name);
  } catch (e) { /* 视图不可用时增员匹配降级为空 */ }
  try {
    const ar = await rdb.from('activities').select('id, name, activity_date')
      .order('activity_date', { ascending: false }).limit(60);
    actNames = (ar.data || []).map(a => a.name + '(' + (a.activity_date || '日期未定') + ')').join('、');
  } catch (e) { /* 活动名单失败不阻塞 */ }

  const messages = [
    { role: 'system', content: qcSystem(today, customers.map(c => c.name).join('、'), recruits.map(r => r.name).join('、'), actNames) },
    { role: 'user', content: text },
  ];
  let res = await generateText(messages, { timeout: 55000 });
  let parsed = extractJson(res.text);
  if (!parsed || !Object.keys(parsed).length) {
    // 模型偶发空响应/非 JSON，重试一次
    res = await generateText(messages, { timeout: 55000 });
    parsed = extractJson(res.text);
  }
  if (!parsed || !Object.keys(parsed).length) {
    return { error: 'AI 暂未返回有效内容，请重试或换个说法', raw: res.text || '' };
  }

  const match = qcResolve(parsed.person_name, parsed.person_type_hint, customers, recruits);

  return { parsed: parsed, match: match, today: today, raw: res.text };
}
