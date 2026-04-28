# 认证与数据隔离实现计划

> **目标受众**：Codex / 开发者
> **项目背景**：Temu 商品采集系统，包含 Chrome 扩展插件（MV3）+ FastAPI 后端 + 管理后台 HTML 页面
> **核心需求**：
> 1. 插件需要登录后才能使用
> 2. 管理后台（`/admin/*`）需要登录
> 3. 数据按用户隔离，用户只能看/操作自己的数据
> 4. admin 角色可以查看和操作所有用户的数据

---

## 一、总体架构设计

### 认证方案：JWT（Bearer Token）

```
[插件 popup 登录] ─→ POST /api/auth/login ─→ 返回 access_token (JWT)
                                                        │
                  ┌─────────────────────────────────────┘
                  ↓
[chrome.storage.local 存储 token]
                  │
                  ↓ 每次 API 请求带上 Authorization: Bearer <token>
                  │
[background.js fetch] ─→ FastAPI 路由 → get_current_user() 依赖注入
                                              │
                              ┌───────────────┴──────────────┐
                              ↓                               ↓
                         普通用户：                       admin 用户：
                    query.filter_by(user_id=me.id)     不加 user_id 过滤
```

### 用户角色

| role   | 权限                             |
|--------|----------------------------------|
| `user` | 只读写自己的数据                 |
| `admin`| 查看/操作所有用户数据，管理用户  |

---

## 二、后端变更

### 2.1 新增依赖

在 `requirements.txt` 追加：

```
python-jose[cryptography]==3.3.0
passlib[bcrypt]==1.7.4
```

### 2.2 新增 User 模型

新建 `backend/app/models/user.py`：

```python
from sqlalchemy import Boolean, String
from sqlalchemy.orm import Mapped, mapped_column
from app.models.base import Base, TimestampMixin

class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(256), unique=True, nullable=False, index=True)
    hashed_password: Mapped[str] = mapped_column(String(128), nullable=False)
    role: Mapped[str] = mapped_column(String(16), default="user", nullable=False)
    # role 取值: "user" | "admin"
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
```

在 `backend/app/models/__init__.py` 添加：

```python
from app.models.user import User
```

### 2.3 数据隔离：在现有数据表加 user_id

以下表需要加 `user_id` 外键，关联到 `users.id`：

- `crawl_runs`（`CrawlRun`）
- `crawl_edges`（`CrawlEdge`，如果有）
- 任何存储采集商品的表（`products`、`scraped_products` 等）

在每个模型加字段：

```python
from sqlalchemy import ForeignKey
user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
# nullable=True 兼容存量数据；存量数据 user_id=NULL 视为"遗留数据"，仅 admin 可见
```

**迁移策略**：  
使用 Alembic 生成迁移脚本（`alembic revision --autogenerate -m "add_user_id_to_tables"`），然后 `alembic upgrade head`。

### 2.4 JWT 工具模块

新建 `backend/app/core/security.py`：

```python
from datetime import datetime, timedelta
from jose import jwt, JWTError
from passlib.context import CryptContext
from app.core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)

def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)

def create_access_token(subject: int | str, role: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=settings.jwt_expire_minutes)
    payload = {"sub": str(subject), "role": role, "exp": expire}
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")

def decode_token(token: str) -> dict:
    # 抛出 JWTError 表示 token 无效或过期
    return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
```

在 `backend/app/core/config.py` 的 `Settings` 类加字段：

```python
jwt_secret: str = "CHANGE_ME_IN_PRODUCTION"   # 从环境变量读取
jwt_expire_minutes: int = 60 * 24 * 7         # 7 天
```

### 2.5 FastAPI 依赖注入：get_current_user

新建 `backend/app/api/deps.py`：

```python
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from app.core.security import decode_token
from app.core.db import get_db
from app.models.user import User
from jose import JWTError

bearer_scheme = HTTPBearer()

def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    token = credentials.credentials
    try:
        payload = decode_token(token)
        user_id = int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token 无效或已过期")
    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在或已停用")
    return user

def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员权限")
    return current_user
```

### 2.6 认证路由

新建 `backend/app/api/routes/auth.py`：

