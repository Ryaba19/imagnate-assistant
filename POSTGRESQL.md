# PostgreSQL для Store Control ERP

## Что уже подготовлено

В проект добавлен боевой слой PostgreSQL:

- `database/schema.sql` — структура базы;
- `GET /api/db/status` — проверка подключения;
- `POST /api/db/init` — создание таблиц;
- `POST /api/scan/receive` — запись товара после сканирования;
- локальная БД в браузере остается как резервный режим.

Если `DATABASE_URL` не задан или драйвер `pg` не установлен, CRM не падает: сканер продолжает работать локально и позволяет скачать `Экспорт БД`.

## Таблицы

- `products` — справочник товаров;
- `stock_units` — конкретные устройства с IMEI / серийником;
- `stock_batches` — партии аксессуаров и запчастей;
- `stock_movements` — история движения склада;
- `audit_log` — кто и что изменил.

## Переменные окружения

```text
DATABASE_URL=postgresql://user:password@host:5432/database
PG_SSL_MODE=require
PG_POOL_MAX=5
STORE_TOKEN=длинный-секрет-для-служебных-запросов
```

## Проверка

```text
https://ваш-домен/api/db/status
```

Если ответ содержит `"configured": true`, сервер видит PostgreSQL.

## Инициализация таблиц

Нужно один раз отправить POST-запрос:

```text
POST https://ваш-домен/api/db/init
Authorization: Bearer STORE_TOKEN
```

После этого можно писать сканы в PostgreSQL.

## Подключение сканера к серверной БД

На рабочем компьютере нужно один раз сохранить токен в браузере:

```js
_erp_setApiToken('ваш_STORE_TOKEN')
```

После этого вкладка `Сканер` при добавлении товара будет:

1. сохранять товар локально;
2. писать его в структурированную локальную БД;
3. отправлять запись в PostgreSQL через сервер.

## Важно

Не вставляйте `DATABASE_URL` и `STORE_TOKEN` в HTML или GitHub. Эти значения должны жить только в `.env` локально или в Environment Variables на Render.
