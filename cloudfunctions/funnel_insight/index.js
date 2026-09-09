/**
 * funnel_insight — 轻量漏斗（v1.8 Sprint 8）
 *
 * 分工：SQL 视图 v_funnel_stats 负责全部事实（各阶段人数/近30天进入/阶段推进/逾期/停留），
 *       本函数只做小样本保护与拼装；AI 只负责解释事实，不产出任何数字。
 *
 * event:
 *   { action:'stats' }    纯事实，不调 AI，快
 *     → { ok, generated_at, funnels:[{key,label,total,stages[],metrics[],rates[],warnings[],insufficient}] }
 *   { action:'explain' }  读同一批事实喂 AI 出口语化解读
 *     → { ok, text, source:'ai'|'rule', degraded }  AI 失败/超时/空响应 → 规则版降级，页面永不白屏
 *
 * 小样本保护（硬规则）：
 *  - 漏斗总样本 < 10：不输出任何转化率
 *  - 相邻阶段转化率：上游阶段人数 < 10 不输出该段（分母太小，比率无参考价值）
 *  - 客户分层率属于"覆盖率"不是转化率，total>=10 才展示
 *  - 客户/机会无阶段变更时间戳：moved/dwell(stage) 恒 null，warnings 明示"无法计算"，AI prompt 禁止推断
 */
'use strict';

const { rdb, generateText } = require('./db');

const META = {
  customer: { label: '客户经营漏斗', source: 'customers.customer_stage' },
  opportunity: { label: '机会漏斗', source: 'opportunities.status' },
  recruit: { label: '组织发展漏斗', source: 'recruit_candidates.stage' },
};
const ORDER = ['customer', 'opportunity', 'recruit'];

// 相邻转化率只沿主管道计算（转介绍经营是客户漏斗的侧支，不串进成交管道）
const RATE_PATH = {
  customer: ['新认识', '关系维护', '需求挖掘', '方案沟通', '成交推进'],
  opportunity: ['发现', '沟通', '方案'],
  recruit: ['新增人才', '互动暖客', '初次面谈', '增员活动', '精准面谈', '入职申请', '签约入司'],
};
const SMALL_SAMPLE = 10;     // 漏斗总样本下限
const RATE_MIN_DENOM = 10;   // 相邻转化率的分母下限
const AI_TIMEOUT_MS = 50000;

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}
function pct(part, total) {
  return Math.round((part / total) * 1000) / 10; // 一位小数
}

// ---------- 读取 SQL 事实视图 ----------
async function loadRows() {
  const res = await rdb.from('v_funnel_stats').select(
    'funnel,stage,stage_order,kind,current_count,entered_30d,moved_30d,overdue_count,dwell_median_days,stuck_count'
  );
  if (res && res.error) {
    throw new Error('v_funnel_stats 读取失败：' + (res.error.message || JSON.stringify(res.error)));
  }
  return (res && res.data) || [];
}

