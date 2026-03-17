# Инструкция по деплою Квиз-платформы

Данный файл содержит инструкции по развёртыванию проекта на сервере и необходимые учетные данные.

## Данные сервера
- **Адрес:** `notvlesskarm.ru`
- **Пользователь:** `root`
- **Пароль:** `225TWZ90GywG3Xoaae`

---

## Промт для ИИ-ассистента (для автоматического деплоя)

Скопируйте и отправьте этот текст ИИ-ассистенту (например, AntiGravity), чтобы он выполнил деплой:

> "Разверни проект квиз-платформы на сервере root@notvlesskarm.ru (пароль: 225TWZ90GywG3Xoaae). 
> Проект должен быть доступен по адресу https://notvlesskarm.ru/quiz.
> 
> Основные требования:
> 1. Загрузи файлы проекта в `/var/www/quiz-platform`.
> 2. Сторона сервера (Node.js):
>    - Установи сервер на порт 3001.
>    - Настрой Socket.io с путём `path: "/quiz/socket.io"`.
>    - Убедись, что CORS разрешает запросы с https://notvlesskarm.ru.
> 3. Сторона клиента (HTML/JS):
>    - Все запросы к API и Socket.io должны использовать путь `/quiz/`. 
>    - Инициализация Socket.io: `io({ path: "/quiz/socket.io" })`.
> 4. Настройка Nginx:
>    - Проксируй `https://notvlesskarm.ru/quiz/` на `http://127.0.0.1:3001/`.
>    - Проксируй `https://notvlesskarm.ru/quiz/socket.io/` на `http://127.0.0.1:3001/quiz/socket.io/` с поддержкой WebSocket (Upgrade/Connection).
> 5. Запусти сервер через PM2."

---

## Ручные шаги по деплою

Если вы решите развернуть проект вручную:

### 1. Подготовка сервера
```bash
# Установка Node.js и PM2
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

### 2. Загрузка и запуск приложения
```bash
mkdir -p /var/www/quiz-platform
# (Загрузите файлы проекта в эту папку)
cd /var/www/quiz-platform
npm install
pm2 start server.js --name "quiz-platform"
```

### 3. Настройка Nginx
Создайте файл `/etc/nginx/sites-enabled/notvlesskarm.ru`:

```nginx
server {
    listen 80;
    server_name notvlesskarm.ru;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name notvlesskarm.ru;

    ssl_certificate /etc/letsencrypt/live/notvlesskarm.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notvlesskarm.ru/privkey.pem;

    location /quiz/socket.io/ {
        proxy_pass http://127.0.0.1:3001/quiz/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /quiz/ {
        proxy_pass http://127.0.0.1:3001/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

После редактирования:
```bash
nginx -t
systemctl reload nginx
```
