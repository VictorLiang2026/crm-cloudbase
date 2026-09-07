/**
 * ai_followup — AI 沟通记录助手（事件云函数，超时 60s，rdb() 版）
 * 入参 event:
 *   action:'parse'（默认） { customer_id, text }
 *     text: 业务员口语化描述本次沟通（必填，≥5 字）
 *     流程：拉取客户 + 最近 5 条跟进（上下文，避免重复识别旧信息）
 *           → hy3 解析为结构化跟进记录 → 日期/枚举校验 → 返回（不写库）
 *   action:'analyze_profile' { customer_id }
 *     流程：拉取客户 + 最近 50 条跟进（正序）+ 附加信息 + 现有画像
 *           → hy3 通读历史，输出完整画像建议 profile_updates → 返回（不写库）
 *     出参: { profile_updates, based_on:{followups_count,has_additional_info}, raw }
 * 出参（parse）: { parsed, today, raw }
 *   parsed: {
 *     followup_notes      本次沟通内容要点（1-3 句，简短客观）
 *     followup_date       本次沟通日期 YYYY-MM-DD（默认今天，识别"昨天/上周X"）
 *     next_followup_date  下次跟进日期 YYYY-MM-DD 或 null（"下周/月底/过两周"换算；无法确定 null）
 *     next_followup_goal  下次跟进目标（枚举词表内）或 null
 *     next_step           下一步建议（1 句）或空串
 *     needs               客户需求/兴趣/关注点 或空串
 *     relationship        客户关系变化 或空串
 *     new_info            新出现的家庭/职业/生命周期信息 或空串
 *     stage_change        { to, reason } 或 null（仅当建议推进且与当前阶段不同）
 *     profile_updates     画像更新建议（8 维度结构，仅本次沟通带来的新信息；全空 null）
 *   }
 * 原则：
 *   - 只解析不写入；所有建议由前端确认页让操作者决定
 *   - 无法确定的日期/目标返回 null，严禁编造
 *   - 输出简短，不生成长篇总结
 * AI 仅用 hy3（app.ai().createModel('cloudbase')）。
 */
'use strict';

const { rdb, generateText, extractJson, assertOk } = require('./db');

// 枚举词表（与 DB enum、前端 GOALS/STAGE 常量完全一致）：AI 输出超出词表置 null
var GOAL_ENUM = ['建立联系', '约见面', '邀请活动', '获取家庭信息', '推进签单', '推进招募', '推进转介绍'];
var STAGE_ENUM = ['新认识', '关系维护', '需求挖掘', '方案沟通', '成交推进', '转介绍经营'];

// 北京时间（与 today_coach 一致：UTC+8）
function bjNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function todayStr() { return bjNow().toISOString().slice(0, 10); }

function inEnum(v, list) {
  return (typeof v === 'string' && list.indexOf(v.trim()) >= 0) ? v.trim() : null;
}