```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr
from app.core.db import get_db
from app.core.security import verify_password, hash_password, create_access_token
from app.models.user import User
from app.api.deps import get_current_user

router = APIRouter()

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    # 注：普通注册默认 role=user；admin 只能由已有 admin 在管理后台创建

class UserMe(BaseModel):
    id: int
    email: str
    role: str

@router.post("/api/auth/login", response_model=TokenResponse, tags=["auth"])
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter_by(email=body.email, is_active=True).first()
    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="邮箱或密码错误")
    token = create_access_token(user.id, user.role)
    return TokenResponse(access_token=token, role=user.role)

@router.post("/api/auth/register", response_model=TokenResponse, tags=["auth"], status_code=201)
def register(body: RegisterRequest, db: Session = Depends(get_db)):
    if db.query(User).filter_by(email=body.email).first():
        raise HTTPException(status_code=400, detail="邮箱已被注册")
    user = User(email=body.email, hashed_password=hash_password(body.password), role="user")
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_access_token(user.id, user.role)
    return TokenResponse(access_token=token, role=user.role)

@router.get("/api/auth/me", response_model=UserMe, tags=["auth"])
def me(current_user: User = Depends(get_current_user)):
    return UserMe(id=current_user.id, email=current_user.email, role=current_user.role)
```

在 `backend/app/api/router.py` 注册：

```python
from app.api.routes import auth, ...
api_router.include_router(auth.router)
```

### 2.7 在现有路由加数据隔离

**原则**：所有需要鉴权的路由加 `current_user: User = Depends(get_current_user)`；查询时：

```python
# 普通用户：只查自己
# admin：查全部

def scoped_query(db, model, current_user):
    q = db.query(model)
    if current_user.role != "admin":
        q = q.filter(model.user_id == current_user.id)
    return q
```

写入时设置 `user_id`：

```python
new_run = CrawlRun(user_id=current_user.id, ...)
```

**需要修改的路由文件**（以下全部加鉴权 + 数据隔离）：

| 文件 | 操作 |
|------|------|
| `routes/runs.py` | 读写 CrawlRun 加 user_id 隔离 |
| `routes/upload.py` | 上传数据关联 user_id |
| `routes/dashboard.py` | products 查询加 user_id 过滤 |
| `routes/config.py` | exclusion-keywords 按 user 隔离（或保持全局，视需求定） |

### 2.8 初始 Admin 账号 seed

在 `backend/app/core/db.py` 的 `init_db()` 里添加（仅在表为空时执行）：

```python
def seed_admin(db):
    from app.models.user import User
    from app.core.security import hash_password
    import os
    if db.query(User).count() == 0:
        admin = User(
            email=os.environ.get("ADMIN_EMAIL", "admin@example.com"),
            hashed_password=hash_password(os.environ.get("ADMIN_PASSWORD", "changeme123")),
            role="admin",
        )
        db.add(admin)
        db.commit()
```

---

## 三、插件端变更

### 3.1 登录状态存储

在 `background.js` 统一管理 token：

```javascript
const AUTH_TOKEN_KEY = 'temu_auth_token';
const AUTH_USER_KEY  = 'temu_auth_user';  // { email, role }

async function getToken() {
    const r = await chrome.storage.local.get([AUTH_TOKEN_KEY]);
    return r[AUTH_TOKEN_KEY] || null;
}

async function setAuth(token, user) {
    await chrome.storage.local.set({ [AUTH_TOKEN_KEY]: token, [AUTH_USER_KEY]: user });
}

async function clearAuth() {
    await chrome.storage.local.remove([AUTH_TOKEN_KEY, AUTH_USER_KEY]);
}
```

### 3.2 所有 API 请求带 token

修改 `background.js` 里的 `postJson` / `getJson`，统一加 `Authorization` header：

```javascript
async function authHeaders() {
    const token = await getToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

async function postJson(path, body) {
    const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) };
    const response = await fetch(`${BACKEND_BASE_URL}${path}`, {
        method: 'POST', headers, body: JSON.stringify(body),
    });
    // ... 原有处理逻辑
    if (response.status === 401) {
        await clearAuth();
        return { ok: false, status: 401, error: '登录已过期，请重新登录' };
    }
    // ...
}

// getJson 同理
```

### 3.3 新增登录 action

