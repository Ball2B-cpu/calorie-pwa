#!/usr/bin/env python3
"""เสิร์ฟแอพในเครื่องเพื่อทดสอบ (พอร์ต 8099) — ไม่ใช่ส่วนของแอพ ไม่ขึ้น repo

ต้องเสิร์ฟผ่าน http:// ไม่ใช่ file:// เพราะ ES modules + service worker ต้องมี origin จริง
รันใต้ pythonw (ไม่มีหน้าต่าง) จึงต้องปิด log_message — handler มาตรฐานเขียน log ลง stderr
ซึ่งไม่มีอยู่ใต้ pythonw แล้วทำให้ request ตายกลางคัน (บทเรียนเดียวกับ agent-chat/serve.py)

เปิดจาก LAN ได้ด้วย (ทดสอบบนไอโฟนในบ้านก่อน deploy ขึ้น Pages)
⚠️ service worker ทำงานเฉพาะ localhost หรือ https — ทดสอบ offline จริงต้องผ่าน Pages
"""
import os, functools
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = 8099


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def end_headers(self):
        # ตอนพัฒนาไม่ต้องให้เบราว์เซอร์แคช ไม่งั้นแก้ไฟล์แล้วไม่เห็นผล
        # ยกเว้นตัว sw.js เอง: บางเบราว์เซอร์ปฏิเสธการลงทะเบียน service worker ที่ตอบมาแบบ no-store
        if not self.path.startswith("/sw.js"):
            self.send_header("Cache-Control", "no-store")
        self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), functools.partial(Handler, directory=ROOT)).serve_forever()
