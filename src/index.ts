#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import axios, { AxiosError } from "axios";
import express from "express";
import { config } from "dotenv";

// ─── 환경변수 ───────────────────────────────────────────────

config();

const APP_KEY = process.env.KIWOOM_APP_KEY ?? "";
const SECRET_KEY = process.env.KIWOOM_SECRET_KEY ?? "";
const ACCOUNT_NO = process.env.KIWOOM_ACCOUNT_NO ?? "";
const IS_MOCK = (process.env.KIWOOM_IS_MOCK ?? "true").toLowerCase() === "true";

const BASE_URL = IS_MOCK
  ? "https://mockapi.kiwoom.com"
  : "https://api.kiwoom.com";

// ─── 공통 Zod 스키마 ────────────────────────────────────────

const stockCodeSchema = z
  .string()
  .regex(/^\d{6}$/, "종목코드는 6자리 숫자여야 합니다")
  .describe("종목코드 (예: 005930)");

const dateSchema = (label: string) =>
  z
    .string()
    .regex(/^\d{8}$/, "YYYYMMDD 형식이어야 합니다")
    .describe(`${label} (YYYYMMDD 형식)`);

const accountNoSchema = z
  .string()
  .optional()
  .describe("계좌번호 (미입력시 기본 계좌 사용)");

// ─── 공통 유틸 ──────────────────────────────────────────────

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

