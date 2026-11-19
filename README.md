# ربات تلگرامی هوشمند رصد و تحلیل اخبار مهم جهان

سیستم Serverless، رایگان‌محور و دائماً فعال برای جمع‌آوری خودکار اخبار مهم جهان از منابع معتبر عمومی (RSS/Atom و GDELT اختیاری)، خوشه‌بندی ۵بعدی، سنجش استقلال ناشران، ارزیابی مجزای اهمیت/اعتبار/اطمینان، تحلیل ساختاری ضدتوهم با Gemini API و انتشار خودکار در کانال تلگرام همراه با پنل مدیریتی فارسی.

## معماری نسخه اول
- **Cloudflare Workers:** یک Worker واحد با دو نقطه ورود (`POST /webhook` و `scheduled` Cron هر ۵ دقیقه).
- **Cloudflare D1:** یک دیتابیس SQLite (سقف پلن رایگان ۵۰۰MB) برای تنظیمات، منابع، خوشه‌های خبری، صف `jobs`، قفل اتمیک `leases` (با `fencing_token`)، جدول `delivery_outbox` (سیاست At-Most-Once) و `publication_events`.
- **Gemini API (Google AI Studio):** مدل‌های خانواده Flash Lite (۵۰۰ درخواست روزانه رایگان) با سقف نرم داخلی ۴۰۰ درخواست، Cooldown خودکار و Fallback قابل تنظیم.
- **Telegram Bot API:** پنل مدیریتی فارسی، تغییر کانال مقصد بدون تغییر کد، و انتشار قالب HTML (فارسی و انگلیسی).

---

## ۱. پیش‌نیازها و راه‌اندازی محلی

```bash
npm install
npm run d1:migrate:local
npm run typecheck
npm test
npm run build