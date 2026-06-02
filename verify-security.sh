#!/bin/bash

# KIMatrix Backend - Pre-Push Security Verification Script
# Run this before pushing to Git to ensure no secrets are exposed

echo "🔒 KIMatrix Backend - Security Verification"
echo "==========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ERRORS=0

echo "📋 Checking for sensitive files..."
echo ""

# Check if .env is staged
if git ls-files --error-unmatch .env 2>/dev/null; then
    echo -e "${RED}❌ ERROR: .env file is staged for commit!${NC}"
    echo "   Run: git rm --cached .env"
    ERRORS=$((ERRORS+1))
else
    echo -e "${GREEN}✅ .env file is properly ignored${NC}"
fi

# Check for any .env files
ENV_FILES=$(git ls-files | grep -E "^\.env($|\.)")
if [ -n "$ENV_FILES" ]; then
    echo -e "${RED}❌ ERROR: Environment files found in git:${NC}"
    echo "$ENV_FILES"
    ERRORS=$((ERRORS+1))
else
    echo -e "${GREEN}✅ No .env files in repository${NC}"
fi

# Check for node_modules
if git ls-files | grep -q "^node_modules/"; then
    echo -e "${RED}❌ ERROR: node_modules/ is in git!${NC}"
    echo "   Run: git rm -r --cached node_modules/"
    ERRORS=$((ERRORS+1))
else
    echo -e "${GREEN}✅ node_modules/ is properly ignored${NC}"
fi

# Check for dist/build folders
if git ls-files | grep -qE "^(dist|build)/"; then
    echo -e "${RED}❌ ERROR: Compiled code in git (dist/build)${NC}"
    ERRORS=$((ERRORS+1))
else
    echo -e "${GREEN}✅ No compiled code in repository${NC}"
fi

# Check for log files
if git ls-files | grep -qE "\.log$"; then
    echo -e "${RED}❌ ERROR: Log files found in git${NC}"
    ERRORS=$((ERRORS+1))
else
    echo -e "${GREEN}✅ No log files in repository${NC}"
fi

echo ""
echo "🔍 Scanning code for potential secrets..."
echo ""

# Check for hardcoded secrets (case-insensitive patterns)
SECRET_PATTERNS=(
    "password.*=.*['\"][^'\"]+"
    "secret.*=.*['\"][^'\"]+"
    "api[_-]?key.*=.*['\"][^'\"]+"
    "token.*=.*['\"][^'\"]+"
    "bearer.*[a-zA-Z0-9]{20,}"
    "aws[_-]?access[_-]?key"
    "paypal.*client.*=.*['\"][^'\"]+"
)

for pattern in "${SECRET_PATTERNS[@]}"; do
    MATCHES=$(git grep -iE "$pattern" -- '*.ts' '*.js' '*.json' 2>/dev/null | grep -v ".example" | grep -v "// " | head -5)
    if [ -n "$MATCHES" ]; then
        echo -e "${YELLOW}⚠️  WARNING: Potential secret pattern found:${NC}"
        echo "$MATCHES"
        echo ""
        ERRORS=$((ERRORS+1))
    fi
done

if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}✅ No hardcoded secrets detected${NC}"
fi

echo ""
echo "📦 Checking file sizes..."
echo ""

# Check for large files (>10MB)
LARGE_FILES=$(git ls-files | xargs -I{} sh -c '[ -f "{}" ] && [ $(stat -f%z "{}" 2>/dev/null || stat -c%s "{}" 2>/dev/null) -gt 10485760 ] && echo "{}"')
if [ -n "$LARGE_FILES" ]; then
    echo -e "${YELLOW}⚠️  WARNING: Large files detected (>10MB):${NC}"
    echo "$LARGE_FILES"
    echo ""
fi

echo ""
echo "📄 Verifying essential files..."
echo ""

# Check essential files exist
ESSENTIAL_FILES=(".gitignore" ".env.example" "README.md" "package.json" "tsconfig.json")
for file in "${ESSENTIAL_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo -e "${GREEN}✅ $file exists${NC}"
    else
        echo -e "${RED}❌ ERROR: $file is missing!${NC}"
        ERRORS=$((ERRORS+1))
    fi
done

echo ""
echo "🔐 Verifying .env.example has no secrets..."
echo ""

# Check .env.example for actual values
if grep -qE "JWT_SECRET=[a-f0-9]{32,}" .env.example; then
    echo -e "${RED}❌ ERROR: .env.example contains actual JWT secret!${NC}"
    ERRORS=$((ERRORS+1))
elif grep -q "JWT_SECRET=$" .env.example || grep -q "JWT_SECRET=GENERATE" .env.example; then
    echo -e "${GREEN}✅ .env.example has placeholder JWT_SECRET${NC}"
fi

if grep -qE "DB_PASSWORD=.{8,}" .env.example; then
    echo -e "${YELLOW}⚠️  WARNING: .env.example may contain real DB password${NC}"
fi

echo ""
echo "==========================================="
echo ""

if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}🎉 ALL CHECKS PASSED!${NC}"
    echo ""
    echo "✅ Your repository is safe to push"
    echo ""
    echo "Next steps:"
    echo "  git add ."
    echo "  git commit -m \"Initial commit: KIMatrix Backend API v1.0.0\""
    echo "  git remote add origin https://github.com/yourusername/kimatrix-api.git"
    echo "  git push -u origin main"
    echo ""
    exit 0
else
    echo -e "${RED}❌ FOUND $ERRORS ISSUE(S)${NC}"
    echo ""
    echo "⚠️  DO NOT PUSH until you fix the issues above!"
    echo ""
    echo "Common fixes:"
    echo "  • Remove .env: git rm --cached .env"
    echo "  • Remove node_modules: git rm -r --cached node_modules/"
    echo "  • Remove secrets from code and use environment variables"
    echo "  • Ensure .gitignore is properly configured"
    echo ""
    exit 1
fi
