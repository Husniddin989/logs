# Xavfsizlik: yangilanishdan keyingi ops qadamlar

Bu hujjat audit topilmalari (default admin paroli, ochiq source map, zaif
server-side avtorizatsiya, default JWT secret) yopilgan versiyani productionga
(`logs.ustozaibot.uz`) chiqarish va eski zaifliklar orqali kirilgan-kirilmaganini
tekshirish uchun. Buyruqlar serverda, loyiha katalogida bajariladi.

> Muhim: eski versiyada admin paroli, JWT secret va butun frontend kodi
> ommaviy edi. Ular orqali har qanday odam admin bo'lib, **barcha
> container loglarini** o'qiy olgan bo'lishi mumkin deb hisoblang.

## 1. Deploydan oldin

```bash
# users-data volume'ining zaxira nusxasi (nomini aniqlash: docker volume ls | grep users-data)
docker run --rm -v logs_users-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/users-data-$(date +%F).tgz -C /data .
```

`.env` faylini yangilang (namuna: `.env.example`):

```bash
# Yangi JWT secret - barcha eski (va soxtalashtirilgan) tokenlar o'ladi
echo "JWT_SECRET=$(openssl rand -base64 48)" >> .env
# Bir martalik admin paroli (birinchi logindan keyin o'chiriladi)
echo "ADMIN_INITIAL_PASSWORD=$(openssl rand -base64 18)" >> .env
chmod 600 .env
```

Eski `JWT_SECRET` qiymatini qayta ishlatmang. Backend repoda e'lon qilingan
default qiymatlar, 32 belgidan qisqa yoki bir xil belgilardan iborat secret bilan
umuman ishga tushmaydi.

## 2. Deploy

```bash
git pull
docker compose up -d --build
docker compose logs backend | grep -E '\[security\]|\[startup\]|audit'
```

Kutiladigan natija:

- Agar prod admin hali ham eski default parolda bo'lsa:
  `Account "admin" still used the published default password; its password has been disabled`
  va `Admin account "admin" initialised from ADMIN_INITIAL_PASSWORD`.
- Agar admin parolni avval o'zgartirgan bo'lsa: `ADMIN_INITIAL_PASSWORD is set
  but an admin account already exists, so it was ignored`. Bu holda 4-qadamda
  admin parolini baribir almashtiring (eski parol oshkor bo'lgan bo'lishi mumkin).
- Oddiy userlardagi `*` (barcha containerlar) ruxsati olib tashlanadi va logga
  yoziladi - ularga containerlarni qo'lda qayta bering.

## 3. Host nginx

`/etc/nginx/sites-available/logs` ga `.map` blokini qo'shing (`NGINX_SETUP.md`):

```nginx
location ~* \.map$ {
    deny all;
    return 404;
}
```

```bash
nginx -t && systemctl reload nginx
```

`2000` port internetdan to'g'ridan-to'g'ri ochiq bo'lmasligi kerak (aks holda
TLS va host nginx chetlab o'tiladi). Tekshiring va yoping:

```bash
ss -ltnp | grep ':2000'          # 0.0.0.0:2000 bo'lsa ochiq
ufw deny 2000/tcp                 # yoki docker-compose.yml da "127.0.0.1:2000:80"
```

## 4. Birinchi login va parollar rotatsiyasi

1. `ADMIN_USERNAME` (default `admin`) va `ADMIN_INITIAL_PASSWORD` bilan kiring,
   yangi parol tanlang (12+ belgi).
