# 🎯 KIMatrix Backend API

> B2B SaaS QR-based customer purchase tracking platform for fuel stations and shops in Niger, West Africa.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22-green)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-lightgrey)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue)](https://www.postgresql.org/)
[![TypeORM](https://img.shields.io/badge/TypeORM-0.3-orange)](https://typeorm.io/)
[![License](https://img.shields.io/badge/license-MIT-green)]()

## 📋 Table of Contents

- [Overview](#-overview)
- [Features](#-features)
- [Tech Stack](#-tech-stack)
- [Architecture](#-architecture)
- [Prerequisites](#-prerequisites)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Database Setup](#-database-setup)
- [Running the Application](#-running-the-application)
- [API Documentation](#-api-documentation)
- [Project Structure](#-project-structure)
- [Security](#-security)
- [Deployment](#-deployment)
- [Contributing](#-contributing)

---

## 🌟 Overview

**KIMatrix** is a comprehensive B2B SaaS platform that enables businesses (fuel stations and shops) in Niger to track customer purchases through QR codes. Customers scan a QR code, submit purchase details without requiring authentication, and businesses gain insights through a powerful dashboard.

### Key Value Propositions

- **Zero Friction**: Customers submit purchases without login
- **PayPal Integration**: Self-service subscription with automatic activation
- **Real-time Tracking**: Live customer data and top spender rankings
- **Mobile-First**: Optimized for 3G networks and budget Android devices
- **Secure**: JWT authentication, refresh token rotation, HIBP password checking

---

## ✨ Features

### 🔐 Authentication & Authorization

- JWT-based authentication with access + refresh token rotation
- Refresh token theft detection (revokes all sessions on reuse)
- Password reset via email (SMTP + BullMQ queue)
- HIBP k-anonymity password breach checking
- Role-based access control (Super Admin, Company)

### 💳 Payment Integration

- **PayPal Sandbox/Live** support
- Self-service subscription (7/15/21/30 day plans)
- Automatic activation on payment capture
- Subscription stacking (renew early, keep remaining days)
- Webhook backup (captures payment if user closes browser)

### 📱 QR Submission

- Mobile-first customer purchase form
- Business-type aware (Fuel Station requires vehicle number)
- Rate limiting: 10/min, 50/day per (company, mobile)
- 15-minute cooldown (same mobile can't resubmit at same company)
- Optional geolocation capture (browser API)
- Invoice duplicate prevention (DB constraint)

### 📊 Company Dashboard

- Real-time stats (total customers, total spend, top spender)
- Paginated customer list (search, sort, filter)
- Paginated purchase history
- CSV exports (customers + purchases)
- Subscription status tracking

### 👑 Super Admin Panel

- Platform-wide statistics
- Company management (activate/deactivate)
- Three-state company status (Pending/Active/Deactivated)
- Manual activation override (for promotions)

---

## 🛠️ Tech Stack

| Layer           | Technology                                  |
| --------------- | ------------------------------------------- |
| **Runtime**     | Node.js 22.x + TypeScript 5.3 (ES2022, ESM) |
| **Framework**   | Express 4.x                                 |
| **Database**    | PostgreSQL 16 + TypeORM 0.3.x               |
| **Validation**  | Joi                                         |
| **Auth**        | JWT (jsonwebtoken) + bcryptjs               |
| **Cache/Queue** | Redis + BullMQ + ioredis                    |
| **Email**       | Nodemailer (SMTP)                           |
| **Payment**     | PayPal REST API v2                          |
| **Security**    | Helmet, CORS, express-rate-limit            |
| **Logging**     | Pino (structured JSON logs)                 |
| **Dev Tools**   | tsx (watch), ESLint, Prettier, Husky        |

---

## 🏗️ Architecture

### Layered Architecture

```
Client Request
   ↓
Route (auth → validation → handler)
   ↓
Controller (parse request, call service, format response)
   ↓
Service (business logic, orchestration)
   ↓
Repository (data access, TypeORM queries)
   ↓
Database (PostgreSQL)
```

### Key Patterns

- **Repository Pattern**: Centralized data access
- **Service Layer**: Business logic isolation
- **Factory Error Functions**: `BadRequestError()`, `NotFoundError()`, etc.
- **Global Error Handler**: Unified error response format
- **Pessimistic Locking**: Payment capture uses `FOR UPDATE`
- **Atomic Aggregates**: Customer totals via SQL expressions (not read-modify-write)

---

## 📦 Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** >= 22.0.0 ([Download](https://nodejs.org/))
- **PostgreSQL** >= 16.0 ([Download](https://www.postgresql.org/download/))
- **Redis** >= 7.0 ([Download](https://redis.io/download))
- **npm** >= 10.0.0 (comes with Node.js)

Optional but recommended:

- **Docker** + **Docker Compose** (for PostgreSQL + Redis)
- **pgAdmin** or **DBeaver** (database GUI)

---

## 🚀 Installation

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/kimatrix-api.git
cd kimatrix-api
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Setup Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and fill in your actual values:

```bash
# Generate strong JWT secrets (min 32 chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Copy output to JWT_SECRET and JWT_REFRESH_SECRET
```

**Required Variables:**

- `JWT_SECRET` (min 32 chars)
- `JWT_REFRESH_SECRET` (different from JWT_SECRET)
- `DB_PASSWORD`
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `SMTP_USER`, `SMTP_PASS`

---

## ⚙️ Configuration

### Environment Variables

See [`.env.example`](.env.example) for all available configuration options.

### Key Settings

| Variable                       | Default       | Description                  |
| ------------------------------ | ------------- | ---------------------------- |
| `NODE_ENV`                     | `development` | Environment mode             |
| `PORT`                         | `5000`        | Server port                  |
| `JWT_EXPIRES_IN`               | `24h`         | Access token lifetime        |
| `JWT_REFRESH_EXPIRES_IN`       | `7d`          | Refresh token lifetime       |
| `QR_MIN_RESUBMIT_INTERVAL_MIN` | `15`          | Cooldown between submissions |
| `MAX_INVOICE_AMOUNT`           | `10000000`    | Maximum invoice amount       |
| `PAYPAL_MODE`                  | `sandbox`     | `sandbox` or `live`          |

---

## 🗄️ Database Setup

### Using Docker (Recommended)

```bash
# Start PostgreSQL + Redis via Docker Compose
docker-compose up -d

# Verify containers are running
docker ps
```

### Manual Setup

```bash
# Create database
createdb kimatrix_dev

# Or via psql
psql -U postgres
CREATE DATABASE kimatrix_dev;
\q
```

### Run Migrations

```bash
# Generate a new migration (if entities changed)
npm run migration:generate -- migrations/YourMigrationName

# Run all pending migrations
npm run migration:run

# Revert last migration
npm run migration:revert
```

### Seed Data

```bash
# Seed subscription plans (7/15/21/30 day in ZAR)
npm run seed:plans

# Create first super admin
npm run seed:superadmin -- --email admin@kimatrix.com --password 'YourStrongPassword123!'
```

---

## 🏃 Running the Application

### Development Mode (with hot reload)

```bash
npm run dev
```

The server will start on `http://localhost:5000`

### Production Build

```bash
# Build TypeScript to JavaScript
npm run build

# Start production server
npm start
```

### Linting & Formatting

```bash
# Run ESLint
npm run lint

# Fix auto-fixable issues
npm run lint:fix

# Format code with Prettier
npm run format
```

### Type Checking

```bash
npm run typecheck
```

---

## 📚 API Documentation

### Base URL

```
http://localhost:5000/api
```

### Health Checks

```bash
# Liveness probe
GET /health

# Readiness probe (checks DB + Redis)
GET /ready
```

### Authentication

All authenticated endpoints require:

```
Authorization: Bearer <access_token>
```

### Endpoints Overview

| Endpoint                          | Method | Auth        | Description                               |
| --------------------------------- | ------ | ----------- | ----------------------------------------- |
| `/auth/register/company`          | POST   | None        | Register new company (pending activation) |
| `/auth/login`                     | POST   | None        | Login (email or username)                 |
| `/auth/refresh`                   | POST   | None        | Refresh access token                      |
| `/auth/logout`                    | POST   | None        | Revoke refresh token                      |
| `/auth/password-reset/request`    | POST   | None        | Request password reset                    |
| `/auth/password-reset/confirm`    | POST   | None        | Confirm password reset                    |
| `/auth/password-change`           | POST   | JWT         | Change password (in-app)                  |
| `/payments/plans`                 | GET    | None        | List subscription plans                   |
| `/payments/paypal/create-order`   | POST   | Company     | Initiate PayPal payment                   |
| `/payments/paypal/capture-order`  | POST   | Company     | Capture PayPal payment                    |
| `/payments/paypal/webhook`        | POST   | None        | PayPal webhook (signed)                   |
| `/company/profile`                | GET    | Company     | Get company profile                       |
| `/company/profile`                | PUT    | Company     | Update company profile                    |
| `/company/stats`                  | GET    | Company     | Dashboard statistics                      |
| `/company/customers`              | GET    | Company     | List customers (paginated)                |
| `/company/customers/:id`          | GET    | Company     | Get customer detail                       |
| `/company/customers/export`       | GET    | Company     | Export customers CSV                      |
| `/company/purchases`              | GET    | Company     | List purchases (paginated)                |
| `/company/purchases/:id`          | GET    | Company     | Get purchase detail                       |
| `/company/purchases/export`       | GET    | Company     | Export purchases CSV                      |
| `/qr/:qrToken`                    | GET    | None        | Resolve QR token to company               |
| `/qr/:qrToken/submit`             | POST   | None        | Customer purchase submission              |
| `/admin/stats`                    | GET    | Super Admin | Platform statistics                       |
| `/admin/companies`                | GET    | Super Admin | List companies (paginated)                |
| `/admin/companies/:id`            | GET    | Super Admin | Get company detail                        |
| `/admin/companies/:id/activate`   | PATCH  | Super Admin | Activate company                          |
| `/admin/companies/:id/deactivate` | PATCH  | Super Admin | Deactivate company                        |

For detailed request/response schemas, see [`FRONTEND_API_GUIDE.md`](FRONTEND_API_GUIDE.md).

---

## 📂 Project Structure

```
backend/
├── src/
│   ├── config/               # Environment config, Redis, mailer
│   ├── controllers/          # HTTP request handlers
│   ├── cron/                 # Scheduled tasks (token cleanup)
│   ├── entities/             # TypeORM entities (7 tables)
│   ├── errors/               # Error factory functions
│   ├── middleware/           # Auth, validation, rate limiting, error handler
│   ├── queues/               # BullMQ job queues
│   ├── repositories/         # Data access layer
│   ├── routes/               # Express routes
│   ├── services/             # Business logic layer
│   ├── templates/            # Email templates
│   ├── types/                # TypeScript types
│   ├── utils/                # Logger, crypto utilities
│   ├── validation/schemas/   # Joi validation schemas
│   ├── workers/              # BullMQ workers
│   ├── app.ts                # Express app configuration
│   └── server.ts             # Entry point (DB init, graceful shutdown)
├── migrations/               # TypeORM migrations
├── scripts/                  # Seed scripts, utilities
├── .husky/                   # Git hooks (pre-commit)
├── data-source.ts            # TypeORM DataSource config
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

---

## 🔒 Security

### Implemented Security Measures

✅ **Authentication**

- JWT with rotation + theft detection
- bcrypt password hashing (cost 12)
- HIBP k-anonymity password checking
- Refresh token single-use (one-time rotation)

✅ **Rate Limiting**

- Global API: 100 req/15min per IP
- Login: 5 req/min per IP
- Password reset: 3 req/min per IP
- QR submit: 10/min + 50/day per (company, mobile)
- 15-min cooldown per (company, mobile)

✅ **Input Validation**

- Joi schemas with `stripUnknown: true`
- SQL injection protection (TypeORM parameterized queries)
- XSS prevention (no raw HTML rendering)

✅ **Headers & CORS**

- Helmet.js (CSP, HSTS, XSS protection)
- CORS restricted to `FRONTEND_BASE_URL`
- X-Frame-Options: DENY

✅ **Secrets Management**

- All secrets in `.env` (never committed)
- Pino logger redacts password/token fields
- PayPal credentials validated at startup

✅ **Database**

- Pessimistic locking on payment capture
- Unique constraints (email, username, invoice)
- Soft deletes (preserves audit trail)
- RESTRICT on foreign keys (no cascade delete)

### Security Checklist (Production)

- [ ] Generate strong JWT secrets (64+ chars)
- [ ] Enable PostgreSQL SSL (`DB_SSL=true`)
- [ ] Set Redis password (`REDIS_PASSWORD`)
- [ ] Use PayPal live credentials (`PAYPAL_MODE=live`)
- [ ] Enable SMTP TLS (`SMTP_SECURE=true`)
- [ ] Configure firewall (PostgreSQL, Redis not public)
- [ ] Set up SSL/TLS certificate (nginx/Cloudflare)
- [ ] Enable log rotation (Pino + winston-daily-rotate)
- [ ] Configure Sentry error tracking
- [ ] Set up monitoring (UptimeRobot, BetterStack)

---

## 🚀 Deployment

### Docker Deployment

```bash
# Build Docker image
docker build -t kimatrix-api:latest .

# Run container
docker run -d \
  --name kimatrix-api \
  -p 5000:5000 \
  --env-file .env \
  kimatrix-api:latest
```

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Run migrations: `npm run migration:run`
- [ ] Seed plans: `npm run seed:plans`
- [ ] Create super admin: `npm run seed:superadmin`
- [ ] Configure reverse proxy (nginx)
- [ ] Set up SSL certificate
- [ ] Configure log aggregation
- [ ] Set up automated backups (PostgreSQL)
- [ ] Configure monitoring alerts
- [ ] Test webhook endpoint (PayPal)

### Environment Variables (Production)

```bash
NODE_ENV=production
DB_SSL=true
PAYPAL_MODE=live
APP_BASE_URL=https://api.kimatrix.com
FRONTEND_BASE_URL=https://kimatrix.com
```

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Coding Standards

- **TypeScript**: Strict mode enabled
- **ESLint**: No warnings in production builds
- **Prettier**: Format before commit (pre-commit hook)
- **Commits**: Use conventional commits (feat, fix, docs, etc.)

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 📞 Support

For issues and questions:

- 📧 Email: support@kimatrix.com
- 🐛 Issues: [GitHub Issues](https://github.com/yourusername/kimatrix-api/issues)
- 📚 Docs: [API Documentation](FRONTEND_API_GUIDE.md)

---

## 🙏 Acknowledgments

- Built for fuel stations and shops in Niger, West Africa
- Designed for low-bandwidth, mobile-first environments
- Inspired by the need for simple, effective customer tracking

---

**Made with ❤️ for small businesses in West Africa**
