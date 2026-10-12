# Eng Shorts

재밌는 영어 쇼츠를 위아래로 끝없이 넘겨 보면서, 영어·한글 자막을 영상 아래에 띄워 주는 개인 학습용 안드로이드 앱이에요.

## 설치 (안드로이드)

1. 휴대폰에서 이 주소를 열어 APK를 받아요: **https://github.com/a107521-cpu/eng-shorts/releases/latest/download/EngShorts.apk**
2. 받은 `EngShorts.apk` 를 눌러 설치해요.
   - "출처를 알 수 없는 앱" 안내가 나오면 **설정 → 이 출처 허용**을 켜고 돌아와요.
   - Play 프로텍트 경고가 나오면 **세부정보 → 무시하고 설치**를 눌러요. (Play 스토어 밖에서 받은 앱이라 나오는 안내예요.)
3. 앱을 열면 바로 영상이 재생돼요.

새 버전이 나오면 같은 주소에서 다시 받아 설치하면 돼요. 저장한 문장은 그대로 남아요. 앱 안 ⚙ 설정 → **새 버전 받기**로도 갈 수 있어요.

## 쓰는 법

| 동작 | 하는 일 |
|---|---|
| 영상 위로 밀기 / 아래로 밀기 | 다음 영상 / 이전 영상 |
| 영상 한 번 누르기 | 멈춤 · 재생 |
| 자막의 단어 누르기 | 한국어 뜻 + 발음 듣기 |
| 아래 자막 목록에서 문장 누르기 | 그 문장부터 다시 재생 |
| 영상과 자막 사이 막대 끌기 | 영상 / 자막 크기 조절 |
| 뒤로가기 버튼 | 열린 창 닫기, 없으면 앱 나가기 |

자막 아래 도구 줄: **이전 줄 · 한 줄 반복 · 속도(1× / 0.75× / 0.5×) · 영어 가리기 · 한글 켜고 끄기 · 저장 · 다음 줄**

저장한 문장은 오른쪽 위 ☆ 버튼에 모여요. ▶를 누르면 그 장면부터 다시 볼 수 있어요.

⚙ 설정에서 볼 영상 종류(코미디, 길거리 인터뷰, 토크쇼, 리액션, 음식, 동물, 상식·과학, 스포츠)를 고르거나, 좋아하는 채널(@핸들 주소도 가능)을 직접 추가할 수 있어요. "문장마다 멈추기"를 켜면 한 문장이 끝날 때마다 멈추고, "자막 없는 영상 건너뛰기"는 영어 자막이 없는 영상을 자동으로 넘겨요.

## 영상과 자막은 어디서 오나요

- 영어로 말을 많이 하는 인기 채널 45개(Smosh, Jubilee, Jimmy Fallon, Max Fosh, Nick DiGiovanni 등)의 쇼츠를 YouTube 공식 플레이어로 섞어서 보여줘요. 볼수록 더 많은 채널에서 모으고, 본 영상은 다시 나오지 않아요.
- 영어 자막은 앱이 휴대폰에서 직접 YouTube에 요청해서 가져와요. 그게 막히면 YouTube 플레이어가 받아오는 자막 파일을 대신 써요.
- 한글 자막은 영어 자막을 Google 번역으로 옮긴 거예요. 자동 생성 영어 자막은 가끔 틀릴 수 있어요.

## 알아둘 점

- 채널이 외부 재생을 막아 둔 영상은 자동으로 건너뛰어요.
- 본 영상 기록과 저장한 문장은 휴대폰 안에만 저장돼요.
- 앱 서명 키(`android/keystore`)는 이 공개 저장소에 들어 있어요. 혼자 쓰는 앱이라 업데이트를 쉽게 하려고 그렇게 했어요. 다른 사람이 보낸 EngShorts APK는 설치하지 마세요.

## 웹 버전 (선택)

같은 앱을 웹사이트로도 쓸 수 있어요. 저장소 **Settings → Pages** 에서 Source를 **Deploy from a branch / main / (root)** 로 저장하면 https://a107521-cpu.github.io/eng-shorts/ 에서 열려요. 웹에서는 브라우저 보안 규칙 때문에 옆 자막을 가져오려면 자막 서버(Cloudflare Worker)가 필요해요.

<details>
<summary>웹 버전용 자막 서버 만들기</summary>

1. https://dash.cloudflare.com 에 가입하고 로그인해요. (무료 플랜이면 충분해요)
2. **Compute (Workers) → Workers & Pages → Create → Start with Hello World!** 를 고르고 이름을 `eng-shorts-subs` 로 정해 **Deploy** 해요.
3. **Edit code** 에서 원래 코드를 지우고 [`worker/worker.js`](worker/worker.js) 내용을 붙여넣어 **Deploy** 해요.
4. 나오는 주소(예: `https://eng-shorts-subs.내계정.workers.dev`)를 웹 버전 ⚙ 설정 → 자막 서버 칸에 넣고 **연결 확인**을 눌러요.

</details>

## 파일

- `index.html` — 앱 화면 전체 (HTML/CSS/JS 한 파일, 앱과 웹이 같이 써요)
- `android/` — 안드로이드 앱 (WebView 껍데기, `build.sh` 로 빌드)
- `.github/workflows/android.yml` — `main` 에 올리면 APK를 빌드해서 Releases에 올려요
- `worker/worker.js` — 웹 버전용 자막 서버 (Cloudflare Worker)
