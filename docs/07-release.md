# 07 · Build & phát hành

Tài liệu Tauri về phân phối: <https://v2.tauri.app/distribute/> — kiểm tra lại tên biến môi trường/cấu hình trước mỗi lần thiết lập, vì có thể đổi theo phiên bản.

## 1. Phiên bản

- SemVer `MAJOR.MINOR.PATCH`; beta: `0.x.y-beta.n`.
- Một nguồn sự thật: `version` trong `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` phải khớp (script `npm run version:sync` — cần viết).
- Ghi `CHANGELOG.md` mỗi bản phát hành.

## 2. Build cục bộ

```bash
npm run build:app
# macOS:   src-tauri/target/release/bundle/macos/TG Studio.app, bundle/dmg/*.dmg
# Windows: src-tauri/target/release/bundle/nsis/*.exe, bundle/msi/*.msi
```

Bản chưa ký chỉ nên dùng nội bộ: macOS sẽ bị Gatekeeper chặn (chuột phải → Open để mở), Windows hiện cảnh báo SmartScreen.

## 3. Ký số macOS + notarize

Cần: tài khoản **Apple Developer Program** (trả phí theo năm), chứng chỉ **Developer ID Application**.

Biến môi trường Tauri dùng khi build (đặt trong CI secrets):

| Biến | Ý nghĩa |
|---|---|
| `APPLE_CERTIFICATE` | Chứng chỉ .p12 mã hóa base64 |
| `APPLE_CERTIFICATE_PASSWORD` | Mật khẩu .p12 |
| `APPLE_SIGNING_IDENTITY` | Ví dụ `Developer ID Application: Tran Gioi (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Notarize bằng Apple ID + app-specific password |
| hoặc `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` | Notarize bằng App Store Connect API key (khuyên dùng cho CI) |

Kiểm tra sau build: `spctl -a -vv "TG Studio.app"` và `xcrun stapler validate *.dmg`.

## 4. Ký số Windows

Hai cách:
1. **Chứng chỉ code signing** (OV/EV) → cấu hình `bundle.windows.certificateThumbprint`, `digestAlgorithm`, `timestampUrl` trong `tauri.conf.json`.
2. **Dịch vụ ký trên cloud** (ví dụ Azure Trusted Signing) → dùng `bundle.windows.signCommand` gọi công cụ ký.

Installer: dùng **NSIS** (`.exe`) làm mặc định cho người dùng cuối; `.msi` cho doanh nghiệp. WebView2 có sẵn trên Windows 11; với Windows 10 cấu hình installer tự tải WebView2.

## 5. Tự cập nhật

1. Thêm `tauri-plugin-updater` (Rust + JS) và quyền tương ứng trong `capabilities/`.
2. Tạo cặp khóa ký bản cập nhật: `npx tauri signer generate -w ~/.tauri/tg-studio.key`. **Giữ khóa riêng an toàn** — mất khóa là không phát hành bản cập nhật được cho người dùng cũ.
3. CI đặt `TAURI_SIGNING_PRIVATE_KEY` và `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; bật `bundle.createUpdaterArtifacts`.
4. `tauri.conf.json` → `plugins.updater`: `pubkey` (khóa công khai) và `endpoints` (ví dụ file `latest.json` trên GitHub Releases).
5. App kiểm tra khi khởi động + mỗi 6 giờ; tải nền; hỏi người dùng khởi động lại.
6. Hai kênh: `beta` và `stable` (hai endpoint).

## 6. CI/CD (GitHub Actions)

```yaml
# .github/workflows/release.yml (phác thảo)
on: { push: { tags: ['v*'] } }
jobs:
  build:
    strategy:
      matrix:
        include:
          - { os: macos-latest, args: '--target universal-apple-darwin' }
          - { os: windows-latest, args: '' }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.os == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}
      - run: npm ci
      - run: npm test -- --watch=false
      - run: cargo test --manifest-path src-tauri/Cargo.toml
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # + các biến ký số/notarize/updater ở mục 3–5
        with:
          tagName: v__VERSION__
          releaseName: TG Studio v__VERSION__
          releaseDraft: true
          args: ${{ matrix.args }}
```

Workflow kiểm tra mỗi PR: cùng matrix, chỉ chạy `npm test`, `npm run build`, `cargo test`, `cargo clippy -- -D warnings`.

## 7. Checklist phát hành

- [ ] Version khớp ở 3 file; CHANGELOG cập nhật
- [ ] Test xanh trên macOS + Windows
- [ ] Smoke test với phiên bản CLI đã ghim: dò agent, chạy 1 task mỗi agent, usage hiện đúng
- [ ] Bản macOS: ký + notarize + staple; mở được trên máy sạch
- [ ] Bản Windows: ký; cài trên máy sạch, không cảnh báo đỏ
- [ ] Cập nhật từ bản trước lên bản mới thành công
- [ ] Release notes; chuyển draft → published
