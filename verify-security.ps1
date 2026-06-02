# KIMatrix Backend - Pre-Push Security Verification Script (PowerShell)
# Run this before pushing to Git to ensure no secrets are exposed

Write-Host ""
Write-Host "🔒 KIMatrix Backend - Security Verification" -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

$Errors = 0

Write-Host "📋 Checking for sensitive files..." -ForegroundColor Yellow
Write-Host ""

# Check if .env is staged
$envStaged = git ls-files --error-unmatch .env 2>$null
if ($envStaged) {
    Write-Host "❌ ERROR: .env file is staged for commit!" -ForegroundColor Red
    Write-Host "   Run: git rm --cached .env" -ForegroundColor Red
    $Errors++
} else {
    Write-Host "✅ .env file is properly ignored" -ForegroundColor Green
}

# Check for any .env files
$envFiles = git ls-files | Select-String -Pattern "^\.env($|\.)"
if ($envFiles) {
    Write-Host "❌ ERROR: Environment files found in git:" -ForegroundColor Red
    $envFiles | ForEach-Object { Write-Host "   $_" -ForegroundColor Red }
    $Errors++
} else {
    Write-Host "✅ No .env files in repository" -ForegroundColor Green
}

# Check for node_modules
$nodeModules = git ls-files | Select-String -Pattern "^node_modules/"
if ($nodeModules) {
    Write-Host "❌ ERROR: node_modules/ is in git!" -ForegroundColor Red
    Write-Host "   Run: git rm -r --cached node_modules/" -ForegroundColor Red
    $Errors++
} else {
    Write-Host "✅ node_modules/ is properly ignored" -ForegroundColor Green
}

# Check for dist/build folders
$compiledCode = git ls-files | Select-String -Pattern "^(dist|build)/"
if ($compiledCode) {
    Write-Host "❌ ERROR: Compiled code in git (dist/build)" -ForegroundColor Red
    $Errors++
} else {
    Write-Host "✅ No compiled code in repository" -ForegroundColor Green
}

# Check for log files
$logFiles = git ls-files | Select-String -Pattern "\.log$"
if ($logFiles) {
    Write-Host "❌ ERROR: Log files found in git" -ForegroundColor Red
    $Errors++
} else {
    Write-Host "✅ No log files in repository" -ForegroundColor Green
}

Write-Host ""
Write-Host "🔍 Scanning code for potential secrets..." -ForegroundColor Yellow
Write-Host ""

# Check for hardcoded secrets
$secretPatterns = @(
    "password.*=.*['\`"][^'\`"]+"
    "secret.*=.*['\`"][^'\`"]+"
    "api[_-]?key.*=.*['\`"][^'\`"]+"
    "token.*=.*['\`"][^'\`"]+"
    "bearer.*[a-zA-Z0-9]{20,}"
)

$secretsFound = $false
foreach ($pattern in $secretPatterns) {
    $matches = git grep -iE $pattern -- '*.ts' '*.js' '*.json' 2>$null | Select-String -Pattern "\.example" -NotMatch | Select-String -Pattern "//" -NotMatch | Select-Object -First 5
    if ($matches) {
        Write-Host "⚠️  WARNING: Potential secret pattern found:" -ForegroundColor Yellow
        $matches | ForEach-Object { Write-Host "   $_" -ForegroundColor Yellow }
        Write-Host ""
        $secretsFound = $true
        $Errors++
    }
}

if (-not $secretsFound) {
    Write-Host "✅ No hardcoded secrets detected" -ForegroundColor Green
}

Write-Host ""
Write-Host "📦 Checking file sizes..." -ForegroundColor Yellow
Write-Host ""

# Check for large files (>10MB)
$largeFiles = git ls-files | Where-Object { 
    if (Test-Path $_) {
        (Get-Item $_).Length -gt 10MB
    }
} | Select-Object -First 10

if ($largeFiles) {
    Write-Host "⚠️  WARNING: Large files detected (>10MB):" -ForegroundColor Yellow
    $largeFiles | ForEach-Object { 
        $size = [math]::Round((Get-Item $_).Length / 1MB, 2)
        Write-Host "   $_ ($size MB)" -ForegroundColor Yellow
    }
    Write-Host ""
}

Write-Host ""
Write-Host "📄 Verifying essential files..." -ForegroundColor Yellow
Write-Host ""

# Check essential files exist
$essentialFiles = @(".gitignore", ".env.example", "README.md", "package.json", "tsconfig.json")
foreach ($file in $essentialFiles) {
    if (Test-Path $file) {
        Write-Host "✅ $file exists" -ForegroundColor Green
    } else {
        Write-Host "❌ ERROR: $file is missing!" -ForegroundColor Red
        $Errors++
    }
}

Write-Host ""
Write-Host "🔐 Verifying .env.example has no secrets..." -ForegroundColor Yellow
Write-Host ""

# Check .env.example for actual values
if (Test-Path .env.example) {
    $envExample = Get-Content .env.example -Raw
    
    if ($envExample -match "JWT_SECRET=[a-f0-9]{32,}") {
        Write-Host "❌ ERROR: .env.example contains actual JWT secret!" -ForegroundColor Red
        $Errors++
    } elseif ($envExample -match "JWT_SECRET=$" -or $envExample -match "JWT_SECRET=GENERATE") {
        Write-Host "✅ .env.example has placeholder JWT_SECRET" -ForegroundColor Green
    }
    
    if ($envExample -match "DB_PASSWORD=.{8,}") {
        Write-Host "⚠️  WARNING: .env.example may contain real DB password" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host ""

if ($Errors -eq 0) {
    Write-Host "🎉 ALL CHECKS PASSED!" -ForegroundColor Green
    Write-Host ""
    Write-Host "✅ Your repository is safe to push" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  git add ."
    Write-Host "  git commit -m `"Initial commit: KIMatrix Backend API v1.0.0`""
    Write-Host "  git remote add origin https://github.com/yourusername/kimatrix-api.git"
    Write-Host "  git push -u origin main"
    Write-Host ""
    exit 0
} else {
    Write-Host "❌ FOUND $Errors ISSUE(S)" -ForegroundColor Red
    Write-Host ""
    Write-Host "⚠️  DO NOT PUSH until you fix the issues above!" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Common fixes:" -ForegroundColor Cyan
    Write-Host "  • Remove .env: git rm --cached .env"
    Write-Host "  • Remove node_modules: git rm -r --cached node_modules/"
    Write-Host "  • Remove secrets from code and use environment variables"
    Write-Host "  • Ensure .gitignore is properly configured"
    Write-Host ""
    exit 1
}
