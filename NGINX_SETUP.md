# Nginx Konfiguratsiyasi (host)

TLS shu host nginx'da tugaydi va u `127.0.0.1:2000` dagi frontend
container'iga proxy qiladi. HSTS va server banner faqat shu qatlamda
sozlanadi (container nginx'i xavfsizlik headerlarini o'zi ham qo'shadi, lekin
HSTS TLS tugaydigan joyda bo'lishi shart).

Quyidagi misollarda `logs.example.com` o'rniga o'z domeningizni yozing.

## To'liq nginx config (HTTPS + WebSocket + xavfsizlik headerlari)

`/etc/nginx/sites-available/logs`:

```nginx
# nginx versiyasini javoblarda ko'rsatmaslik (nginx.conf ichidagi http{} blokida):
#   server_tokens off;

server {
    server_name logs.example.com;

    # Certbot uchun
    location /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }

    # Barcha javoblarda xavfsizlik headerlari ("always" xato javoblarni ham qamraydi)
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;

    # Source map'lar original kodni ochib beradi - hech qachon tashqariga bermang
    location ~* \.map$ {
        deny all;
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:2000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/logs.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/logs.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
}

# HTTP -> HTTPS
server {
    listen 80;
    server_name logs.example.com;
    return 301 https://$host$request_uri;
}
```

Eslatmalar:
- **`server_tokens off;`** — `http{}` blokida (`/etc/nginx/nginx.conf`) qo'ying, shunda
  `Server:` headerida nginx versiyasi ko'rinmaydi.
- **HSTS** — `max-age=31536000` (1 yil). `includeSubDomains` ni faqat barcha
  subdomenlar HTTPS bo'lsa qoldiring, aks holda olib tashlang.
- **`X-Powered-By`** — backend `app.disable('x-powered-by')` orqali o'chirilgan,
  qo'shimcha sozlash shart emas.
- Agar `add_header` biror `location` blokida ishlatilsa, nginx o'sha blokda
  yuqoridagi barcha `add_header`larni bekor qiladi — u holda ularni o'sha blokda
  ham takrorlang.

## Qo'llash

```bash
nano /etc/nginx/sites-enabled/logs
nginx -t
systemctl reload nginx
```

## Tekshirish

```bash
B=https://logs.example.com
curl -s -D - -o /dev/null "$B/" | grep -iE 'strict-transport|content-security|x-frame|x-content-type|referrer-policy'
curl -s -o /dev/null -w 'HTTP->HTTPS: %{http_code}\n' "http://logs.example.com/"
```
