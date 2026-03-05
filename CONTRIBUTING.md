# Contributing to kiwoom-mcp

기여해주셔서 감사합니다! 아래 가이드를 참고해주세요.

## 개발 환경 설정

```bash
git clone https://github.com/YOUR_USERNAME/kiwoom-mcp.git
cd kiwoom-mcp
npm install
cp .env.example .env
# .env 파일에 모의투자 키 입력
```

## 개발

```bash
npm run dev     # tsx로 바로 실행 (빌드 불필요)
npm run build   # TypeScript 컴파일
npm start       # 빌드된 파일 실행
```

## Pull Request 가이드

1. Fork 후 feature 브랜치를 생성하세요
2. 변경사항을 커밋하세요
3. `npm run build`가 에러 없이 통과하는지 확인하세요
4. Pull Request를 생성하세요

## 코드 스타일

- TypeScript strict 모드
- ESM (`import`/`export`)
- 에러 처리: try/catch로 감싸서 `isError: true` 반환

## 주의사항

- `.env` 파일이나 API 키를 커밋하지 마세요
- 주문 관련 tool은 반드시 모의투자에서 테스트하세요
- 키움 REST API 응답 필드명이 변경될 수 있으므로 fallback 처리를 권장합니다
