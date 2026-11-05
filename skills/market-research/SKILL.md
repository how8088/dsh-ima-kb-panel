---
name: market-research
description: 用 ima 知识库里的方法论结合通达信 MCP 实时数据做资本市场分析。当用户要分析个股/板块/大盘、按「我的材料/方法论」复盘、研判题材或检查交易计划时使用；用户没要求做市场分析时不要主动触发。
---

# 资本市场联动分析（知识库 × 通达信）

## 什么时候用

用户问个股/板块/指数走势、买卖点、题材、复盘，或明确说「按我的方法论分析」时。
**「默认不主动查知识库」的全局规则不变**：用户没让分析市场就不查。

## 工作流（按序执行，缺数据就说缺）

1. **定标的**：用户给的名称/简称先用 `tdx_lookup_stock` 换成精确 code/setcode；概念板块用 880/881 代码、setcode=1。
2. **查方法论**（ima 知识库，两个检索各有分工）：
   - 不确定原文措辞 → `kb_find(query)` 官方分词检索找候选篇（换个说法也能命中）；
   - 确定原词（如「止损」「冰点」「缩量回踩」）→ `kb_search(query, limit≈6)` 拿带 offset 的多处命中；
   - `kb_read(note_id, offset, limit≈6000)` 读上下文，需要时继续翻页；
   - 看文件/目录 → `kb_space_list` / `kb_space_browse` / `kb_space_search`（文件检索只匹配文件名，不搜正文）。
3. **取实时数据**（通达信，按问题选，别全查）：

   | 要什么 | 工具 |
   |---|---|
   | 实时行情 + 估值（PE/PB/ROE/市值） | `tdx_quotes(code, setcode, hasCwInfo="1")` |
   | 历史走势 | `tdx_kline(code, setcode, period="4")`（日线必须显式 period="4"） |
   | 基本面 F10（财务/股东/资金/龙虎榜/分红） | `tdx_api_data(entry=...)`，entry 与 fixedTag 从工具描述里选 |
   | 多股对比 / 行业排名 / 估值指标 | `tdx_indicator_select(message="…")` |
   | 「最近发生了什么」资讯聚合 + 多空 | `tdx_ai_listening(setcode_code="1_600519", date="YYYY-MM-DD")` |
   | 公告 / 研报 / 新闻 | `wenda_notice_query` / `wenda_report_query` / `wenda_news_query` |
   | 宏观数据 | `wenda_macro_query` |
   | 按条件找股票 | `tdx_screener` |
   | 期货/期权 | 先 `tdx_lookup_stock(..., range="QH"/"QQ")` 再取数 |

4. **检查前提条件**：方法论都有适用环境（如「冰点不割肉」要求情绪冰点）。用刚取的数据核对现状是否满足前提；不满足就说「不适用」并说明原因，**绝不硬套**。
5. **输出格式**：
   - 结论在前；
   - 严格区分「**数据事实**」（工具返回值，标注工具名）与「**方法论判断**」（引用笔记）；
   - 引用格式：`《笔记标题》 offset N`；
   - 数据与材料矛盾时，明确说存在矛盾，不要自己挑一个。

## 红线

- 通达信工具返回空数据就如实说「没取到」，**禁止编造行情数字、涨跌幅或任何指标**。
- 知识库里查不到就说「材料里没有」，**禁止用通用知识冒充用户材料**。
- `kb_read` 分页读（≤3 万字符/次），不要把几十万字的整篇读进上下文；也不要碰无分页的 `mcp__ima-kb__get_note_content`。
- 涉及时效（「今天/最近/本周」）必须给 wenda_* 与 tdx_ai_listening 传**具体日期**。