2. `.env` dan `ADMIN_INITIAL_PASSWORD` qatorini o'chiring.
3. **Users** sahifasida:
   - notanish foydalanuvchilarni o'chiring, rol va container ruxsatlarini
     tekshiring (hujumchi admin bo'lgan bo'lsa o'z hisobini qo'shgan bo'lishi mumkin);
   - har bir foydalanuvchiga yangi vaqtinchalik parol bering (keyingi loginda
     o'zi almashtiradi) va **Revoke sessions** bosing.

## 5. Kirilgan-kirilmaganini tekshirish

Eski versiyada audit log yo'q edi, shuning uchun o'tmish uchun host nginx
loglariga qarang:

```bash
# Source map yuklab olganlar
zgrep -hE '\.map HTTP' /var/log/nginx/access.log* | awk '{print $1}' | sort | uniq -c | sort -rn
# Muvaffaqiyatli loginlar (200) - IP'lar tanishmi?
zgrep -h 'POST /api/auth/login' /var/log/nginx/access.log* | awk '$9 == 200 {print $1, $4}' | sort | uniq -c
# Foydalanuvchilarni boshqarish chaqiruvlari
zgrep -hE '"(POST|PUT|DELETE) /api/users' /var/log/nginx/access.log*
```

Docker socket orqali hostda iz qolgan-qolmaganini ko'ring:

```bash
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.CreatedAt}}'   # notanish containerlar
docker images --format '{{.Repository}}:{{.Tag}}\t{{.CreatedSince}}'
```

Hujumchi barcha container loglarini o'qiy olgan bo'lishi mumkin. Loglarda
chiqqan har qanday secret (DB parollari, API kalitlari, tokenlar) ni
**almashtiring**.

Deploydan keyin yangi audit log:

```bash
docker exec docker-log-viewer-backend sh -c \
  "grep -E 'auth.login|access.denied|admin\.' /app/src/data/audit.log | tail -100"
```

## 6. Zanjirni qayta test qilish

Audit ko'rsatgan zanjir: source map -> credential -> JWT -> API -> logs -> WebSocket.
Har bir halqa yopilganini tekshiring (`B=https://logs.ustozaibot.uz`):

```bash
B=https://logs.ustozaibot.uz
JS=$(curl -s $B/ | grep -oE 'static/js/main\.[a-f0-9]+\.js' | head -1)
curl -s -o /dev/null -w 'source map: %{http_code}\n' "$B/$JS.map"                 # 404
curl -s "$B/$JS" | grep -c admin123                                               # 0
curl -s -o /dev/null -w 'default login: %{http_code}\n' -X POST "$B/api/auth/login" \
  -H 'content-type: application/json' -d '{"username":"admin","password":"admin123"}'   # 401
curl -s -o /dev/null -w 'no token: %{http_code}\n' "$B/api/containers"            # 401
curl -s -o /dev/null -w 'no token users: %{http_code}\n' "$B/api/users"           # 401
```

Eski default secret bilan yasalgan token rad etilishi kerak (401). Oddiy user
bilan kirib, ruxsat berilmagan containerning loglari REST'da ham
(`/api/containers/<nom>/logs` -> 403), WebSocket'da ham ("Access denied") yopiq
ekanini tekshiring.

## 7. Repo va CI

- GitHub'da Actions yoqilgan bo'lsin; `main` uchun branch protection bilan
  `CI` (secret scan, backend testlar, frontend build check) majburiy bo'lsin.
- GitHub **Secret scanning** va **Push protection** ni yoqing.
- Har bir dasturchi: `git config core.hooksPath .githooks` (yoki
  `pre-commit install`).
- Git tarixidagi eski seed hash `.gitleaksignore` da izoh bilan qayd etilgan;
  tarixni qayta yozish shart emas (parol baribir oshkor bo'lgan va endi
  bloklanadi).

## Tavsiyalar (bu o'zgarishlar doirasidan tashqarida)

- Backend Docker socketga to'liq kirish huquqiga ega (`:ro` API'ni
  cheklamaydi) - bu host root'ga teng. Faqat `GET /containers`, `/info` ga
  ruxsat beradigan socket proxy (masalan `tecnativa/docker-socket-proxy`) qo'ying.
- `node:20` 2026-yil aprelda EOL bo'ldi - `node:22`/`node:24` ga o'ting.
- `audit.log` ni logrotate bilan aylantiring.
- Tokenlar `localStorage` da; keyingi bosqichda httpOnly cookie'ga o'tish XSS
  xavfini kamaytiradi.