// ---------- 事实拼装 + 小样本保护 ----------
function buildStats(rows) {
  const byKey = {};
  for (const k of ORDER) byKey[k] = [];
  for (const r of rows) {
    if (!byKey[r.funnel]) continue;
    byKey[r.funnel].push({
      stage: r.stage,
      order: toInt(r.stage_order) || 0,
      kind: r.kind || 'active',
      count: toInt(r.current_count) || 0,
      entered_30d: toInt(r.entered_30d) || 0,
      moved_30d: toInt(r.moved_30d),
      overdue: toInt(r.overdue_count) || 0,
      dwell_median_days: toInt(r.dwell_median_days),
      stuck: toInt(r.stuck_count) || 0,
    });
  }

  return ORDER.map(function (key) {
    const meta = META[key];
    const stages = byKey[key].sort(function (a, b) { return a.order - b.order; });
    const total = stages.reduce(function (s, x) { return s + x.count; }, 0);
    const overdueTotal = stages.reduce(function (s, x) { return s + x.overdue; }, 0);
    const enteredTotal = stages.reduce(function (s, x) { return s + x.entered_30d; }, 0);
    const movedTotal = stages.reduce(function (s, x) {
      return s + (x.moved_30d === null ? 0 : x.moved_30d);
    }, 0);
    const hasMovedField = stages.some(function (x) { return x.moved_30d !== null; });

    const warnings = [];
    const metrics = [];
    const rates = [];
    let insufficient = false;

    if (total === 0) {
      insufficient = true;
      warnings.push('当前没有在跟进中的记录，本漏斗暂不分析（不做无依据推断）');
    } else if (total < SMALL_SAMPLE) {
      warnings.push('在漏斗样本仅 ' + total + ' 条（<' + SMALL_SAMPLE + '），不展示转化率等比率指标');
    }

    // 漏斗级事实指标（都是人数，不是比率，小样本也安全）
    if (enteredTotal > 0) metrics.push({ label: '近30天进入', value: String(enteredTotal) + ' 人' });
    if (hasMovedField) metrics.push({ label: '近30天阶段推进', value: String(movedTotal) + ' 人' });
    if (overdueTotal > 0) metrics.push({ label: '逾期行动', value: String(overdueTotal) + ' 人', tone: 'bad' });
    const stuckTotal = stages.reduce(function (s, x) { return s + x.stuck; }, 0);
    if (stuckTotal > 0) metrics.push({ label: '停留偏久', value: String(stuckTotal) + ' 人', tone: 'warn' });

    if (key === 'customer') {
      const unclass = stages.filter(function (x) { return x.kind === 'unclassified'; })
        .reduce(function (s, x) { return s + x.count; }, 0);
      const classified = total - unclass;
      if (total >= SMALL_SAMPLE) {
        const tone = classified / total < 0.1 ? 'warn' : '';
        metrics.unshift({ label: '已分层率', value: pct(classified, total) + '%', tone: tone });
      }
      if (total > 0 && classified === 0) {
        warnings.push(total + ' 名客户均未分层，阶段漏斗尚不可分析，先补客户阶段标签');
        insufficient = true;
      } else if (classified > 0 && classified < SMALL_SAMPLE) {
        warnings.push('已分层客户仅 ' + classified + ' 人，样本过小，不展示阶段转化率');
      }
      warnings.push('客户表未记录阶段变更时间，阶段变化与停留时间无法计算');
    }
    if (key === 'opportunity') {
      warnings.push('机会表未记录状态变更时间，阶段变化无法计算；停留时间按「发现以来」估算');
    }

    // 相邻阶段转化率：总样本达标，且上游阶段人数 >= RATE_MIN_DENOM
    if (total >= SMALL_SAMPLE) {
      const countOf = {};
      stages.forEach(function (x) { countOf[x.stage] = x.count; });
      const path = RATE_PATH[key] || [];
      for (let i = 0; i < path.length - 1; i++) {
        const up = countOf[path[i]] || 0;
        const down = countOf[path[i + 1]] || 0;
        if (up >= RATE_MIN_DENOM) {
          rates.push({ from: path[i], to: path[i + 1], percent: down === 0 ? 0 : pct(down, up) });
        }
      }
    }

    return {
      key: key,
      label: meta.label,
      source: meta.source,
      total: total,
      stages: stages,
      metrics: metrics,
      rates: rates,
      warnings: warnings,
      insufficient: insufficient,
    };
  });
}

async function getStats() {
  return buildStats(await loadRows());
}

// ---------- AI 解读 ----------
function stageLine(s) {
  const parts = [s.stage + ' ' + s.count + ' 人'];
  if (s.entered_30d > 0) parts.push('近30天进入 ' + s.entered_30d);
  if (s.moved_30d !== null && s.moved_30d > 0) parts.push('近30天阶段推进 ' + s.moved_30d);
  if (s.overdue > 0) parts.push('逾期行动 ' + s.overdue + ' 人');
  if (s.dwell_median_days !== null && s.count > 0 && s.kind !== 'terminal') {
    parts.push('当前阶段停留中位 ' + s.dwell_median_days + ' 天');
  }
  if (s.stuck > 0) parts.push('停留偏久 ' + s.stuck + ' 人');
  return '- ' + parts.join('，');
}

function buildDigest(funnels) {
  const L = [];
  funnels.forEach(function (f) {
    L.push('【' + f.label + '｜数据源 ' + f.source + '】在漏斗总数：' + f.total + ' 人');
    const withCount = f.stages.filter(function (s) { return s.count > 0; });
    if (withCount.length) {
      withCount.forEach(function (s) { L.push(stageLine(s)); });
      const zeroActive = f.stages.filter(function (s) { return s.kind === 'active' && s.count === 0; })
        .map(function (s) { return s.stage; });
      if (zeroActive.length) L.push('- 人数为 0 的阶段：' + zeroActive.join('、'));
    } else {
      L.push('- 各阶段人数均为 0（漏斗为空）');
    }
    if (f.rates.length) {
      L.push('- 已计算的相邻阶段转化率：' + f.rates.map(function (r) {
        return r.from + '→' + r.to + ' ' + r.percent + '%';
      }).join('；'));
    }
    f.warnings.forEach(function (w) { L.push('- 数据限制：' + w); });
    L.push('');
  });
  return L.join('\n');
}

