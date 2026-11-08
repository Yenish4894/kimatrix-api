# Infrastructure

One Ubuntu 24.04 VPS at OVH (`kimates.com`). aaPanel was removed on 2026-10-31; everything is now standard packages. Credentials live in the owner's `CREDENTIALS.md`, never in this repo.

## Services on the box

| Service              | How it runs                                                                                        | Notes                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nginx 1.24           | `systemctl`, site `/etc/nginx/sites-available/kimates.com`, tuning in `conf.d/kimates-tuning.conf` | `/api/`, `/health`, `/ready` → 127.0.0.1:9420; everything else → 127.0.0.1:3000. www and http redirect to `https://kimates.com`                                                   |
| PostgreSQL 18 (PGDG) | cluster `18/main` on 5432                                                                          | `sudo -u postgres psql -d qr_scan`. `/etc/systemd/logind.conf.d/postgres.conf` sets `RemoveIPC=no`; without it the DB loses shared memory after a `sudo -u postgres` session ends |
| Redis 7.0 (Ubuntu)   | `/etc/redis/redis.conf`, 127.0.0.1 only                                                            | gets Ubuntu security updates                                                                                                                                                      |
| pm2                  | `pm2-ubuntu.service`, node 22 via nvm                                                              | apps `kimatrix-api` (9420) and `kimatrix-web` (3000); `pm2 save` after changes                                                                                                    |
| certbot              | `certbot.timer`, webroot `/var/www/letsencrypt`                                                    | deploy hook reloads nginx; cert renews itself                                                                                                                                     |
| fail2ban             | jail `sshd-5522.local`                                                                             | SSH is on port 5522                                                                                                                                                               |

Firewall (ufw): 80, 443, 5522 only.

## Deploy

`.github/workflows/deploy.yml`: on push to `main`, `npm ci`, `npm run lint`, `npm test`; then over SSH `git pull`, `npm ci`, `npm run build` (previous `dist` kept as `dist.prev` and restored on failure), **`npm run migration:run` against the live database**, `pm2 restart kimatrix-api --kill-timeout 12000`, then a `/ready` check.

A deploy is live only when HEAD matches, `dist` is newer than before, `dist.prev` is gone and pm2 uptime is younger than the build.

## Health and monitoring

- `GET /health` liveness; `GET /ready` checks database and Redis (`DatabaseHealthRepository`, Redis ping).
- `kimatrix-web/.github/workflows/uptime.yml` calls `/ready` and checks certificate expiry every 10 minutes from GitHub; a failure emails the repo owner. GitHub pauses scheduled workflows after 60 days without repo activity.
- Admin dashboard "Service status" shows SMTP (hourly canary), PayPal, database, Redis and queue health (`SystemStatusService`, `SmtpHealthStore`).
- Logs: `~/.pm2/logs/kimatrix-api-out-0.log` (JSON lines, rotated daily by pm2-logrotate; about a week kept).

## Backups

- Nightly `pg_dump -Fc` by `/home/ubuntu/backup-qr-scan.sh` (cron 02:30 UTC) into `/var/backups/qr_scan/`, 14 days kept, log in `backup.log`.
- **No off-site copy yet.** The owner has deferred this; raise it before real customers arrive.

## Email

Outbound through Resend's SMTP (`smtp.resend.com:465`, user `resend`), sender `info@kimates.com`. The `From` address must match the authenticated identity or mail is dropped silently. The hourly canary (`smtpCanary.cron.ts`) sends to `SMTP_CANARY_TO` and stores the result in Redis for the status panel.

## Incident history worth knowing

- 2026-10-25 to 10-31: certificate expired (nginx redirected the ACME path) and Redis stayed down after a package upgrade. Fixed, and both now have monitoring. Root causes are gone with aaPanel.
- Email was suspended four times on the previous provider for reputation; that is why mail moved to Resend.
