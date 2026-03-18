# Nginx Konfiguratsiyasi

## To'liq nginx config (WebSocket qo'llab-quvvatlash bilan)

`/etc/nginx/sites-available/logs` faylining to'g'ri ko'rinishi:

```nginx
server {
    server_name logs.example.com;

    # Certbot uchun
    location /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }

    location / {
        proxy_pass http://127.0.0.1:2000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }

    listen 80;
}
```


## Qo'llash

```bash
# Faylni tahrirlash
nano /etc/nginx/sites-enabled/logs

# Sintaksisni tekshirish
nginx -t

# Nginxni qayta yuklash
systemctl reload nginx
```
