import json
import urllib.request
from urllib.error import HTTPError

BASE_URL = "http://localhost:4000"
LOGIN_PAYLOAD = {
    "email": "admin@receptionmate.ai",
    "password": "ChangeMe123!",
    "garageId": "827efd7f-c5df-47b1-b2b0-f9a5bde39efa",
}
CREATE_PAYLOAD = {
    "email": "test-response@receptionmate.ai",
    "password": "TestPass123!",
    "role": "USER",
    "garageAccessIds": ["827efd7f-c5df-47b1-b2b0-f9a5bde39efa"],
}


def post_json(path, data, token=None):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.load(resp)
    except HTTPError as err:
        payload = err.read().decode("utf-8")
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            pass
        return err.code, payload
    return err.code, payload


def get_json(path, token=None):
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        method="GET",
        headers={"Content-Type": "application/json"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.load(resp)
    except HTTPError as err:
        payload = err.read().decode("utf-8")
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            pass
        return err.code, payload


def delete(path, token):
    req = urllib.request.Request(
        f"{BASE_URL}{path}",
        method="DELETE",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, None
    except HTTPError as err:
        payload = err.read().decode("utf-8")
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            pass
        return err.code, payload


def main():
    login_status, login_body = post_json("/api/auth/login", LOGIN_PAYLOAD)
    print("LOGIN", login_status, login_body)
    if login_status != 200 or "token" not in login_body:
        return
    token = login_body["token"]

    businesses_status, businesses_body = get_json("/api/admin/businesses", token)
    print("BUSINESSES", businesses_status, businesses_body)

    create_status, create_body = post_json("/api/admin/users", CREATE_PAYLOAD, token)
    print("CREATE", create_status, create_body)

    if create_status == 201 and create_body.get("user"):
        user_id = create_body["user"]["id"]
        delete_status, delete_body = delete(f"/api/admin/users/{user_id}", token)
        print("DELETE", delete_status, delete_body)


if __name__ == "__main__":
    main()