function textContent(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorContent(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function resolveAccountNo(accountNo?: string): string {
  const acct = accountNo || ACCOUNT_NO;
  if (!acct) {
    throw new Error(
      "계좌번호를 입력하거나 KIWOOM_ACCOUNT_NO 환경변수를 설정해주세요."
    );
  }
  return acct;
}

// ─── TokenManager ───────────────────────────────────────────

class TokenManager {
  private token: string | null = null;
  private expiresAt = 0;
  private refreshPromise: Promise<string> | null = null;

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) {
      return this.token;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  private async refresh(): Promise<string> {
    if (!APP_KEY || !SECRET_KEY) {
      throw new Error(
        "KIWOOM_APP_KEY와 KIWOOM_SECRET_KEY 환경변수를 설정해주세요.\n" +
          "https://openapi.kiwoom.com 에서 발급받을 수 있습니다."
      );
    }

    const res = await axios.post(`${BASE_URL}/oauth2/token`, {
      grant_type: "client_credentials",
      appkey: APP_KEY,
      secretkey: SECRET_KEY,
    });

    this.token = res.data.token;
    const expiresIn = res.data.expires_in;
    // 서버 응답의 expires_in 사용, 없으면 23시간 (24h 만료 - 1h 여유)
    this.expiresAt = expiresIn
      ? Date.now() + (expiresIn - 3600) * 1000
      : Date.now() + 23 * 60 * 60 * 1000;
    return this.token!;
  }
}

// ─── KiwoomApiClient ────────────────────────────────────────

class KiwoomApiClient {
  private tokenManager = new TokenManager();

  private async request(path: string, apiId: string, body: Record<string, unknown> = {}) {
    const doRequest = async () => {
      const token = await this.tokenManager.getToken();
      const res = await axios.post(`${BASE_URL}${path}`, body, {
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          Authorization: `Bearer ${token}`,
          appkey: APP_KEY,
          secretkey: SECRET_KEY,
          "api-id": apiId,
        },
      });
      return res.data;
    };

    try {
      return await doRequest();
    } catch (error) {
      // 401 시 토큰 무효화 후 1회 재시도
      if (error instanceof AxiosError && error.response?.status === 401) {
        this.tokenManager.invalidate();
        return await doRequest();
      }
      throw error;
    }
  }

  async getAccountBalance(accountNo: string) {
    return this.request("/api/dostk/acnt", "ka10085", {
      acc_no: accountNo,
      stex_tp: "0",
    });
  }

  async getDeposit(accountNo: string) {
    return this.request("/api/dostk/acnt", "ka10072", {
      acc_no: accountNo,
      strt_dt: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
    });
  }

  async getStockPrice(stockCode: string) {
    return this.request("/api/dostk/stkinfo", "ka10001", {
      stk_cd: stockCode,
    });
  }

  async getStockChart(stockCode: string, startDate: string, endDate: string) {
    return this.request("/api/dostk/chart", "ka10002", {
      stk_cd: stockCode,
      start_dt: startDate,
      end_dt: endDate,
    });
  }

  async searchStockCode(keyword: string) {
    return this.request("/api/dostk/stkinfo", "ka10004", {
      keyword,
    });
  }

  async placeOrder(
    apiId: string,
    accountNo: string,
    stockCode: string,
    quantity: number,
    price: number,
    orderType: string
  ) {
    const priceType = orderType === "market" ? "03" : "00";
    return this.request("/api/dostk/order", apiId, {
      acc_no: accountNo,
      stk_cd: stockCode,
      qty: quantity,
      price: orderType === "market" ? 0 : price,
      price_type: priceType,
    });
  }

  async getUnfilledOrders(accountNo: string) {
    return this.request("/api/dostk/acnt", "ka10075", {
      acc_no: accountNo,
    });
  }

  async cancelOrder(
    accountNo: string,
    originalOrderNo: string,
    stockCode: string,
    quantity: number
  ) {
    return this.request("/api/dostk/order", "kt10003", {
      acc_no: accountNo,
      org_ord_no: originalOrderNo,
      stk_cd: stockCode,
      qty: quantity,
    });
  }

  async getTradeHistory(
    accountNo: string,
    startDate: string,
    endDate: string
  ) {
    return this.request("/api/dostk/acnt", "ka10170", {
      acc_no: accountNo,
      start_dt: startDate,
      end_dt: endDate,
    });
  }
}

// ─── 포맷팅 헬퍼 ────────────────────────────────────────────

function formatCurrency(value: number | string | unknown): string {
  const num = Number(value);
  if (isNaN(num)) return String(value);
  return Math.round(num).toLocaleString("ko-KR") + "원";
}

function formatPercent(value: number | string | unknown): string {
  const num = Number(value);
  if (isNaN(num)) return String(value);
  const sign = num > 0 ? "+" : "";
  return `${sign}${num.toFixed(2)}%`;
}

function formatVolume(value: unknown): string {
  const num = Number(value);
  if (isNaN(num)) return "-";
  return num.toLocaleString("ko-KR");
}

function extractStockFields(item: Record<string, unknown>) {
  return {
    name: item.stk_nm ?? item.stock_name ?? "-",
    code: item.stk_cd ?? item.stock_code ?? "-",
    qty: item.hold_qty ?? item.quantity ?? "-",
    curPrice: item.cur_pr ?? item.current_price ?? "-",
    evalAmt: item.eval_amt ?? item.eval_amount ?? 0,
    plAmt: item.pl_amt ?? item.profit_loss ?? 0,
    plRate: item.pl_rate ?? item.profit_rate ?? "-",
  };
}

function formatBalance(data: Record<string, unknown>): string {
  const items = (data.acnt_prft_rt ?? data.output) as Record<string, unknown>[] | undefined;

  let result = "## 계좌 잔고\n\n";

  if (items && items.length > 0) {
    result += "| 종목명 | 종목코드 | 보유수량 | 현재가 | 매입금액 |\n";
    result += "|--------|---------|---------|--------|----------|\n";
    for (const item of items) {
      const name = item.stk_nm ?? "-";
      const code = item.stk_cd ?? "-";
      const qty = item.rmnd_qty ?? item.hold_qty ?? "-";
      const price = item.cur_prc ?? item.cur_pr ?? "-";
      const purAmt = item.pur_amt ?? "-";
      result += `| ${name} | ${code} | ${qty} | ${formatCurrency(price)} | ${formatCurrency(purAmt)} |\n`;
    }
  } else {
    result += "보유 종목이 없습니다.\n";
  }

  return result;
}

function formatPortfolioSummary(data: Record<string, unknown>): string {
  const output = data.output as Record<string, unknown>[] | undefined;
  const output2 = data.output2 as Record<string, unknown> | undefined;

  let result = "## 포트폴리오 분석\n\n";

  if (!output || output.length === 0) {
    return result + "보유 종목이 없습니다.\n";
  }

  const totalEval = output2
    ? Number(output2.tot_eval_amt ?? output2.total_eval_amt ?? 0)
    : 0;

  result += "| 종목명 | 비중 | 평가금액 | 손익금액 | 수익률 |\n";
  result += "|--------|------|---------|---------|--------|\n";

  let totalProfit = 0;
  let profitCount = 0;
  let lossCount = 0;

  for (const item of output) {
    const s = extractStockFields(item);
    const evalAmt = Number(s.evalAmt);
    const plAmt = Number(s.plAmt);
    const weight =
      totalEval > 0 ? ((evalAmt / totalEval) * 100).toFixed(1) + "%" : "-";

    if (plAmt >= 0) profitCount++;
    else lossCount++;
    totalProfit += plAmt;

    result += `| ${s.name} | ${weight} | ${formatCurrency(evalAmt)} | ${formatCurrency(plAmt)} | ${formatPercent(s.plRate)} |\n`;
  }

  result += `\n### 요약\n`;
  result += `- 총 보유종목: ${output.length}개\n`;
  result += `- 수익 종목: ${profitCount}개 / 손실 종목: ${lossCount}개\n`;
  result += `- 총 평가손익: ${formatCurrency(totalProfit)}\n`;

  return result;
}

function formatStockPrice(data: Record<string, unknown>): string {
  const o = (data.output ?? data) as Record<string, unknown>;

  const name = o.stk_nm ?? "-";
  const code = o.stk_cd ?? "-";
  const price = o.cur_prc ?? o.cur_pr ?? "-";
  const change = o.pred_pre ?? o.change_amt ?? "-";
  const high = o.high_pric ?? "-";
  const low = o.low_pric ?? "-";
  const open = o.open_pric ?? "-";
  const high250 = o["250hgst"] ?? o.oyr_hgst ?? "-";
  const low250 = o["250lwst"] ?? o.oyr_lwst ?? "-";
  const per = o.per ?? "-";
  const pbr = o.pbr ?? "-";
  const eps = o.eps ?? "-";

  let result = `## ${name} (${code}) 현재가 정보\n\n`;
  result += `- 현재가: ${formatCurrency(price)}\n`;
  result += `- 전일대비: ${formatCurrency(change)}\n`;
  result += `- 시가: ${formatCurrency(open)} / 고가: ${formatCurrency(high)} / 저가: ${formatCurrency(low)}\n`;
  result += `- 250일 최고: ${formatCurrency(high250)} / 최저: ${formatCurrency(low250)}\n`;
  result += `- PER: ${per} / PBR: ${pbr} / EPS: ${eps}\n`;

  return result;
}

function formatChartData(data: Record<string, unknown>): string {
  const output = data.output as Record<string, unknown>[] | undefined;

  let result = "## 차트 데이터 (일봉)\n\n";

  if (!output || output.length === 0) {
    return result + "데이터가 없습니다.\n";
  }

  result += "| 날짜 | 시가 | 고가 | 저가 | 종가 | 거래량 |\n";
  result += "|------|------|------|------|------|--------|\n";

  for (const item of output) {
    const date = item.date ?? item.trd_dt ?? "-";
    const open = item.open ?? item.open_pr ?? "-";
    const high = item.high ?? item.high_pr ?? "-";
    const low = item.low ?? item.low_pr ?? "-";
    const close = item.close ?? item.close_pr ?? "-";
    const vol = item.volume ?? item.trd_vol ?? "-";
    result += `| ${date} | ${formatCurrency(open)} | ${formatCurrency(high)} | ${formatCurrency(low)} | ${formatCurrency(close)} | ${formatVolume(vol)} |\n`;
  }

  return result;
}

function formatError(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status ?? "N/A";
    const msg =
      error.response?.data?.message ??
      error.response?.data?.msg ??
      error.message;
    return `API 오류 (HTTP ${status}): ${msg}`;
  }
  if (error instanceof Error) {
    return `오류: ${error.message}`;
  }
  return `알 수 없는 오류가 발생했습니다.`;
}

