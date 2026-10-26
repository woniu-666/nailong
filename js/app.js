/* ============================================================
   “舆”法风险辅助研判系统 · 原型逻辑
   事件录入 → 线索识别 → 四维研判 → 法律匹配 → 分级 → 人工复核 → 报告
   ============================================================ */
(function () {
  'use strict';

  var D = window.YF_DATA;
  var $ = function (s, p) { return (p || document).querySelector(s); };
  var $$ = function (s, p) { return Array.prototype.slice.call((p || document).querySelectorAll(s)); };

  /* ---------------- 状态 ---------------- */
  var mem = {}; // localStorage 降级方案
  function storeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return mem[key] || null; }
  }
  function storeSet(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { mem[key] = val; }
  }

  var state = {
    cases: [],
    activeId: null,
    filter: 'all',
    view: 'dash',
    noticeClosed: false
  };

  function loadCases() {
    var raw = storeGet(D.STORAGE_KEY);
    if (raw) {
      try { state.cases = JSON.parse(raw) || []; } catch (e) { state.cases = []; }
    }
    if (!state.cases.length) {
      state.cases = seedCases();
      saveCases();
    }
    var act = storeGet(D.ACTIVE_KEY);
    state.activeId = act && findCase(act) ? act : null;
  }
  function saveCases() { storeSet(D.STORAGE_KEY, JSON.stringify(state.cases)); }
  function setActive(id) { state.activeId = id; storeSet(D.ACTIVE_KEY, id || ''); }
  function findCase(id) {
    for (var i = 0; i < state.cases.length; i++) if (state.cases[i].id === id) return state.cases[i];
    return null;
  }
  function activeCase() { return state.activeId ? findCase(state.activeId) : null; }

  function seedCases() {
    return D.DEMO_CASES.map(function (c) {
      var k = Object.assign({}, c);
      k.createdAt = c.createdAt || new Date().toISOString();
      k.status = 'progress';
      k.clues = runClues(k);
      k.dims = computeDims(k);
      k.grade = suggestGrade(k);
      k.review = null;
      k.records = [{
        t: k.createdAt, actor: '系统', type: 'machine',
        text: '完成线索识别、四维评估与分级建议（预置演示数据，机器输出）'
      }];
      return k;
    });
  }

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function maskPII(frag) {
    return frag
      .replace(/(1[3-9]\d)\d{4}(\d{4})/g, '$1****$2')
      .replace(/(\d{4})\d{10,13}([0-9Xx])/g, '$1**********$2');
  }

  var toastTimer = null;
  function toast(msg, type) {
    var el = $('#yfToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'yfToast';
      el.style.cssText = 'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:999;' +
        'padding:10px 22px;border-radius:999px;font-size:13.5px;color:#fff;box-shadow:0 10px 30px rgba(14,33,72,.35);' +
        'transition:opacity .3s, transform .3s;pointer-events:none;max-width:86vw;text-align:center;';
      document.body.appendChild(el);
    }
    el.style.background = type === 'err' ? 'var(--risk-4)' : 'var(--navy-700)';
    el.textContent = msg;
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(8px)';
    }, 2400);
  }

  /* ---------------- 线索识别 ---------------- */
  function runClues(c) {
    var clues = [], text = c.text || '';
    D.CLUE_RULES.forEach(function (rule) {
      (rule.words || []).forEach(function (w) {
        var from = 0, pos;
        while ((pos = text.indexOf(w, from)) !== -1) {
          clues.push(mkClue(rule, w, pos));
          from = pos + w.length;
        }
      });
      if (rule.regex) {
        rule.regex.forEach(function (r) {
          r.re.lastIndex = 0;
          var m;
          while ((m = r.re.exec(text)) !== null) {
            clues.push(mkClue(rule, m[0], m.index, r.label));
            if (m.index === r.re.lastIndex) r.re.lastIndex++;
          }
        });
      }
    });
    clues.sort(function (a, b) { return a.start - b.start; });
    // 保留旧的人工状态（同一片段且同类别）
    var old = {};
    (c.clues || []).forEach(function (o) { old[o.frag + '|' + o.cat] = o; });
    clues.forEach(function (n) {
      var o = old[n.frag + '|' + n.cat];
      if (o) { n.status = o.status; n.humanCat = o.humanCat || null; }
    });
    return clues;
  }
  function mkClue(rule, frag, start, regexLabel) {
    return {
      id: uid(),
      catIdx: rule.idx,
      cat: rule.cat,
      frag: frag,
      start: start,
      end: start + frag.length,
      regexLabel: regexLabel || null,
      reason: (regexLabel ? '命中' + regexLabel + '：' : '') + rule.reason,
      verify: rule.verify,
      method: '规则匹配',
      status: 'machine', // machine | confirmed | rejected
      humanCat: null
    };
  }
  function activeClues(c) {
    return (c.clues || []).filter(function (x) { return x.status !== 'rejected'; });
  }

  /* ---------------- 四维研判 ---------------- */
  function computeDims(c) {
    var clues = activeClues(c).filter(function (x) { return x.status !== 'rejected'; });
    var cnt = {};
    clues.forEach(function (x) { cnt[x.cat] = (cnt[x.cat] || 0) + 1; });
    var fact = D.FACT_MAP[c.fact] || D.FACT_MAP['尚未核实'];

    // D2 攻击强度
    var threat = (cnt['威胁恐吓'] || 0), mob = (cnt['动员围攻'] || 0),
        insult = (cnt['侮辱谩骂'] || 0), acc = (cnt['未证实指控'] || 0);
    var d2, d2Why;
    if (threat > 0 || mob >= 2) { d2 = '高'; d2Why = '出现威胁或成规模动员表述'; }
    else if (mob === 1 || insult >= 2 || (insult + acc) >= 3) { d2 = '中'; d2Why = '存在重复攻击或多条侮辱/指控线索'; }
    else if (clues.length > 0) { d2 = '低'; d2Why = '仅零星线索，需结合上下文与持续性判断'; }
    else { d2 = '待核实'; d2Why = '暂未识别到攻击性线索'; }

    // D3 权益风险
    var risks = [];
    if (cnt['侮辱谩骂'] || cnt['未证实指控']) risks.push('名誉风险');
    if (cnt['个人信息暴露']) risks.push('个人信息与隐私风险');
    if (cnt['威胁恐吓']) risks.push('人身安全风险');
    if (cnt['动员围攻']) risks.push('群体性围攻风险');
    var d3 = risks.length ? (threat > 0 || cnt['个人信息暴露'] ? '高风险' : '中风险') : '低风险';
    var d3Why = risks.length ? '疑似涉及：' + risks.join('、') : '暂未识别到明确权益侵害线索';

    // D4 平台注意义务（仅清单与提示，不自动判定责任）
    var duty = [];
    if (c.notice === '已收到') duty.push('已收到通知/投诉：需记录收到时间与内容，评估响应是否及时（参见“通知—删除”规则）。');
    else if (c.notice === '情况不明') duty.push('通知情况不明：需核查平台是否已接到投诉或已通过巡查知悉。');
    else duty.push('暂未收到通知：需评估平台是否“应当知道”风险（如线索已上热搜、被多次举报）。');
    if (c.measure === '未知') duty.push('既有平台措施未知：需调取处置记录。');
    else if (c.measure === '未处理') duty.push('平台尚未处置：需评估风险紧迫性与措施可行性。');
    else duty.push('平台已有处置动作：需评估措施与风险是否相称、是否需要升级。');
    duty.push('传播规模与扩散速度尚缺可靠数据：如可获得，应补充传播情况观察。');

    return {
      d1: { auto: fact.status, human: null, why: '依据录入的事实状态“' + c.fact + '”作出初步判断。', todo: '关键事实是否有权威来源？各方说法冲突点是什么？当事人是否已回应？' },
      d2: { auto: d2, human: null, why: d2Why + '。', todo: '攻击是否持续、集中？是否跨平台扩散？是否存在讽刺、转述等误判可能？' },
      d3: { auto: d3, human: null, why: d3Why + '。', todo: '疑似个人信息是否真实、是否已公开？威胁是否明确、具体、紧迫？' },
      d4: { auto: duty.length >= 3 ? '需优先核查' : '需关注', human: null, why: '结合平台获知方式与既有措施形成核查清单。', todo: duty.join(' ') }
    };
  }
  function dimDisplay(dk, d) { return d.human || d.auto; }

  function dimClsMap(dk, val) {
    if (dk === 'd1') return { '已核实': 'ds-ok', '部分核实': 'ds-mid', '尚未核实': 'ds-high', '存在冲突': 'ds-crit' }[val] || 'ds-mid';
    if (dk === 'd2') return { '低': 'ds-ok', '待核实': 'ds-mid', '中': 'ds-mid', '高': 'ds-crit' }[val] || 'ds-mid';
    if (dk === 'd3') return { '低风险': 'ds-ok', '待核实': 'ds-mid', '中风险': 'ds-high', '高风险': 'ds-crit' }[val] || 'ds-mid';
    return { '常规': 'ds-ok', '待核实': 'ds-mid', '需关注': 'ds-mid', '需优先核查': 'ds-crit' }[val] || 'ds-mid';
  }

  var DIM_META = [
    { key: 'd1', title: 'D1 事实确定度', obs: '<b>观察项：</b>权威来源情况、关键事实核实程度、来源冲突、信息缺口', note: '该维度不直接判断事件真伪' },
    { key: 'd2', title: 'D2 攻击强度', obs: '<b>观察项：</b>集中指向、重复攻击、威胁、动员、传播情况', note: '不得仅凭负面情绪或热度定级' },
    { key: 'd3', title: 'D3 权益风险', obs: '<b>观察项：</b>名誉、隐私、个人信息、人身安全等潜在影响', note: '须核查语境、真实性和具体权益影响' },
    { key: 'd4', title: 'D4 平台注意义务', obs: '<b>观察项：</b>是否收到通知、是否已知悉、处置时间、措施可行性与适当性', note: '不得由 AI 单独判定平台有责/无责' }
  ];
  var DIM_OPTIONS = {
    d1: ['已核实', '部分核实', '尚未核实', '存在冲突'],
    d2: ['低', '中', '高', '待核实'],
    d3: ['低风险', '中风险', '高风险', '待核实'],
    d4: ['常规', '需关注', '需优先核查', '待核实']
  };

  /* ---------------- 分级建议 ---------------- */
  function suggestGrade(c) {
    var cnt = {};
    activeClues(c).forEach(function (x) { if (x.status !== 'rejected') cnt[x.cat] = (cnt[x.cat] || 0) + 1; });
    var g = 1;
    if (cnt['侮辱谩骂'] || cnt['未证实指控']) g = 2;
    if (cnt['动员围攻'] || cnt['个人信息暴露']) g = 3;
    if (cnt['威胁恐吓']) g = 4;
    return g;
  }

  /* ---------------- 法律匹配 ---------------- */
  function matchedLaws(c) {
    var cats = {};
    activeClues(c).forEach(function (x) { cats[x.cat] = true; });
    return D.LAW_LIBRARY.filter(function (l) {
      return l.match.some(function (m) { return cats[m]; });
    });
  }

  /* ---------------- 记录 ---------------- */
  function addRecord(c, type, actor, text) {
    c.records = c.records || [];
    c.records.push({ t: new Date().toISOString(), actor: actor, type: type, text: text });
  }

  /* ---------------- 渲染：顶栏/导航 ---------------- */
  var VIEWS = [
    { id: 'dash', name: '工作台' },
    { id: 'event', name: '新建事件' },
    { id: 'clues', name: '线索识别' },
    { id: 'dims', name: '四维研判' },
    { id: 'legal', name: '法律与建议' },
    { id: 'report', name: '复核与报告' }
  ];

  function renderTop() {
    var c = activeCase();
    $('#topCaseName').textContent = c ? c.name : '未选择';
    var steps = $('#topSteps');
    steps.innerHTML = VIEWS.map(function (v) {
      return '<span class="tstep' + (v.id === state.view ? ' active' : '') + '" data-goto="' + v.id + '">' + v.name + '</span>';
    }).join('');
    $$('.side-item').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-view') === state.view);
    });
  }

  function goto(view) {
    var gated = ['clues', 'dims', 'legal', 'report'];
    if (gated.indexOf(view) !== -1 && !activeCase()) {
      toast('请先选择或新建一个研判案件', 'err');
      view = 'dash';
    }
    state.view = view;
    $$('.view').forEach(function (v) { v.classList.remove('active'); });
    var el = $('#view-' + view);
    if (el) el.classList.add('active');
    renderTop();
    $('#appSide').classList.remove('open');
    $('#sideMask').classList.remove('show');
    if (view === 'dash') renderDash();
    if (view === 'event') loadFormFromCase();
    if (view === 'clues') renderClues();
    if (view === 'dims') renderDims();
    if (view === 'legal') renderLegal();
    if (view === 'report') renderReportView();
    window.scrollTo({ top: 0 });
  }

  /* ---------------- 渲染：工作台 ---------------- */
  var ST_MAP = {
    draft: ['草稿', 'st-draft'],
    progress: ['研判中', 'st-progress'],
    done: ['已复核', 'st-done']
  };

  function renderDash() {
    var total = state.cases.length;
    var pending = state.cases.filter(function (c) { return c.status !== 'done'; }).length;
    var done = total - pending;
    var high = state.cases.filter(function (c) { return (c.review ? c.review.grade : c.grade) >= 3; }).length;
    $('#statRow').innerHTML =
      stat('📋', total, '案件总数', '#E8EEFC') +
      stat('⏳', pending, '待复核', '#F9EFE0') +
      stat('✅', done, '已复核', '#E5F2E6') +
      stat('🚨', high, '三级及以上', '#FCEAE0');

    var list = state.cases.filter(function (c) {
      if (state.filter === 'pending') return c.status !== 'done';
      if (state.filter === 'done') return c.status === 'done';
      return true;
    }).sort(function (a, b) { return b.createdAt < a.createdAt ? -1 : 1; });

    var box = $('#caseList');
    if (!list.length) {
      box.innerHTML = '<div class="empty-tip">暂无案件，点击右上角“新建研判”开始</div>';
      return;
    }
    box.innerHTML = list.map(function (c) {
      var st = ST_MAP[c.status] || ST_MAP.progress;
      var g = c.review ? c.review.grade : c.grade;
      var gCls = 'g' + g;
      var gName = (D.GRADES[g] || D.GRADES[1]).name.split(' · ')[1];
      return '<div class="case-item' + (c.id === state.activeId ? ' active' : '') + '" data-open="' + c.id + '">' +
        '<div class="case-info">' +
        '<h3>' + esc(c.name) + '</h3>' +
        '<div class="case-meta"><span>录入：' + fmtTime(c.createdAt) + '</span><span>事实状态：' + esc(c.fact || '—') + '</span><span>线索：' + activeClues(c).length + ' 条</span></div>' +
        '</div>' +
        '<span class="status-chip ' + st[1] + '">' + st[0] + '</span>' +
        '<span class="grade-chip ' + gCls + '">' + esc(gName) + '</span>' +
        '<button class="case-del" data-del="' + c.id + '" title="删除案件">✕</button>' +
        '</div>';
    }).join('');
  }
  function stat(ico, num, lab, bg) {
    return '<div class="stat-card"><div class="stat-ico" style="background:' + bg + '">' + ico + '</div>' +
      '<div><div class="stat-num">' + num + '</div><div class="stat-lab">' + lab + '</div></div></div>';
  }

  /* ---------------- 渲染：事件表单 ---------------- */
  function loadFormFromCase() {
    var c = activeCase();
    if (!c) return;
    $('#fName').value = c.name || '';
    $('#fTime').value = c.time || '';
    $('#fFact').value = c.fact || '';
    $('#fBg').value = c.background || '';
    $('#fText').value = c.text || '';
    $('#fSource').value = c.source || '';
    $('#fMeasure').value = c.measure || '未知';
    $('#fNotice').value = c.notice || '未收到';
    $('#fAttach').value = c.attach || '';
  }
  function collectForm() {
    return {
      name: $('#fName').value.trim(),
      time: $('#fTime').value,
      fact: $('#fFact').value,
      background: $('#fBg').value.trim(),
      text: $('#fText').value,
      source: $('#fSource').value.trim(),
      measure: $('#fMeasure').value,
      notice: $('#fNotice').value,
      attach: $('#fAttach').value.trim()
    };
  }
  function validateForm() {
    var ok = true;
    [['fName', 'v'], ['fTime', 'v'], ['fFact', 'v'], ['fBg', 'v'], ['fText', 'v'], ['fSource', 'v']].forEach(function (pair) {
      var id = pair[0];
      var el = $('#' + id);
      var val = (el.type === 'radio') ? '' : el.value.trim();
      var bad = !val;
      el.closest('.field').classList.toggle('invalid', bad);
      if (bad) ok = false;
    });
    return ok;
  }

  /* ---------------- 渲染：线索识别 ---------------- */
  function renderClues() {
    var c = activeCase();
    if (!c) return;
    // 原文标注
    var text = c.text || '';
    var clues = (c.clues || []).slice().sort(function (a, b) { return a.start - b.start; });
    var ranges = [], lastEnd = -1;
    clues.forEach(function (cl) {
      if (cl.start >= lastEnd) { ranges.push(cl); lastEnd = cl.end; }
    });
    var html = '', pos = 0;
    ranges.forEach(function (cl) {
      if (cl.start > pos) html += esc(text.slice(pos, cl.start));
      var shown = esc(cl.status === 'rejected' ? cl.frag : (cl.cat === '个人信息暴露' ? maskPII(cl.frag) : cl.frag));
      html += '<span class="mk mk-c' + cl.catIdx + (cl.status === 'rejected' ? ' mk-removed' : '') + '" data-clue="' + cl.id + '" title="' + esc(cl.cat) + '">' + shown + '</span>';
      pos = cl.end;
    });
    if (pos < text.length) html += esc(text.slice(pos));
    $('#markText').innerHTML = html || '<span class="hint">暂无文本</span>';

    // 线索列表
    $('#clueCount').textContent = clues.filter(function (x) { return x.status !== 'rejected'; }).length;
    var box = $('#clueList');
    if (!clues.length) {
      box.innerHTML = '<div class="empty-tip">规则库未命中风险线索。请继续人工浏览原文，规则匹配可能存在漏报。</div>';
      return;
    }
    box.innerHTML = clues.map(function (cl) {
      var frag = cl.cat === '个人信息暴露' ? maskPII(cl.frag) : cl.frag;
      var catSel = '<select data-recat="' + cl.id + '" style="display:none">' +
        D.CLUE_RULES.map(function (r) { return '<option value="' + r.idx + '"' + (r.idx === cl.catIdx ? ' selected' : '') + '>' + r.cat + '</option>'; }).join('') +
        '</select>';
      return '<div class="clue-item cl-c' + cl.catIdx + (cl.status === 'rejected' ? ' rejected' : '') + '">' +
        '<div class="clue-top">' +
        '<span class="clue-cat">' + esc(cl.humanCat ? cl.humanCat + '（人工改判）' : cl.cat) + '</span>' +
        '<span class="src-chip">' + esc(cl.method) + '</span>' +
        (cl.status === 'confirmed' ? '<span class="mbadge mb-human">人工已确认</span>' : '') +
        (cl.status === 'rejected' ? '<span class="mbadge" style="background:#F0F3F9;color:#8A94A6">人工判定为误报</span>' : '') +
        '<span class="clue-frag">命中片段：“' + esc(frag) + '”</span>' +
        '</div>' +
        catSel +
        '<div class="clue-row"><b>识别理由：</b>' + esc(cl.reason) + '</div>' +
        '<div class="clue-verify"><b>待人工核验：</b>' + esc(cl.verify) + '</div>' +
        '<div class="clue-ops">' +
        (cl.status !== 'confirmed' ? '<button class="btn btn-plain" data-clue-ok="' + cl.id + '">✓ 确认为有效线索</button>' : '') +
        '<button class="btn btn-plain" data-clue-edit="' + cl.id + '">改判类别</button>' +
        (cl.status !== 'rejected' ? '<button class="btn btn-plain" data-clue-bad="' + cl.id + '">✕ 标记误报</button>' : '') +
        '</div></div>';
    }).join('');
  }
  function afterHumanClueChange(c, text) {
    c.dims = computeDims(c);
    c.grade = suggestGrade(c);
    addRecord(c, 'human', '复核人', text);
    saveCases();
    renderClues();
  }

  /* ---------------- 渲染：四维研判 ---------------- */
  function renderDims() {
    var c = activeCase();
    if (!c) return;
    $('#dimGrid').innerHTML = DIM_META.map(function (m) {
      var d = c.dims[m.key];
      if (!d) return '';
      var shown = dimDisplay(m.key, d);
      var opts = DIM_OPTIONS[m.key].map(function (o) {
        return '<option' + (o === shown ? ' selected' : '') + '>' + o + '</option>';
      }).join('');
      return '<div class="dim-box ' + (m.key === 'd1' ? '' : m.key) + '">' +
        '<div class="dim-box-head"><h3>' + m.title + '</h3>' +
        '<span class="dim-status ' + dimClsMap(m.key, shown) + '">' + esc(shown) + '</span></div>' +
        '<p class="dim-obs">' + m.obs + '</p>' +
        '<p class="dim-reason">' + esc(d.why) + '</p>' +
        '<p class="dim-todo"><b>待核实：</b>' + esc(d.todo) + '</p>' +
        '<div class="dim-adjust"><label>人工调整结论：</label>' +
        '<select data-dim="' + m.key + '">' + opts + '</select></div>' +
        '<p class="dim-note-mini">' + m.note + '</p>' +
        '</div>';
    }).join('');
  }

  /* ---------------- 渲染：法律与建议 ---------------- */
  function renderLegal() {
    var c = activeCase();
    if (!c) return;
    var laws = matchedLaws(c);
    $('#lawList').innerHTML = laws.length ? laws.map(function (l) {
      return '<div class="law-item">' +
        '<div class="law-item-top"><h3>' + esc(l.name) + '</h3><span class="law-tag">' + esc(l.tag) + '</span></div>' +
        '<p><b>条文摘要：</b>' + l.summary + '</p>' +
        '<p><b>适用提示：</b>' + esc(l.apply) + '</p>' +
        '<a class="law-link" href="' + l.link + '" target="_blank" rel="noopener">查看官方来源 ↗</a>' +
        '</div>';
    }).join('') : '<div class="empty-tip">未命中风险线索，暂无匹配规范。可返回补充文本或人工研判。</div>';

    var tips = [
      '<b>边界提示：</b>关键词命中只能作为线索，讽刺、反问、新闻引用、合理批评或转述他人言论可能产生误判，请结合上下文判断。',
      '<b>相称性原则：</b>处置措施应与风险紧迫性、损害程度和可逆性相称，优先采用可逆的温和措施。',
      '<b>程序要求：</b>处置过程应留存记录，保障用户申诉与复核渠道；高风险措施应由授权人员执行。',
      '<b>禁止事项：</b>不得仅依据观点立场、情绪强度或事件热度判定高风险；不得由 AI 自动实施账号处罚或内容删除。'
    ];
    $('#lawTips').innerHTML = tips.map(function (t) { return '<li>' + t + '</li>'; }).join('');
  }

  /* ---------------- 渲染：复核与报告 ---------------- */
  function renderReportView() {
    var c = activeCase();
    if (!c) return;

    // 分级建议
    var g = c.review ? c.review.grade : c.grade;
    var gd = D.GRADES[g] || D.GRADES[1];
    $('#gradeSuggest').innerHTML =
      '<div class="grade-big" style="background:' + gd.color + '"><b>' + g + '</b><span>级</span></div>' +
      '<div class="grade-desc"><h3>' + esc(gd.name) + (c.review && c.review.grade !== c.grade ? '（人工调整）' : '（机器建议）') + '</h3>' +
      '<p><b>触发情形：</b>' + esc(gd.trigger) + '</p>' +
      '<p><b>建议措施：</b>' + esc(gd.measure) + '　<b class="hint">限制：' + esc(gd.limit) + '</b></p></div>' +
      '<div class="grade-warn">⚠ 机器分级仅基于规则命中情况，未充分纳入语境与证据核验，最终分级以人工复核结论为准。</div>';

    // 记录
    $('#recordList').innerHTML = (c.records || []).slice().reverse().map(function (r) {
      return '<li class="record-item rec-' + r.type + '">' +
        '<span class="record-dot"></span>' +
        '<div class="record-body"><h4>' + esc(r.actor) + ' · ' +
        (r.type === 'machine' ? '<span class="mbadge mb-machine">机器</span>' : r.type === 'final' ? '<span class="mbadge" style="background:#F7EEDB;color:#8A6A2E">最终</span>' : '<span class="mbadge mb-human">人工</span>') +
        '<span class="record-time">' + fmtTime(r.t) + '</span></h4>' +
        '<p>' + esc(r.text) + '</p></div></li>';
    }).join('') || '<div class="empty-tip">暂无记录</div>';

    // 复核表单回填
    if (c.review) {
      $('#rReviewer').value = c.review.reviewer;
      $('#rDecision').value = c.review.decision;
      $('#rGrade').value = c.review.grade;
      $('#rMeasures').value = c.review.measures;
      $('#rReason').value = c.review.reason;
    }

    // 报告
    if (c.review) {
      $('#reportEmpty').style.display = 'none';
      $('#reportBody').style.display = 'block';
      $('#reportBody').innerHTML = buildReport(c);
    } else {
      $('#reportEmpty').style.display = 'block';
      $('#reportBody').style.display = 'none';
    }
  }

  function clueStatusName(s) {
    return s === 'confirmed' ? '人工确认' : s === 'rejected' ? '人工驳回（误报）' : '机器识别';
  }

  function buildReport(c) {
    var g = c.review.grade;
    var gd = D.GRADES[g];
    var laws = matchedLaws(c);
    var clues = c.clues || [];
    var todos = [];
    clues.forEach(function (x) { if (x.status !== 'rejected') todos.push(x.verify); });
    ['d1', 'd2', 'd3', 'd4'].forEach(function (k) { if (c.dims[k]) todos.push(c.dims[k].todo); });

    var rows = clues.length ? clues.map(function (x) {
      return '<tr><td>' + esc(x.cat) + '</td><td>' + esc(x.cat === '个人信息暴露' ? maskPII(x.frag) : x.frag) + '</td><td>' + esc(x.method) + '</td><td>' + clueStatusName(x.status) + '</td></tr>';
    }).join('') : '<tr><td colspan="4">未命中风险线索</td></tr>';

    var dimRows = DIM_META.map(function (m) {
      var d = c.dims[m.key];
      return '<tr><td>' + m.title + '</td><td>' + esc(dimDisplay(m.key, d)) + (d.human ? '（人工调整）' : '') + '</td><td>' + esc(d.why) + '</td></tr>';
    }).join('');

    var recRows = (c.records || []).map(function (r) {
      return '<tr><td style="white-space:nowrap">' + fmtTime(r.t) + '</td><td>' + esc(r.actor) + '</td><td>' + esc(r.text) + '</td></tr>';
    }).join('');

    return '<h2>“舆”法风险辅助研判报告</h2>' +
      '<p class="rp-sub">案件编号：' + esc(c.id) + ' ｜ 生成时间：' + fmtTime(new Date().toISOString()) + ' ｜ 版本 V1.0</p>' +

      '<div class="rp-sec"><h3>一、事件信息</h3><div class="rp-meta">' +
      '<div><b>事件名称</b>' + esc(c.name) + '</div>' +
      '<div><b>发生/发现时间</b>' + fmtTime(c.time) + '</div>' +
      '<div><b>当前事实状态</b>' + esc(c.fact) + '</div>' +
      '<div><b>已有平台措施</b>' + esc(c.measure) + '</div>' +
      '<div><b>通知/投诉情况</b>' + esc(c.notice) + '</div>' +
      '<div><b>附件说明</b>' + esc(c.attach || '无') + '</div>' +
      '</div><p>' + esc(c.background) + '</p></div>' +

      '<div class="rp-sec"><h3>二、材料来源</h3><p>' + esc(c.source) + '（来源不代表其内容当然真实）</p></div>' +

      '<div class="rp-sec"><h3>三、线索识别结果</h3><table class="rp-table">' +
      '<tr><th>线索类别</th><th>命中片段</th><th>识别方式</th><th>状态</th></tr>' + rows + '</table></div>' +

      '<div class="rp-sec"><h3>四、四维分析</h3><table class="rp-table">' +
      '<tr><th>维度</th><th>结论</th><th>主要依据</th></tr>' + dimRows + '</table></div>' +

      '<div class="rp-sec"><h3>五、相关法律规则</h3><ul>' +
      laws.map(function (l) { return '<li>' + esc(l.name) + '（' + esc(l.tag) + '）</li>'; }).join('') +
      '</ul><p class="hint">条文以官方发布文本为准，链接见系统“法律与建议”页。</p></div>' +

      '<div class="rp-sec"><h3>六、分级与处置建议</h3><p><b>' + esc(gd.name) + '</b>　' + esc(gd.trigger) + '</p>' +
      '<p><b>建议措施：</b>' + esc(c.review.measures) + '</p>' +
      '<p><b>限制说明：</b>' + esc(gd.limit) + '</p></div>' +

      '<div class="rp-sec"><h3>七、待核实事项</h3><ul>' +
      todos.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>' +

      '<div class="rp-sec"><h3>八、人工复核结论</h3><p><b>复核人：</b>' + esc(c.review.reviewer) + '　<b>结论：</b>' +
      (c.review.decision === 'confirm' ? '确认机器建议' : c.review.decision === 'adjust' ? '调整分级' : '驳回重审') + '</p>' +
      '<p><b>理由：</b>' + esc(c.review.reason) + '</p></div>' +

      '<div class="rp-sec"><h3>九、操作记录</h3><table class="rp-table">' +
      '<tr><th>时间</th><th>操作人</th><th>内容</th></tr>' + recRows + '</table></div>' +

      '<div class="rp-disclaim">免责声明：本报告由“舆”法风险辅助研判系统（教学演示原型）生成，属于辅助研判结果，不构成最终法律意见，不替代平台工作人员、律师或司法机关作出最终判断。风险颜色与分级仅提示处理优先级，不暗示当事人有罪或内容必然违法。演示数据均为脱敏或虚构样例。数据使用遵循最小化原则。</div>';
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    // 导航
    $$('.side-item').forEach(function (a) {
      a.addEventListener('click', function () { goto(a.getAttribute('data-view')); });
    });
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-goto]');
      if (t) { goto(t.getAttribute('data-goto')); return; }

      // 工作台
      var open = e.target.closest('[data-open]');
      if (open && !e.target.closest('[data-del]')) {
        setActive(open.getAttribute('data-open'));
        goto('clues');
        return;
      }
      var del = e.target.closest('[data-del]');
      if (del) {
        var id = del.getAttribute('data-del');
        state.cases = state.cases.filter(function (c) { return c.id !== id; });
        if (state.activeId === id) setActive(null);
        saveCases(); renderDash();
        toast('案件已删除');
        return;
      }
      var ft = e.target.closest('.ftab');
      if (ft) {
        state.filter = ft.getAttribute('data-f');
        $$('.ftab').forEach(function (x) { x.classList.toggle('active', x === ft); });
        renderDash();
        return;
      }

      // 线索操作
      var ok = e.target.closest('[data-clue-ok]');
      if (ok) {
        var c1 = activeCase();
        var cl1 = c1.clues.filter(function (x) { return x.id === ok.getAttribute('data-clue-ok'); })[0];
        if (cl1) { cl1.status = 'confirmed'; afterHumanClueChange(c1, '确认线索「' + cl1.cat + '：' + cl1.frag + '」为有效线索'); toast('已确认，四维研判与分级建议已同步更新'); }
        return;
      }
      var bad = e.target.closest('[data-clue-bad]');
      if (bad) {
        var c2 = activeCase();
        var cl2 = c2.clues.filter(function (x) { return x.id === bad.getAttribute('data-clue-bad'); })[0];
        if (cl2) { cl2.status = 'rejected'; afterHumanClueChange(c2, '将线索「' + cl2.cat + '：' + cl2.frag + '」标记为误报'); toast('已标记误报，研判结果已更新'); }
        return;
      }
      var edit = e.target.closest('[data-clue-edit]');
      if (edit) {
        var sel = edit.parentElement.parentElement.querySelector('[data-recat]');
        if (sel) { sel.style.display = sel.style.display === 'none' ? 'block' : 'none'; }
        return;
      }

      // 移动端导航
      if (e.target.closest('#mNavBtn')) {
        $('#appSide').classList.add('open');
        $('#sideMask').classList.add('show');
        return;
      }
      if (e.target.closest('#sideMask')) {
        $('#appSide').classList.remove('open');
        $('#sideMask').classList.remove('show');
        return;
      }
    });

    // 改判类别（change 事件）
    document.addEventListener('change', function (e) {
      var recat = e.target.closest('[data-recat]');
      if (recat) {
        var c = activeCase();
        var cl = c.clues.filter(function (x) { return x.id === recat.getAttribute('data-recat'); })[0];
        var rule = D.CLUE_RULES[+recat.value];
        if (cl && rule) {
          cl.catIdx = rule.idx; cl.cat = rule.cat; cl.humanCat = rule.cat;
          cl.status = 'confirmed';
          cl.reason = '人工改判：' + rule.reason;
          afterHumanClueChange(c, '将线索改判为「' + rule.cat + '」并确认');
          toast('类别已更新，研判结果已同步');
        }
        return;
      }
      // 四维人工调整
      var dimSel = e.target.closest('[data-dim]');
      if (dimSel) {
        var c3 = activeCase();
        var key = dimSel.getAttribute('data-dim');
        var val = dimSel.value;
        var before = dimDisplay(key, c3.dims[key]);
        if (val !== before) {
          c3.dims[key].human = val;
          addRecord(c3, 'human', '复核人', '调整' + key.toUpperCase() + '维度结论：' + before + ' → ' + val);
          saveCases(); renderDims();
          toast('维度结论已调整并留痕');
        }
        return;
      }
      // 复核结论联动
      if (e.target.id === 'rDecision') {
        $('#rGradeField').style.display = e.target.value === 'adjust' ? 'flex' : 'none';
      }
    });

    // 新建研判
    $('#btnNewCase').addEventListener('click', function () {
      setActive(null);
      $('#eventForm').reset();
      $('#fMeasure').value = '未知';
      $$('#eventForm .field').forEach(function (f) { f.classList.remove('invalid'); });
      $('#view-event .view-head h1').textContent = '事件录入';
      goto('event');
    });

    // 保存草稿
    $('#btnSaveDraft').addEventListener('click', function () {
      var data = collectForm();
      if (!data.name) { toast('至少填写事件名称才能保存草稿', 'err'); return; }
      var c = activeCase() || {};
      Object.assign(c, data);
      if (!c.id) { c.id = uid(); c.status = 'draft'; c.createdAt = new Date().toISOString(); state.cases.push(c); }
      else { c.status = 'draft'; }
      setActive(c.id); saveCases();
      toast('草稿已保存，可稍后继续研判');
      goto('dash');
    });

    // 提交事件
    $('#eventForm').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!validateForm()) { toast('请完善必填项后再开始研判', 'err'); return; }
      var data = collectForm();
      var c = activeCase() || {};
      var isNew = !c.id;
      Object.assign(c, data);
      if (isNew) {
        c.id = uid();
        c.status = 'progress';
        c.createdAt = new Date().toISOString();
        state.cases.push(c);
        c.clues = runClues(c);
        c.dims = computeDims(c);
        c.grade = suggestGrade(c);
        c.review = null;
        addRecord(c, 'machine', '系统', '完成线索识别（' + c.clues.length + ' 条）、四维评估与分级建议');
      } else {
        c.clues = runClues(c);
        c.dims = computeDims(c);
        c.grade = suggestGrade(c);
        addRecord(c, 'machine', '系统', '事件信息更新，已重新执行机器研判');
      }
      c.status = 'progress';
      setActive(c.id); saveCases();
      toast('研判完成，共识别线索 ' + activeClues(c).length + ' 条');
      goto('clues');
    });

    // 复核提交
    $('#reviewForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var c = activeCase();
      if (!c) return;
      var reviewer = $('#rReviewer').value.trim();
      var reason = $('#rReason').value.trim();
      var bad = false;
      $('#rReviewer').closest('.field').classList.toggle('invalid', !reviewer); if (!reviewer) bad = true;
      $('#rReason').closest('.field').classList.toggle('invalid', !reason); if (!reason) bad = true;
      if (bad) { toast('请填写复核人与复核理由', 'err'); return; }
      var decision = $('#rDecision').value;
      var grade = decision === 'adjust' ? +$('#rGrade').value : c.grade;
      c.review = {
        reviewer: reviewer, decision: decision, grade: grade,
        measures: $('#rMeasures').value, reason: reason,
        time: new Date().toISOString()
      };
      c.status = 'done';
      addRecord(c, 'human', reviewer, (decision === 'confirm' ? '确认机器分级建议' : decision === 'adjust' ? '调整分级为「' + D.GRADES[grade].name + '」' : '驳回机器建议，需重新审查') + '；理由：' + reason);
      addRecord(c, 'final', '复核人', '最终处置记录：' + D.GRADES[grade].name + ' · ' + $('#rMeasures').value);
      saveCases(); renderReportView();
      toast('复核结论已提交，报告已生成');
    });

    // 打印
    $('#btnPrint').addEventListener('click', function () {
      var c = activeCase();
      if (!c || !c.review) { toast('请先提交人工复核结论', 'err'); return; }
      window.print();
    });

    // 重置演示数据
    $('#resetDemo').addEventListener('click', function () {
      state.cases = seedCases();
      setActive(null); saveCases();
      toast('演示数据已重置');
      goto('dash');
    });

    // 免责提示
    $('#noticeClose').addEventListener('click', function () { $('#noticeBar').style.display = 'none'; });
  }

  /* ---------------- 启动 ---------------- */
  loadCases();
  bind();
  goto(activeCase() ? 'dash' : 'dash');
})();
