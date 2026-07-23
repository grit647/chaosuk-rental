package com.chaosuk.rentalapp;

import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.appcompat.app.AppCompatActivity;

// "เปลือกแอป" ห่อเว็บเช่าสุขที่มีอยู่แล้ว (2026-07-23 ตามคำขอคุณต้น
// "สร้าง app ไฟล์ apk ใช้เปิดแอปเช่าสุขให้หน่อยครับ เปิดไปหน้า Login") —
// ไม่มีระบบธุรกิจ/ฐานข้อมูลอะไรใหม่เลย จอเดียวคือ WebView ที่โหลดหน้า
// /login ของเว็บจริงตรงๆ ทุกอย่างทำงานเหมือนเปิดผ่านเบราว์เซอร์ปกติทุก
// ประการ (ล็อกอิน/แดชบอร์ด/จองห้อง/ฯลฯ) — ตัดฟีเจอร์เสียงพูด/Foreground
// Service ที่ check-service-24/android-app/ มีออกทั้งหมด เพราะเช่าสุข
// ไม่มีระบบเลขาเสียง ต้องการแค่ทางลัดเปิดแอปเข้าเว็บตรงๆ เท่านั้น
public class MainActivity extends AppCompatActivity {

    // แก้ตรงนี้ถ้าต้องการชี้ไปที่ URL อื่น (เช่น ทดสอบกับ localhost/ngrok
    // ก่อน deploy จริง)
    private static final String SITE_URL = "https://chaosuk-rental.onrender.com/login";

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // localStorage — ให้ค่าตั้งของเว็บ (เช่น session) ทำงานเหมือนเว็บปกติ
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient()); // เปิดลิงก์ทั้งหมดในแอปนี้ ไม่เด้งออกเบราว์เซอร์นอก
        webView.setWebChromeClient(new WebChromeClient());

        webView.loadUrl(SITE_URL);
    }

    @Override
    public void onBackPressed() {
        // ปุ่มย้อนกลับของเครื่อง = ย้อนกลับหน้าเว็บก่อนหน้า (เหมือนเบราว์เซอร์
        // ปกติ) ถ้าไม่มีหน้าให้ย้อนแล้วค่อยปิดแอปจริง
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
