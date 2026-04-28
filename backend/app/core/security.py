from datetime import datetime, timedelta, timezone
import base64
import hashlib
import hmac
import secrets

from jose import jwt
from passlib.context import CryptContext

from app.core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
PBKDF2_PREFIX = "pbkdf2_sha256"
PBKDF2_ITERATIONS = 260_000


def verify_password(plain: str, hashed: str) -> bool:
    if str(hashed or "").startswith(f"{PBKDF2_PREFIX}$"):
        return verify_pbkdf2_password(plain, hashed)
    if (
        isinstance(plain, str)
        and len(plain.encode("utf-8")) > 72
        and str(hashed or "").startswith(("$2a$", "$2b$", "$2y$"))
    ):
        return False
    try:
        return pwd_context.verify(plain, hashed)
    except ValueError:
        # bcrypt 对明文有 72-byte 限制；旧 hash + 超长密码时会抛 ValueError。
        # 认证层应返回校验失败，而不是让服务崩溃。
        return False


def hash_password(plain: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        plain.encode("utf-8"),
        salt,
        PBKDF2_ITERATIONS,
    )
    salt_text = base64.urlsafe_b64encode(salt).decode("ascii").rstrip("=")
    digest_text = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return f"{PBKDF2_PREFIX}${PBKDF2_ITERATIONS}${salt_text}${digest_text}"


def verify_pbkdf2_password(plain: str, hashed: str) -> bool:
    try:
        _, iterations_text, salt_text, expected_text = hashed.split("$", 3)
        iterations = int(iterations_text)
        salt = base64.urlsafe_b64decode(salt_text + "=" * (-len(salt_text) % 4))
        expected = base64.urlsafe_b64decode(expected_text + "=" * (-len(expected_text) % 4))
    except (ValueError, TypeError):
        return False

    digest = hashlib.pbkdf2_hmac(
        "sha256",
        plain.encode("utf-8"),
        salt,
        iterations,
    )
    return hmac.compare_digest(digest, expected)


def create_access_token(subject: int | str, role: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    payload = {
        "sub": str(subject),
        "role": role,
        "exp": expire,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
