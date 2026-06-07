// ==UserScript==
// @name         AutoAnswer
// @namespace    http://tampermonkey.net/
// @version      3.3.0
// @description  自动识别页面题目，调用 AI 作答，答案内联展示 — 支持选择题/判断题/填空题/问答题
// @author       Gux
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @connect      *
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════
  //  配置
  // ═══════════════════════════════════════════════════════

  function safeGetValue(key, fallback) {
    try {
      return GM_getValue(key, fallback);
    } catch (e) {
      return fallback;
    }
  }

  const CFG = {
    provider: safeGetValue("provider", "deepseek"),
    endpoint: safeGetValue(
      "endpoint",
      "https://api.deepseek.com/v1/chat/completions",
    ),
    apiKey: safeGetValue("apiKey", ""),
    model: safeGetValue("model", "deepseek-v4-flash"),
    maxTokens: safeGetValue("maxTokens", 2048),
    temperature: safeGetValue("temperature", 0),
    fallbackEndpoint: safeGetValue("fallbackEndpoint", ""),
    fallbackApiKey: safeGetValue("fallbackApiKey", ""),
    autoAnswerDelay: safeGetValue("autoAnswerDelay", 800),
    maxQuestions: safeGetValue("maxQuestions", 50),
    retryCount: safeGetValue("retryCount", 1),
    similarityThreshold: safeGetValue("similarityThreshold", 50),
    position: safeGetValue("position", "br"),
    enableVision: safeGetValue("enableVision", false),
  };

  const SCRIPT_VERSION = "3.3.0";

  // ─── 配置迁移 ───
  (function migrateConfig() {
    try {
      if (GM_getValue("_version", "0.0.0") !== SCRIPT_VERSION) {
        GM_setValue("_version", SCRIPT_VERSION);
      }
    } catch (_) {}
  })();

  // ═══════════════════════════════════════════════════════
  //  状态
  // ═══════════════════════════════════════════════════════

  const STATE = { questions: [], running: false, answered: 0, total: 0 };

  // ═══════════════════════════════════════════════════════
  //  日志
  // ═══════════════════════════════════════════════════════

  const Logger = {
    _logs: [],
    _maxLogs: 200,
    _listeners: [],
    log(message, level = "info") {
      const entry = { message: String(message), time: _fmt(), level };
      this._logs.push(entry);
      if (this._logs.length > this._maxLogs) this._logs.shift();
      const pre = { info: "ℹ", success: "✔", warning: "⚠", error: "✘" }[level];
      const css = {
        info: "color:#2196f3",
        success: "color:#4caf50",
        warning: "color:#ff9800;font-weight:bold",
        error: "color:#f44336;font-weight:bold",
      }[level];
      console.log(`%c${pre} [${entry.time}] ${entry.message}`, css);
      this._listeners.forEach((fn) => fn(entry));
    },
    info(m) {
      this.log(m, "info");
    },
    success(m) {
      this.log(m, "success");
    },
    warning(m) {
      this.log(m, "warning");
    },
    error(m) {
      this.log(m, "error");
    },
    getLogs(n = 50) {
      return this._logs.slice(-n);
    },
    clear() {
      this._logs = [];
      this._listeners.forEach((fn) => fn({ _clear: true }));
    },
    onChange(fn) {
      this._listeners.push(fn);
      return () => {
        this._listeners = this._listeners.filter((f) => f !== fn);
      };
    },
  };

  function _fmt() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  }

  // ═══════════════════════════════════════════════════════
  //  模糊匹配
  // ═══════════════════════════════════════════════════════

  function calculateSimilarity(str1, str2) {
    const s1 = str1.trim().toLowerCase();
    const s2 = str2.trim().toLowerCase();
    if (s1 === s2) return 100;
    if (!s1.length || !s2.length) return 0;
    const m = [];
    for (let i = 0; i <= s1.length; i++) m[i] = [i];
    for (let j = 0; j <= s2.length; j++) m[0][j] = j;
    for (let i = 1; i <= s1.length; i++)
      for (let j = 1; j <= s2.length; j++)
        m[i][j] =
          s1[i - 1] === s2[j - 1]
            ? m[i - 1][j - 1]
            : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
    const dist = m[s1.length][s2.length];
    return Math.round(
      ((Math.max(s1.length, s2.length) - dist) /
        Math.max(s1.length, s2.length)) *
        100,
    );
  }

  function findBestMatch(answer, options, threshold = 50) {
    let best = null;
    const entries = Array.isArray(options)
      ? options.map((o, i) => [i, o.text])
      : Object.entries(options);
    for (const [key, text] of entries) {
      const sim = calculateSimilarity(answer, text);
      if (sim === 100) return { key, similarity: 100 };
      if (sim >= threshold && (!best || sim > best.similarity))
        best = { key, similarity: sim };
    }
    return best;
  }

  // ═══════════════════════════════════════════════════════
  //  题目检测引擎
  // ═══════════════════════════════════════════════════════

  const QTYPE = { CHOICE: "choice", TF: "tf", BLANK: "blank", ESSAY: "essay" };

  const BLANK_KW =
    /(填空|填入|填写|blank|___|\[[\s_]*\]|【[\s_]*】|（[\s_]*）|\([\s_]*\))/i;
  const ESSAY_KW =
    /(简述|简答|分析|论述|请回答|试述|说明理由|讨论|阐述|essay|问答题|简答题)/i;

  // ─────────────────────────────────────────────────────
  //  [FIX 1] isRichEditor — 不再无限向上爬，只检查元素自身及直接子节点
  //  修复原因：原版 while(node) 会爬到整个 DOM 树，把含有 contenteditable 祖先
  //  的所有普通容器都误判为富文本编辑器
  // ─────────────────────────────────────────────────────
  function isRichEditor(el) {
    if (!el) return false;
    // 只检查自身是否是编辑器
    if (el.getAttribute?.("contenteditable") === "true") return true;
    if (el.tagName === "IFRAME") return true;
    // 检查直接子节点中是否有富文本 iframe（CKEditor/TinyMCE 嵌入方式）
    const editIframe = el.querySelector?.(
      ":scope > iframe[src*='editor'], :scope > iframe[class*='cke'], :scope > iframe[class*='mce']",
    );
    if (editIframe) return true;
    return false;
  }

  // ─────────────────────────────────────────────────────
  //  [FIX 2] classifyInputQuestion — textarea 大小判断改为多维度
  //  修复原因：很多平台不设 rows 属性，原版默认 rows=2 导致所有 textarea 都降级为 BLANK
  // ─────────────────────────────────────────────────────
  function classifyInputQuestion(stem, textareas, textInputs, container) {
    const allInputs = [...textareas, ...textInputs];

    // 规则 1：textarea 多维度判断是否为问答框
    for (const ta of textareas) {
      const rows = parseInt(ta.getAttribute("rows") || "0");
      const style = ta.style;
      const computed = window.getComputedStyle(ta);
      const h = parseFloat(computed.height) || 0;
      const isLarge =
        rows >= 3 ||
        h > 60 ||
        (style.minHeight && parseFloat(style.minHeight) > 60) ||
        ta.className.match(/\b(essay|answer|big|large|long|detail)\b/i);
      if (isLarge)
        return { type: QTYPE.ESSAY, text: stem, element: container, input: ta };
    }

    // 规则 2：存在富文本编辑器
    if (allInputs.some((el) => isRichEditor(el))) {
      const editor = allInputs.find((el) => isRichEditor(el)) || allInputs[0];
      return {
        type: QTYPE.ESSAY,
        text: stem,
        element: container,
        input: editor,
      };
    }

    // 规则 3：多个独立 input → 多空填空
    if (textInputs.length >= 2) {
      return {
        type: QTYPE.BLANK,
        text: stem,
        element: container,
        input: textInputs[0],
        inputs: textInputs,
        multiBlank: true,
      };
    }

    // 规则 4：关键词优先
    const hasBlankKw = BLANK_KW.test(stem);
    const hasEssayKw = ESSAY_KW.test(stem);
    if (hasEssayKw && !hasBlankKw)
      return {
        type: QTYPE.ESSAY,
        text: stem,
        element: container,
        input: allInputs[0],
      };
    if (hasBlankKw)
      return {
        type: QTYPE.BLANK,
        text: stem,
        element: container,
        input: allInputs[0],
      };

    // 规则 5：题干长度启发（textarea 无标记时优先判问答）
    if (textareas.length > 0 || stem.length > 150) {
      return {
        type: QTYPE.ESSAY,
        text: stem,
        element: container,
        input: allInputs[0],
      };
    }
    return {
      type: QTYPE.BLANK,
      text: stem,
      element: container,
      input: allInputs[0],
    };
  }

  /** 已知考试平台专用选择器 */
  const PLATFORM_SELECTORS = [
    ".TiMu, .questionLi, .mark_item, .exam-item, .cql-item",
    ".topic-item, .subject-item",
    ".u-question, .m-question",
    ".que, .formulation",
    '[role="listitem"]:has([role="radio"]), [role="listitem"]:has([role="checkbox"])',
    ".field, .question-item",
    ".form-item",
    ".question-box, .exam-question",
    ".problem, .question-wrapper",
    '.question, .quiz, .exam, [data-type="question"]',
    'fieldset:has(input[type="radio"])',
    'fieldset:has(input[type="checkbox"])',
  ];

  function isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    return (
      s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0"
    );
  }

  function isNonQuestionElement(el) {
    if (!el) return true;
    if (el.closest?.("#ai-auto-answer-panel, #ai-settings-overlay"))
      return true;
    if (
      el.classList?.contains("ai-answer-badge") ||
      el.classList?.contains("ai-answer-card")
    )
      return true;
    if (el.closest?.(".search-box")) return true;
    const ph = el.getAttribute?.("placeholder") || "";
    if (/搜索|search|find/i.test(ph)) return true;
    if (el.closest?.(".user-info, .tab-score-txt, .cover-img")) return true;
    const text = (el.textContent || "").trim();
    if (text.length > 0 && text.length <= 10 && /^[\d.,%+\-\s]+$/.test(text))
      return true;
    return false;
  }

  function getText(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function detectQuestions() {
    const questions = [];
    const seen = new WeakSet();

    // 策略 1：平台专用选择器
    for (const sel of PLATFORM_SELECTORS) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          if (!isVisible(el) || seen.has(el) || isNonQuestionElement(el))
            continue;
          const q = parseQuestionBlock(el);
          if (q) {
            questions.push(q);
            seen.add(el);
          }
        }
      } catch (_) {}
    }

    // 策略 2：radio/checkbox 组
    if (questions.length === 0) {
      for (const group of findRadioGroups()) {
        if (seen.has(group.container)) continue;
        const q = parseChoiceFromRadios(group);
        if (q) {
          questions.push(q);
          seen.add(group.container);
        }
      }
    }

    // 策略 3：独立 input/textarea
    const inputs = document.querySelectorAll(
      'input[type="text"]:not([type="hidden"]), input:not([type]), textarea',
    );
    for (const inp of inputs) {
      if (!isVisible(inp) || seen.has(inp) || isNonQuestionElement(inp))
        continue;
      if (
        /search|login|password|email|name|phone|address/i.test(
          inp.name || inp.id || inp.placeholder || "",
        )
      )
        continue;
      const q = parseBlankFromInput(inp);
      if (q) {
        questions.push(q);
        seen.add(inp);
        if (q.element && q.element !== inp) seen.add(q.element);
      }
    }

    // 策略 4：文本模式兜底
    if (questions.length === 0) {
      for (const q of detectByTextPattern()) {
        if (!seen.has(q.element)) {
          questions.push(q);
          seen.add(q.element);
        }
      }
    }

    return dedupeQuestions(questions)
      .sort((a, b) => {
        const pos = a.element.compareDocumentPosition(b.element);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      })
      .slice(0, CFG.maxQuestions);
  }

  function parseQuestionBlock(el) {
    const radios = el.querySelectorAll('input[type="radio"]');
    const checks = el.querySelectorAll('input[type="checkbox"]');
    const textInp = el.querySelectorAll(
      'input[type="text"], input:not([type]), textarea',
    );
    const select = el.querySelector("select");

    if (radios.length >= 2) {
      const stem = extractStem(el);
      const options = Array.from(radios).map((r) => ({
        text: findLabel(r),
        element: r,
      }));
      return {
        type: isTrueFalseOptions(options) ? QTYPE.TF : QTYPE.CHOICE,
        text: stem,
        options,
        element: el,
      };
    }

    if (checks.length >= 2) {
      const stem = extractStem(el);
      const options = Array.from(checks).map((c) => ({
        text: findLabel(c),
        element: c,
      }));
      return {
        type: QTYPE.CHOICE,
        text: stem,
        options,
        element: el,
        multi: true,
      };
    }

    if (textInp.length > 0) {
      const stem = extractStem(el);
      const textareas = Array.from(textInp).filter(
        (e) => e.tagName === "TEXTAREA",
      );
      const textInputs = Array.from(textInp).filter(
        (e) => e.tagName === "INPUT",
      );
      return classifyInputQuestion(stem, textareas, textInputs, el);
    }

    if (isRichEditor(el)) {
      return { type: QTYPE.ESSAY, text: extractStem(el), element: el };
    }

    if (select) {
      const stem = extractStem(el);
      const options = Array.from(select.options)
        .filter((o) => o.value)
        .map((o) => ({ text: o.textContent.trim(), element: select }));
      if (options.length > 1)
        return { type: QTYPE.CHOICE, text: stem, options, element: el, select };
    }

    // 自定义选项检测
    const customOpts = detectCustomOptions(el);
    if (
      customOpts &&
      customOpts.length >= 2 &&
      lookLikeRealOptions(customOpts)
    ) {
      const stem = extractStem(el);
      if (!optionsAreSubsetOfStem(stem, customOpts)) {
        return {
          type: isTrueFalseOptions(customOpts) ? QTYPE.TF : QTYPE.CHOICE,
          text: stem,
          options: customOpts,
          element: el,
          customOptions: true,
        };
      }
    }

    // ─────────────────────────────────────────────────────
    //  [FIX 4] 兜底文本判断收紧 — 必须有明确的题目信号
    //  修复原因：原版 text.length > 30 会把普通段落全部命中
    // ─────────────────────────────────────────────────────
    const text = getText(el);
    if (text.length >= 20 && text.length < 2000) {
      const hasEssay = ESSAY_KW.test(text);
      const hasBlank = BLANK_KW.test(text);
      const hasSerial = /^\s*[\d一二三四五六七八九十]+[.、．)）]\s/.test(text); // 有序号
      // 必须命中关键词或题目序号，否则不当作题目
      if (hasEssay || hasBlank || hasSerial) {
        return {
          type: hasEssay ? QTYPE.ESSAY : QTYPE.BLANK,
          text,
          element: el,
        };
      }
    }
    return null;
  }

  // ─────────────────────────────────────────────────────
  //  [FIX 7] isTrueFalseOptions — 逐项严格匹配，不再 join 后整体 test
  //  修复原因：join 后 "对选项一|错误信息" 整体 test 会误命中
  // ─────────────────────────────────────────────────────
  function isTrueFalseOptions(opts) {
    if (opts.length !== 2) return false;
    const TF_PAT = /^(对|错|是|否|正确|错误|true|false|yes|no|√|×|✓|✗|T|F)$/i;
    return opts.every((o) => TF_PAT.test(o.text.trim()));
  }

  function lookLikeRealOptions(opts) {
    if (opts.some((o) => o.text.length > 150)) return false;
    if (
      opts.some((o) =>
        /(答案|解析|积分|得分|我的|正确选项|参考答案)/.test(o.text),
      )
    )
      return false;
    // 全部选项都是 1-2 字 → 疑似误判（但保留纯字母如 "A"/"B" 的情况到 TF 判断）
    const allVeryShort = opts.every((o) => o.text.length <= 2);
    if (allVeryShort && !isTrueFalseOptions(opts)) return false;
    return true;
  }

  function optionsAreSubsetOfStem(stem, opts) {
    if (stem.length < 50) return false;
    return opts.every((o) => {
      const t = o.text.trim();
      return t.length >= 2 && stem.includes(t);
    });
  }

  function cleanOptionText(text) {
    return text
      .replace(/\d+人\s*\d+%/g, "")
      .replace(/\d+人/g, "")
      .replace(/\d+%/g, "")
      .trim();
  }

  function detectCustomOptions(el) {
    // 策略 A：已知 class
    const knownSelectors = [
      ".option",
      ".choice",
      ".answer-item",
      ".answerBg",
      ".chooseAnswer",
      ".radio",
      ".checkbox",
      ".topic-option",
      ".exam-option",
      ".question-option",
      ".chose-item",
      ".chosen-list li",
      "[data-option]",
      "[data-answer]",
      // 注意：去掉了 [class*='option'] / [class*='choice'] 这两个过于宽泛的选择器
      // 它们会命中 "optional" / "choices" 等无关 class
    ];
    for (const sel of knownSelectors) {
      try {
        const items = el.querySelectorAll(sel);
        if (items.length >= 2 && items.length <= 10) {
          const opts = [];
          for (const item of items) {
            if (!isVisible(item)) continue;
            const text = cleanOptionText(getText(item));
            if (text.length > 0 && text.length < 300)
              opts.push({ text, element: item });
          }
          if (opts.length >= 2) return opts;
        }
      } catch (_) {}
    }

    // ─────────────────────────────────────────────────────
    //  [FIX 3] 策略 B — 只收集明确以 A-E 字母开头的子元素作为选项
    //  移除了原版"短文本兜底" (else if ct.length>1 && ct.length<80)
    //  修复原因：该兜底把题干片段也当作选项
    // ─────────────────────────────────────────────────────
    const letterChildren = Array.from(el.children).filter((c) => {
      const ct = getText(c);
      return /^[A-Ea-e][.、．)\s]/.test(ct);
    });
    if (letterChildren.length >= 2 && letterChildren.length <= 10) {
      return letterChildren.map((c) => ({
        text: getText(c)
          .replace(/^[A-Ea-e][.、．)\s]+/, "")
          .trim(),
        element: c,
      }));
    }

    // 策略 C：ul/ol > li
    const list = el.querySelector("ul, ol");
    if (list) {
      const items = list.querySelectorAll(":scope > li");
      if (items.length >= 2 && items.length <= 10) {
        const opts = [];
        for (const item of items) {
          if (!isVisible(item)) continue;
          const text = getText(item);
          if (text.length > 0 && text.length < 300)
            opts.push({ text, element: item });
        }
        if (opts.length >= 2) return opts;
      }
    }

    // 策略 D：结构相似的直接子元素，需额外语义信号（含 radio/checkbox 或字母序号开头）
    const directChildren = Array.from(el.children).filter(
      (c) =>
        isVisible(c) && !["SCRIPT", "STYLE", "BR", "HR"].includes(c.tagName),
    );
    if (directChildren.length >= 2 && directChildren.length <= 10) {
      const tags = new Set(directChildren.map((c) => c.tagName));
      if (tags.size <= 2) {
        const hasFormInputs =
          directChildren.filter((c) =>
            c.querySelector('input[type="radio"], input[type="checkbox"]'),
          ).length >= 2;
        const letterCount = directChildren.filter((c) =>
          /^[A-Ea-e][.、．)\s]/.test((c.textContent || "").trim()),
        ).length;
        if (!hasFormInputs && letterCount < 2) return null;

        const opts = directChildren
          .map((c) => ({ text: getText(c), element: c }))
          .filter((o) => o.text.length > 0 && o.text.length < 300);
        if (opts.length >= 2) {
          const avg = opts.reduce((s, o) => s + o.text.length, 0) / opts.length;
          const filtered = opts.filter((o) => o.text.length < avg * 2.5);
          if (filtered.length >= 2) return filtered;
        }
      }
    }

    return null;
  }

  // ─────────────────────────────────────────────────────
  //  [FIX 6] extractStem — 克隆后移除所有选项容器（不限于 li）
  //  修复原因：原版只移除 li，导致 div/span 形式的选项文字留在题干里
  // ─────────────────────────────────────────────────────
  function extractStem(el) {
    const stemArea =
      el.querySelector(
        ".left-title, .top-question, .q-title, .question-stem",
      ) || el;
    const clone = stemArea.cloneNode(true);

    // 1. 移除表单输入元素
    for (const s of clone.querySelectorAll("input, textarea, select"))
      s.remove();

    // 2. 移除已知答案/解析/统计区域
    for (const s of clone.querySelectorAll(
      "label, .option, .choice, .answer-item, .answerBg, .chooseAnswer," +
        ".person-answer, .static-box, .chosen-static, .chose-detail," +
        ".chart-box, .score-txt, .question-type, [data-option], [data-answer]",
    ))
      s.remove();

    // 3. 移除含字母序号的选项元素（li/div/p/span 均处理）
    for (const node of clone.querySelectorAll("li, div, p, span")) {
      const t = (node.textContent || "").trim();
      if (/^[A-Ea-e][.、．)\s]/.test(t)) node.remove();
    }

    const stemText = getText(clone);
    if (stemText.length >= 5) return stemText;

    // 兜底：从原始文本中截取第一个字母序号前的内容
    return getText(el)
      .split(/[A-E][.、．)\s]/)[0]
      .trim();
  }

  // ─────────────────────────────────────────────────────
  //  [FIX 5] findLabel — 从父元素提取文本时，排除兄弟 input 的干扰
  //  修复原因：直接 getText(parent) 会把同容器内其他选项文本也拼进来
  // ─────────────────────────────────────────────────────
  function findLabel(input) {
    // 1. label[for=id]
    if (input.id) {
      try {
        const lbl = document.querySelector(
          `label[for="${CSS.escape(input.id)}"]`,
        );
        if (lbl) return getText(lbl);
      } catch (_) {}
    }
    // 2. 直接父级 label
    const parentLabel = input.closest("label");
    if (parentLabel) {
      // 克隆父 label，移除 input 本身，取剩余文字
      const clone = parentLabel.cloneNode(true);
      for (const inp of clone.querySelectorAll("input, select, textarea"))
        inp.remove();
      const t = getText(clone);
      return t || input.value || "";
    }
    // 3. 相邻 label 兄弟
    const prev = input.previousElementSibling;
    if (prev?.tagName === "LABEL") return getText(prev);
    const next = input.nextElementSibling;
    if (next?.tagName === "LABEL") return getText(next);
    // 4. 父元素文本（移除所有 input 后提取）
    const parent = input.parentElement;
    if (parent) {
      const clone = parent.cloneNode(true);
      for (const inp of clone.querySelectorAll("input, select, textarea"))
        inp.remove();
      const t = getText(clone);
      return t || input.value || `选项 ${input.value}`;
    }
    return input.value || "未识别";
  }

  /** 按 radio name 分组 */
  function findRadioGroups() {
    const byName = {};
    for (const r of document.querySelectorAll('input[type="radio"]')) {
      if (!isVisible(r)) continue;
      const name = r.name || r.id || r.getAttribute("data-name");
      if (!name) continue;
      (byName[name] = byName[name] || []).push(r);
    }
    const groups = [];
    for (const radios of Object.values(byName)) {
      if (radios.length < 2) continue;
      const container = findCommonContainer(radios);
      const stem = findPrecedingText(container || radios[0]);
      if (stem.length < 5) continue;
      groups.push({
        container: container || radios[0].parentElement,
        radios,
        stem,
      });
    }
    return mergeGroups(groups);
  }

  function findCommonContainer(elements) {
    if (!elements.length) return null;
    if (elements.length === 1) return elements[0].parentElement;
    let container = _lca(elements[0], elements[1]);
    for (let i = 2; i < elements.length; i++)
      container = _lca(container, elements[i]);
    return container;
  }

  function _lca(a, b) {
    if (a.contains(b)) return a;
    if (b.contains(a)) return b;
    let node = a.parentElement;
    while (node) {
      if (node.contains(b)) return node;
      node = node.parentElement;
    }
    return document.body;
  }

  function findPrecedingText(el, maxDepth = 8) {
    let node = el,
      depth = 0;
    const walked = new Set();
    while (node && !walked.has(node) && depth < maxDepth) {
      walked.add(node);
      depth++;
      const prev = node.previousElementSibling;
      if (prev) {
        const t = getText(prev);
        if (t.length > 5 && t.length < 2000) return t;
      }
      const parentText = node.parentElement
        ? getText(node.parentElement)
            .split(/[A-E][.、．)]\s*/)[0]
            .trim()
        : "";
      if (parentText.length > 5 && parentText.length < 2000) return parentText;
      node = node.parentElement;
    }
    return "";
  }

  function mergeGroups(groups) {
    const merged = [];
    for (const g of groups) {
      const ex = merged.find((m) => m.container?.contains(g.container));
      if (ex) {
        ex.radios.push(...g.radios);
        ex.stem = ex.stem || g.stem;
      } else merged.push(g);
    }
    return merged;
  }

  function parseChoiceFromRadios(group) {
    const options = group.radios.map((r) => ({
      text: findLabel(r),
      element: r,
    }));
    return {
      type: isTrueFalseOptions(options) ? QTYPE.TF : QTYPE.CHOICE,
      text: group.stem,
      options,
      element: group.container,
    };
  }

  function parseBlankFromInput(inp) {
    const stem = findPrecedingText(inp);
    if (stem.length < 5) return null;
    const container =
      inp.closest("div, fieldset, li, .form-group") || inp.parentElement;
    const textareas = inp.tagName === "TEXTAREA" ? [inp] : [];
    const textInputs = inp.tagName === "INPUT" ? [inp] : [];
    return classifyInputQuestion(stem, textareas, textInputs, container);
  }

  function detectByTextPattern() {
    const questions = [];
    const patterns = [
      /^\s*\d+[.、．)]\s*.{10,}/,
      /^\s*[（(]\s*\d+\s*[）)]\s*.{10,}/,
      /^\s*[一二三四五六七八九十]+[.、．)]\s*.{10,}/,
    ];
    for (const el of document.querySelectorAll("p, div, li, td")) {
      if (!isVisible(el) || isNonQuestionElement(el)) continue;
      const text = getText(el);
      if (text.length < 20 || text.length > 2000) continue;
      for (const pat of patterns) {
        if (pat.test(text)) {
          questions.push({ type: QTYPE.ESSAY, text, element: el });
          break;
        }
      }
    }
    return questions;
  }

  function dedupeQuestions(questions) {
    const seen = new Set();
    return questions.filter((q) => {
      const key = q.text.slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ═══════════════════════════════════════════════════════
  //  AI 调用
  // ═══════════════════════════════════════════════════════

  function buildPrompt(q) {
    const label =
      {
        [QTYPE.CHOICE]: "单选题",
        [QTYPE.TF]: "判断题",
        [QTYPE.BLANK]: "填空题",
        [QTYPE.ESSAY]: "问答题",
      }[q.type] || "题目";
    let p = `你是一个答题助手。下面是${label}。\n\n【题目】${q.text}\n`;
    if (q.options?.length) {
      p += "【选项】\n";
      q.options.forEach((o, i) => {
        p += `${String.fromCharCode(65 + i)}. ${o.text}\n`;
      });
      p += q.multi
        ? '\n（多选题）请只输出字母，如 "ABD"，不要解释。'
        : "\n请只输出一个字母，不要解释。";
    } else if (q.type === QTYPE.BLANK) {
      p += "\n请输出填空答案，稍作解释。";
    } else if (q.type === QTYPE.TF) {
      p += '\n请只输出"对"或"错"，不要解释。';
    } else {
      p += "\n请简短作答，可稍作解释。";
    }

    let imgs = [];
    if (CFG.enableVision && q.element) {
      const imgEls = q.element.querySelectorAll("img");
      for (let i = 0; i < imgEls.length; i++) {
        const src = imgEls[i].src;
        if (src && (src.startsWith("http") || src.startsWith("data:image/"))) {
          imgs.push(src);
        }
      }
    }
    imgs = [...new Set(imgs)].slice(0, 8); // Max 8 images to prevent payload bloat

    if (imgs.length === 0) return p;

    const content = [{ type: "text", text: p }];
    imgs.forEach(url => content.push({ type: "image_url", image_url: { url } }));
    return content;
  }

  function _stripAnswerPrefix(s) {
    return s
      .replace(
        /^(正确的?|参考答案?|我的答案?|本题)?\s*(答案|选项|选择)[是为：:]\s*/i,
        "",
      )
      .replace(/^(正确答案|参考答案|我的答案|本题答案)[：:]\s*/i, "");
  }

  function parseAnswer(raw, q) {
    let answer = _stripAnswerPrefix(raw.trim());

    if ((q.type === QTYPE.CHOICE || q.type === QTYPE.TF) && q.options?.length) {
      // 策略 1：提取字母
      const m = answer.match(/[A-Ea-e]+/);
      if (m) {
        let letters = m[0]
          .toUpperCase()
          .split("")
          .filter((l) => {
            const idx = l.charCodeAt(0) - 65;
            return idx >= 0 && idx < q.options.length;
          });
        if (letters.length) {
          if (!q.multi) letters = [letters[0]];
          return {
            type: "choice",
            indices: letters.map((l) => l.charCodeAt(0) - 65),
            raw,
            matchMethod: "letter",
          };
        }
      }
      // 策略 2：精确文本匹配
      for (let i = 0; i < q.options.length; i++) {
        const t = q.options[i].text;
        if (answer === t || answer.includes(t) || t.includes(answer))
          return { type: "choice", indices: [i], raw, matchMethod: "exact" };
      }
      // 策略 3：模糊匹配
      const best = findBestMatch(answer, q.options, CFG.similarityThreshold);
      if (best) {
        const idx = +best.key;
        return {
          type: "choice",
          indices: [idx],
          raw,
          matchMethod: "fuzzy",
          similarity: best.similarity,
        };
      }
      // 策略 4：降阈
      const loose = findBestMatch(answer, q.options, 30);
      if (loose) {
        return {
          type: "choice",
          indices: [+loose.key],
          raw,
          matchMethod: "fuzzy",
          similarity: loose.similarity,
          fallback: true,
        };
      }
      return { type: "choice", indices: [], raw, fallback: true };
    }

    if (q.type === QTYPE.TF) {
      if (/^(对|是|正确|true|yes|√|✓|T)$/i.test(answer))
        return { type: "tf", value: true, raw };
      if (/^(错|否|错误|false|no|×|✗|F)$/i.test(answer))
        return { type: "tf", value: false, raw };
      return { type: "tf", value: null, raw, fallback: true };
    }

    if (q.type === QTYPE.BLANK) {
      answer = answer.replace(/^(答案[：:]?\s*|填空[：:]?\s*)/, "");
      return { type: "blank", text: answer, raw };
    }

    return { type: "essay", text: answer, raw };
  }

  function _doSingleRequest(
    endpoint,
    apiKey,
    question,
    idx,
    timeoutMs = 30000,
  ) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: CFG.model,
        messages: [
          {
            role: "system",
            content:
              "你是一个精准的答题助手。严格遵守输出格式，只输出答案本身。",
          },
          { role: "user", content: buildPrompt(question) },
        ],
        max_tokens: CFG.maxTokens,
        temperature: CFG.temperature,
        stream: false,
      });
      GM_xmlhttpRequest({
        method: "POST",
        url: endpoint,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        data: body,
        timeout: timeoutMs,
        onload(resp) {
          if (resp.status !== 200) {
            let msg = `[HTTP ${resp.status}]`;
            try {
              const j = JSON.parse(resp.responseText);
              msg = j.error?.message || j.message || msg;
            } catch (_) {}
            return reject(new Error(`API 错误: ${msg}`));
          }
          try {
            const json = JSON.parse(resp.responseText);
            const raw = json.choices?.[0]?.message?.content;
            if (raw == null) {
              const fr = json.choices?.[0]?.finish_reason || "无";
              return reject(
                new Error(
                  fr === "content_filter"
                    ? "题目被安全过滤"
                    : `AI 返回空内容 (${fr})`,
                ),
              );
            }
            if (!raw.trim()) return reject(new Error("AI 返回空白内容"));
            resolve({ raw: raw.trim(), source: endpoint });
          } catch (e) {
            reject(
              new Error(`响应解析失败: ${resp.responseText.slice(0, 200)}`),
            );
          }
        },
        onerror: (e) => reject(new Error(`网络错误 (${e?.status || "N/A"})`)),
        ontimeout: () => reject(new Error("请求超时")),
      });
    });
  }

  async function callAI(question, idx) {
    const endpoints = [{ url: CFG.endpoint, key: CFG.apiKey }];
    if (CFG.fallbackEndpoint && CFG.fallbackApiKey)
      endpoints.push({ url: CFG.fallbackEndpoint, key: CFG.fallbackApiKey });

    let lastError = null;
    for (const ep of endpoints) {
      for (let attempt = 0; attempt <= (CFG.retryCount || 1); attempt++) {
        try {
          const { raw, source } = await _doSingleRequest(
            ep.url,
            ep.key,
            question,
            idx,
          );
          return {
            ...parseAnswer(raw, question),
            idx,
            question,
            source: source === CFG.fallbackEndpoint ? "fallback" : "primary",
          };
        } catch (err) {
          lastError = err;
          if (attempt < CFG.retryCount) {
            Logger.warning(
              `第 ${idx + 1} 题失败，重试 ${attempt + 1}/${CFG.retryCount}: ${err.message}`,
            );
            await sleep(500);
          }
        }
      }
      if (endpoints.length > 1 && ep === endpoints[0])
        Logger.warning(`主 API 全部失败，切换备用 API`);
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError || "AI 调用失败"));
  }

  // ═══════════════════════════════════════════════════════
  //  答案注入
  // ═══════════════════════════════════════════════════════

  let answerStyleEl = null;

  function injectAnswerCSS() {
    if (answerStyleEl) return;
    answerStyleEl = document.createElement("style");
    answerStyleEl.textContent = `
      .ai-answer-badge {
        display:block !important;
        margin:8px 0 !important;
        padding:8px 14px;border-radius:12px;
        font-size:14px;font-weight:600;
        background:linear-gradient(135deg, rgba(232, 245, 233, 0.95), rgba(200, 230, 201, 0.95));
        color:#1b5e20;border:1px solid rgba(165, 214, 167, 0.5);
        backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
        box-shadow:0 4px 12px rgba(76, 175, 80, 0.15);
        cursor:default;
        white-space:pre-wrap !important;
        word-break:break-word !important;
        max-width:100% !important;
        width:fit-content !important;
        box-sizing:border-box;
        position:relative !important;
        float:none !important;
        animation:aiBadgePop .4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      }
      .ai-answer-badge.fallback{
        background:linear-gradient(135deg, rgba(255, 243, 224, 0.95), rgba(255, 224, 178, 0.95));
        color:#e65100;border-color:rgba(255, 204, 128, 0.5);
        box-shadow:0 4px 12px rgba(255, 152, 0, 0.15);
      }
      .ai-answer-highlight{
        outline:2px solid #4caf50;outline-offset:4px;border-radius:6px;
        background:rgba(76,175,80,0.1);transition:all 0.3s ease;
      }
      .ai-answer-highlight.fallback{outline-color:#ff9800;background:rgba(255,152,0,0.1);}
      .ai-filled-input{
        background:rgba(232,245,233,0.8)!important;
        border-color:#4caf50!important;box-shadow:0 0 0 3px rgba(76,175,80,0.2)!important;
        transition:all 0.3s ease;
      }
      .ai-answer-card{
        margin:12px 0;border-radius:12px;
        border:1px solid rgba(200,230,201,0.6);
        background:rgba(241,248,233,0.95);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
        box-shadow:0 8px 24px rgba(0,0,0,0.08);overflow:hidden;
        animation:aiBadgePop .4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      }
      .ai-answer-card.fallback{border-color:rgba(255,204,128,0.6);background:rgba(255,248,225,0.95);}
      .ai-answer-card-header{
        padding:10px 16px;background:linear-gradient(90deg, #c8e6c9, #a5d6a7);
        font-size:14px;font-weight:700;color:#1b5e20;
      }
      .ai-answer-card.fallback .ai-answer-card-header{background:linear-gradient(90deg, #ffecb3, #ffe082);color:#e65100;}
      .ai-answer-card-body{padding:12px 16px;font-size:14px;color:#2c3e50;line-height:1.6;max-height:400px;overflow-y:auto;white-space:pre-wrap;}
      @keyframes aiBadgePop{from{opacity:0;transform:scale(0.9) translateY(-8px)}to{opacity:1;transform:scale(1) translateY(0)}}
    `;
    document.head.appendChild(answerStyleEl);
  }

  function injectAnswerToPage(q, answer) {
    injectAnswerCSS();
    if (q.type === QTYPE.CHOICE || q.type === QTYPE.TF) {
      const indices = answer.indices || [];
      const correctTexts = indices
        .map((i) => q.options[i]?.text)
        .filter(Boolean);
      for (const i of indices) {
        const optEl = q.options[i]?.element;
        if (!optEl) continue;
        const wrapper = findClickableWrapper(optEl);
        if (wrapper) {
          wrapper.classList.add("ai-answer-highlight");
          if (answer.fallback) wrapper.classList.add("fallback");
        }
        clickOptionElement(optEl);
        if (wrapper && wrapper !== optEl) clickOptionElement(wrapper);
      }
      let label = indices.length
        ? ` ${indices.map((i) => String.fromCharCode(65 + i)).join("")}${answer.matchMethod === "fuzzy" && answer.similarity != null ? ` (${answer.similarity}%)` : ""}${correctTexts.length ? `  ${correctTexts.join(" / ")}` : ""}`
        : ` ${answer.raw || "无法确定"}`;
      insertBadgeNearOptions(
        q,
        label,
        answer.fallback || answer.matchMethod === "fuzzy",
      );
    } else if (q.type === QTYPE.BLANK) {
      const text = answer.text || answer.raw || "";
      if (q.input && text) _fillInputElement(q.input, text);
      if (q.multiBlank && q.inputs && text) {
        const parts = text.split(/[,，;；\s]+/).filter(Boolean);
        q.inputs.forEach((inp, i) => {
          if (i < parts.length) _fillInputElement(inp, parts[i]);
        });
      }
      insertBeforeQuestion(q, createBadge(` 答案: ${text}`, answer.fallback));
    } else {
      createAnswerCard(q, answer.text || answer.raw || "", answer.fallback);
    }
  }

  function _fillInputElement(el, text) {
    if (!el || !text) return;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      const proto =
        tag === "INPUT"
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter ? setter.call(el, text) : (el.value = text);
      el.classList.add("ai-filled-input");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.getAttribute?.("contenteditable") === "true") {
      el.textContent = text;
      el.classList.add("ai-filled-input");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    } else if (tag === "IFRAME") {
      try {
        const doc = el.contentDocument || el.contentWindow?.document;
        if (doc?.body) {
          doc.body.innerHTML = text;
          doc.body.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } catch (_) {}
    } else {
      el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function clickOptionElement(el) {
    if (!el) return;
    const isForm =
      el.tagName === "INPUT" && (el.type === "radio" || el.type === "checkbox");
    isForm ? clickFormOption(el) : clickCustomOption(el);
  }

  function clickFormOption(inputEl) {
    try {
      inputEl.click();
    } catch (_) {}
    if (inputEl.checked) return;
    const label =
      inputEl.closest("label") ||
      (inputEl.id
        ? document.querySelector(`label[for="${CSS.escape(inputEl.id)}"]`)
        : null);
    if (label) {
      try {
        label.click();
      } catch (_) {}
      if (inputEl.checked) return;
    }
    const wrapper =
      inputEl.closest(".option,.choice,.answer-item,.radio,.checkbox") ||
      inputEl.parentElement;
    if (wrapper && wrapper !== label) {
      try {
        wrapper.click();
      } catch (_) {}
      if (inputEl.checked) return;
    }
    fireMouseEvents(inputEl);
    if (!inputEl.checked) {
      inputEl.checked = true;
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function clickCustomOption(el) {
    const clickable = el.querySelector("a, button, [onclick], label") || el;
    try {
      clickable.click();
    } catch (_) {}
    try {
      el.click();
    } catch (_) {}
    fireMouseEvents(el);
    if (clickable !== el) fireMouseEvents(clickable);
    const outer = el.closest("[onclick], a, button");
    if (outer && outer !== el && outer !== clickable) {
      try {
        outer.click();
      } catch (_) {}
      fireMouseEvents(outer);
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    const rk = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    if (rk) {
      el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    }
  }

  function fireMouseEvents(el) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2,
      cy = r.top + r.height / 2;
    const o = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
    ["mouseover", "mouseenter", "mousedown", "mouseup", "click"].forEach((t) =>
      el.dispatchEvent(new MouseEvent(t, o)),
    );
  }

  function findClickableWrapper(el) {
    return (
      el.closest("label") ||
      el.closest(
        ".option,.choice,.answer-item,.radio,.checkbox,.answerBg,.chooseAnswer",
      ) ||
      el.parentElement
    );
  }

  function safeInsertBefore(node, target) {
    if (!target || !target.parentElement) {
      if (target) target.prepend(node);
      return;
    }
    const pTag = target.parentElement.tagName;
    if (["TBODY", "TABLE", "THEAD", "TFOOT"].includes(pTag)) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 99;
      td.style.border = "none";
      td.style.background = "transparent";
      td.style.padding = "0";
      td.appendChild(node);
      tr.appendChild(td);
      target.parentElement.insertBefore(tr, target);
    } else if (pTag === "TR") {
      target.insertBefore(node, target.firstChild);
    } else if (pTag === "UL" || pTag === "OL") {
      const li = document.createElement("li");
      li.style.listStyle = "none";
      li.style.margin = "0";
      li.style.padding = "0";
      li.appendChild(node);
      target.parentElement.insertBefore(li, target);
    } else {
      target.parentElement.insertBefore(node, target);
    }
  }

  function safeInsertAfter(node, target) {
    if (!target || !target.parentElement) {
      if (target) target.appendChild(node);
      return;
    }
    const pTag = target.parentElement.tagName;
    if (["TBODY", "TABLE", "THEAD", "TFOOT"].includes(pTag)) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 99;
      td.style.border = "none";
      td.style.background = "transparent";
      td.style.padding = "0";
      td.appendChild(node);
      tr.appendChild(td);
      target.nextSibling ? target.parentElement.insertBefore(tr, target.nextSibling) : target.parentElement.appendChild(tr);
    } else if (pTag === "TR") {
      target.appendChild(node);
    } else if (pTag === "UL" || pTag === "OL") {
      const li = document.createElement("li");
      li.style.listStyle = "none";
      li.style.margin = "0";
      li.style.padding = "0";
      li.appendChild(node);
      target.nextSibling ? target.parentElement.insertBefore(li, target.nextSibling) : target.parentElement.appendChild(li);
    } else {
      target.nextSibling ? target.parentElement.insertBefore(node, target.nextSibling) : target.parentElement.appendChild(node);
    }
  }

  function insertBadgeNearOptions(q, text, isFallback) {
    const badge = createBadge(text, isFallback);
    const firstOpt = q.options?.[0]?.element;
    if (firstOpt) {
      const wrapper = findClickableWrapper(firstOpt);
      if (wrapper && wrapper.parentElement) {
        safeInsertBefore(badge, wrapper);
        return;
      }
    }
    insertBeforeQuestion(q, badge);
  }

  function createAnswerCard(q, text, isFallback) {
    if (!text) return;
    const card = document.createElement("div");
    card.className = "ai-answer-card" + (isFallback ? " fallback" : "");
    card.innerHTML = `<div class="ai-answer-card-header">AI 答案</div><div class="ai-answer-card-body">${escapeHtml(text)}</div>`;
    safeInsertAfter(card, q.element);
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML.replace(/\n/g, "<br>");
  }

  function createBadge(text, isFallback) {
    const span = document.createElement("span");
    span.className = "ai-answer-badge" + (isFallback ? " fallback" : "");
    span.textContent = text;
    return span;
  }

  function insertBeforeQuestion(q, node) {
    safeInsertBefore(node, q.element);
  }

  function clearAllAnswers() {
    document.querySelectorAll(".ai-answer-badge").forEach((b) => b.remove());
    document.querySelectorAll(".ai-answer-card").forEach((b) => b.remove());
    document
      .querySelectorAll(".ai-answer-highlight")
      .forEach((b) => b.classList.remove("ai-answer-highlight", "fallback"));
    document.querySelectorAll(".ai-filled-input").forEach((b) => {
      b.classList.remove("ai-filled-input");
      b.value = "";
    });
    if (answerStyleEl) {
      answerStyleEl.remove();
      answerStyleEl = null;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  控制面板 UI
  // ═══════════════════════════════════════════════════════

  let panelEl = null;
  let _panelPos = { x: null, y: null };

  function _getInitialPos() {
    if (_panelPos.x !== null)
      return {
        left: _panelPos.x,
        top: _panelPos.y,
        right: "auto",
        bottom: "auto",
      };
    const map = {
      tl: { top: "20px", left: "20px", right: "auto", bottom: "auto" },
      tr: { top: "20px", right: "20px", left: "auto", bottom: "auto" },
      bl: { bottom: "20px", left: "20px", right: "auto", top: "auto" },
    };
    return (
      map[CFG.position] || {
        bottom: "20px",
        right: "20px",
        left: "auto",
        top: "auto",
      }
    );
  }

  function createPanel() {
    if (panelEl) return;
    const pos = _getInitialPos();
    panelEl = document.createElement("div");
    panelEl.id = "ai-auto-answer-panel";
    panelEl.innerHTML = `
      <style>
        #ai-auto-answer-panel{position:fixed;z-index:2147483647;font-family:"Inter",-apple-system,"Microsoft YaHei",sans-serif;${pos.top ? `top:${pos.top};` : ""}${pos.bottom ? `bottom:${pos.bottom};` : ""}${pos.left ? `left:${pos.left};` : ""}${pos.right ? `right:${pos.right};` : ""}}
        #ai-auto-answer-panel .ai-panel-bar{
          display:flex;align-items:center;gap:8px;
          background:rgba(24, 24, 38, 0.7);
          backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
          border:1px solid rgba(255, 255, 255, 0.1);
          color:#fff;border-radius:32px;padding:10px 18px;
          box-shadow:0 12px 40px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1);
          user-select:none;cursor:grab;transition:all 0.3s cubic-bezier(0.2,0.8,0.2,1);
        }
        #ai-auto-answer-panel .ai-panel-bar:active{cursor:grabbing;transform:scale(0.98);}
        #ai-auto-answer-panel button{
          border:none;border-radius:24px;padding:8px 16px;font-size:13px;
          cursor:pointer;font-weight:600;transition:all 0.25s cubic-bezier(0.2,0.8,0.2,1);
          white-space:nowrap;font-family:inherit;outline:none;
        }
        #ai-auto-answer-panel .ai-btn-scan{
          background:linear-gradient(135deg, #6366f1, #8b5cf6);
          color:#fff;box-shadow:0 4px 12px rgba(99,102,241,0.25);
        }
        #ai-auto-answer-panel .ai-btn-scan:hover{
          background:linear-gradient(135deg, #4f46e5, #7c3aed);
          transform:translateY(-2px);box-shadow:0 6px 16px rgba(99,102,241,0.4);
        }
        #ai-auto-answer-panel .ai-btn-answer{
          background:linear-gradient(135deg, #10b981, #059669);
          color:#fff;box-shadow:0 4px 12px rgba(16,185,129,0.25);
        }
        #ai-auto-answer-panel .ai-btn-answer:hover:not(:disabled){
          background:linear-gradient(135deg, #059669, #047857);
          transform:translateY(-2px);box-shadow:0 6px 16px rgba(16,185,129,0.4);
        }
        #ai-auto-answer-panel .ai-btn-answer:disabled{
          background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.3);
          box-shadow:none;cursor:not-allowed;
        }
        #ai-auto-answer-panel .ai-btn-clear{
          background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.7);
          border:1px solid rgba(255,255,255,0.1);padding:7px 14px;
        }
        #ai-auto-answer-panel .ai-btn-clear:hover{
          color:#fff;border-color:rgba(255,255,255,0.3);background:rgba(255,255,255,0.1);
        }
        #ai-auto-answer-panel .ai-btn-icon{
          background:transparent;color:rgba(255,255,255,0.7);
          padding:8px;border-radius:50%;font-size:16px;line-height:1;
          display:flex;align-items:center;justify-content:center;
          width:32px;height:32px;
        }
        #ai-auto-answer-panel .ai-btn-icon:hover{
          color:#fff;background:rgba(255,255,255,0.15);transform:rotate(15deg);
        }
        #ai-auto-answer-panel .ai-btn-icon.active{
          color:#a78bfa;background:rgba(139,92,246,0.2);transform:rotate(0);
        }
        #ai-auto-answer-panel .ai-progress{font-size:13px;color:rgba(255,255,255,0.9);min-width:60px;text-align:center;font-weight:500;letter-spacing:0.5px;}
        #ai-auto-answer-panel .ai-dot{
          width:10px;height:10px;border-radius:50%;
          background:#10b981;flex-shrink:0;
          box-shadow:0 0 10px rgba(16,185,129,0.6);
        }
        #ai-auto-answer-panel .ai-dot.running{
          background:#f59e0b;box-shadow:0 0 12px rgba(245,158,11,0.6);
          animation:aiPulse 1s ease-in-out infinite alternate;
        }
        @keyframes aiPulse{from{opacity:1;transform:scale(1)}to{opacity:0.6;transform:scale(0.85)}}
        #ai-log-panel{
          display:none;position:absolute;bottom:70px;right:0;width:340px;max-height:300px;overflow-y:auto;
          background:rgba(24,24,38,0.85);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
          border:1px solid rgba(255,255,255,0.1);border-radius:16px;
          box-shadow:0 20px 40px rgba(0,0,0,0.4);padding:12px 0;
          animation:aiSlideUp 0.3s cubic-bezier(0.2,0.8,0.2,1);
        }
        @keyframes aiSlideUp{from{opacity:0;transform:translateY(12px) scale(0.95)}to{opacity:1;transform:translateY(0) scale(1)}}
        #ai-log-panel.show{display:block;}
        #ai-log-panel .le{
          display:flex;gap:10px;padding:8px 16px;font-size:13px;line-height:1.5;
          color:rgba(255,255,255,0.85);border-bottom:1px solid rgba(255,255,255,0.04);
          transition:background 0.2s;
        }
        #ai-log-panel .le:hover{background:rgba(255,255,255,0.03);}
        #ai-log-panel .le .lt{color:rgba(255,255,255,0.4);flex-shrink:0;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;}
        #ai-log-panel .le.ls{color:#34d399;}#ai-log-panel .le.lw{color:#fbbf24;}#ai-log-panel .le.le2{color:#f87171;}
        #ai-log-panel::-webkit-scrollbar{width:6px;}
        #ai-log-panel::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:3px;}
        
        #ai-settings-overlay{
          position:fixed;inset:0;z-index:2147483648;
          background:rgba(0,0,0,0.4);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
          display:flex;align-items:center;justify-content:center;
          animation:aiFadeIn 0.3s ease;font-family:"Inter",-apple-system,sans-serif;
        }
        #ai-settings-overlay .sm{
          background:rgba(30,30,46,0.9);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
          border:1px solid rgba(255,255,255,0.1);
          color:#fff;border-radius:24px;padding:32px;
          max-width:480px;width:90%;max-height:85vh;overflow-y:auto;
          box-shadow:0 24px 64px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1);
          animation:aiScaleIn 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }
        @keyframes aiScaleIn{from{opacity:0;transform:scale(0.95) translateY(10px)}to{opacity:1;transform:scale(1) translateY(0)}}
        #ai-settings-overlay h3{
          margin:0 0 24px;color:#fff;font-size:22px;font-weight:700;
          display:flex;align-items:center;gap:8px;
        }
        #ai-settings-overlay .fr{margin-bottom:16px;}
        #ai-settings-overlay label{
          display:block;font-size:13px;font-weight:600;color:rgba(255,255,255,0.7);
          margin-bottom:6px;letter-spacing:0.3px;
        }
        #ai-settings-overlay input, #ai-settings-overlay select{
          width:100%;box-sizing:border-box;padding:12px 16px;
          background:rgba(0,0,0,0.2);color:#fff;
          border:1px solid rgba(255,255,255,0.1);border-radius:12px;
          font-size:14px;font-family:inherit;transition:all 0.2s ease;
        }
        #ai-settings-overlay input:focus, #ai-settings-overlay select:focus{
          border-color:#6366f1;outline:none;background:rgba(0,0,0,0.3);
          box-shadow:0 0 0 3px rgba(99,102,241,0.2);
        }
        #ai-settings-overlay select option{background:#1e1e2e;color:#fff;}
        #ai-settings-overlay .fa{display:flex;gap:12px;justify-content:flex-end;margin-top:32px;}
        #ai-settings-overlay .fa button{
          border:none;border-radius:12px;padding:10px 24px;font-size:14px;
          font-weight:600;cursor:pointer;transition:all 0.2s ease;font-family:inherit;
        }
        #s-cancel{background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.8);border:1px solid rgba(255,255,255,0.1);}
        #s-cancel:hover{background:rgba(255,255,255,0.1);color:#fff;}
        #s-save{
          background:linear-gradient(135deg, #10b981, #059669);color:#fff;
          box-shadow:0 4px 12px rgba(16,185,129,0.3);
        }
        #s-save:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(16,185,129,0.4);}
        #ai-settings-overlay::-webkit-scrollbar{width:8px;}
        #ai-settings-overlay::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.2);border-radius:4px;}
      </style>
      <div class="ai-panel-bar" id="ai-drag">
        <div class="ai-dot" id="ai-dot"></div>
        <span class="ai-progress" id="ai-prog">就绪</span>
        <button class="ai-btn-scan"   id="ai-scan"  title="扫描题目">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px;"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>扫描
        </button>
        <button class="ai-btn-answer" id="ai-run"   title="自动答题" disabled>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>答题
        </button>
        <button class="ai-btn-icon"   id="ai-logs"  title="日志">📋</button>
        <button class="ai-btn-clear"  id="ai-clear" title="清除">清除</button>
        <button class="ai-btn-icon"   id="ai-cfg"   title="设置">⚙</button>
      </div>
      <div id="ai-log-panel"></div>
    `;
    document.body.appendChild(panelEl);
    _initDrag();
    _initLogPanel();
    document.getElementById("ai-scan").onclick = handleScan;
    document.getElementById("ai-run").onclick = handleAnswer;
    document.getElementById("ai-clear").onclick = handleClear;
    document.getElementById("ai-cfg").onclick = showSettings;
  }

  function _initDrag() {
    const handle = document.getElementById("ai-drag");
    if (!handle) return;
    let sx,
      sy,
      sl,
      st,
      dragging = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      const r = panelEl.getBoundingClientRect();
      sx = e.clientX;
      sy = e.clientY;
      sl = r.left;
      st = r.top;
      panelEl.style.right = "auto";
      panelEl.style.bottom = "auto";
      panelEl.style.left = sl + "px";
      panelEl.style.top = st + "px";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      let nl = Math.max(
        0,
        Math.min(sl + e.clientX - sx, window.innerWidth - 50),
      );
      let nt = Math.max(
        0,
        Math.min(st + e.clientY - sy, window.innerHeight - 40),
      );
      panelEl.style.left = nl + "px";
      panelEl.style.top = nt + "px";
      _panelPos.x = nl + "px";
      _panelPos.y = nt + "px";
    });
    document.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  function _initLogPanel() {
    const lp = document.getElementById("ai-log-panel");
    const btn = document.getElementById("ai-logs");
    let show = false;
    btn.onclick = () => {
      show = !show;
      lp.classList.toggle("show", show);
      btn.classList.toggle("active", show);
      if (show) _renderLogs();
    };
    Logger.onChange((e) => {
      if (e._clear) {
        lp.innerHTML = "";
        return;
      }
      if (show) _renderLogs();
    });
  }

  function _renderLogs() {
    const lp = document.getElementById("ai-log-panel");
    if (!lp) return;
    const clsMap = { info: "", success: "ls", warning: "lw", error: "le2" };
    lp.innerHTML = Logger.getLogs(40)
      .map(
        (e) =>
          `<div class="le ${clsMap[e.level]}"><span class="lt">${e.time}</span><span>${escapeHtml(e.message)}</span></div>`,
      )
      .join("");
    lp.scrollTop = lp.scrollHeight;
  }

  function setProgress(t) {
    const el = document.getElementById("ai-prog");
    if (el) el.textContent = t;
  }

  function updateUI() {
    const dot = document.getElementById("ai-dot");
    const btn = document.getElementById("ai-run");
    if (dot) dot.classList.toggle("running", STATE.running);
    if (btn) btn.disabled = STATE.running || STATE.questions.length === 0;
    if (STATE.questions.length > 0 && !STATE.running)
      setProgress(`${STATE.questions.length} 题`);
  }

  async function handleScan() {
    setProgress("扫描中...");
    await sleep(100);
    const questions = detectQuestions();
    STATE.questions = questions;
    STATE.answered = 0;
    STATE.total = questions.length;
    if (!questions.length) {
      setProgress("未找到题目");
      Logger.warning("未检测到题目，请确认页面包含题目元素");
      setTimeout(() => setProgress("就绪"), 2000);
      return;
    }
    questions.forEach((q, i) => {
      q.id = i + 1;
      q.element.style.outline = "2px dashed rgba(92,106,196,0.4)";
      q.element.style.outlineOffset = "2px";
    });
    Logger.success(`扫描完成，共 ${questions.length} 题`);
    updateUI();
  }

  async function handleAnswer() {
    if (STATE.running || !STATE.questions.length) return;
    if (!CFG.apiKey) {
      Logger.error("请先在设置中填入 API Key");
      showSettings();
      return;
    }
    STATE.running = true;
    STATE.answered = 0;
    STATE.total = STATE.questions.length;
    updateUI();
    Logger.info(`开始答题，共 ${STATE.total} 题`);
    for (let i = 0; i < STATE.questions.length; i++) {
      const q = STATE.questions[i];
      setProgress(`${i + 1}/${STATE.total}`);
      if (!document.contains(q.element)) {
        Logger.warning(`第 ${i + 1} 题已脱离文档，跳过`);
        continue;
      }
      try {
        const answer = await callAI(q, i);
        injectAnswerToPage(q, answer);
        STATE.answered++;
        Logger.success(
          `第 ${i + 1} 题完成${answer.matchMethod === "fuzzy" ? ` (模糊匹配 ${answer.similarity}%)` : ""}`,
        );
      } catch (err) {
        Logger.error(`第 ${i + 1} 题失败: ${err.message}`);
        insertBeforeQuestion(q, createBadge(`❌ ${err.message}`, true));
      }
      setProgress(`${STATE.answered}/${STATE.total}`);
      if (i < STATE.questions.length - 1) await sleep(CFG.autoAnswerDelay);
    }
    STATE.running = false;
    updateUI();
    setProgress(`完成 ${STATE.answered}/${STATE.total}`);
    Logger.success(`答题完成 ${STATE.answered}/${STATE.total}`);
    if (STATE.answered > 0 && typeof GM_notification !== "undefined")
      GM_notification({
        text: `已完成 ${STATE.answered}/${STATE.total} 题`,
        title: "AI 自动答题",
        timeout: 3000,
      });
  }

  function handleClear() {
    clearAllAnswers();
    Logger.clear();
    STATE.questions.forEach((q) => {
      if (q.element) {
        q.element.style.outline = "";
        q.element.style.outlineOffset = "";
      }
    });
    STATE.questions = [];
    STATE.answered = 0;
    STATE.total = 0;
    updateUI();
    setProgress("就绪");
  }

  // ═══════════════════════════════════════════════════════
  //  设置面板
  // ═══════════════════════════════════════════════════════

  function showSettings() {
    document.getElementById("ai-settings-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "ai-settings-overlay";
    overlay.innerHTML = `
      <div class="sm" onclick="event.stopPropagation()">
        <h3>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          AI 自动答题设置
        </h3>
        <div class="fr"><label>API 提供商</label>
          <select id="s-prov">
            <option value="deepseek" ${CFG.provider === "deepseek" ? "selected" : ""}>DeepSeek（推荐）</option>
            <option value="openai"   ${CFG.provider === "openai" ? "selected" : ""}>OpenAI</option>
            <option value="custom"   ${CFG.provider === "custom" ? "selected" : ""}>自定义（兼容 OpenAI 格式）</option>
          </select></div>
        <div class="fr"><label>API 端点</label>      <input id="s-ep"  type="text"     value="${CFG.endpoint}"></div>
        <div class="fr"><label>模型名称</label>      <input id="s-md"  type="text"     value="${CFG.model}" placeholder="deepseek-chat"></div>
        <div class="fr"><label>API Key</label>       <input id="s-key" type="password" value="${CFG.apiKey}" placeholder="sk-..."></div>
        <div class="fr"><label>备用 API 端点</label> <input id="s-fep" type="text"     value="${CFG.fallbackEndpoint}" placeholder="留空不启用"></div>
        <div class="fr"><label>备用 API Key</label>  <input id="s-fk"  type="password" value="${CFG.fallbackApiKey}"  placeholder="留空不启用"></div>
        <div class="fr"><label>每题延迟 (ms)</label> <input id="s-del" type="number"   value="${CFG.autoAnswerDelay}"     min="200" max="5000"></div>
        <div class="fr"><label>最大题数</label>      <input id="s-max" type="number"   value="${CFG.maxQuestions}"         min="1"   max="200"></div>
        <div class="fr"><label>重试次数</label>      <input id="s-ret" type="number"   value="${CFG.retryCount}"            min="0"   max="5"></div>
        <div class="fr"><label>模糊匹配阈值 (%)</label><input id="s-sim" type="number" value="${CFG.similarityThreshold}"  min="30"  max="90"></div>
        <div class="fr" style="display:flex;align-items:center;gap:8px;margin-top:20px;">
          <input id="s-vis" type="checkbox" style="width:16px;height:16px;margin:0;padding:0;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.1);cursor:pointer;" ${CFG.enableVision ? "checked" : ""}>
          <label style="margin:0;display:inline;cursor:pointer;color:#a5d6a7;" onclick="document.getElementById('s-vis').click()">启用图片识别（需 GPT-4o 等多模态模型，DeepSeek 暂不支持）</label>
        </div>
        <div class="fa">
          <button id="s-cancel">取消</button>
          <button id="s-save">保存设置</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    overlay.querySelector("#s-cancel").onclick = () => overlay.remove();
    overlay.querySelector("#s-prov").onchange = (e) => {
      const ep = overlay.querySelector("#s-ep"),
        md = overlay.querySelector("#s-md");
      if (e.target.value === "deepseek") {
        ep.value = "https://api.deepseek.com/v1/chat/completions";
        md.value = "deepseek-chat";
      } else if (e.target.value === "openai") {
        ep.value = "https://api.openai.com/v1/chat/completions";
        md.value = "gpt-4o-mini";
      } else {
        ep.value = "";
        md.value = "";
      }
    };
    overlay.querySelector("#s-save").onclick = () => {
      CFG.provider = overlay.querySelector("#s-prov").value;
      CFG.endpoint = overlay.querySelector("#s-ep").value;
      CFG.model = overlay.querySelector("#s-md").value;
      CFG.apiKey = overlay.querySelector("#s-key").value;
      CFG.fallbackEndpoint = overlay.querySelector("#s-fep").value;
      CFG.fallbackApiKey = overlay.querySelector("#s-fk").value;
      CFG.autoAnswerDelay =
        parseInt(overlay.querySelector("#s-del").value) || 800;
      CFG.maxQuestions = parseInt(overlay.querySelector("#s-max").value) || 50;
      CFG.retryCount = parseInt(overlay.querySelector("#s-ret").value) || 1;
      CFG.similarityThreshold =
        parseInt(overlay.querySelector("#s-sim").value) || 50;
      CFG.enableVision = overlay.querySelector("#s-vis").checked;
      for (const [k, v] of Object.entries(CFG)) {
        try {
          GM_setValue(k, v);
        } catch (_) {}
      }
      overlay.remove();
      Logger.success("设置已保存");
    };
  }

  // ═══════════════════════════════════════════════════════
  //  工具 + 快捷键 + SPA 监听
  // ═══════════════════════════════════════════════════════

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.key === "s") {
      e.preventDefault();
      handleScan();
    }
    if (e.altKey && e.key === "a") {
      e.preventDefault();
      handleAnswer();
    }
    if (e.altKey && e.key === "c") {
      e.preventDefault();
      handleClear();
    }
  });

  let _lastUrl = window.location.href;

  function _setupSpaMonitor() {
    const _wrap = (type) => {
      const orig = window.history[type];
      return function (...args) {
        const r = orig.apply(this, args);
        _onUrlChange();
        return r;
      };
    };
    window.history.pushState = _wrap("pushState");
    window.history.replaceState = _wrap("replaceState");
    window.addEventListener("popstate", _onUrlChange);
    setInterval(() => {
      if (window.location.href !== _lastUrl) _onUrlChange();
    }, 2000);
  }

  function _onUrlChange() {
    const url = window.location.href;
    if (url === _lastUrl) return;
    _lastUrl = url;
    Logger.info("路由变化，重新扫描");
    STATE.questions.forEach((q) => {
      if (q.element) {
        q.element.style.outline = "";
        q.element.style.outlineOffset = "";
      }
      if (q.options)
        q.options.forEach((o) => {
          o.element = null;
        });
      q.element = null;
      q.input = null;
      q.inputs = null;
    });
    STATE.questions = [];
    STATE.answered = 0;
    STATE.total = 0;
    updateUI();
    setTimeout(handleScan, 800);
  }

  // ═══════════════════════════════════════════════════════
  //  初始化
  // ═══════════════════════════════════════════════════════

  _setupSpaMonitor();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () =>
      setTimeout(createPanel, 500),
    );
  } else {
    setTimeout(createPanel, 500);
  }
  Logger.info(`AutoAnswer v${SCRIPT_VERSION} 已加载`);
})();
 