// ─── MCP 서버 ───────────────────────────────────────────────

const client = new KiwoomApiClient();

const server = new McpServer({
  name: "kiwoom-mcp",
  version: "1.0.0",
});

// ─── 조회 Tools (readOnlyHint: true) ────────────────────────

// 1. get_account_balance
server.tool(
  "get_account_balance",
  "보유 주식 목록, 평가금액, 수익률 등 계좌 잔고를 조회합니다",
  { account_no: accountNoSchema },
  { readOnlyHint: true },
  async ({ account_no }) => {
    try {
      const acct = resolveAccountNo(account_no);
      const data = await client.getAccountBalance(acct);
      return textContent(formatBalance(data));
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// 2. get_portfolio_summary
server.tool(
  "get_portfolio_summary",
  "종목별 비중, 손익 분석 등 포트폴리오를 요약 분석합니다",
  { account_no: accountNoSchema },
  { readOnlyHint: true },
  async ({ account_no }) => {
    try {
      const acct = resolveAccountNo(account_no);
      const data = await client.getAccountBalance(acct);
      return textContent(formatPortfolioSummary(data));
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// 3. get_deposit_detail
server.tool(
  "get_deposit_detail",
  "예수금, 출금가능금액, 주문가능금액 등 예수금 상세를 조회합니다",
  { account_no: accountNoSchema },
  { readOnlyHint: true },
  async ({ account_no }) => {
    try {
      const acct = resolveAccountNo(account_no);
      const data = await client.getDeposit(acct);
      const o = (data.output ?? data) as Record<string, unknown>;

      let text = "## 예수금 상세\n\n";
      text += `- 예수금: ${formatCurrency(o.deposit ?? o.dpst_amt ?? "-")}\n`;
      text += `- 출금가능금액: ${formatCurrency(o.withdrawable ?? o.wdr_able_amt ?? "-")}\n`;
      text += `- 주문가능금액: ${formatCurrency(o.orderable ?? o.ord_able_amt ?? "-")}\n`;

      return textContent(text);
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// 4. get_stock_price
server.tool(
  "get_stock_price",
  "종목의 현재가, 등락률, 거래량, 52주 고저, PER/PBR 등을 조회합니다",
  { stock_code: stockCodeSchema },
  { readOnlyHint: true },
  async ({ stock_code }) => {
    try {
      const data = await client.getStockPrice(stock_code);
      return textContent(formatStockPrice(data));
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// 5. get_stock_chart
server.tool(
  "get_stock_chart",
  "일봉 OHLCV 차트 데이터를 기간 지정하여 조회합니다",
  {
    stock_code: stockCodeSchema,
    start_date: dateSchema("시작일"),
    end_date: dateSchema("종료일"),
  },
  { readOnlyHint: true },
  async ({ stock_code, start_date, end_date }) => {
    try {
      const data = await client.getStockChart(stock_code, start_date, end_date);
      return textContent(formatChartData(data));
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// 6. search_stock_code
server.tool(
  "search_stock_code",
  "종목명으로 종목코드를 검색합니다 (예: 삼성전자 → 005930)",
  { keyword: z.string().describe("검색할 종목명 (예: 삼성전자)") },
  { readOnlyHint: true },
  async ({ keyword }) => {
    try {
      const data = await client.searchStockCode(keyword);
      const output = data.output as Record<string, unknown>[] | undefined;

      if (!output || output.length === 0) {
        return textContent(`"${keyword}"에 대한 검색 결과가 없습니다.`);
      }

      let text = `## "${keyword}" 검색 결과\n\n`;
      text += "| 종목코드 | 종목명 | 시장 |\n";
      text += "|---------|--------|------|\n";
      for (const item of output) {
        const code = item.stk_cd ?? item.stock_code ?? "-";
        const name = item.stk_nm ?? item.stock_name ?? "-";
        const market = item.market ?? item.mkt_nm ?? "-";
        text += `| ${code} | ${name} | ${market} |\n`;
      }

      return textContent(text);
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// 9. get_unfilled_orders
server.tool(
  "get_unfilled_orders",
  "미체결 주문 목록을 조회합니다",
  { account_no: accountNoSchema },
  { readOnlyHint: true },
  async ({ account_no }) => {
    try {
      const acct = resolveAccountNo(account_no);
      const data = await client.getUnfilledOrders(acct);
      const output = data.output as Record<string, unknown>[] | undefined;

      if (!output || output.length === 0) {
        return textContent("미체결 주문이 없습니다.");
      }

      let text = "## 미체결 주문 목록\n\n";
      text +=
        "| 주문번호 | 종목명 | 매매구분 | 주문수량 | 주문가격 | 미체결수량 |\n";
      text +=
        "|---------|--------|---------|---------|---------|----------|\n";

      for (const item of output) {
        const ordNo = item.ord_no ?? item.order_no ?? "-";
        const name = item.stk_nm ?? item.stock_name ?? "-";
        const side = item.buy_sell ?? item.side ?? "-";
        const qty = item.ord_qty ?? item.order_qty ?? "-";
        const prc = item.ord_pr ?? item.order_price ?? "-";
        const unfilled = item.unfilled_qty ?? item.rmn_qty ?? "-";
        text += `| ${ordNo} | ${name} | ${side} | ${qty} | ${formatCurrency(prc)} | ${unfilled} |\n`;
      }

      return textContent(text);
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// 11. get_trade_history
server.tool(
  "get_trade_history",
  "기간별 체결 내역 (매수/매도)을 조회합니다",
  {
    start_date: dateSchema("시작일"),
    end_date: dateSchema("종료일"),
    account_no: accountNoSchema,
  },
  { readOnlyHint: true },
  async ({ start_date, end_date, account_no }) => {
    try {
      const acct = resolveAccountNo(account_no);
      const data = await client.getTradeHistory(acct, start_date, end_date);
      const output = data.output as Record<string, unknown>[] | undefined;

      if (!output || output.length === 0) {
        return textContent(
          `${start_date} ~ ${end_date} 기간 체결 내역이 없습니다.`
        );
      }

      let text = `## 체결 내역 (${start_date} ~ ${end_date})\n\n`;
      text +=
        "| 체결일 | 종목명 | 매매구분 | 체결수량 | 체결가격 | 체결금액 |\n";
      text +=
        "|--------|--------|---------|---------|---------|----------|\n";

      for (const item of output) {
        const date = item.exec_dt ?? item.trade_date ?? "-";
        const name = item.stk_nm ?? item.stock_name ?? "-";
        const side = item.buy_sell ?? item.side ?? "-";
        const qty = item.exec_qty ?? item.trade_qty ?? "-";
        const prc = item.exec_pr ?? item.trade_price ?? "-";
        const amt = item.exec_amt ?? item.trade_amount ?? "-";
        text += `| ${date} | ${name} | ${side} | ${qty} | ${formatCurrency(prc)} | ${formatCurrency(amt)} |\n`;
      }

      return textContent(text);
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// 12. analyze_profit_loss
server.tool(
  "analyze_profit_loss",
  "기간별 종목별 실현손익, 승률, 수익률을 자동 계산하여 분석합니다",
  {
    start_date: dateSchema("시작일"),
    end_date: dateSchema("종료일"),
    account_no: accountNoSchema,
  },
  { readOnlyHint: true },
  async ({ start_date, end_date, account_no }) => {
    try {
      const acct = resolveAccountNo(account_no);
      const data = await client.getTradeHistory(acct, start_date, end_date);
      const output = data.output as Record<string, unknown>[] | undefined;

      if (!output || output.length === 0) {
        return textContent(
          `${start_date} ~ ${end_date} 기간 거래 내역이 없어 분석할 수 없습니다.`
        );
      }

      const stockMap = new Map<
        string,
        { name: string; totalProfit: number; count: number }
      >();

      for (const item of output) {
        const code = String(item.stk_cd ?? item.stock_code ?? "unknown");
        const name = String(item.stk_nm ?? item.stock_name ?? code);
        const profit = Number(item.pl_amt ?? item.profit_loss ?? 0);

        const existing = stockMap.get(code);
        if (existing) {
          existing.totalProfit += profit;
          existing.count++;
        } else {
          stockMap.set(code, { name, totalProfit: profit, count: 1 });
        }
      }

      let totalProfit = 0;
      let winCount = 0;
      let lossCount = 0;
      let bestStock = { name: "", profit: -Infinity };
      let worstStock = { name: "", profit: Infinity };

      for (const [, info] of stockMap) {
        totalProfit += info.totalProfit;
        if (info.totalProfit >= 0) winCount++;
        else lossCount++;
        if (info.totalProfit > bestStock.profit) {
          bestStock = { name: info.name, profit: info.totalProfit };
        }
        if (info.totalProfit < worstStock.profit) {
          worstStock = { name: info.name, profit: info.totalProfit };
        }
      }

      const totalTrades = winCount + lossCount;
      const winRate =
        totalTrades > 0
          ? ((winCount / totalTrades) * 100).toFixed(1)
          : "0";

      let text = `## 손익 분석 (${start_date} ~ ${end_date})\n\n`;
      text += `- 총 거래 종목: ${totalTrades}개\n`;
      text += `- 수익 종목: ${winCount}개 / 손실 종목: ${lossCount}개\n`;
      text += `- 승률: ${winRate}%\n`;
      text += `- 총 실현손익: ${formatCurrency(totalProfit)}\n`;

      if (bestStock.name) {
        text += `- 최고 수익: ${bestStock.name} (${formatCurrency(bestStock.profit)})\n`;
      }
      if (worstStock.name && worstStock.profit !== Infinity) {
        text += `- 최대 손실: ${worstStock.name} (${formatCurrency(worstStock.profit)})\n`;
      }

      text += `\n### 종목별 상세\n\n`;
      text += "| 종목명 | 거래횟수 | 실현손익 |\n";
      text += "|--------|---------|----------|\n";

      const sorted = [...stockMap.entries()].sort(
        (a, b) => b[1].totalProfit - a[1].totalProfit
      );
      for (const [, info] of sorted) {
        text += `| ${info.name} | ${info.count}회 | ${formatCurrency(info.totalProfit)} |\n`;
      }

      return textContent(text);
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// ─── 주문 Tools (readOnlyHint: false) ───────────────────────

function registerOrderTool(
  name: string,
  description: string,
  trcode: string,
  sideLabel: string
) {
  server.tool(
    name,
    description,
    {
      stock_code: stockCodeSchema,
      quantity: z.number().int().positive().describe("주문 수량"),
      price: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("주문 가격 (시장가일 경우 0)"),
      order_type: z
        .enum(["market", "limit"])
        .default("market")
        .describe("주문유형: market(시장가) 또는 limit(지정가)"),
      account_no: accountNoSchema,
    },
    { readOnlyHint: false, idempotentHint: false },
    async ({ stock_code, quantity, price, order_type, account_no }) => {
      try {
        const acct = resolveAccountNo(account_no);

        if (order_type === "limit" && price <= 0) {
          return errorContent(
            "지정가 주문 시 가격을 0보다 큰 값으로 입력해주세요."
          );
        }

        const data = await client.placeOrder(
          trcode,
          acct,
          stock_code,
          quantity,
          price,
          order_type
        );

        const orderNo = data.output?.ord_no ?? data.ord_no ?? "N/A";
        const typeLabel =
          order_type === "market"
            ? "시장가"
            : `지정가 ${formatCurrency(price)}`;

        let text = `## ${sideLabel} 주문 완료\n\n`;
        text += `- 주문번호: ${orderNo}\n`;
        text += `- 종목코드: ${stock_code}\n`;
        text += `- 주문유형: ${typeLabel}\n`;
        text += `- 주문수량: ${quantity}주\n`;
        if (IS_MOCK) text += "\n(모의투자 주문)\n";

        return textContent(text);
      } catch (error) {
        return errorContent(formatError(error));
      }
    }
  );
}

// 7. place_buy_order
registerOrderTool(
  "place_buy_order",
  "주식 매수 주문을 실행합니다. 시장가 또는 지정가 매수를 지원합니다",
  "kt10000",
  "매수"
);

// 8. place_sell_order
registerOrderTool(
  "place_sell_order",
  "주식 매도 주문을 실행합니다. 시장가 또는 지정가 매도를 지원합니다",
  "kt10001",
  "매도"
);

// 10. cancel_order
server.tool(
  "cancel_order",
  "주문번호로 미체결 주문을 취소합니다",
  {
    original_order_no: z.string().describe("취소할 원주문번호"),
    stock_code: stockCodeSchema,
    quantity: z.number().int().positive().describe("취소 수량"),
    account_no: accountNoSchema,
  },
  { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  async ({ original_order_no, stock_code, quantity, account_no }) => {
    try {
      const acct = resolveAccountNo(account_no);
      const data = await client.cancelOrder(
        acct,
        original_order_no,
        stock_code,
        quantity
      );

      const cancelNo = data.output?.ord_no ?? data.ord_no ?? "N/A";

      let text = `## 주문 취소 완료\n\n`;
      text += `- 취소 주문번호: ${cancelNo}\n`;
      text += `- 원주문번호: ${original_order_no}\n`;
      text += `- 종목코드: ${stock_code}\n`;
      text += `- 취소수량: ${quantity}주\n`;

      return textContent(text);
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// ─── 서버 시작 ──────────────────────────────────────────────

const MCP_TRANSPORT = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
const MCP_PORT = Number(process.env.MCP_PORT ?? 3000);

async function main() {
  if (MCP_TRANSPORT === "http") {
    const app = express();
    app.use(express.json());

    app.post("/mcp", async (req, res) => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    app.get("/mcp", async (req, res) => {
      res.writeHead(405).end(JSON.stringify({ error: "Method Not Allowed. Use POST." }));
    });

    app.delete("/mcp", async (req, res) => {
      res.writeHead(405).end(JSON.stringify({ error: "Method Not Allowed." }));
    });

    app.listen(MCP_PORT, () => {
      console.log(`Kiwoom MCP server running on http://0.0.0.0:${MCP_PORT}/mcp`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : "서버 시작 실패";
  console.error(message);
  process.exit(1);
});