// 日期校验：YYYY-MM-DD 且真实存在（拦截 2026-02-31 之类）
function normDate(v) {
  if (typeof v !== 'string') return null;
  var m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  var y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  var dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function clip(v, n) { return typeof v === 'string' ? v.trim().slice(0, n) : ''; }

// ---------- 画像补全：基于该客户全部历史跟进 + 附加信息，生成完整画像建议（只返回不写库） ----------
async function analyzeProfile(event) {
  var customerId = parseInt(event && event.customer_id, 10);
  if (!customerId) return { error: 'customer_id required' };

  var c = assertOk(await rdb.from('customers').select().eq('Id', customerId)
    .is('deleted_at', null).maybeSingle());
  if (!c.data) return { error: 'customer not found' };
  var customer = c.data;

  // 最近 50 条跟进（先按时间倒序取 50 条，再反转为正序供 AI 通读演变）
  var rows = assertOk(await rdb.from('followups')
    .select('followup_date, followup_notes')
    .eq('customer_id', customerId).is('deleted_at', null)
    .order('followup_date', { ascending: false, nullsFirst: false })
    .order('Id', { ascending: false }).limit(50)).data || [];
  var folRows = rows.slice().reverse();

  var curProfile = {};
  try { if (customer.profile) curProfile = typeof customer.profile === 'object' ? customer.profile : JSON.parse(customer.profile); } catch (e) { curProfile = {}; }

  var sys = [
    '你是保险业务员的客户画像助手。下面是某位客户的历史跟进记录与已知资料，请通读全部材料，整理出该客户当前的客户画像。',
    '【只输出 JSON】字段 profile_updates，结构：',
    'family(家庭情况：婚姻/配偶/家庭结构的当前状况)、children(子女情况：数量/年龄/教育阶段/重大安排)、parents(父母情况：赡养/健康/养老安排)、',
    'career(职业/事业状态：工作变动/创业/晋升/收入变化等；职业名称本身不用填)、needs(当前主要需求：客户当下最关心的保障/财务需求，短语)、',
    'relationship(与业务员的关系程度，如"可约饭的朋友关系""仅业务往来")，',
    'events(重要人生事件数组：从历史材料中找出的、对保险经营有意义的人生事件，如子女升学/留学/家人退休/买房/生子/换工作，每项 {"date":"YYYY-MM 或空字符串","text":"事件"}，按时间先后排列，没有则空数组)。',
    '【纪律】',
    '1. 只基于材料中明确出现的内容综合归纳，严禁猜测、严禁补充材料里没有的信息；某维度材料中完全没有依据时给 null。',
    '2. 文本字段是"当前状况"的一句话归纳（不超过 60 字），不是逐条摘抄；新旧信息冲突时以时间更晚的记录为准。',
    '3. events 的 date 优先用记录中明确提到的时间（如"明年""刚退休"结合跟进日期推断），无法确定月份时用空字符串；同一事件不重复列出。',
    '4. 只输出 JSON，不要解释、不要 markdown 代码块。',
  ].join('\n');

  var userContent = '客户：' + customer.customer_name +
    (customer.occupation ? '\n职业：' + customer.occupation : '') +
    (customer.hobbies ? '\n兴趣爱好：' + customer.hobbies : '') +
    (customer.marital_status ? '\n婚姻状况：' + customer.marital_status : '') +
    '\n附加信息：' + (customer.additional_info || '（无）') +
    '\n现有画像（仅供参考，可补充纠正，不要照抄空话）：' + (JSON.stringify(curProfile) === '{}' ? '（空）' : JSON.stringify(curProfile)) +
    '\n历史跟进记录（共 ' + folRows.length + ' 条，按时间正序）：\n' +
    (folRows.length
      ? folRows.map(function (f) {
          return '- [' + (f.followup_date || '日期不详') + '] ' + clip(f.followup_notes || '', 300);
        }).join('\n')
      : '（无跟进记录）');

  var gen = await generateText([
    { role: 'system', content: sys },
    { role: 'user', content: userContent },
  ], { timeout: 60000 });
  var parsed = extractJson(gen.text) || {};
  var updates = normProfileUpdates(parsed.profile_updates || parsed);

  return {
    profile_updates: updates,
    based_on: { followups_count: folRows.length, has_additional_info: !!(customer.additional_info || '') },
    raw: gen.text,
  };
}

// 画像更新建议清洗：仅保留本次沟通带来新信息的维度；全空返回 null
var PROFILE_TEXT_KEYS = ['family', 'children', 'parents', 'career', 'needs', 'relationship'];
function normProfileUpdates(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  var out = {}, any = false;
  PROFILE_TEXT_KEYS.forEach(function (k) {
    var v = clip(p[k], 100);
    if (v) { out[k] = v; any = true; }
  });
  var events = [];
  if (Array.isArray(p.events)) {
    p.events.forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      var text = clip(e.text, 80);
      if (!text) return;
      var date = '';
      if (typeof e.date === 'string') {
        var m = e.date.trim().match(/^(\d{4})-(\d{2})/);
        if (m) date = m[1] + '-' + m[2];
      }
      events.push({ date: date, text: text });
    });
  }
  if (events.length) { out.events = events.slice(0, 20); any = true; }
  return any ? out : null;
}

