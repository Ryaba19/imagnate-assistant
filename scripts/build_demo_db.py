import json
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "demo-data.json"
SCHEMA_PATH = ROOT / "database" / "schema.sql"
DB_PATH = ROOT / "database" / "store_assistant_demo.sqlite"


def main() -> None:
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    if DB_PATH.exists():
        DB_PATH.unlink()

    with sqlite3.connect(DB_PATH) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))

        store = data["store"]
        cursor = connection.execute(
            """
            INSERT INTO stores (name, owner_name, city, site_url, phone, telegram, whatsapp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                store["name"],
                store["ownerName"],
                store["city"],
                store["siteUrl"],
                store["phone"],
                store["telegram"],
                store["whatsapp"],
            ),
        )
        store_id = cursor.lastrowid

        connection.executemany(
            """
            INSERT INTO users (store_id, name, role, role_label, login, password_demo, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    store_id,
                    employee["name"],
                    employee["role"],
                    employee["roleLabel"],
                    employee["login"],
                    employee["password"],
                    1 if employee["active"] else 0,
                )
                for employee in data["employees"]
            ],
        )

        connection.executemany(
            """
            INSERT INTO products (
              store_id, sku, name, category, status, days_in_sale,
              cost_price, sale_price, stock_qty, source, comment,
              condition, kit, description, photos_count, photo_urls, avito_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    store_id,
                    product["sku"],
                    product["name"],
                    product["category"],
                    product["status"],
                    product["daysInSale"],
                    product["costPrice"],
                    product["salePrice"],
                    product["stockQty"],
                    product["source"],
                    product["comment"],
                    product.get("condition", ""),
                    product.get("kit", ""),
                    product.get("description", product["comment"]),
                    product.get("photosCount", 0),
                    ";".join(product.get("photoUrls", [])),
                    product.get("avitoStatus", ""),
                )
                for product in data["products"]
            ],
        )

        connection.executemany(
            """
            INSERT INTO tasks (store_id, title, owner, due_label, priority, is_done)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    store_id,
                    task["title"],
                    task["owner"],
                    task["due"],
                    task["priority"],
                    1 if task["done"] else 0,
                )
                for task in data["tasks"]
            ],
        )

        shift = data["shift"]
        expected = shift["cashStart"] + shift["cashSales"] - shift["refunds"] - shift["expenses"] - shift["collection"]
        difference = shift["cashActual"] - expected
        connection.execute(
            """
            INSERT INTO shift_reports (
              store_id, cashier_name, opened_at, closed_at, cash_start,
              cash_sales, card_sales, transfers, refunds, expenses, collection,
              expected_cash, actual_cash, difference, comment
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                store_id,
                "Продавец",
                "2026-07-14 10:00:00",
                "2026-07-14 21:00:00",
                shift["cashStart"],
                shift["cashSales"],
                shift["cardSales"],
                shift["transfers"],
                shift["refunds"],
                shift["expenses"],
                shift["collection"],
                expected,
                shift["cashActual"],
                difference,
                shift["comment"],
            ),
        )

        site_import = data["siteImport"]
        captured_at = site_import["capturedAt"]
        connection.executemany(
            """
            INSERT INTO site_routes (store_id, title, url, route_type, captured_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            [(store_id, route["title"], route["url"], "page", captured_at) for route in site_import["routes"]],
        )
        connection.executemany(
            """
            INSERT INTO site_catalog_categories (store_id, title, url, captured_at)
            VALUES (?, ?, ?, ?)
            """,
            [(store_id, category["title"], category["url"], captured_at) for category in site_import["catalogCategories"]],
        )
        connection.executemany(
            """
            INSERT INTO site_page_meta (store_id, title, url, description, captured_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (store_id, page["title"], page["url"], page["description"], captured_at)
                for page in site_import["pageMeta"]
            ],
        )
        connection.executemany(
            """
            INSERT INTO site_sample_products (store_id, title, url, category, import_use, captured_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (store_id, product["title"], product["url"], product["category"], product["importUse"], captured_at)
                for product in site_import["sampleProducts"]
            ],
        )
        connection.executemany(
            """
            INSERT INTO site_promotions (store_id, title, url, import_use, captured_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (store_id, promotion["title"], promotion["url"], promotion["importUse"], captured_at)
                for promotion in site_import["promotions"]
            ],
        )
        connection.executemany(
            """
            INSERT INTO site_articles (store_id, title, url, import_use, captured_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (store_id, article["title"], article["url"], article["importUse"], captured_at)
                for article in site_import["articles"]
            ],
        )
        connection.executemany(
            """
            INSERT INTO import_options (store_id, name, risk, description)
            VALUES (?, ?, ?, ?)
            """,
            [
                (store_id, option["name"], option["risk"], option["description"])
                for option in site_import["importOptions"]
            ],
        )
        connection.executemany(
            """
            INSERT INTO activity_events (store_id, title, meta)
            VALUES (?, ?, ?)
            """,
            [(store_id, event["title"], event["meta"]) for event in data["activity"]],
        )
        connection.executemany(
            """
            INSERT INTO employee_questions (
              store_id, type, priority, title, text,
              author_name, author_login, status, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    store_id,
                    question["type"],
                    question["priority"],
                    question["title"],
                    question["text"],
                    question["authorName"],
                    question["authorLogin"],
                    question["status"],
                    question["createdAt"],
                )
                for question in data.get("questions", [])
            ],
        )

    print(f"Created {DB_PATH}")


if __name__ == "__main__":
    main()
