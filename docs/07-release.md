# 07 · Build & phát hành

Tài liệu Tauri về phân phối: <https://v2.tauri.app/distribute/> — kiểm tra lại tên biến môi trường/cấu hình trước mỗi lần thiết lập, vì có thể đổi theo phiên bản.

## 1. Phiên bản

- SemVer `MAJOR.MINOR.PATCH`; beta: `0.x.y-beta.n`.
- Một nguồn sự thật: `version` trong `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` phải khớp (`npm run version:sync`, CI kiểm tra bằng `version:check`).
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

## 6. CI/CD (GitHub Actions) — đã có

- `.github/workflows/ci.yml`: mỗi push/PR chạy `version:check`, build, `npm test`, `cargo test` trên macOS và Windows.
- `.github/workflows/release.yml`:
  - **Đẩy tag `vX.Y.Z`** (khớp `package.json`, kiểm tra tự động): test rồi `tauri-action` build macOS (universal) + Windows và tạo **bản nháp** release kèm installer. Tag có dấu `-` (ví dụ `v0.2.0-beta.1`) thành prerelease.
  - **Chạy tay** (Actions → Release → Run workflow; cần workflow đã có trên nhánh mặc định): build và để installer ở mục *Artifacts* của lần chạy, không tạo release.
- Phát hành một bản: sửa `version` trong `package.json` → `npm run version:sync` → cập nhật `CHANGELOG.md` → commit → `git tag v0.2.0 && git push --tags` → kiểm tra bản nháp rồi Publish.

### Việc của chủ repo (agent không làm thay được)

1. **Ký số macOS:** thêm secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` (mục 3), rồi thêm chúng vào `env:` của bước *Build and attach to a draft release*.
2. **Ký số Windows:** chọn chứng chỉ OV/EV hoặc Azure Trusted Signing (mục 4), cấu hình `bundle.windows` trong `tauri.conf.json`.
3. **Tự cập nhật (mục 5):** tự tạo cặp khóa trên máy mình `npx tauri signer generate -w ~/.tauri/tg-studio.key` (không đưa khóa riêng cho ai, kể cả agent), thêm secrets `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, rồi giao task thêm `tauri-plugin-updater` với **khóa công khai** và endpoint `latest.json` của GitHub Releases.

## 7. Checklist phát hành

- [ ] Version khớp ở 3 file; CHANGELOG cập nhật
- [ ] Test xanh trên macOS + Windows
- [ ] Smoke test với phiên bản CLI đã ghim: dò agent, chạy 1 task mỗi agent, usage hiện đúng
- [ ] Bản macOS: ký + notarize + staple; mở được trên máy sạch
- [ ] Bản Windows: ký; cài trên máy sạch, không cảnh báo đỏ
- [ ] Cập nhật từ bản trước lên bản mới thành công
- [ ] Release notes; chuyển draft → published

## 8. Trang tải cho anh em (Cloudflare Pages)

Repo riêng tư nên không dùng GitHub Pages hay link Release được: người tải phải có quyền vào repo. Workflow **Download site** (`.github/workflows/site.yml`) build bộ cài Windows trên GitHub Actions rồi đẩy lên Cloudflare Pages **chỉ** trang tải (`site/`), ảnh giao diện (`docs/ui-review/`), logo agent và bộ cài. Source không rời GitHub.

**Làm một lần**
1. Tạo tài khoản Cloudflare (miễn phí). Lấy **Account ID** ở trang Workers & Pages (cột phải).
2. My Profile → API Tokens → Create Token → mẫu **Edit Cloudflare Workers**, hoặc Custom token với quyền **Account → Cloudflare Pages → Edit**. Chép token.
3. GitHub repo → Settings → Secrets and variables → Actions → New repository secret:
   - `CLOUDFLARE_API_TOKEN`: token vừa tạo
   - `CLOUDFLARE_ACCOUNT_ID`: Account ID
   - (tuỳ chọn) tab Variables: `CF_PAGES_PROJECT` nếu muốn tên khác `tg-studio`.
4. Actions → **Download site** → Run workflow. Lần đầu workflow tự tạo project Pages. Xong, trang ở `https://tg-studio.pages.dev` (hoặc tên project bạn đặt).

**Mỗi lần có bản mới:** chạy lại workflow bằng tay, hoặc đẩy tag `vX.Y.Z` (cùng lúc workflow Release tạo bản nháp trên GitHub). Link cố định `downloads/TG-Studio-latest-windows-x64-setup.exe` luôn trỏ bản mới nhất; trang tự đọc phiên bản và dung lượng từ `version.json`.

**Chỉ cho người trong nhóm tải:** Cloudflare Zero Trust → Access → Applications → Add → Self-hosted, domain `tg-studio.pages.dev`, policy **Allow** theo danh sách email (gói Free tới 50 người). Người tải nhập email, nhận mã đăng nhập một lần. Không bật Access thì ai có link đều tải được (source vẫn không lộ).

Giới hạn của Pages: mỗi tệp tối đa 25 MiB; bộ cài hiện khoảng 7 MiB.
