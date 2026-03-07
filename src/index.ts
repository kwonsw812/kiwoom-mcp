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

function today(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
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
      if (error instanceof AxiosError && error.response?.status === 401) {
        this.tokenManager.invalidate();
        return await doRequest();
      }
      throw error;
    }
  }

  // 계좌수익률요청 (ka10085) - 보유종목 목록
  // URL: /api/dostk/acnt | 필수: stex_tp
  async getAccountBalance(accountNo: string) {
    return this.request("/api/dostk/acnt", "ka10085", {
      acc_no: accountNo,
      stex_tp: "0",
    });
  }

  // 계좌평가잔고내역요청 (kt00018) - 평가손익 포함 잔고
  // URL: /api/dostk/acnt | 필수: qry_tp, dmst_stex_tp
  async getAccountEvaluation(accountNo: string) {
    return this.request("/api/dostk/acnt", "kt00018", {
      acc_no: accountNo,
      qry_tp: "1",
      dmst_stex_tp: "KRX",
    });
  }

  // 예수금상세현황요청 (kt00001)
  // URL: /api/dostk/acnt | 필수: qry_tp (2:일반조회, 3:추정조회)
  async getDeposit(accountNo: string) {
    return this.request("/api/dostk/acnt", "kt00001", {
      acc_no: accountNo,
      qry_tp: "2",
    });
  }

  // 주식기본정보요청 (ka10001)
  // URL: /api/dostk/stkinfo | 필수: stk_cd
  async getStockPrice(stockCode: string) {
    return this.request("/api/dostk/stkinfo", "ka10001", {
      stk_cd: stockCode,
    });
  }

  // 주식일봉차트조회요청 (ka10081)
  // URL: /api/dostk/chart | 필수: stk_cd, base_dt, upd_stkpc_tp
  async getStockChart(stockCode: string, baseDate: string) {
    return this.request("/api/dostk/chart", "ka10081", {
      stk_cd: stockCode,
      base_dt: baseDate,
      upd_stkpc_tp: "1",
    });
  }

  // 종목정보 리스트 (ka10099) - 시장별 전체 종목 리스트
  // URL: /api/dostk/stkinfo | 필수: mrkt_tp (0:코스피, 10:코스닥)
  async getStockList(marketType: string) {
    return this.request("/api/dostk/stkinfo", "ka10099", {
      mrkt_tp: marketType,
    });
  }

  // 종목정보 조회 (ka10100) - 종목코드로 종목 상세 조회
  // URL: /api/dostk/stkinfo | 필수: stk_cd
  async getStockInfo(stockCode: string) {
    return this.request("/api/dostk/stkinfo", "ka10100", {
      stk_cd: stockCode,
    });
  }

  // 미체결요청 (ka10075)
  // URL: /api/dostk/acnt | 필수: all_stk_tp, trde_tp, stex_tp
  async getUnfilledOrders(accountNo: string) {
    return this.request("/api/dostk/acnt", "ka10075", {
      acc_no: accountNo,
      all_stk_tp: "0",
      trde_tp: "0",
      stex_tp: "0",
    });
  }

  // 당일매매일지요청 (ka10170) - 당일 매매 내역
  // URL: /api/dostk/acnt | 필수: ottks_tp, ch_crd_tp | 선택: base_dt
  async getTradeHistory(accountNo: string, baseDate?: string) {
    return this.request("/api/dostk/acnt", "ka10170", {
      acc_no: accountNo,
      base_dt: baseDate ?? today(),
      ottks_tp: "2",
      ch_crd_tp: "0",
    });
  }

  // 주식 매수주문 (kt10000)
  // URL: /api/dostk/ordr | 필수: dmst_stex_tp, stk_cd, ord_qty, trde_tp
  // trde_tp: 0:보통(지정가), 3:시장가
  async placeBuyOrder(accountNo: string, stockCode: string, quantity: number, price: number, orderType: string) {
    const trde_tp = orderType === "market" ? "3" : "0";
    const body: Record<string, unknown> = {
      acc_no: accountNo,
      dmst_stex_tp: "KRX",
      stk_cd: stockCode,
      ord_qty: String(quantity),
      trde_tp,
    };
    if (orderType === "limit") {
      body.ord_uv = String(price);
    }
    return this.request("/api/dostk/ordr", "kt10000", body);
  }

  // 주식 매도주문 (kt10001)
  // URL: /api/dostk/ordr | 필수: dmst_stex_tp, stk_cd, ord_qty, trde_tp
  async placeSellOrder(accountNo: string, stockCode: string, quantity: number, price: number, orderType: string) {
    const trde_tp = orderType === "market" ? "3" : "0";
    const body: Record<string, unknown> = {
      acc_no: accountNo,
      dmst_stex_tp: "KRX",
      stk_cd: stockCode,
      ord_qty: String(quantity),
      trde_tp,
    };
    if (orderType === "limit") {
      body.ord_uv = String(price);
    }
    return this.request("/api/dostk/ordr", "kt10001", body);
  }

  // 주식 취소주문 (kt10003)
  // URL: /api/dostk/ordr | 필수: dmst_stex_tp, orig_ord_no, stk_cd, cncl_qty
  async cancelOrder(accountNo: string, origOrdNo: string, stockCode: string, quantity: number) {
    return this.request("/api/dostk/ordr", "kt10003", {
      acc_no: accountNo,
      dmst_stex_tp: "KRX",
      orig_ord_no: origOrdNo,
      stk_cd: stockCode,
      cncl_qty: String(quantity),
    });
  }
}

