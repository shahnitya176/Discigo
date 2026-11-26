import argparse
import csv
import os
import sqlite3
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "discigo.db")


def connect_readonly(path):
    # Read-only connection: Python script database ne badlavi nahi shake
    if not os.path.exists(path):
        sys.exit(f"Database malyo nahi: {path}")
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def user_report(conn, user_id):
    tasks = conn.execute(
        "SELECT name, hours, done, category FROM tasks WHERE user_id = ?",
        (user_id,),
    ).fetchall()

    total = len(tasks)
    done = sum(1 for t in tasks if t["done"])
    total_hours = sum(t["hours"] or 0 for t in tasks)
    done_hours = sum((t["hours"] or 0) for t in tasks if t["done"])
    percent = round(done / total * 100, 1) if total else 0.0

    by_category = {}
    for t in tasks:
        cat = t["category"] or "general"
        bucket = by_category.setdefault(cat, {"total": 0, "done": 0, "hours": 0.0})
        bucket["total"] += 1
        bucket["done"] += 1 if t["done"] else 0
        bucket["hours"] += t["hours"] or 0

    return {
        "total": total,
        "done": done,
        "pending": total - done,
        "percent": percent,
        "total_hours": round(total_hours, 2),
        "done_hours": round(done_hours, 2),
        "by_category": by_category,
    }


def print_report(user, report):
    print(f"\n== {user['name']} <{user['email']}> ==")
    print(f"Goal (din dithi hours): {user['daily_goal']}")
    print(f"Tasks: {report['total']}  |  Done: {report['done']}  |  Pending: {report['pending']}")
    print(f"Completion: {report['percent']}%")
    print(f"Hours: {report['done_hours']} / {report['total_hours']}")
    if report["by_category"]:
        print("Category wise:")
        for cat, b in sorted(report["by_category"].items()):
            print(f"  - {cat}: {b['done']}/{b['total']} done, {round(b['hours'], 2)} h")


def main():
    parser = argparse.ArgumentParser(description="DiScigo user progress report")
    parser.add_argument("--email", help="Ek user no report (email thi)")
    parser.add_argument("--csv", help="CSV file ma export karo, jem ke report.csv")
    parser.add_argument("--db", default=DB_PATH, help="Database path")
    args = parser.parse_args()

    conn = connect_readonly(args.db)

    if args.email:
        users = conn.execute(
            "SELECT id, name, email, daily_goal FROM users WHERE email = ?",
            (args.email.strip().lower(),),
        ).fetchall()
    else:
        users = conn.execute(
            "SELECT id, name, email, daily_goal FROM users ORDER BY id"
        ).fetchall()

    if not users:
        sys.exit("Koi user malyo nahi.")

    rows = []
    for user in users:
        report = user_report(conn, user["id"])
        print_report(user, report)
        rows.append({
            "id": user["id"],
            "name": user["name"],
            "email": user["email"],
            "total_tasks": report["total"],
            "done_tasks": report["done"],
            "pending_tasks": report["pending"],
            "completion_percent": report["percent"],
            "done_hours": report["done_hours"],
            "total_hours": report["total_hours"],
        })

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        print(f"\nCSV saved: {args.csv}")

    conn.close()


if __name__ == "__main__":
    main()