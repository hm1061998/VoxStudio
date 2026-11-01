# 11 — Thanh toán (tùy chọn)

Quyết định: [ADR 0010](../decisions/0010-optional-billing-by-bank-transfer.md). Trang này mô tả những gì đã làm, cách bật, và cách nối cổng thanh toán sau này. Chưa có giao dịch tiền thật nào được thử.

## Hiện trạng

- **Tắt mặc định.** Chỉ bật khi đặt giá trong `PLAN_PRICES_VND_JSON`. Khi tắt, quản trị viên gán gói như trước.
- **Gói có thời hạn.** Mỗi workspace có `plan_expires_at`. Gói trả phí quá hạn được tính là free ở mọi nơi (hạn mức, hàng đợi, xuất WAV nặng, trang quản trị). Không xóa dữ liệu nào.
- **Đơn hàng.** Người dùng chọn gói pro hoặc business và 1, 3, 6, 12 tháng. Hệ thống tạo đơn với số tiền cố định (giá mỗi tháng nhân số tháng) và mã thanh toán dạng `VOX` cộng 8 ký tự, ví dụ `VOXK7M2QH9T`. Người dùng chuyển khoản và ghi mã vào nội dung. Mỗi workspace có tối đa 3 đơn chưa thanh toán cùng lúc; đơn hết hạn sau 48 giờ (khoản tiền đến muộn vẫn được nhận).
- **Xác nhận.** Hoặc quản trị viên bấm "Xác nhận thanh toán" sau khi đối chiếu sao kê, hoặc một nhà cung cấp gọi webhook. Cả hai dùng chung một hàm, an toàn khi chạy lặp.
- **Quy tắc an toàn.** Thiếu tiền, đang có gói trả phí khác còn hạn, hoặc đơn đã bị hủy: đơn sang trạng thái "đang kiểm tra" và không đổi gói, chờ quản trị viên. Chuyển thừa: nhận và ghi lại. Khoản không khớp đơn nào: lưu để quản trị viên xem, không đổi gói. Cùng gói còn hạn: cộng thêm thời gian vào ngày hết hạn hiện tại. Gói do quản trị viên gán không có ngày hết hạn: giữ nguyên không hết hạn.

## Cấu hình

| Biến                                                               | Ý nghĩa                                                                                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAN_PRICES_VND_JSON`                                             | Giá mỗi tháng (VND) của từng gói trả phí, ví dụ `{"pro":99000,"business":299000}`. Mỗi giá từ 1.000 đến 100 triệu. Để trống = tắt thanh toán |
| `PAYMENT_BANK_NAME`, `PAYMENT_BANK_ACCOUNT`, `PAYMENT_BANK_HOLDER` | Thông tin tài khoản nhận tiền hiển thị cho người dùng (cần tên ngân hàng và số tài khoản)                                                    |
| `PAYMENT_WEBHOOK_SECRET`                                           | Chuỗi bí mật dùng chung (ít nhất 16 ký tự) mà nhà cung cấp gửi kèm webhook. Để trống = tắt webhook                                           |

Giá chưa được quyết định trong dự án: bạn tự đặt.

## Nối một nhà cung cấp thanh toán

Điểm vào: `POST /api/v1/payments/webhook/<provider>`, công khai (không cần phiên đăng nhập, không cần CSRF), xác thực bằng bí mật dùng chung, giới hạn 120 lần mỗi phút.

Dạng chuẩn hóa `generic` (đã có, dùng cho kiểm thử và cho cầu nối nhỏ do bạn tự viết):

```text
Authorization: Bearer <PAYMENT_WEBHOOK_SECRET>
{ "eventId": "mã duy nhất của giao dịch", "direction": "in", "amountVnd": 99000, "note": "nội dung chuyển khoản" }
```

Trả lời `{ "success": true, "result": "applied" | "review" | "unmatched" | "ignored" | "duplicate" }`. Nhà cung cấp gửi lại cùng `eventId` thì không có thay đổi nào.

Để thêm một nhà cung cấp thật (payOS, SePay, hoặc ngân hàng khác) khi đã có tài khoản:

1. Mở tài liệu của họ và ghi lại đúng cách xác thực webhook, tên các trường (mã giao dịch, số tiền, nội dung, chiều tiền vào hoặc ra) và cách họ mong đợi phản hồi.
2. Thêm một đối tượng `PaymentProvider` trong `packages/core/src/billing.ts` (hàm `authenticate` so sánh bí mật bằng `timingSafeEqual`, hàm `parse` đổi payload sang `PaymentEvent`) và đăng ký vào `PAYMENT_PROVIDERS`.
3. Viết test với payload mẫu lấy từ tài liệu của họ, và thử bằng môi trường sandbox của họ trước khi nhận tiền thật.
4. Nếu nhà cung cấp yêu cầu chữ ký trên toàn thân yêu cầu (HMAC) thay vì bí mật dùng chung, cần cho adapter đọc thân yêu cầu thô; hiện `parse` chỉ nhận thân đã giải mã.

Chưa có adapter nào cho nhà cung cấp thật, vì định dạng payload chưa được kiểm chứng.

## Chưa làm

- Ảnh mã QR VietQR (trang chỉ hiện ngân hàng, số tài khoản, số tiền và mã).
- Hóa đơn điện tử và biên lai; nghĩa vụ thuế cần hỏi kế toán trước khi bán.
- Hoàn tiền, nâng hoặc hạ gói giữa kỳ, tự gia hạn, email nhắc hết hạn.
- Mọi thử nghiệm bằng tiền thật hoặc nhà cung cấp thật.
