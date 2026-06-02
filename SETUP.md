# 🚀 Quick Setup Guide - KIMatrix Backend

> Get the backend running in under 10 minutes!

## Prerequisites Check

```bash
# Check Node.js version (need >= 22.0.0)
node --version

# Check PostgreSQL (need >= 16.0)
psql --version

# Check Redis (need >= 7.0)
redis-cli --version

# Check npm (need >= 10.0.0)
npm --version
```

---

## Step 1: Install Dependencies

```bash
npm install
```

---

## Step 2: Configure Environment

```bash
# Copy example env file
cp .env.example .env

# Generate JWT secrets
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"

# Copy the generated secrets and paste into .env file
```

**Minimum Required Variables:**

```bash
JWT_SECRET=<paste_generated_secret_here>
JWT_REFRESH_SECRET=<paste_different_secret_here>
DB_PASSWORD=your_postgres_password
```

---

## Step 3: Database Setup

### Option A: Using Docker (Easiest)

```bash
# Start PostgreSQL + Redis
docker-compose up -d

# Check containers are running
docker ps
```

### Option B: Local Installation

```bash
# Start PostgreSQL (if installed locally)
# macOS: brew services start postgresql
# Ubuntu: sudo systemctl start postgresql
# Windows: Start via Services app

# Start Redis
# macOS: brew services start redis
# Ubuntu: sudo systemctl start redis-server
# Windows: Start via Services app

# Create database
createdb kimatrix_dev

# Or via psql
psql -U postgres
CREATE DATABASE kimatrix_dev;
\q
```

---

## Step 4: Run Migrations

```bash
# Apply all migrations
npm run migration:run
```

You should see:

```
Migration InitialSchema1776194924275 has been executed successfully.
Migration AddPlansAndPayments1748100000000 has been executed successfully.
...
```

---

## Step 5: Seed Data

```bash
# Seed subscription plans (7/15/21/30 day)
npm run seed:plans

# Create first super admin
npm run seed:superadmin -- --email admin@kimatrix.com --password 'Admin123!'
```

---

## Step 6: Start Development Server

```bash
npm run dev
```

You should see:

```
[INFO] Server listening on port 5000
[INFO] Database connected
[INFO] Redis connected
```

---

## Step 7: Test the API

```bash
# Test health endpoint
curl http://localhost:5000/health

# Expected response:
# {"status":"ok","environment":"development","timestamp":"..."}

# Test readiness endpoint
curl http://localhost:5000/ready

# Expected response:
# {"status":"ready","checks":{"database":"ok","redis":"ok"},"timestamp":"..."}
```

---

## Step 8: Login as Super Admin

```bash
# Login
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "identifier": "admin@kimatrix.com",
    "password": "Admin123!"
  }'

# You'll get an access token + refresh token
```

---

## 🎉 Success!

Your backend is now running. Next steps:

1. **Test Registration**: Try registering a company via `/api/auth/register/company`
2. **Setup PayPal**: Add PayPal sandbox credentials to `.env`
3. **Configure SMTP**: Add email credentials for password reset
4. **Connect Frontend**: Point frontend to `http://localhost:5000`

---

## Common Issues

### "Migration table not found"

```bash
# Reset database
npm run migration:revert
npm run migration:run
```

### "Redis connection failed"

```bash
# Check Redis is running
redis-cli ping
# Should return: PONG

# If not running, start it:
# macOS: brew services start redis
# Ubuntu: sudo systemctl start redis-server
```

### "JWT_SECRET must be at least 32 characters"

```bash
# Generate new secrets
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Copy output to .env
```

### "Port 5000 already in use"

```bash
# Change PORT in .env
PORT=5001

# Or kill process on port 5000
# macOS/Linux: lsof -ti:5000 | xargs kill -9
# Windows: netstat -ano | findstr :5000 (then taskkill /PID <PID> /F)
```

---

## Development Workflow

```bash
# Watch mode (auto-reload on file changes)
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint
npm run lint:fix

# Format code
npm run format

# Generate new migration (after entity changes)
npm run migration:generate -- migrations/YourMigrationName

# Run migrations
npm run migration:run

# Revert last migration
npm run migration:revert
```

---

## Next Steps

- Read [README.md](README.md) for full documentation
- Check [FRONTEND_API_GUIDE.md](FRONTEND_API_GUIDE.md) for API details
- Review [FRONTEND_FLOWS.md](FRONTEND_FLOWS.md) for user flows
- Explore [`src/`](src/) folder structure

---

**Happy Coding! 🚀**