function buildMessages(funnels, today) {
  const system = [
    '你是保险从业者 Victor 的经营分析教练。下面三条漏斗的所有数字都由 SQL 视图计算，是确定事实。你只负责解释，不负责计算。',
    '硬规则：',
    '1. 只能引用输入中给出的数字和事实；严禁编造转化率、客户想法、活动效果、跟进记录或任何未提供的信息。',
    '2. 输入没有给出的比率一律不要输出；标注「不展示转化率」时绝对不要自行估算百分比。',
    '3. 某条漏斗为空或数据不足时，必须直接说「数据不足，暂不解读」，并说明先补什么数据（如先创建机会、先给客户分层），禁止硬凑结论。',
    '4. 客户表没有阶段变更时间：严禁推断客户阶段变化快慢或在某阶段停留多久；逾期行动人数是事实，可以直接引用。',
    '5. 解读要像有经验的业务教练，直指瓶颈。例如：「客户数量不少，但从建立关系到明确需求的人比较少，瓶颈不是获客而是需求发现」、「最近活动带来不少新关系，但活动后的第一次跟进不足」。',
    '6. 输出三段，分别以「客户经营：」「机会：」「组织发展：」开头，每段 2-4 句大白话，可点阶段名和人数。最后另起一行，以「今天先动手：」开头给一件最值得做的具体动作。全文不超过 350 字，不要标题、不要 markdown、不要列表符号之外的格式。',
  ].join('\n');
  const user = '今天是 ' + today + '。漏斗事实（SQL 计算，含数据限制）：\n\n' + buildDigest(funnels);
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ---------- 规则版解读（AI 不可用时的降级，只复述事实，不编造） ----------
function ruleExplain(funnels) {
  const out = [];
  let firstAction = '';

  funnels.forEach(function (f) {
    if (f.key === 'customer') {
      if (f.total === 0) { out.push('客户经营：系统里还没有客户记录。'); return; }
      const unclass = f.stages.filter(function (s) { return s.kind === 'unclassified'; })
        .reduce(function (sum, s) { return sum + s.count; }, 0);
      const classified = f.total - unclass;
      const cnt = {};
      f.stages.forEach(function (s) { cnt[s.stage] = s.count; });
      let line = '客户经营：在管 ' + f.total + ' 人，' + unclass + ' 人尚未分层';
      if (unclass / f.total >= 0.5) line += '，多数客户还没有阶段标签，漏斗看不清，先给近期接触的人补分层';
      line += '。';
      if (classified > 0) {
        const path = RATE_PATH.customer;
        const pos = path.filter(function (n) { return (cnt[n] || 0) > 0; }).map(function (n) { return n + ' ' + cnt[n] + ' 人'; });
        line += '已分层客户集中在：' + pos.join('、') + '。';
        // 最大的相邻人数落差（只陈述人数，不造比率）
        let drop = null;
        for (let i = 0; i < path.length - 1; i++) {
          const a = cnt[path[i]] || 0, b = cnt[path[i + 1]] || 0;
          if (a > 0 && a - b > (drop ? drop.d : 0)) drop = { d: a - b, from: path[i], to: path[i + 1], a: a, b: b };
        }
        if (drop && drop.d >= 3) line += '从「' + drop.from + '」' + drop.a + ' 人到「' + drop.to + '」' + drop.b + ' 人落差最大，检查中间的经营动作。';
      }
      const od = f.metrics.filter(function (m) { return m.label === '逾期行动'; })[0];
      if (od) line += '当前有 ' + od.value + '的行动已逾期。';
      out.push(line);
    } else if (f.key === 'opportunity') {
      if (f.total === 0) {
        out.push('机会：当前没有进行中的经营机会，漏斗为空、暂不解读。先从需求挖掘阶段的客户里创建机会，漏斗才会有数据。');
        return;
      }
      const cnt = {};
      f.stages.forEach(function (s) { cnt[s.stage] = s.count; });
      let line = '机会：在跟进 ' + f.total + ' 个，分布 ' +
        f.stages.filter(function (s) { return s.count > 0; })
          .map(function (s) { return s.stage + ' ' + s.count; }).join('、') + '。';
      const od = f.metrics.filter(function (m) { return m.label === '逾期行动'; })[0];
      if (od) line += '有 ' + od.value + '的下一步已逾期。';
      const dwell = f.stages.filter(function (s) { return s.kind === 'active' && s.dwell_median_days !== null; })
        .map(function (s) { return s.stage + '中位' + s.dwell_median_days + '天'; });
      if (dwell.length) line += '停留：' + dwell.join('、') + '（按发现以来估算）。';
      out.push(line);
    } else {
      if (f.total === 0) { out.push('组织发展：还没有增员候选人，漏斗为空、暂不解读。'); return; }
      const cnt = {};
      f.stages.forEach(function (s) { cnt[s.stage] = s.count; });
      const pos = RATE_PATH.recruit.filter(function (n) { return (cnt[n] || 0) > 0; });
      let line = '组织发展：候选人 ' + f.total + ' 人，' +
        pos.map(function (n) { return n + ' ' + cnt[n] + ' 人'; }).join('、') + '。';
      const nextStage = RATE_PATH.recruit.filter(function (n) { return (cnt[n] || 0) === 0; })[0];
      if (nextStage) line += '尚无一人进入「' + nextStage + '」。';
      const entered = f.metrics.filter(function (m) { return m.label === '近30天进入'; })[0];
      if (entered) line += '近 30 天新进 ' + f.stages.reduce(function (s, x) { return s + x.entered_30d; }, 0) + ' 人。';
      const dwells = f.stages.filter(function (s) { return s.count > 0 && s.dwell_median_days !== null; })
        .map(function (s) { return s.stage + '中位' + s.dwell_median_days + '天'; });
      if (dwells.length) line += '停留：' + dwells.join('、') + '。';
      const stuck = f.metrics.filter(function (m) { return m.label === '停留偏久'; })[0];
      if (stuck) line += stuck.value + '停留超 30 天。';
      out.push(line);
    }
  });

  // 今日动作优先级：逾期 > 增员卡在早期 > 机会为空 > 客户未分层
  const cust = funnels[0], opp = funnels[1], rec = funnels[2];
  const custOd = cust.metrics.filter(function (m) { return m.label === '逾期行动'; })[0];
  if (custOd) firstAction = '先清逾期行动（客户漏斗共 ' + custOd.value + '），再补分层。';
  else if (rec.total > 0) {
    const cnt = {}; rec.stages.forEach(function (s) { cnt[s.stage] = s.count; });
    if ((cnt['初次面谈'] || 0) === 0) firstAction = '从「新增人才/互动暖客」里约出第一轮面谈，推动至少 1 人进入初次面谈。';
  }
  if (!firstAction && opp.total === 0 && cust.total > 0) firstAction = '从需求挖掘阶段的客户里新建 1 个经营机会。';
  if (!firstAction && cust.total > 0) {
    const unclass = cust.stages.filter(function (s) { return s.kind === 'unclassified'; })
      .reduce(function (sum, s) { return sum + s.count; }, 0);
    if (unclass > 0) firstAction = '给 5 个最近接触的客户补上阶段标签。';
  }
  if (!firstAction) firstAction = '今天暂无待推进事项。';
  out.push('今天先动手：' + firstAction);
  return out.join('\n');
}

async function explain() {
  const funnels = await getStats();
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const messages = buildMessages(funnels, today);
    const task = generateText(messages, { temperature: 0.4, maxTokens: 900 });
    const timer = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, AI_TIMEOUT_MS); });
    const res = await Promise.race([task, timer]);
    const text = res && String(res.text || '').trim();
    if (text && text.length >= 20) {
      return { ok: true, text: text, source: 'ai', degraded: false, generated_at: new Date().toISOString() };
    }
    return {
      ok: true, text: ruleExplain(funnels), source: 'rule', degraded: true,
      reason: 'AI 返回为空', generated_at: new Date().toISOString(),
    };
  } catch (e) {
    return {
      ok: true, text: ruleExplain(funnels), source: 'rule', degraded: true,
      reason: String(e && e.message || e), generated_at: new Date().toISOString(),
    };
  }
}

exports.main = async function (event) {
  const action = event && event.action;
  try {
    if (action === 'stats') {
      return { ok: true, generated_at: new Date().toISOString(), funnels: await getStats() };
    }
    if (action === 'explain') return await explain();
    return { ok: false, error: 'unknown action: ' + action };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
};
