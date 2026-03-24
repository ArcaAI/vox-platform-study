#!/bin/bash
set -euo pipefail

# Redis Backup Script
# Triggers an RDB snapshot and copies both RDB + AOF to the backup directory.
# Designed to run via cron. Pass REDIS_PASS as an environment variable.
#
# Usage:
#   REDIS_PASS="your-password" /usr/local/bin/redis-backup.sh
#
# Cron example (daily at 04:00):
#   0 4 * * * REDIS_PASS="password" /usr/local/bin/redis-backup.sh >> /opt/redis/logs/backup.log 2>&1

BACKUP_DIR="/opt/redis/backups"
DATA_DIR="/opt/redis/data"
DATE=$(date +%Y%m%d_%H%M%S)
LOG_TAG="redis-backup"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  logger -t "$LOG_TAG" "$1" 2>/dev/null || true
}

log "Starting Redis backup..."

mkdir -p "$BACKUP_DIR"

# Trigger RDB snapshot
if docker exec hope-redis redis-cli -a "${REDIS_PASS}" BGSAVE 2>/dev/null; then
  log "BGSAVE triggered"
else
  log "ERROR: Failed to trigger BGSAVE"
  exit 1
fi

# Wait for BGSAVE to complete (max 60 seconds)
for i in $(seq 1 12); do
  BGSAVE_STATUS=$(docker exec hope-redis redis-cli -a "${REDIS_PASS}" LASTSAVE 2>/dev/null)
  sleep 5
  BGSAVE_STATUS_NEW=$(docker exec hope-redis redis-cli -a "${REDIS_PASS}" LASTSAVE 2>/dev/null)
  if [ "$BGSAVE_STATUS" != "$BGSAVE_STATUS_NEW" ] || [ "$i" -ge 3 ]; then
    break
  fi
done

log "BGSAVE completed"

# Copy RDB
if [ -f "$DATA_DIR/dump.rdb" ]; then
  cp "$DATA_DIR/dump.rdb" "$BACKUP_DIR/dump_${DATE}.rdb"
  log "RDB copied: dump_${DATE}.rdb ($(du -h "$BACKUP_DIR/dump_${DATE}.rdb" | cut -f1))"
fi

# Copy AOF (if exists)
if [ -d "$DATA_DIR/appendonlydir" ]; then
  tar czf "$BACKUP_DIR/aof_${DATE}.tar.gz" -C "$DATA_DIR" appendonlydir/
  log "AOF archived: aof_${DATE}.tar.gz ($(du -h "$BACKUP_DIR/aof_${DATE}.tar.gz" | cut -f1))"
elif [ -f "$DATA_DIR/appendonly.aof" ]; then
  cp "$DATA_DIR/appendonly.aof" "$BACKUP_DIR/aof_${DATE}.aof"
  log "AOF copied: aof_${DATE}.aof"
fi

# Clean old backups
DELETED=$(find "$BACKUP_DIR" -name "dump_*.rdb" -mtime +${RETENTION_DAYS} -delete -print | wc -l)
DELETED=$((DELETED + $(find "$BACKUP_DIR" -name "aof_*" -mtime +${RETENTION_DAYS} -delete -print | wc -l)))
if [ "$DELETED" -gt 0 ]; then
  log "Cleaned $DELETED backup files older than ${RETENTION_DAYS} days"
fi

# Summary
TOTAL_BACKUPS=$(find "$BACKUP_DIR" -name "dump_*.rdb" | wc -l)
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
log "Backup complete. Total: $TOTAL_BACKUPS snapshots, $TOTAL_SIZE on disk"
