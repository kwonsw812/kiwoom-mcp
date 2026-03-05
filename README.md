# kiwoom-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io/)

> Claude Desktop에서 자연어로 키움증권 계좌를 제어하는 MCP 서버

키움증권 REST API와 Claude Desktop을 MCP(Model Context Protocol)로 연결하여, 자연어로 주식 조회/매매를 할 수 있습니다.

```
사용자: "삼성전자 현재가 알려줘"
Claude: 삼성전자(005930) 현재가 72,300원, 전일대비 +1,200원(+1.69%)...

사용자: "10주 시장가 매수해줘"
Claude: 삼성전자 10주 시장가 매수 주문 완료 (주문번호: 12345)
```

## 사전 준비

1. [openapi.kiwoom.com](https://openapi.kiwoom.com) → 로그인 → API 사용신청
2. 계좌 등록 + **본인 서버 IP 등록** (필수)
3. App Key 다운로드
4. 모의투자 신청 (kiwoom.com → 모의/실전투자 → 상시모의투자)

## 설치 방법

### 방법 1: 로컬 설치 (stdio)

```bash
git clone https://github.com/YOUR_USERNAME/kiwoom-mcp.git
cd kiwoom-mcp
npm install
npm run build
```

#### Claude Desktop 설정

설정 파일 위치:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "kiwoom": {
      "command": "node",
      "args": ["/절대경로/kiwoom-mcp/dist/index.js"],
      "env": {
        "KIWOOM_APP_KEY": "...",
        "KIWOOM_SECRET_KEY": "...",
        "KIWOOM_ACCOUNT_NO": "계좌번호10자리",
        "KIWOOM_IS_MOCK": "true"
      }
    }
  }
}
```

> 빌드 없이 개발 중 실행하려면:
> ```json
> "command": "npx", "args": ["tsx", "/경로/kiwoom-mcp/src/index.ts"]
> ```

### 방법 2: Docker 원격 배포 (HTTP)

키움 API는 등록된 IP에서만 호출 가능하므로, IP가 등록된 서버에 Docker로 배포하고 원격으로 연결할 수 있습니다.

#### 1. 서버에 `.env` 파일 생성

```env
KIWOOM_APP_KEY=발급받은_앱키
KIWOOM_SECRET_KEY=발급받은_시크릿키
KIWOOM_ACCOUNT_NO=계좌번호10자리
KIWOOM_IS_MOCK=true
MCP_TRANSPORT=http
MCP_PORT=3000
```

#### 2. Docker Compose로 실행

```bash
git clone https://github.com/YOUR_USERNAME/kiwoom-mcp.git
cd kiwoom-mcp
# .env 파일을 위에서 생성한 내용으로 작성
docker compose up -d --build
```

#### 3. Claude Desktop에서 원격 연결

```json
{
  "mcpServers": {
    "kiwoom": {
      "url": "http://서버IP:3000/mcp"
    }
  }
}
```

## 환경변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `KIWOOM_APP_KEY` | O | 키움 OpenAPI 앱 키 |
| `KIWOOM_SECRET_KEY` | O | 키움 OpenAPI 시크릿 키 |
| `KIWOOM_ACCOUNT_NO` | O | 계좌번호 (10자리) |
| `KIWOOM_IS_MOCK` | O | 모의투자 여부 (`true` / `false`) |
| `MCP_TRANSPORT` | X | 전송 방식 (`stdio` 또는 `http`, 기본값: `stdio`) |
| `MCP_PORT` | X | HTTP 모드 포트 (기본값: `3000`) |

## 제공 도구 (12개)

### 잔고/포트폴리오
| Tool | 설명 |
|------|------|
| `get_account_balance` | 보유 주식 목록, 평가금액, 수익률 |
| `get_portfolio_summary` | 종목별 비중/손익 분석 |
| `get_deposit_detail` | 예수금, 출금/주문 가능금액 |

### 시세 조회
| Tool | 설명 |
|------|------|
| `get_stock_price` | 현재가, 등락률, 거래량, PER/PBR |
| `get_stock_chart` | 일봉 OHLCV 차트 (기간 지정) |
| `search_stock_code` | 종목명 → 종목코드 검색 |

### 주문
| Tool | 설명 |
|------|------|
| `place_buy_order` | 시장가/지정가 매수 |
| `place_sell_order` | 시장가/지정가 매도 |
| `get_unfilled_orders` | 미체결 주문 목록 |
| `cancel_order` | 주문 취소 |

### 거래내역 분석
| Tool | 설명 |
|------|------|
| `get_trade_history` | 기간별 체결내역 |
| `analyze_profit_loss` | 종목별 실현손익, 승률 분석 |

## 사용 예시

```
"오늘 내 포트폴리오 현황 분석해줘"
"HD현대일렉트릭 현재가 알려주고 10주 매수해줘"
"이번달 거래 손익 분석해줘"
"미체결 주문 전부 취소해줘"
```

## 주의사항

- **반드시 모의투자(`KIWOOM_IS_MOCK=true`)에서 충분히 테스트한 후 실전 전환하세요**
- API 키를 공개 저장소에 절대 업로드하지 마세요
- 키움 REST API는 허용된 IP에서만 동작합니다
- 본 프로젝트는 키움증권 공식 프로젝트가 아닙니다
- **투자 손실에 대한 책임은 사용자 본인에게 있습니다**

## 라이선스

[MIT](./LICENSE) - 투자 손실에 대한 책임은 지지 않습니다.