exports.main = async (event, context) => {
  try {
    var action = (event && event.action) || 'parse';
    if (action === 'analyze_profile') return await analyzeProfile(event);
    if (action !== 'parse') return { error: 'unknown action: ' + action };

    var customerId = parseInt(event && event.customer_id, 10);
    if (!customerId) return { error: 'customer_id required' };
    var text = ((event && event.text) || '').trim();
    if (text.length < 5) return { error: '沟通内容太短，请描述本次沟通（至少 5 个字）' };

    // 客户上下文
    var c = assertOk(await rdb.from('customers').select().eq('Id', customerId)
      .is('deleted_at', null).maybeSingle());
    if (!c.data) return { error: 'customer not found' };
    var customer = c.data;

    // 最近 5 条跟进：仅作上下文（避免把旧事当新信息），不照抄
    var folRows = assertOk(await rdb.from('followups')
      .select('followup_date, followup_notes, next_followup_date, next_followup_goal')
      .eq('customer_id', customerId).is('deleted_at', null)
      .order('followup_date', { ascending: false, nullsFirst: false })
      .order('Id', { ascending: false }).limit(5)).data || [];

    var today = todayStr();

    var sys = [
      '你是保险业务员的沟通记录助手。业务员用口语描述刚才与客户的沟通，你负责提取结构化信息，让他不用逐项填表。',
      '【今天】' + today + '。所有相对时间以此换算："下周X"=下一个自然周的周X、"月底"=本月最后一天、"过两周/两周后"=今天+14天、"月初"=下月1号（若本月已过月初）。',
      '【只输出 JSON】字段如下：',
      'followup_notes: 本次沟通内容要点，1-3句，简短客观，只写这次沟通发生的事实（聊了什么、客户什么反应），不写建议；',
      'followup_date: 本次沟通日期 YYYY-MM-DD；默认今天；若说"昨天/上周X/几天前"则换算；无法判断用 null；',
      'next_followup_date: 下次跟进日期 YYYY-MM-DD；从"下周/月底/过两天"等说法换算；明确没约时间也无法推断时用 null；',
      'next_followup_goal: 下次跟进目标，只能取：建立联系/约见面/邀请活动/获取家庭信息/推进签单/推进招募/推进转介绍；无法判断用 null；',
      'next_step: 下一步建议，1句、具体可执行（业务员拿到就能做）；没有则空字符串；',
      'needs: 客户本次表达的需求/兴趣/关注点（如教育费用、养老规划、保障缺口），用分号分隔，简短；没有则空字符串；',
      'relationship: 客户关系变化（如"关系明显升温""答应约时间""态度转冷"），简短；没有则空字符串；',
      'new_info: 本次新出现的家庭/职业/生命周期信息（如"孩子明年赴美留学""本人考虑换工作""配偶刚退休"），简短；没有则空字符串；',
      'stage_change: 若本次沟通表明客户经营阶段应向前推进，输出 {"to":阶段,"reason":"1句理由"}；阶段只能取：新认识/关系维护/需求挖掘/方案沟通/成交推进/转介绍经营；阶段无需变化或证据不足时用 null。',
      'profile_updates: 客户画像更新建议。仅当本次沟通"明确出现"以下维度的新信息或变化时才填，未提及的维度给 null：',
      '  family(家庭情况：婚姻/配偶/家庭结构)、children(子女情况：子女数量/年龄/教育阶段/重大安排)、parents(父母情况：赡养/健康/养老安排)、',
      '  career(职业/事业状态：工作变动/创业/晋升/收入变化等；职业名称本身不用填)、needs(当前主要需求：客户当下最关心的保障/财务需求，短语)、',
      '  relationship(与业务员的关系程度，如"可约饭的朋友关系""仅业务往来""转介绍来的信任关系")，',
      '  events(重要人生事件数组：本次提到的、对保险经营有意义的人生事件，如子女留学/家人退休/买房/生子/换工作，每项 {"date":"YYYY-MM 或空字符串","text":"事件"}，没有则空数组)。',
      '  每个文本字段不超过 60 字；只基于客户明确说出的内容，严禁猜测。',
      '【纪律】',
      '1. 严禁编造客户没说的信息；信息不足的字段给 null 或空字符串。',
      '2. 输出要短：followup_notes 不超过 120 字，其余每个字段不超过 60 字（new_info/needs 不超过 100 字）。',
      '3. needs/new_info 只记录"本次新出现"的内容；客户资料里已知的旧事不要重复。',
      '4. 只输出 JSON，不要解释、不要 markdown 代码块。',
    ].join('\n');

    var userContent = '客户：' + customer.customer_name +
      '；当前经营阶段：' + (customer.customer_stage || '未分层') +
      (customer.occupation ? '；职业：' + customer.occupation : '') +
      '\n客户已知附加信息（旧事，勿重复记录）：' + (customer.additional_info || '（无）') +
      '\n最近跟进记录（仅供了解上下文，勿照抄）：\n' +
      (folRows.length
        ? folRows.map(function (f) {
            return '- ' + (f.followup_date || '（无日期）') + '：' + clip(f.followup_notes || '', 100);
          }).join('\n')
        : '（无）') +
      '\n\n业务员对本次沟通的口语描述：\n' + text;

    var messages = [
      { role: 'system', content: sys },
      { role: 'user', content: userContent },
    ];
    var gen = await generateText(messages, { timeout: 60000 });
    var parsed = extractJson(gen.text) || {};

    // 阶段建议：词表校验 + 必须与当前阶段不同（相同则无意义）
    var stageChange = null;
    var sc = parsed.stage_change;
    if (sc && typeof sc === 'object' && !Array.isArray(sc)) {
      var to = inEnum(sc.to, STAGE_ENUM);
      if (to && to !== customer.customer_stage) {
        stageChange = { to: to, reason: clip(sc.reason, 60) };
      }
    }

    var result = {
      followup_notes: clip(parsed.followup_notes, 300),
      followup_date: normDate(parsed.followup_date) || today,
      next_followup_date: normDate(parsed.next_followup_date),
      next_followup_goal: inEnum(parsed.next_followup_goal, GOAL_ENUM),
      next_step: clip(parsed.next_step, 120),
      needs: clip(parsed.needs, 200),
      relationship: clip(parsed.relationship, 120),
      new_info: clip(parsed.new_info, 200),
      stage_change: stageChange,
      profile_updates: normProfileUpdates(parsed.profile_updates),
    };
    if (!result.followup_notes) {
      return { error: 'AI 未能从描述中识别出沟通内容，请补充细节后重试' };
    }
    return { parsed: result, today: today, raw: gen.text };
  } catch (e) {
    return { error: e.message };
  }
};