在 `background.js` 的消息处理（`handleBackendAction`）里加：

```javascript
if (msg.action === 'login') {
    const result = await postJson('/api/auth/login', { email: msg.email, password: msg.password });
    if (result.ok) {
        await setAuth(result.access_token, { role: result.role });
    }
    return result;
}

if (msg.action === 'logout') {
    await clearAuth();
    return { ok: true };
}

if (msg.action === 'getAuthUser') {
    const r = await chrome.storage.local.get([AUTH_USER_KEY]);
    const token = await getToken();
    return { ok: !!token, user: r[AUTH_USER_KEY] || null };
}
```

### 3.4 popup.html 加登录页面

在 `popup.html` 的顶部加一个登录面板（默认隐藏，未登录时显示）：

```html
<!-- 登录面板 -->
<div id="loginPanel" style="display:none; padding:16px;">
  <div class="section-title">登录</div>
  <div class="cfg-row">
    <label>邮箱</label>
    <input type="email" id="loginEmail" placeholder="your@email.com" />
  </div>
  <div class="cfg-row">
    <label>密码</label>
    <input type="password" id="loginPassword" placeholder="••••••••" />
  </div>
  <div id="loginError" style="color:red; font-size:12px; display:none;"></div>
  <button id="loginBtn" class="btn-primary">登 录</button>
</div>

<!-- 主面板（已登录时显示）-->
<div id="mainPanel">
  <!-- 现有所有内容 -->
  <!-- 在"更多设置"区加一个退出登录按钮 -->
  <div id="userInfo" style="font-size:12px; color:#888;"></div>
  <button id="logoutBtn" class="btn-secondary">退出登录</button>
</div>
```

### 3.5 popup.js 登录逻辑

在 `popup.js` 初始化时检查登录状态：

```javascript
async function initAuth() {
    const { ok, user } = await callRuntime('getAuthUser');
    if (!ok) {
        document.getElementById('loginPanel').style.display = '';
        document.getElementById('mainPanel').style.display = 'none';
    } else {
        document.getElementById('loginPanel').style.display = 'none';
        document.getElementById('mainPanel').style.display = '';
        document.getElementById('userInfo').textContent = `${user.email}（${user.role}）`;
    }
}

document.getElementById('loginBtn')?.addEventListener('click', async () => {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const result = await callRuntime('login', { email, password });
    if (result.ok) {
        await initAuth();
    } else {
        const errEl = document.getElementById('loginError');
        errEl.textContent = result.error || '登录失败';
        errEl.style.display = '';
    }
});

document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await callRuntime('logout');
    await initAuth();
});

// 在 DOMContentLoaded 最后调用
initAuth();
```

---

## 四、管理后台变更

### 4.1 新增登录页

新建 `backend/app/web/login.html`，提供一个简单的登录表单：

- 表单 POST（AJAX）到 `/api/auth/login`
- 成功后将 `access_token` 存入 `sessionStorage`（key: `temu_admin_token`），并跳转到 `/admin/products`
- 失败显示错误信息

```html
<!-- 关键 JS 逻辑示意 -->
<script>
async function doLogin(email, password) {
    const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (res.ok) {
        sessionStorage.setItem('temu_admin_token', data.access_token);
        sessionStorage.setItem('temu_admin_role', data.role);
        location.href = '/admin/products';
    } else {
        showError(data.detail || '登录失败');
    }
}
</script>
```

### 4.2 管理后台各页加鉴权拦截

在所有 admin HTML 页的公共 JS（或每个页面内联）加：

```javascript
function getAdminToken() {
    return sessionStorage.getItem('temu_admin_token');
}

function authFetch(url, options = {}) {
    const token = getAdminToken();
    if (!token) { location.href = '/login'; return Promise.reject('未登录'); }
    return fetch(url, {
        ...options,
        headers: {
            ...(options.headers || {}),
            'Authorization': `Bearer ${token}`,
        },
    }).then(res => {
        if (res.status === 401) { location.href = '/login'; }
        return res;
    });
}
```

将页面内所有 `fetch(...)` 替换为 `authFetch(...)`。

### 4.3 新增登录路由

在 `backend/app/api/router.py`（或 `main.py`）注册静态文件路由：

