# DMS Backend API

Node.js + Express REST API following **MVC architecture**, aligned with the DMS frontend modules.

## Folder structure

```
backend/
├── server.js                 # Application entry point
├── package.json
├── .env.example
├── src/
│   ├── app.js                # Express app setup & middleware
│   ├── config/               # Environment & database config
│   ├── controllers/          # Controller — handle HTTP req/res
│   ├── models/               # Model — data schemas & DB access
│   ├── views/                # View — response formatting & email templates
│   │   ├── responses/        # JSON output formatters
│   │   └── emails/           # Email templates (2FA, notifications)
│   ├── routes/               # Route definitions → controllers
│   ├── middleware/           # Auth, validation, errors, uploads
│   ├── services/             # Business logic (used by controllers)
│   ├── validators/           # Request validation rules
│   └── utils/                # Shared helpers (ApiError, logger, etc.)
├── tests/
│   ├── unit/
│   └── integration/
├── (uploads live under FILE_SERVER/uploads — not in this repo)
│   ├── documents/
│   └── temp/
└── logs/
```

## MVC flow

```
Request → Route → Controller → Service → Model (database)
                      ↓
                    View (format response) → JSON Response
```

| Layer | Responsibility |
|-------|----------------|
| **Model** | Database schemas, queries, data persistence |
| **View** | Response shaping (`views/responses`) and email templates |
| **Controller** | HTTP handling, calls services, returns formatted responses |
| **Routes** | URL mapping to controllers |
| **Services** | Business rules (keeps controllers thin) |

## API routes (prefix `/api`)

| Module | Base path |
|--------|-----------|
| Auth | `/api/auth` |
| Orders | `/api/orders` |
| Facilities | `/api/facilities` |
| Employees | `/api/employees` |
| Invoices | `/api/invoices` |
| Reports | `/api/reports` |
| Notifications | `/api/notifications` |
| Activity log | `/api/activity-log` |
| Settings | `/api/settings` |

## Getting started

```bash
cd backend
cp .env.example .env   # add MySQL, JWT, and SMTP values
npm install
npm run seed           # creates test user (admin@dms.local / Admin@123)
npm run dev
```

Health check: `GET http://localhost:5000/health`

## Authentication (JWT + 2FA)

Uses `matrix_employees` and `auth_sessions` in MySQL.

### Flow

1. **Login** — validate credentials, create session, email 6-digit OTP
2. **Verify 2FA** — validate OTP, issue access + refresh JWT tokens
3. **Refresh** — get a new access token using refresh token
4. **Logout** — delete session

### Auth endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Login with email/logon + password |
| POST | `/api/auth/verify-2fa` | Verify OTP and receive tokens |
| POST | `/api/auth/resend-2fa` | Resend OTP email |
| POST | `/api/auth/refresh` | Refresh access token |
| POST | `/api/auth/logout` | End session |
| GET | `/api/auth/me` | Current user (requires access token) |

### Login request

```json
{
  "email": "admin@dms.local",
  "password": "Admin@123"
}
```

### Verify 2FA request

```json
{
  "sessionToken": "<from login response>",
  "code": "123456",
  "trustDevice": true
}
```

### Token usage

Send access token on protected routes:

```
Authorization: Bearer <accessToken>
```

### Role-based access

Use middleware on protected routes:

```js
const { authenticate, authorize } = require("../middleware/authMiddleware");

router.get("/admin-only", authenticate, authorize("Manager"), controller.action);
```

Supported roles match `matrix_employees.role` (e.g. `Manager`, `Employee`).

## Environment variables

See `.env.example` for MySQL, JWT, SMTP, and session settings.
