# Запуск Store Control ERP на Render

## Что это дает

Render запускает наш Node.js сервер в облаке. Тогда CRM открывается по публичной ссылке, а OpenAI-ключ хранится в настройках Render, а не в браузере и не в GitHub.

## Файлы, которые нужны в GitHub

- `store-control-erp.html`
- `storecontrolapi.js`
- `package.json`
- `render.yaml`
- `.env.example`
- `.gitignore`
- `database/schema.sql`
- `POSTGRESQL.md`
- `ai-knowledge-base-template.json`
- `ai-training-questions-for-lenya.md`

Файл `.env` загружать в GitHub нельзя.

## Настройка Render

1. Создать аккаунт на Render.
2. Создать новый `Web Service`.
3. Подключить GitHub-репозиторий с проектом.
4. В настройках сервиса поставить:

```text
Build Command: npm install
Start Command: npm start
Health Check Path: /api/health
```

5. В разделе `Environment` добавить переменные:

```text
OPENAI_API_KEY=ваш_ключ_openai
OPENAI_MODEL=gpt-4o-mini
STORE_TOKEN=любой_длинный_секрет
DATABASE_URL=строка_подключения_PostgreSQL
PG_SSL_MODE=require
```

6. Нажать `Deploy`.

## Что открыть после запуска

Главная CRM:

```text
https://ваш-сервис.onrender.com/store-control-erp.html
```

Проверка сервера:

```text
https://ваш-сервис.onrender.com/api/health
```

Проверка AI:

```text
https://ваш-сервис.onrender.com/api/ai/status
```

Если `configured: true`, ключ подключен. Если `configured: false`, Render не получил `OPENAI_API_KEY`.

Проверка PostgreSQL:

```text
https://ваш-сервис.onrender.com/api/db/status
```

Если `configured: true`, PostgreSQL подключен. Таблицы создаются один раз через `POST /api/db/init` с заголовком `Authorization: Bearer STORE_TOKEN`.
