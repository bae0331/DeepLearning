# Visual ChatGPT Android App

Visual ChatGPT 서버와 연동하는 Android 채팅 앱입니다.

## 기능

- 텍스트 메시지 전송
- 이미지 첨부 및 전송 (Base64 인코딩)
- AI 응답 이미지 표시
- 한국어/영어 지원
- 서버 URL 및 API Key 설정

## 설정 방법

1. 앱 실행 후 우측 상단 설정 아이콘 탭
2. **서버 URL** 입력: Visual ChatGPT 서버 주소 (예: `http://192.168.1.100:7860`)
3. **OpenAI API Key** 입력 (선택사항)
4. **언어** 선택: English / Chinese
5. 저장 후 채팅 시작

## Visual ChatGPT 서버 실행

```bash
# VisualChatGPT.ipynb 노트북 실행 후 ngrok 또는 로컬 IP로 접속
# Gradio가 0.0.0.0:7860에서 실행됨
```

## 프로젝트 구조

```
app/src/main/
├── java/com/example/visualchatgpt/
│   ├── MainActivity.kt          # 메인 채팅 화면
│   ├── SettingsActivity.kt      # 설정 화면
│   ├── adapter/
│   │   └── ChatAdapter.kt       # RecyclerView 어댑터
│   ├── model/
│   │   └── ChatMessage.kt       # 메시지 데이터 클래스
│   ├── network/
│   │   └── ApiService.kt        # HTTP API 통신
│   └── viewmodel/
│       └── ChatViewModel.kt     # ViewModel (MVVM)
└── res/
    ├── layout/                  # XML 레이아웃
    ├── values/                  # 문자열, 색상, 테마
    └── drawable/                # 아이콘, 배경
```

## 빌드 요구사항

- Android Studio Hedgehog 이상
- minSdk 24 (Android 7.0)
- targetSdk 34 (Android 14)
- Kotlin 1.9.0
