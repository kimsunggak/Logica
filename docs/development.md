# 개발 가이드

소스에서 LOGICA를 빌드하고 개발하는 방법입니다. 앱 사용법은 [README](../README.md)를 보세요.

## 준비물

- Node.js 20 이상
- Rust stable (1.80 이상)
- Tauri 2 시스템 의존성: <https://v2.tauri.app/start/prerequisites/>
  - Linux(Ubuntu/Debian): `libwebkit2gtk-4.1-dev build-essential libssl-dev libayatana-appindicator3-dev librsvg2-dev`
- TeX 배포판은 필요 없습니다. LOGICA에는 TeX 엔진 [Tectonic](https://tectonic-typesetting.github.io/)이 내장되어 있습니다. TeX Live, MacTeX, MiKTeX가 설치되어 있으면 그쪽을 먼저 씁니다(패키지 호환성이 가장 좋음).
  - `npm run tauri:dev` / `npm run tauri build`가 시작될 때 `scripts/fetch-tectonic.mjs`가 해당 플랫폼의 공식 Tectonic 릴리스를 내려받아 고정된 SHA-256과 대조한 뒤 `src-tauri/binaries/`에 둡니다. `cargo`를 직접 실행할 때는 먼저 `npm run tectonic`을 실행하세요.
  - 내장 엔진은 처음 컴파일할 때 필요한 LaTeX 패키지를 인터넷에서 내려받고, 이후에는 캐시를 씁니다.
- Linux에서 API key 저장: Secret Service 구현(GNOME Keyring 또는 KWallet)이 실행 중이어야 합니다.

## 실행

```bash
npm install
npm run tauri:dev        # 개발 모드 데스크톱 앱 (LOGICA Dev)
npm run tauri build      # 배포용 빌드 (src-tauri/target/release/bundle)
```

`examples/sample-paper/`에 바로 열어볼 수 있는 예제 논문이 있습니다.

### 개발 앱과 배포 앱 구분

`npm run tauri:dev`는 `src-tauri/tauri.dev.conf.json`을 덧씌워 **LOGICA Dev**로 실행합니다. 창 제목은 `LOGICA (Dev)`, 아이콘에는 주황색 DEV 표시(`src-tauri/icons-dev/`)가 붙고, 앱 ID가 `app.logica.desktop.dev`라서 채팅 기록·논문 요약·설정·최근 작업이 배포 앱(`app.logica.desktop`)과 따로 저장됩니다. API key와 ChatGPT 로그인은 두 앱이 함께 씁니다. 배포 빌드(`npm run tauri build`)에는 영향이 없습니다.

데이터 폴더도 [README의 저장 위치](../README.md#데이터와-개인정보)에서 `app.logica.desktop` 대신 `app.logica.desktop.dev`를 씁니다.

### 브라우저 미리보기 모드

`npm run dev` 후 브라우저에서 `http://localhost:1420`을 열면 메모리 내 가짜 backend로 UI 전체 흐름을 확인할 수 있습니다. 파일, 컴파일, AI 응답이 모두 시뮬레이션되며(AI 응답도 실제 OpenAI/Claude streaming 형식으로 흉내 내므로 provider adapter 코드가 그대로 실행됩니다) 이 코드는 배포 빌드에 포함되지 않습니다. `npm run tauri:dev` 중에는 같은 주소가 [런타임 디버거](#런타임-디버거)로 넘어갑니다.

## 테스트

```bash
npm test                         # 프런트엔드 단위 테스트 (vitest)
npm run typecheck
cd src-tauri && cargo test       # backend 테스트 (latexmk가 있으면 실제 컴파일 포함)
cd src-tauri && cargo test -- --ignored   # 실제 Anthropic API에 잘못된 key로 요청해 오류 처리와 redaction 확인
```

Sign in with ChatGPT 전체 흐름(PKCE, callback, token 교환, refresh 회전)은 `cargo test`에서 로컬 mock OAuth 서버로 검증합니다.

## 런타임 디버거

`npm run tauri:dev`로 앱을 띄운 뒤 브라우저에서 `http://localhost:1420`을 열면 런타임 디버거(`http://127.0.0.1:1430`, 터미널에도 `LOGICA debug visualizer`로 출력)로 넘어갑니다. 앱은 Tauri 창에서 그대로 실행되고, 앱 빌드가 끝나기 전에 열면 디버거가 뜰 때까지 기다렸다가 넘어갑니다. 디버거에서는 User Input → Request Refinement → Paper Orchestra → Section Selection → Paper Chat/Edit 실행과 원문 적용 tool을 추적합니다. Architecture는 실제 호출과 건너뛴 모듈, Flow Chart는 UI 모드·섹션 해시·수정안 적용·세션 요약의 조건 분기를 표시합니다. 각 노드의 Inspector에서 함수 호출, 입력·출력, 모델 프롬프트, 수정 tool 인자와 실제 적용 결과를 볼 수 있습니다. Paper Summary Module과 Session Summary Module은 각자의 조건에 따라 별도로 표시되며, 상단 버튼으로 현재 프로젝트의 논문 요약 YAML과 세션 요약 JSON을 확인할 수 있습니다. LLM Gateway는 호출 모델, 오류와 fallback을 표시하고 동일 이벤트를 터미널에도 기록합니다.

- 이벤트는 웹뷰(`src/debug/trace.ts`)와 Rust(`src-tauri/src/ai.rs`)의 실제 실행에서 만들어지고, `src-tauri/src/debug_trace.rs`가 Server-Sent Events로 페이지에 보냅니다.
- 중앙의 `Architecture`와 `Flow Chart` 버튼으로 모듈 구조·실행 상태와 조건별 처리 흐름을 전환합니다. Flow Chart는 최초 요약의 해시 일치 여부, 응답 경로, 답변 후 변경 섹션 재요약과 세션 요약 조건을 마름모와 Yes/No로 표시합니다. 모듈을 클릭하면 선택한 실행의 Inspector가 열리고, 저장 파일 노드를 클릭하면 해당 요약 파일 조회 창이 열립니다.
- 패널 사이 경계선을 드래그하거나 방향키로 크기를 조절합니다. 창 너비가 1100px 이하이면 Data Inspector가 하단으로 이동하고 위쪽 경계로 높이를 조절할 수 있습니다. 경계선을 더블클릭하면 해당 패널 크기가 기본값으로 돌아갑니다.
- `논문 요약 파일` 버튼은 현재 열린 프로젝트의 `paper-summary.yaml` 저장 경로와 실제 YAML 내용을 보여 줍니다. 파일이 없으면 `none`으로 표시하고, 창을 열어 두면 1초마다 다시 읽어 최초 저장과 이후 갱신을 확인할 수 있습니다. 이 버튼은 요약을 실행하거나 파일을 만들지 않습니다.
- `세션 요약 파일` 버튼은 앱에서 현재 선택한 대화의 세션 JSON 저장 경로와 `summary`를 보여 줍니다. `요약만`과 대화 원문을 포함한 `전체 파일` 보기를 전환할 수 있고, 파일이 아직 없는 상태와 파일은 있지만 요약이 없는 상태를 구분합니다. 창이 열려 있는 동안 1초마다 다시 읽으며, 새 대화·이전 대화 선택·프로젝트 변경도 따라갑니다. 조회만 하므로 대화를 저장하거나 요약을 생성하지 않습니다.
- 그래프는 중앙 영역 높이의 75%로 시작하고, 초기 배율은 Architecture 100%, Flow Chart 80%입니다. 드래그로 이동하고 휠이나 `+`/`-`로 확대·축소하며, `맞춤` 또는 `0`으로 전체 그래프를 볼 수 있습니다. 두 보기의 배율·위치는 각각 저장되며, 패널 크기와 선택한 보기도 새로고침 후 유지됩니다. `레이아웃 초기화`로 크기와 두 보기의 배율을 기본 상태로 복원합니다.
- 키, 토큰, `Bearer` 값은 이벤트를 만드는 단계와 backend에서 두 번 가립니다. 서버는 `127.0.0.1`에만 열리고 다른 Host 이름의 요청은 거부합니다.
- 디버그 빌드에서만 동작합니다. 배포 빌드는 서버를 열지 않고 이벤트도 보내지 않습니다. 포트는 `LOGICA_DEBUG_PORT`로 바꿀 수 있습니다.

## 배포 빌드

`npm run tauri build`는 빌드한 OS용 설치 파일만 `src-tauri/target/release/bundle/` 아래에 만듭니다. 릴리스에는 사용자가 바로 설치하는 파일을 올립니다.

| OS | 폴더 | 릴리스에 올릴 파일 |
| --- | --- | --- |
| Windows | `nsis/`, `msi/` | `*_x64-setup.exe` (`.msi`는 선택) |
| macOS | `dmg/` | `*.dmg` (`macos/`의 `.app`은 dmg 안에 들어 있음) |
| Linux | `appimage/`, `deb/`, `rpm/` | `*.AppImage`, `*.deb` (`.rpm`은 선택) |

`target/release/`의 실행 파일만 따로 올리면 내장 TeX 엔진과 라이선스 파일이 빠져 제대로 동작하지 않습니다. 설치 파일에는 코드 서명이 없습니다.