```python
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

@app.get("/login", response_class=HTMLResponse, include_in_schema=False)
def login_page():
    # 读取并返回 login.html
    with open("app/web/login.html") as f:
        return f.read()
```

（或继续用 Jinja2 模板，与现有 admin 页风格保持一致）

### 4.4 管理后台增加用户管理页（可选，admin 专用）

`/admin/users` 页面，提供：

- 用户列表（id、email、role、is_active、created_at）
- 创建用户（可指定 role=admin）
- 停用/启用用户

对应后端路由 `routes/admin_users.py`（受 `require_admin` 保护）：

```
GET  /api/admin/users
POST /api/admin/users
PATCH /api/admin/users/{user_id}
```

---

## 五、实现顺序（推荐）

```
Step 1  后端 User 模型 + security.py + deps.py
Step 2  后端 auth 路由（login / register / me）
Step 3  后端 seed_admin()，验证登录接口可用
Step 4  Alembic 迁移：给 crawl_runs / products 等表加 user_id 列
Step 5  后端现有路由加鉴权 + 数据隔离
Step 6  插件 background.js：token 存储 + authHeaders
Step 7  插件 popup.html + popup.js：登录面板
Step 8  管理后台：login.html + authFetch 替换
Step 9  （可选）管理后台用户管理页
```

---

## 六、关键约束与注意事项

1. **token 存储位置**：插件用 `chrome.storage.local`（持久化，跨会话保持登录）；管理后台用 `sessionStorage`（关闭浏览器自动退出）。

2. **CORS**：插件通过 background service worker 发请求（不受 CORS 限制），无需改动。管理后台是同域，也无需 CORS 配置。

3. **密码强度**：注册时至少验证密码长度 ≥ 8 位（Pydantic validator）。

4. **jwt_secret 必须从环境变量读取**，不能硬编码在代码里。生产环境使用强随机字符串（≥32位）。

5. **存量数据兼容**：`user_id = NULL` 的历史数据只有 admin 能看（`scoped_query` 里 admin 不过滤即可覆盖）。

6. **Token 过期处理**：插件收到 401 时调用 `clearAuth()`，并在日志面板显示"登录已过期"；popup 重新弹出登录面板。

7. **exclusion_keywords 表**：关键词是全局配置，建议不做 user_id 隔离（所有用户共享同一份），只有 admin 可以增删。

---

## 七、文件变更清单

### 新增文件

| 路径 | 说明 |
|------|------|
| `backend/app/models/user.py` | User ORM 模型 |
| `backend/app/core/security.py` | 密码哈希 + JWT 工具 |
| `backend/app/api/deps.py` | `get_current_user` / `require_admin` 依赖 |
| `backend/app/api/routes/auth.py` | 登录 / 注册 / me 接口 |
| `backend/app/api/routes/admin_users.py` | 用户管理接口（可选） |
| `backend/app/web/login.html` | 管理后台登录页 |
| `backend/alembic/versions/xxx_add_user_id.py` | 数据库迁移脚本 |

### 修改文件

| 路径 | 变更 |
|------|------|
| `backend/app/models/__init__.py` | 加 User import |
| `backend/app/models/crawl_run.py` | 加 `user_id` 字段 |
| `backend/app/core/config.py` | 加 `jwt_secret`, `jwt_expire_minutes` |
| `backend/app/core/db.py` | 加 `seed_admin()` |
| `backend/app/api/router.py` | 注册 auth / admin_users router |
| `backend/app/api/routes/runs.py` | 加鉴权 + 数据隔离 |
| `backend/app/api/routes/upload.py` | 加鉴权 + 写入 user_id |
| `backend/app/api/routes/dashboard.py` | 加鉴权 + 数据隔离 |
| `backend/app/api/routes/config.py` | exclusion-keywords 写接口加 require_admin |
| `backend/requirements.txt` | 加 python-jose, passlib |
| `temu-extension/background.js` | token 管理 + authHeaders + login/logout action |
| `temu-extension/popup.html` | 加登录面板 HTML |
| `temu-extension/popup.js` | 加登录/登出逻辑 + initAuth() |
| `backend/app/web/products.html` | fetch → authFetch |
| `backend/app/web/*.html` | 其他 admin 页 fetch → authFetch |