// ─── 포맷팅 헬퍼 ────────────────────────────────────────────

function formatCurrency(value: number | string | unknown): string {
  const str = String(value).replace(/[+]/g, "");
  const num = Number(str);
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

// ─── 포맷팅 함수 ────────────────────────────────────────────

// ka10085 응답: acnt_prft_rt 배열
// 필드: stk_cd, stk_nm, cur_prc, pur_pric, pur_amt, rmnd_qty, tdy_sel_pl
function formatBalance(data: Record<string, unknown>): string {
  const items = data.acnt_prft_rt as Record<string, unknown>[] | undefined;

  let result = "## 계좌 잔고 (보유종목)\n\n";

  if (!items || items.length === 0) {
    return result + "보유 종목이 없습니다.\n";
  }

  result += "| 종목명 | 종목코드 | 보유수량 | 현재가 | 매입가 | 매입금액 | 당일매도손익 |\n";
  result += "|--------|---------|---------|--------|--------|---------|-------------|\n";
  for (const item of items) {
    const name = item.stk_nm ?? "-";
    const code = item.stk_cd ?? "-";
    const qty = item.rmnd_qty ?? "-";
    const curPrc = item.cur_prc ?? "-";
    const purPric = item.pur_pric ?? "-";
    const purAmt = item.pur_amt ?? "-";
    const selPl = item.tdy_sel_pl ?? "0";
    result += `| ${name} | ${code} | ${qty} | ${formatCurrency(curPrc)} | ${formatCurrency(purPric)} | ${formatCurrency(purAmt)} | ${formatCurrency(selPl)} |\n`;
  }

  return result;
}

// kt00018 응답: tot_pur_amt, tot_evlt_amt, tot_evlt_pl, tot_prft_rt + acnt_evlt_remn_indv_tot 배열
// 필드: stk_cd, stk_nm, cur_prc, pur_pric, rmnd_qty, evltv_prft, prft_rt
function formatPortfolioSummary(data: Record<string, unknown>): string {
  const items = data.acnt_evlt_remn_indv_tot as Record<string, unknown>[] | undefined;

  let result = "## 포트폴리오 분석\n\n";

  result += `- 총매입금액: ${formatCurrency(data.tot_pur_amt ?? "-")}\n`;
  result += `- 총평가금액: ${formatCurrency(data.tot_evlt_amt ?? "-")}\n`;
  result += `- 총평가손익: ${formatCurrency(data.tot_evlt_pl ?? "-")}\n`;
  result += `- 총수익률: ${data.tot_prft_rt ?? "-"}%\n`;
  result += `- 추정예탁자산: ${formatCurrency(data.prsm_dpst_aset_amt ?? "-")}\n\n`;

  if (!items || items.length === 0) {
    return result + "보유 종목이 없습니다.\n";
  }

  result += "| 종목명 | 종목코드 | 보유수량 | 현재가 | 매입가 | 평가손익 | 수익률 |\n";
  result += "|--------|---------|---------|--------|--------|---------|--------|\n";
  for (const item of items) {
    const name = item.stk_nm ?? "-";
    const code = item.stk_cd ?? "-";
    const qty = item.rmnd_qty ?? "-";
    const curPrc = item.cur_prc ?? "-";
    const purPric = item.pur_pric ?? "-";
    const evltvPrft = item.evltv_prft ?? "-";
    const prftRt = item.prft_rt ?? "-";
    result += `| ${name} | ${code} | ${qty} | ${formatCurrency(curPrc)} | ${formatCurrency(purPric)} | ${formatCurrency(evltvPrft)} | ${prftRt}% |\n`;
  }

  return result;
}

// kt00001 응답: entr(예수금), profa_ch(주식증거금현금) 등
function formatDeposit(data: Record<string, unknown>): string {
  let result = "## 예수금 상세\n\n";
  result += `- 예수금: ${formatCurrency(data.entr ?? "-")}\n`;
  result += `- 주식증거금(현금): ${formatCurrency(data.profa_ch ?? "-")}\n`;
  result += `- 신용보증금(현금): ${formatCurrency(data.crd_grnta_ch ?? "-")}\n`;
  result += `- 미수확보금: ${formatCurrency(data.uncl_stk_amt ?? "-")}\n`;
  return result;
}

// ka10001 응답: 최상위 필드로 바로 옴
// 필드: stk_nm, cur_prc, pred_pre, open_pric, high_pric, low_pric, 250hgst, 250lwst, per, pbr, eps
function formatStockPrice(data: Record<string, unknown>): string {
  const name = data.stk_nm ?? "-";
  const code = data.stk_cd ?? "-";
  const price = data.cur_prc ?? "-";
  const change = data.pred_pre ?? "-";
  const open = data.open_pric ?? "-";
  const high = data.high_pric ?? "-";
  const low = data.low_pric ?? "-";
  const high250 = data["250hgst"] ?? data.oyr_hgst ?? "-";
  const low250 = data["250lwst"] ?? data.oyr_lwst ?? "-";
  const per = data.per ?? "-";
  const pbr = data.pbr ?? "-";
  const eps = data.eps ?? "-";

  let result = `## ${name} (${code}) 현재가 정보\n\n`;
  result += `- 현재가: ${formatCurrency(price)}\n`;
  result += `- 전일대비: ${formatCurrency(change)}\n`;
  result += `- 시가: ${formatCurrency(open)} / 고가: ${formatCurrency(high)} / 저가: ${formatCurrency(low)}\n`;
  result += `- 250일 최고: ${formatCurrency(high250)} / 최저: ${formatCurrency(low250)}\n`;
  result += `- PER: ${per} / PBR: ${pbr} / EPS: ${eps}\n`;

  return result;
}

// ka10081 응답: stk_dt_pole_chart_qry 배열
// 필드: dt, cur_prc(종가), open_pric, high_pric, low_pric, trde_qty, pred_pre
function formatChartData(data: Record<string, unknown>): string {
  const items = data.stk_dt_pole_chart_qry as Record<string, unknown>[] | undefined;

  let result = "## 일봉 차트 데이터\n\n";

  if (!items || items.length === 0) {
    return result + "데이터가 없습니다.\n";
  }

  result += "| 날짜 | 시가 | 고가 | 저가 | 종가 | 거래량 |\n";
  result += "|------|------|------|------|------|--------|\n";

  for (const item of items) {
    const dt = item.dt ?? "-";
    const open = item.open_pric ?? "-";
    const high = item.high_pric ?? "-";
    const low = item.low_pric ?? "-";
    const close = item.cur_prc ?? "-";
    const vol = item.trde_qty ?? "-";
    result += `| ${dt} | ${formatCurrency(open)} | ${formatCurrency(high)} | ${formatCurrency(low)} | ${formatCurrency(close)} | ${formatVolume(vol)} |\n`;
  }

  return result;
}

// ka10075 응답: oso 배열
// 필드: ord_no, stk_nm, stk_cd, ord_qty, ord_pric, tsk_tp(업무구분), ord_stt(주문상태)
function formatUnfilledOrders(data: Record<string, unknown>): string {
  const items = data.oso as Record<string, unknown>[] | undefined;

  let result = "## 미체결 주문 목록\n\n";

  if (!items || items.length === 0) {
    return result + "미체결 주문이 없습니다.\n";
  }

  result += "| 주문번호 | 종목명 | 종목코드 | 주문수량 | 주문가격 | 주문상태 |\n";
  result += "|---------|--------|---------|---------|---------|--------|\n";
  for (const item of items) {
    const ordNo = item.ord_no ?? "-";
    const name = item.stk_nm ?? "-";
    const code = item.stk_cd ?? "-";
    const qty = item.ord_qty ?? "-";
    const prc = item.ord_pric ?? "-";
    const stt = item.ord_stt ?? "-";
    result += `| ${ordNo} | ${name} | ${code} | ${qty} | ${formatCurrency(prc)} | ${stt} |\n`;
  }

  return result;
}

// ka10170 응답: tot_sell_amt, tot_buy_amt, tot_pl_amt, tot_prft_rt + tdy_trde_diary 배열
// 필드: stk_nm, buy_avg_pric, buy_qty, sel_avg_pric, sell_qty, pl_amt, prft_rt
function formatTradeHistory(data: Record<string, unknown>): string {
  let result = "## 당일 매매일지\n\n";

  result += `- 총매도금액: ${formatCurrency(data.tot_sell_amt ?? "-")}\n`;
  result += `- 총매수금액: ${formatCurrency(data.tot_buy_amt ?? "-")}\n`;
  result += `- 총손익금액: ${formatCurrency(data.tot_pl_amt ?? "-")}\n`;
  result += `- 총수익률: ${data.tot_prft_rt ?? "-"}%\n\n`;

  const items = data.tdy_trde_diary as Record<string, unknown>[] | undefined;

  if (!items || items.length === 0 || !items[0].stk_nm) {
    return result + "당일 매매 내역이 없습니다.\n";
  }

  result += "| 종목명 | 매수평균가 | 매수수량 | 매도평균가 | 매도수량 | 손익금액 | 수익률 |\n";
  result += "|--------|---------|---------|---------|---------|---------|--------|\n";
  for (const item of items) {
    if (!item.stk_nm) continue;
    const name = item.stk_nm ?? "-";
    const buyAvg = item.buy_avg_pric ?? "-";
    const buyQty = item.buy_qty ?? "-";
    const selAvg = item.sel_avg_pric ?? "-";
    const selQty = item.sell_qty ?? "-";
    const plAmt = item.pl_amt ?? "-";
    const prftRt = item.prft_rt ?? "-";
    result += `| ${name} | ${formatCurrency(buyAvg)} | ${buyQty} | ${formatCurrency(selAvg)} | ${selQty} | ${formatCurrency(plAmt)} | ${prftRt}% |\n`;
  }

  return result;
}

function formatError(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status ?? "N/A";
    const data = error.response?.data;
    const msg = data?.return_msg ?? data?.message ?? error.message;
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

// ─── 조회 Tools ─────────────────────────────────────────────

// 1. get_account_balance - 보유종목 + 현재가/매입가 (ka10085)
server.tool(
  "get_account_balance",
  "보유 주식 목록, 현재가, 매입가, 매입금액 등 계좌 잔고를 조회합니다",
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

// 2. get_portfolio_summary - 평가손익 포함 포트폴리오 (kt00018)
server.tool(
  "get_portfolio_summary",
  "총평가금액, 총손익, 수익률 등 포트폴리오 전체 현황을 분석합니다",
  { account_no: accountNoSchema },
  { readOnlyHint: true },
  async ({ account_no }) => {
    try {
      const acct = resolveAccountNo(account_no);
      const data = await client.getAccountEvaluation(acct);
      return textContent(formatPortfolioSummary(data));
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// 3. get_deposit_detail - 예수금 상세 (kt00001)
server.tool(
  "get_deposit_detail",
  "예수금, 증거금, 미수확보금 등 예수금 상세를 조회합니다",
  { account_no: accountNoSchema },
  { readOnlyHint: true },
  async ({ account_no }) => {
    try {
      const acct = resolveAccountNo(account_no);
      const data = await client.getDeposit(acct);
      return textContent(formatDeposit(data));
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// 4. get_stock_price - 주식 현재가 (ka10001)
server.tool(
  "get_stock_price",
  "종목의 현재가, 전일대비, 시가/고가/저가, 250일 고저, PER/PBR/EPS를 조회합니다",
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

// 5. get_stock_chart - 일봉 차트 (ka10081)
server.tool(
  "get_stock_chart",
  "기준일자 기준 일봉 OHLCV 차트 데이터를 조회합니다 (최근 데이터부터 내림차순)",
  {
    stock_code: stockCodeSchema,
    base_date: dateSchema("기준일자 (이 날짜 이전 데이터 조회)").optional(),
  },
  { readOnlyHint: true },
  async ({ stock_code, base_date }) => {
    try {
      const data = await client.getStockChart(stock_code, base_date ?? today());
      return textContent(formatChartData(data));
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// 6. search_stock - 종목코드로 종목 정보 조회 (ka10100)
server.tool(
  "search_stock",
  "종목코드로 종목명, 시장구분, 업종, 상장일 등 종목 기본 정보를 조회합니다",
  { stock_code: stockCodeSchema },
  { readOnlyHint: true },
  async ({ stock_code }) => {
    try {
      const data = await client.getStockInfo(stock_code);
      let text = `## 종목 정보\n\n`;
      text += `- 종목코드: ${data.code ?? stock_code}\n`;
      text += `- 종목명: ${data.name ?? "-"}\n`;
      text += `- 시장: ${data.marketName ?? "-"} (${data.marketCode ?? "-"})\n`;
      text += `- 업종: ${data.upName ?? "-"}\n`;
      text += `- 상장일: ${data.regDay ?? "-"}\n`;
      text += `- 전일종가: ${formatCurrency(data.lastPrice ?? "-")}\n`;
      text += `- 상장주식수: ${Number(data.listCount ?? 0).toLocaleString("ko-KR")}주\n`;
      text += `- 종목상태: ${data.state ?? "-"}\n`;
      return textContent(text);
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// 7. get_unfilled_orders - 미체결 주문 (ka10075)
server.tool(
  "get_unfilled_orders",
  "미체결 주문 목록을 조회합니다",
  { account_no: accountNoSchema },
  { readOnlyHint: true },
  async ({ account_no }) => {
    try {
      const acct = resolveAccountNo(account_no);
      const data = await client.getUnfilledOrders(acct);
      return textContent(formatUnfilledOrders(data));
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// 8. get_trade_history - 당일 매매일지 (ka10170)
server.tool(
  "get_trade_history",
  "당일 또는 특정 날짜의 매매일지(매수/매도 내역, 손익)를 조회합니다 (최근 2개월까지)",
  {
    base_date: dateSchema("조회일자 (미입력시 오늘)").optional(),
    account_no: accountNoSchema,
  },
  { readOnlyHint: true },
  async ({ base_date, account_no }) => {
    try {
      const acct = resolveAccountNo(account_no);
      const data = await client.getTradeHistory(acct, base_date);
      return textContent(formatTradeHistory(data));
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// ─── 주문 Tools ──────────────────────────────────────────────

// 9. place_buy_order - 매수주문 (kt10000)
// trde_tp: 0:보통(지정가), 3:시장가
server.tool(
  "place_buy_order",
  "주식 매수 주문을 실행합니다. 시장가 또는 지정가 매수를 지원합니다",
  {
    stock_code: stockCodeSchema,
    quantity: z.number().int().positive().describe("주문 수량"),
    price: z.number().int().min(0).default(0).describe("주문 가격 (시장가일 경우 0)"),
    order_type: z.enum(["market", "limit"]).default("market").describe("주문유형: market(시장가) 또는 limit(지정가)"),
    account_no: accountNoSchema,
  },
  { readOnlyHint: false, idempotentHint: false },
  async ({ stock_code, quantity, price, order_type, account_no }) => {
    try {
      const acct = resolveAccountNo(account_no);
      if (order_type === "limit" && price <= 0) {
        return errorContent("지정가 주문 시 가격을 0보다 큰 값으로 입력해주세요.");
      }
      const data = await client.placeBuyOrder(acct, stock_code, quantity, price, order_type);
      const orderNo = data.ord_no ?? "N/A";
      const typeLabel = order_type === "market" ? "시장가" : `지정가 ${formatCurrency(price)}`;
      let text = `## 매수 주문 완료\n\n`;
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

// 10. place_sell_order - 매도주문 (kt10001)
server.tool(
  "place_sell_order",
  "주식 매도 주문을 실행합니다. 시장가 또는 지정가 매도를 지원합니다",
  {
    stock_code: stockCodeSchema,
    quantity: z.number().int().positive().describe("주문 수량"),
    price: z.number().int().min(0).default(0).describe("주문 가격 (시장가일 경우 0)"),
    order_type: z.enum(["market", "limit"]).default("market").describe("주문유형: market(시장가) 또는 limit(지정가)"),
    account_no: accountNoSchema,
  },
  { readOnlyHint: false, idempotentHint: false },
  async ({ stock_code, quantity, price, order_type, account_no }) => {
    try {
      const acct = resolveAccountNo(account_no);
      if (order_type === "limit" && price <= 0) {
        return errorContent("지정가 주문 시 가격을 0보다 큰 값으로 입력해주세요.");
      }
      const data = await client.placeSellOrder(acct, stock_code, quantity, price, order_type);
      const orderNo = data.ord_no ?? "N/A";
      const typeLabel = order_type === "market" ? "시장가" : `지정가 ${formatCurrency(price)}`;
      let text = `## 매도 주문 완료\n\n`;
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

// 11. cancel_order - 취소주문 (kt10003)
// cncl_qty: '0' 입력시 잔량 전부 취소
server.tool(
  "cancel_order",
  "원주문번호로 미체결 주문을 취소합니다. 수량을 0으로 입력하면 잔량 전부 취소",
  {
    original_order_no: z.string().describe("취소할 원주문번호"),
    stock_code: stockCodeSchema,
    quantity: z.number().int().min(0).describe("취소 수량 (0 입력시 잔량 전부 취소)"),
    account_no: accountNoSchema,
  },
  { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  async ({ original_order_no, stock_code, quantity, account_no }) => {
    try {
      const acct = resolveAccountNo(account_no);
      const data = await client.cancelOrder(acct, original_order_no, stock_code, quantity);
      let text = `## 주문 취소 완료\n\n`;
      text += `- 취소 주문번호: ${data.ord_no ?? "N/A"}\n`;
      text += `- 원주문번호: ${original_order_no}\n`;
      text += `- 종목코드: ${stock_code}\n`;
      text += `- 취소수량: ${data.cncl_qty ?? quantity}주\n`;
      return textContent(text);
    } catch (error) {
      return errorContent(formatError(error));
    }
  }
);

// ─── 서버 시작 ──────────────────────────────────────────────

const MCP_TRANSPORT = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
const MCP_PORT = Number(process.env.MCP_PORT ?? 3000);
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";

async function main() {
  if (MCP_TRANSPORT === "http") {
    if (!MCP_AUTH_TOKEN) {
      console.error("HTTP 모드에서는 MCP_AUTH_TOKEN 환경변수가 필수입니다.");
      process.exit(1);
    }

    const app = express();
    app.use(express.json());

    app.use("/mcp", (req, res, next) => {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${MCP_AUTH_TOKEN}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    });

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
