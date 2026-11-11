#!/usr/bin/env python3
"""批量注册 Quota-Flow 用户：INSERT auth.users（触发器自动建 profiles），跳过邮件验证。
用法: python3 register_users.py <邮箱1> <邮箱2> ...
      或: echo -e "a@x.com\nb@x.com" | python3 register_users.py -
"""
import subprocess
import secrets
import string
import sys

DB = "supabase_db_quota-flow"
# 易读字符集（去掉 0/O/1/l/I 等易混淆字符）
ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"


def gen_password(length=6):
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


def run_sql(sql):
    r = subprocess.run(
        ["docker", "exec", DB, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql],
        capture_output=True,
        text=True,
    )
    return r


def main():
    # 收集邮箱
    emails = []
    args = sys.argv[1:]
    if args and args[0] == "-":
        emails = [ln.strip() for ln in sys.stdin if ln.strip()]
    else:
        emails = [a.strip() for a in args if a.strip()]

    if not emails:
        print("未提供邮箱。用法: python3 register_users.py <邮箱1> <邮箱2> ...", file=sys.stderr)
        sys.exit(1)

    results = []
    for email in emails:
        # 去重检查
        chk = run_sql(f"SELECT email FROM auth.users WHERE email = '{email}'")
        if chk.stdout.strip():
            results.append((email, "", "已存在，跳过"))
            continue

        pw = gen_password(6)
        sql = (
            "INSERT INTO auth.users "
            "(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at) "
            "VALUES ("
            "'00000000-0000-0000-0000-000000000000', "
            "gen_random_uuid(), "
            "'authenticated', "
            "'authenticated', "
            f"'{email}', "
            f"crypt('{pw}', gen_salt('bf')), "
            "now(), "
            "'{}', "
            "now(), "
            "now()"
            ")"
        )
        r = run_sql(sql)
        if r.returncode == 0:
            results.append((email, pw, "成功"))
        else:
            err = (r.stderr or "").strip().split("\n")[0][:120]
            results.append((email, pw, f"失败: {err}"))

    print("\n===== 注册结果（邮箱 \t 密码 \t 状态）=====")
    for email, pw, status in results:
        print(f"{email}\t{pw}\t{status}")
    print("=" * 50)


if __name__ == "__main__":
    main()
